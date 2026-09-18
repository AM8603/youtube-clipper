// Express backend for the YouTube -> vertical clips pipeline.
//
// Jobs take minutes, so this uses an async job pattern: POST starts a job and
// returns a jobId immediately; the frontend polls GET for progress. A single
// long HTTP request would be killed by every host's proxy (and by Back4app's).
//
// FIXES vs original:
//  - CORS is an allowlist from ALLOWED_ORIGINS instead of wide open.
//  - Jobs run through a queue with concurrency 1. Two ffmpeg encodes at once
//    instantly OOM a 256MB container; the queue makes that impossible.
//  - All heavy work is async, so polling and health checks keep answering.
//  - Clip URLs are absolute, so the Netlify frontend can load them.
//  - Source files are deleted after each job and clips expire, so the
//    container's small disk can't fill up and crash the app.
//  - Config is validated at boot with a clear log line instead of failing
//    mysteriously on the first request.
//  - Graceful shutdown, 404/500 handlers, request size limit, basic per-IP
//    throttle so one person can't queue 50 jobs.
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { downloadVideo, getVideoDurationSeconds } from "./src/downloader.js";
import { extractAudio, transcribe } from "./src/transcriber.js";
import { findHighlights } from "./src/highlightFinder.js";
import { renderClip } from "./src/clipper.js";
import { buildAssFile } from "./src/subtitler.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const OUTPUT_DIR = path.join(__dirname, "output");
const FRONTEND_DIR = path.join(__dirname, "frontend");

[DOWNLOAD_DIR, OUTPUT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const PORT = Number(process.env.PORT || 8080);
const MAX_VIDEO_MINUTES = Number(process.env.MAX_VIDEO_MINUTES || 30);
const CLEANUP_SOURCE = String(process.env.CLEANUP_SOURCE || "true") === "true";
const CLIP_TTL_MINUTES = Number(process.env.CLIP_TTL_MINUTES || 120);

if (!process.env.GROQ_API_KEY) {
  console.warn(
    "[boot] WARNING: GROQ_API_KEY is not set. Jobs will fail. " +
      "Set it in your host's environment variables."
  );
}

const app = express();
app.set("trust proxy", 1); // Back4app / Netlify sit behind a proxy

// ---------- CORS ----------
const allowed = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);            // curl / same-origin
      if (allowed.includes("*")) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
  })
);

app.use(express.json({ limit: "16kb" }));

// ---------- Static ----------
app.use(
  "/output",
  express.static(OUTPUT_DIR, {
    maxAge: "1h",
    setHeaders: (res) => res.setHeader("Access-Control-Allow-Origin", "*"),
  })
);
if (fs.existsSync(FRONTEND_DIR)) app.use(express.static(FRONTEND_DIR));

// ---------- Job store + queue ----------
const jobs = new Map();
const queue = [];
let running = false;

function publicBaseUrl(req) {
  // The proxy terminates TLS but does not always forward the scheme,
  // so build https ourselves in production.
  const proto = process.env.NODE_ENV === "production" ? "https" : req.protocol;
  return `${proto}://${req.get("host")}`;
}

function enqueue(task) {
  queue.push(task);
  pump();
}

async function pump() {
  if (running) return;
  const task = queue.shift();
  if (!task) return;
  running = true;
  try {
    await task();
  } catch (err) {
    console.error("[queue] task crashed:", err);
  } finally {
    running = false;
    setImmediate(pump);
  }
}

// ---------- Simple per-IP throttle ----------
const recent = new Map();
function throttled(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 5) return true; // max 5 jobs per IP per 10 min
  hits.push(now);
  recent.set(ip, hits);
  return false;
}

// ---------- Routes ----------
app.get(["/health", "/healthz"], (req, res) =>
  res.json({
    ok: true,
    queued: queue.length,
    busy: running,
    groqKey: Boolean(process.env.GROQ_API_KEY),
  })
);

app.post("/api/clip", async (req, res) => {
  const { youtubeUrl } = req.body || {};
  if (!youtubeUrl || typeof youtubeUrl !== "string") {
    return res.status(400).json({ error: "youtubeUrl is required" });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: "Server is missing GROQ_API_KEY." });
  }
  if (throttled(req.ip)) {
    return res.status(429).json({ error: "Too many jobs from this IP. Try again in a few minutes." });
  }

  const jobId = uuidv4().slice(0, 12);
  jobs.set(jobId, {
    status: "queued",
    stage: "Waiting in queue...",
    progress: 0,
    clips: [],
    createdAt: Date.now(),
  });

  const baseUrl = publicBaseUrl(req);
  enqueue(() => processJob(jobId, youtubeUrl, baseUrl));

  res.json({ jobId, position: queue.length });
});

app.get("/api/clip/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found (it may have expired)" });
  res.json(job);
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.use((err, req, res, next) => {
  if (err && /CORS/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }
  console.error("[error]", err);
  res.status(500).json({ error: "internal server error" });
});

// ---------- Pipeline ----------
function setStage(jobId, stage, progress) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.stage = stage;
  if (typeof progress === "number") job.progress = progress;
  job.status = job.status === "queued" ? "processing" : job.status;
  console.log(`[${jobId}] ${stage}`);
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

async function processJob(jobId, youtubeUrl, baseUrl) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "processing";

  const apiKey = process.env.GROQ_API_KEY;
  let videoPath = null;
  let audioPath = null;

  try {
    setStage(jobId, "Checking video...", 5);
    const duration = await getVideoDurationSeconds(youtubeUrl);
    if (duration && duration > MAX_VIDEO_MINUTES * 60) {
      throw new Error(
        `That video is ${Math.round(duration / 60)} minutes long. ` +
          `This server accepts videos up to ${MAX_VIDEO_MINUTES} minutes.`
      );
    }

    setStage(jobId, "Downloading video...", 15);
    videoPath = await downloadVideo(youtubeUrl, DOWNLOAD_DIR, jobId);

    setStage(jobId, "Extracting audio...", 30);
    audioPath = path.join(DOWNLOAD_DIR, `${jobId}.mp3`);
    await extractAudio(videoPath, audioPath);

    setStage(jobId, "Transcribing speech...", 40);
    const { words, segments } = await transcribe(audioPath, apiKey);

    setStage(jobId, "Finding the best moments...", 55);
    const highlights = await findHighlights(segments, apiKey);

    const clips = [];
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      setStage(
        jobId,
        `Rendering clip ${i + 1} of ${highlights.length}...`,
        60 + Math.round((35 * i) / highlights.length)
      );

      const assPath = path.join(OUTPUT_DIR, `${jobId}_clip${i + 1}.ass`);
      const finalPath = path.join(OUTPUT_DIR, `${jobId}_clip${i + 1}.mp4`);

      buildAssFile(words, h.start, h.end, assPath);

      try {
        await renderClip(videoPath, h.start, h.end, assPath, finalPath);
      } catch (err) {
        console.warn(`[${jobId}] clip ${i + 1} failed: ${err.message}`);
        safeUnlink(assPath);
        continue; // one bad clip shouldn't kill the whole job
      }
      safeUnlink(assPath);

      clips.push({
        title: h.title,
        reason: h.reason,
        start: h.start,
        end: h.end,
        duration: Number((h.end - h.start).toFixed(1)),
        url: `${baseUrl}/output/${path.basename(finalPath)}`,
      });

      job.clips = [...clips];
    }

    if (clips.length === 0) throw new Error("Every clip failed to render. Try a different video.");

    job.status = "done";
    job.stage = "Done";
    job.progress = 100;
    job.clips = clips;
    console.log(`[${jobId}] done - ${clips.length} clip(s)`);
  } catch (err) {
    console.error(`[${jobId}] failed:`, err.message);
    job.status = "error";
    job.stage = "Failed";
    job.error = err.message;
  } finally {
    if (CLEANUP_SOURCE) {
      safeUnlink(videoPath);
      safeUnlink(audioPath);
    }
  }
}

// ---------- Housekeeping ----------
setInterval(() => {
  const now = Date.now();

  // Forget old job records (2x the clip TTL, min 1 hour).
  const jobTtl = Math.max(60, CLIP_TTL_MINUTES * 2) * 60 * 1000;
  for (const [id, job] of jobs) {
    if (now - job.createdAt > jobTtl) jobs.delete(id);
  }

  // Delete expired clip files so the small container disk never fills.
  if (CLIP_TTL_MINUTES > 0) {
    const cutoff = now - CLIP_TTL_MINUTES * 60 * 1000;
    try {
      for (const f of fs.readdirSync(OUTPUT_DIR)) {
        const p = path.join(OUTPUT_DIR, f);
        if (fs.statSync(p).mtimeMs < cutoff) safeUnlink(p);
      }
    } catch {
      /* ignore */
    }
  }
}, 10 * 60 * 1000).unref();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] listening on 0.0.0.0:${PORT}`);
  console.log(`[boot] allowed origins: ${allowed.join(", ")}`);
  console.log(`[boot] output ${process.env.CLIP_WIDTH || 720}x${process.env.CLIP_HEIGHT || 1280}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[shutdown] ${sig} received`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

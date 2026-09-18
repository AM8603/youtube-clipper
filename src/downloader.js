// Downloads a YouTube video with the standalone yt-dlp binary.
//
// FIXES vs original:
//  - No hard-coded Windows path (the old .env pointed at C:\Users\... which
//    made every Linux/Docker deploy fail instantly).
//  - Caps resolution, because 1080p source files OOM a 256MB container.
//  - Finds the real output file instead of assuming ".mp4" (yt-dlp sometimes
//    merges to .mkv/.webm when an mp4 stream pair isn't available).
//  - Supports cookies for the "Sign in to confirm you're not a bot" wall
//    that YouTube throws at datacenter IPs.
import fs from "fs";
import os from "os";
import path from "path";
import { run } from "./runner.js";

const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".mov"];

function isValidYouTubeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return ["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(host);
  } catch {
    return false;
  }
}

let cookieFilePath = null;
function getCookieFile() {
  const raw = process.env.YTDLP_COOKIES;
  if (!raw || !raw.trim()) return null;
  if (cookieFilePath && fs.existsSync(cookieFilePath)) return cookieFilePath;
  cookieFilePath = path.join(os.tmpdir(), "yt-cookies.txt");
  fs.writeFileSync(cookieFilePath, raw.replace(/\\n/g, "\n"), { mode: 0o600 });
  return cookieFilePath;
}

export async function getVideoDurationSeconds(url) {
  const bin = process.env.YT_DLP_PATH || "yt-dlp";
  const args = ["--no-playlist", "--no-warnings", "--print", "%(duration)s", url];
  const cookies = getCookieFile();
  if (cookies) args.unshift("--cookies", cookies);
  const { stdout } = await run(bin, args, { timeoutMs: 120_000, label: "yt-dlp (metadata)" });
  const seconds = parseFloat(stdout.trim().split("\n").pop());
  return Number.isFinite(seconds) ? seconds : 0;
}

export async function downloadVideo(url, outputDir, id) {
  if (!isValidYouTubeUrl(url)) {
    throw new Error("That doesn't look like a YouTube URL.");
  }

  const bin = process.env.YT_DLP_PATH || "yt-dlp";
  const maxHeight = Number(process.env.MAX_SOURCE_HEIGHT || 720);
  const outputTemplate = path.join(outputDir, `${id}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
    "-f",
    `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}]/best`,
    "--merge-output-format", "mp4",
    "-o", outputTemplate,
    url,
  ];

  const cookies = getCookieFile();
  if (cookies) args.unshift("--cookies", cookies);

  try {
    await run(bin, args, { timeoutMs: 15 * 60 * 1000, label: "yt-dlp (download)" });
  } catch (err) {
    const msg = err.message || "";
    if (/Sign in to confirm|not a bot|cookies/i.test(msg)) {
      throw new Error(
        "YouTube blocked this server's IP with a bot check. Set the YTDLP_COOKIES " +
          "environment variable (see README) to fix it."
      );
    }
    if (/Private video|unavailable|age|members-only|region/i.test(msg)) {
      throw new Error("That video is private, age-restricted, or unavailable in this region.");
    }
    throw new Error(`Download failed: ${msg.slice(-400)}`);
  }

  // Find whatever file yt-dlp actually produced.
  const produced = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith(id) && VIDEO_EXTS.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(outputDir, f));

  if (produced.length === 0) {
    throw new Error("yt-dlp finished but produced no video file.");
  }

  // Prefer mp4, else biggest file.
  produced.sort((a, b) => {
    const ap = path.extname(a) === ".mp4" ? 0 : 1;
    const bp = path.extname(b) === ".mp4" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return fs.statSync(b).size - fs.statSync(a).size;
  });

  return produced[0];
}

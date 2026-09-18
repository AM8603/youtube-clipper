// Transcribes audio with Groq's free Whisper API (whisper-large-v3).
//
// FIXES vs original:
//  - Audio extraction is async (was execSync, which froze the whole server).
//  - Enforces Groq's ~25MB upload limit BEFORE uploading, with a clear
//    message instead of a raw 413 from the API.
//  - Retries on 429 (Groq free tier rate-limits aggressively).
//  - Mono 16kHz 32kbps keeps a 30-minute video comfortably under the limit.
import fs from "fs";
import { run } from "./runner.js";

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // Groq's limit is 25MB; leave headroom.

export async function extractAudio(videoPath, audioPath) {
  await run(
    "ffmpeg",
    [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "32k",
      audioPath,
    ],
    { timeoutMs: 10 * 60 * 1000, label: "ffmpeg (audio extract)" }
  );
  return audioPath;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function transcribe(audioPath, apiKey) {
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set on the server. Add it in your host's environment variables.");
  }

  const { size } = fs.statSync(audioPath);
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio is ${(size / 1024 / 1024).toFixed(1)}MB, over Groq's 25MB limit. ` +
        `Use a shorter video (under ~${process.env.MAX_VIDEO_MINUTES || 30} minutes).`
    );
  }

  const fileBuffer = fs.readFileSync(audioPath);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([fileBuffer], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", "whisper-large-v3");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");

    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (res.ok) {
      const data = await res.json();
      const words = (data.words || [])
        .filter((w) => w && typeof w.start === "number" && typeof w.end === "number")
        .map((w) => ({ word: String(w.word || "").trim(), start: w.start, end: w.end }))
        .filter((w) => w.word.length > 0);

      const segments = (data.segments || [])
        .filter((s) => s && typeof s.start === "number" && typeof s.end === "number")
        .map((s) => ({ start: s.start, end: s.end, text: String(s.text || "").trim() }))
        .filter((s) => s.text.length > 0);

      if (segments.length === 0) {
        throw new Error("No speech was detected in this video, so there is nothing to clip.");
      }
      return { words, segments };
    }

    const body = await res.text();

    if (res.status === 401) {
      throw new Error("Groq rejected the API key (401). Check GROQ_API_KEY on your host.");
    }
    if (res.status === 429 && attempt < 4) {
      await sleep(attempt * 8000); // back off and retry
      continue;
    }
    throw new Error(`Groq transcription failed (${res.status}): ${body.slice(0, 300)}`);
  }

  throw new Error("Groq transcription failed after retries (rate limited).");
}

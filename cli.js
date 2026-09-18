// Run the pipeline locally from the command line (no server).
// Usage: node cli.js "https://www.youtube.com/watch?v=VIDEO_ID"
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { downloadVideo } from "./src/downloader.js";
import { extractAudio, transcribe } from "./src/transcriber.js";
import { findHighlights } from "./src/highlightFinder.js";
import { renderClip } from "./src/clipper.js";
import { buildAssFile } from "./src/subtitler.js";

dotenv.config();

const DOWNLOAD_DIR = "downloads";
const OUTPUT_DIR = "output";
[DOWNLOAD_DIR, OUTPUT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

async function run(youtubeUrl) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("Missing GROQ_API_KEY. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  const id = uuidv4().slice(0, 8);

  console.log("[1/4] Downloading video...");
  const videoPath = await downloadVideo(youtubeUrl, DOWNLOAD_DIR, id);
  console.log(`   -> ${videoPath}`);

  console.log("[2/4] Extracting audio + transcribing (Groq Whisper)...");
  const audioPath = path.join(DOWNLOAD_DIR, `${id}.mp3`);
  await extractAudio(videoPath, audioPath);
  const { words, segments } = await transcribe(audioPath, apiKey);
  console.log(`   -> ${segments.length} segments, ${words.length} words`);

  console.log("[3/4] Finding viral moments (Groq LLM)...");
  const highlights = await findHighlights(segments, apiKey);
  console.log(`   -> ${highlights.length} highlight(s)`);

  console.log("[4/4] Cutting, reframing, and captioning...");
  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const assPath = path.join(OUTPUT_DIR, `${id}_clip${i + 1}.ass`);
    const finalPath = path.join(OUTPUT_DIR, `${id}_clip${i + 1}.mp4`);
    buildAssFile(words, h.start, h.end, assPath);
    await renderClip(videoPath, h.start, h.end, assPath, finalPath);
    console.log(`   -> ${finalPath}  (${h.title})`);
  }

  console.log("\nAll clips are in the output/ folder.");
}

const url = process.argv[2];
if (!url) {
  console.error('Usage: node cli.js "<youtube_url>"');
  process.exit(1);
}
run(url).catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});

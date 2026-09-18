// Cuts a segment, reframes it to vertical 9:16, and burns in the captions -
// all in ONE ffmpeg pass.
//
// FIXES vs original:
//  - The old code encoded the clip, wrote it to disk, then re-encoded it again
//    just to burn subtitles. That is 2x the CPU and 2x the disk on a container
//    that only has 0.25 CPU. One pass halves the work.
//  - scale/crop now uses force_original_aspect_ratio=increase, so a source
//    that is already portrait (or square) no longer errors out with
//    "crop area out of bounds".
//  - Output size is configurable; 720x1280 is the safe default for free tiers.
//  - Async (was execSync, which blocked the server for the whole encode).
import path from "path";
import { run } from "./runner.js";

function escapeForFilter(p) {
  // ffmpeg filter args: backslashes break it and ":" reads as a separator.
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export async function renderClip(inputPath, start, end, assPath, outputPath) {
  const outW = Number(process.env.CLIP_WIDTH || 720);
  const outH = Number(process.env.CLIP_HEIGHT || 1280);
  const duration = Math.max(1, end - start);

  const filters = [
    `scale=${outW}:${outH}:force_original_aspect_ratio=increase`,
    `crop=${outW}:${outH}`,
  ];
  if (assPath) filters.push(`ass=${escapeForFilter(assPath)}`);

  await run(
    "ffmpeg",
    [
      "-y",
      "-ss", String(start),      // fast seek before -i
      "-i", inputPath,
      "-t", String(duration),
      "-vf", filters.join(","),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",     // required for playback in Safari / iOS
      "-profile:v", "main",
      "-movflags", "+faststart", // lets the browser start playing before full download
      "-c:a", "aac",
      "-b:a", "128k",
      "-threads", "1",           // 0.25 vCPU: more threads just thrash
      outputPath,
    ],
    { timeoutMs: 20 * 60 * 1000, label: `ffmpeg (clip ${path.basename(outputPath)})` }
  );

  return outputPath;
}

// Kept for backwards compatibility with any older scripts.
export async function cutAndReframe(inputPath, start, end, outputPath) {
  return renderClip(inputPath, start, end, null, outputPath);
}

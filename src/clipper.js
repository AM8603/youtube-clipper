// Cuts a segment out of the source video, reframes it to vertical, and burns
// in the subtitles -- all in ONE ffmpeg pass. This matters on small
// containers (e.g. Back4App's 256MB free tier): doing cut+reframe and
// subtitle-burn as two separate ffmpeg calls (as the original version did)
// means writing a full intermediate video to disk and running ffmpeg twice;
// combining them into a single pass roughly halves both time and disk use.
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

export async function renderClip(inputPath, start, end, assPath, outputPath) {
  const width = Number(process.env.CLIP_WIDTH || 720);
  const height = Number(process.env.CLIP_HEIGHT || 1280);
  const duration = end - start;

  // ffmpeg's filter-string parser cannot reliably handle absolute Windows
  // paths inside a filter argument -- the drive-letter colon (C:) gets
  // misparsed as a filter-option separator no matter how it's escaped
  // (this is a known ffmpeg/Windows limitation, not something we can
  // escape our way around). Using a path RELATIVE to the working
  // directory sidesteps the problem entirely, since it has no colon.
  const relAssPath = path.relative(process.cwd(), assPath).split(path.sep).join("/");

  const vf = `scale=-2:${height},crop=${width}:${height},ass='${relAssPath}'`;

  const args = [
    "-y",
    "-ss", String(start),
    "-i", inputPath,
    "-t", String(duration),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    outputPath,
  ];

  try {
    await execFileAsync("ffmpeg", args);
  } catch (err) {
    throw new Error(`ffmpeg render failed: ${err.message}`);
  }
}

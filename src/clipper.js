// Cuts a segment out of the source video, reframes it to vertical, and burns
// in the subtitles -- all in ONE ffmpeg pass. This matters on small
// containers (e.g. Back4App's 256MB free tier): doing cut+reframe and
// subtitle-burn as two separate ffmpeg calls (as the original version did)
// means writing a full intermediate video to disk and running ffmpeg twice;
// combining them into a single pass roughly halves both time and disk use.
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function renderClip(inputPath, start, end, assPath, outputPath) {
  const width = Number(process.env.CLIP_WIDTH || 720);
  const height = Number(process.env.CLIP_HEIGHT || 1280);
  const duration = end - start;

  // ffmpeg's filter syntax treats backslashes as escape characters, which
  // breaks Windows-style paths -- converting to forward slashes (ffmpeg
  // accepts these fine everywhere) and escaping any colon (drive letters)
  // avoids that.
  // was: assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
const escapedAss = assPath.replace(/\\/g, "/").replace(/:/g, "\\\\:");

  const vf = `scale=-2:${height},crop=${width}:${height},ass=${escapedAss}`;

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

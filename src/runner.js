// Central place to run external binaries (ffmpeg / yt-dlp / ffprobe).
//
// WHY THIS EXISTS: the original code used execSync(), which BLOCKS Node's
// single thread. While ffmpeg ran (minutes), the server could not answer the
// frontend's polling requests, so the UI looked frozen and health checks
// failed. Everything here is async + streamed, so the server stays responsive.
import { spawn } from "child_process";

export function run(bin, args, { timeoutMs = 20 * 60 * 1000, label = bin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let stdout = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
      // Keep only the tail: ffmpeg is extremely chatty and this would
      // otherwise eat the container's whole 256MB of RAM on a long job.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        return reject(
          new Error(
            `"${bin}" not found. Inside Docker this is installed automatically; ` +
              `locally, install it and make sure it is on your PATH.`
          )
        );
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${label} timed out and was killed.`));
      if (code !== 0) {
        return reject(new Error(`${label} exited with code ${code}: ${stderr.slice(-1200)}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function probeDuration(filePath) {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { timeoutMs: 60_000, label: "ffprobe" }
  );
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

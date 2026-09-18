// Downloads a YouTube video by calling the standalone yt-dlp binary directly
// (no Python needed -- the compiled yt-dlp.exe/binary is fully self-contained).
// Set YT_DLP_PATH in .env if yt-dlp isn't on your system PATH; otherwise this
// just runs "yt-dlp" and assumes it's reachable.
//
// Cloud hosts (Back4App, Render, Railway, etc.) run on datacenter IPs that
// YouTube often blocks, demanding proof of a logged-in session. To support
// that, set YT_COOKIES_B64 to your exported cookies.txt content, base64
// encoded (base64 survives being pasted into an env var intact -- a raw
// pasted cookies file usually does not, since tabs/newlines get mangled).
// Leave YT_COOKIES_B64 unset for local use; it's not needed on a home IP.
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";

const execFileAsync = promisify(execFile);

function readChunkedEnv(baseName) {
  // Supports a first chunk with no numeric suffix (BASE_NAME) followed by
  // BASE_NAME_2, BASE_NAME_3, ... for hosts that cap individual env var length.
  const first = process.env[baseName];
  if (!first) return null;

  let combined = first;
  let i = 2;
  while (process.env[`${baseName}_${i}`]) {
    combined += process.env[`${baseName}_${i}`];
    i++;
  }
  return combined;
}

function writeCookiesFileIfConfigured() {
  const b64 = readChunkedEnv("YTDLP_COOKIES") || readChunkedEnv("YT_COOKIES_B64");
  if (!b64) return null;

  const cookiesPath = path.join(os.tmpdir(), "yt-cookies.txt");
  const decoded = Buffer.from(b64, "base64").toString("utf-8");

  if (!decoded.startsWith("# Netscape HTTP Cookie File") && !decoded.startsWith("# HTTP Cookie File")) {
    throw new Error(
      "YT_COOKIES_B64 didn't decode into a valid Netscape cookies file. " +
      "Make sure you base64-encoded the exact exported cookies.txt content, not a copy-pasted snippet."
    );
  }

  fs.writeFileSync(cookiesPath, decoded);
  return cookiesPath;
}

export async function downloadVideo(url, outputDir, id) {
  const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";
  const outputTemplate = path.join(outputDir, `${id}.%(ext)s`);

  const args = [
    url,
    "-o", outputTemplate,
    "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "--no-playlist",
  ];

  const cookiesPath = writeCookiesFileIfConfigured();
  if (cookiesPath) {
    args.push("--cookies", cookiesPath);
  }

  try {
    await execFileAsync(YT_DLP_BIN, args);
  } catch (err) {
    throw new Error(
      `yt-dlp failed to run (${err.message}). Make sure yt-dlp.exe is on your PATH, ` +
      `or set YT_DLP_PATH in .env to its full file path. If this is running on a cloud ` +
      `host, YouTube may be blocking it -- set YT_COOKIES_B64 (see downloader.js comments).`
    );
  }

  return path.join(outputDir, `${id}.mp4`);
}

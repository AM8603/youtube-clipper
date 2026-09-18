// Downloads a YouTube video by calling the standalone yt-dlp binary directly
// (no Python needed -- the compiled yt-dlp.exe/binary is fully self-contained).
// Set YT_DLP_PATH in .env if yt-dlp isn't on your system PATH; otherwise this
// just runs "yt-dlp" and assumes it's reachable.
//
// Cloud hosts (Back4App, Render, Railway, etc.) run on datacenter IPs that
// YouTube often blocks, demanding proof of a logged-in session. To support
// that, set YTDLP_COOKIES (optionally split across YTDLP_COOKIES_2,
// YTDLP_COOKIES_3, ... for hosts with a per-variable length cap) to your
// exported cookies.txt content, base64 encoded. Leave unset for local use.
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";

const execFileAsync = promisify(execFile);

function readChunkedEnv(baseName) {
  // First chunk has no numeric suffix (BASE_NAME), followed by
  // BASE_NAME_2, BASE_NAME_3, ... Each chunk is trimmed before joining,
  // since pasting into a dashboard sometimes adds stray leading/trailing
  // whitespace or a trailing newline that would otherwise corrupt the
  // base64 once every chunk is concatenated back together.
  const first = process.env[baseName];
  if (!first) return null;

  let combined = first.trim();
  let i = 2;
  while (process.env[`${baseName}_${i}`]) {
    combined += process.env[`${baseName}_${i}`].trim();
    i++;
  }
  return combined;
}

function writeCookiesFileIfConfigured() {
  const raw = readChunkedEnv("YTDLP_COOKIES") || readChunkedEnv("YT_COOKIES_B64");
  if (!raw) return null;

  // base64 never legitimately contains whitespace -- stripping it all is a
  // safe, defensive fix for any newlines/spaces that snuck in during copy-paste.
  const b64 = raw.replace(/\s+/g, "");
  const cookiesPath = path.join(os.tmpdir(), "yt-cookies.txt");
  const decoded = Buffer.from(b64, "base64").toString("utf-8");

  if (!decoded.startsWith("# Netscape HTTP Cookie File") && !decoded.startsWith("# HTTP Cookie File")) {
    throw new Error(
      "Cookie env var didn't decode into a valid Netscape cookies file. " +
      "Make sure every chunk was pasted in the correct order with nothing added or dropped."
    );
  }

  fs.writeFileSync(cookiesPath, decoded);
  return cookiesPath;
}

function buildCommonArgs(url) {
  const args = [url];
  const cookiesPath = writeCookiesFileIfConfigured();
  if (cookiesPath) args.push("--cookies", cookiesPath);
  return args;
}

export async function downloadVideo(url, outputDir, id) {
  const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";
  const outputTemplate = path.join(outputDir, `${id}.%(ext)s`);

  const args = [
    ...buildCommonArgs(url),
    "-o", outputTemplate,
    "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "--no-playlist",
  ];

  try {
    await execFileAsync(YT_DLP_BIN, args);
  } catch (err) {
    throw new Error(
      `yt-dlp (download) failed: ${err.message}. If this is running on a cloud host, ` +
      `YouTube may be blocking it -- check your cookie env vars.`
    );
  }

  return path.join(outputDir, `${id}.mp4`);
}

// Fetches just the video's duration (no download) so the server can reject
// videos over its configured length limit before spending time/tokens on them.
export async function getVideoDurationSeconds(url) {
  const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";

  const args = [
    ...buildCommonArgs(url),
    "--skip-download",
    "--no-warnings",
    "--print", "%(duration)s",
  ];

  try {
    const { stdout } = await execFileAsync(YT_DLP_BIN, args);
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  } catch (err) {
    throw new Error(`yt-dlp (metadata) failed: ${err.message}`);
  }
}

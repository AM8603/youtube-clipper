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

// YouTube's blocking behavior is inconsistent right now (see comments in
// the Dockerfile) -- different videos succeed with different client
// strategies. Rather than betting on one fixed approach, try several in
// order and use the first one that works.
const CLIENT_STRATEGIES = [
  ["--extractor-args", "youtube:player_client=default,web_embedded"],
  ["--extractor-args", "youtube:player_client=tv_simply"],
  ["--extractor-args", "youtube:player_client=web_embedded"],
  ["--extractor-args", "youtube:player_client=android"],
  [], // yt-dlp's own default behavior, no override
];

function buildCommonArgs(url, strategyArgs) {
  const args = [url, ...strategyArgs];
  const cookiesPath = writeCookiesFileIfConfigured();
  if (cookiesPath) args.push("--cookies", cookiesPath);
  return args;
}

async function runWithFallbacks(buildArgsForStrategy, label) {
  const errors = [];

  for (const strategy of CLIENT_STRATEGIES) {
    const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";
    const args = buildArgsForStrategy(strategy);
    try {
      return await execFileAsync(YT_DLP_BIN, args);
    } catch (err) {
      const clientDesc = strategy.length ? strategy[1] : "yt-dlp default";
      errors.push(`  - [${clientDesc}] ${err.message.split("\n")[0]}`);
    }
  }

  throw new Error(
    `yt-dlp (${label}) failed after trying ${CLIENT_STRATEGIES.length} client strategies:\n` +
    errors.join("\n")
  );
}

export async function downloadVideo(url, outputDir, id) {
  const outputTemplate = path.join(outputDir, `${id}.%(ext)s`);

  await runWithFallbacks(
    (strategy) => [
      ...buildCommonArgs(url, strategy),
      "-o", outputTemplate,
      "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
    ],
    "download"
  );

  return path.join(outputDir, `${id}.mp4`);
}

// Fetches just the video's duration (no download) so the server can reject
// videos over its configured length limit before spending time/tokens on them.
export async function getVideoDurationSeconds(url) {
  const { stdout } = await runWithFallbacks(
    (strategy) => [
      ...buildCommonArgs(url, strategy),
      "--skip-download",
      "--no-warnings",
      "--print", "%(duration)s",
    ],
    "metadata"
  );

  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

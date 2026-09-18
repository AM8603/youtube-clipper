// Builds Opus-Clips-style karaoke captions (.ass) - a few words on screen,
// with the currently spoken word highlighted.
//
// FIXES vs original:
//  - Font changed from "Arial Black" to "Liberation Sans". Arial Black does
//    NOT exist on a Linux container, so on the deployed server every caption
//    rendered as a fallback/blank. Liberation Sans is installed by the
//    Dockerfile and is metrically Arial-compatible.
//  - PlayResX/Y now follow the configured output size, so font size scales
//    correctly instead of being half the intended size at 720x1280.
//  - Text is escaped, so a stray "{" or newline in the transcript can no
//    longer corrupt the subtitle file and break the whole ffmpeg render.
//  - burnSubtitles() is kept, but the pipeline now burns during the single
//    clip pass in clipper.js instead.
import fs from "fs";
import { run } from "./runner.js";

const WORDS_PER_LINE = 3;
const DEFAULT_BASE_COLOR = "FFFFFF";
const DEFAULT_HIGHLIGHT_COLOR = "FFD60A";

function rgbToAss(hex) {
  const r = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const b = hex.slice(4, 6);
  return `&H00${b}${g}${r}`; // ASS is BGR with an alpha byte
}

function fmtTime(t) {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = (clamped % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}

function escapeAssText(str) {
  return str
    .replace(/\\/g, "")
    .replace(/[{}]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

export function buildAssFile(words, clipStart, clipEnd, outputAss, opts = {}) {
  const playX = Number(process.env.CLIP_WIDTH || 720);
  const playY = Number(process.env.CLIP_HEIGHT || 1280);
  const font = opts.font || "Liberation Sans";
  // Scale the font with the frame so 720p and 1080p look identical.
  const fontsize = opts.fontsize || Math.round(playY * 0.047);
  const marginV = Math.round(playY * 0.14);
  const outline = Math.max(2, Math.round(playY * 0.0035));

  const baseAss = rgbToAss(opts.baseColor || DEFAULT_BASE_COLOR);
  const highlightAss = rgbToAss(opts.highlightColor || DEFAULT_HIGHLIGHT_COLOR);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playX}
PlayResY: ${playY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${fontsize},${baseAss},${highlightAss},&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${outline},2,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const clipWords = (words || [])
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({
      word: escapeAssText(w.word).toUpperCase(),
      start: Math.max(w.start, clipStart),
      end: Math.min(w.end, clipEnd),
    }))
    .filter((w) => w.word.length > 0 && w.end > w.start);

  const lines = [header];

  for (let i = 0; i < clipWords.length; i += WORDS_PER_LINE) {
    const chunk = clipWords.slice(i, i + WORDS_PER_LINE);

    for (let j = 0; j < chunk.length; j++) {
      const start = chunk[j].start - clipStart;
      const end =
        j < chunk.length - 1
          ? chunk[j + 1].start - clipStart
          : Math.max(chunk[j].end - clipStart, start + 0.12);

      if (end <= start) continue;

      const text = chunk
        .map((w, k) =>
          k === j ? `{\\c${highlightAss}\\fscx108\\fscy108}${w.word}{\\c${baseAss}\\fscx100\\fscy100}` : w.word
        )
        .join(" ");

      lines.push(`Dialogue: 0,${fmtTime(start)},${fmtTime(end)},Default,,0,0,0,,${text}`);
    }
  }

  fs.writeFileSync(outputAss, lines.join("\n"), "utf8");
  return outputAss;
}

export async function burnSubtitles(inputVideo, assPath, outputVideo) {
  const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  await run(
    "ffmpeg",
    ["-y", "-i", inputVideo, "-vf", `ass=${escaped}`, "-c:a", "copy", outputVideo],
    { timeoutMs: 20 * 60 * 1000, label: "ffmpeg (burn subs)" }
  );
  return outputVideo;
}

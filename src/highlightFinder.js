// Picks viral-worthy moments from the transcript with Groq's free LLM API.
//
// FIXES vs original:
//  - Validates and clamps whatever the model returns. The old code did a bare
//    JSON.parse on model output and trusted start/end blindly; a hallucinated
//    timestamp past the end of the video made ffmpeg produce a 0-byte clip.
//  - Retries on 429 and falls back to evenly-spaced clips if the LLM fails
//    completely, so a job never dies with zero output.
//  - Deduplicates overlapping picks from different chunks.
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

const MAX_CHUNK_CHARS = 6000;
const DELAY_BETWEEN_CALLS_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkSegments(segments, maxChars) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const seg of segments) {
    const line = `[${seg.start.toFixed(1)}-${seg.end.toFixed(1)}] ${seg.text}\n`;
    if (chars + line.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(seg);
    chars += line.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function extractJsonArray(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function askGroq(prompt, apiKey, model) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || "";
    }
    if (res.status === 429 && attempt < 3) {
      await sleep(attempt * 8000);
      continue;
    }
    if (res.status === 401) throw new Error("Groq rejected the API key (401).");
    throw new Error(`Groq highlight request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return "";
}

function sanitize(raw, { videoEnd, minDur, maxDur }) {
  const out = [];
  for (const h of raw) {
    let start = Number(h?.start);
    let end = Number(h?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    start = Math.max(0, start);
    end = Math.min(videoEnd, end);
    if (end - start < 5) continue;                 // useless sliver
    if (end - start > maxDur) end = start + maxDur; // clamp overly long picks
    if (end - start < minDur) {                     // stretch short picks if room
      end = Math.min(videoEnd, start + minDur);
      if (end - start < 8) continue;
    }

    out.push({
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      title: String(h?.title || "Clip").slice(0, 90),
      reason: String(h?.reason || "").slice(0, 240),
    });
  }

  // Drop overlaps (keep the earlier one).
  out.sort((a, b) => a.start - b.start);
  const deduped = [];
  for (const h of out) {
    const last = deduped[deduped.length - 1];
    if (last && h.start < last.end - 2) continue;
    deduped.push(h);
  }
  return deduped;
}

function evenlySpacedFallback(segments, { numClips, minDur, maxDur }) {
  const videoEnd = segments[segments.length - 1].end;
  const dur = Math.min(maxDur, Math.max(minDur, 45));
  const usable = Math.max(0, videoEnd - dur);
  const clips = [];
  for (let i = 0; i < numClips; i++) {
    const start = Math.round((usable * (i + 0.5)) / numClips);
    clips.push({
      start,
      end: Math.min(videoEnd, start + dur),
      title: `Clip ${i + 1}`,
      reason: "Automatic fallback selection (AI highlight picking was unavailable).",
    });
  }
  return clips;
}

export async function findHighlights(segments, apiKey, options = {}) {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set on the server.");

  const model = options.model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const numClips = Number(options.numClips || process.env.NUM_CLIPS || 3);
  const minDur = Number(options.minDur || process.env.MIN_CLIP_SECONDS || 20);
  const maxDur = Number(options.maxDur || process.env.MAX_CLIP_SECONDS || 60);
  const videoEnd = segments[segments.length - 1].end;

  const chunks = chunkSegments(segments, MAX_CHUNK_CHARS);
  const clipsPerChunk = Math.max(1, Math.ceil(numClips / chunks.length));
  const collected = [];

  for (let i = 0; i < chunks.length; i++) {
    if (collected.length >= numClips) break;

    const transcriptText = chunks[i]
      .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
      .join("\n");

    const prompt = `You are an expert short-form video editor who finds viral moments in long videos.

Below is a timestamped transcript excerpt. Select up to ${clipsPerChunk} standalone
segments from THIS EXCERPT that would work as viral short clips. Each clip must be
between ${minDur} and ${maxDur} seconds, have a strong hook in the first 3 seconds,
and be a complete thought. Prioritise strong emotion, surprising claims, concrete
stories, actionable insights, or punchy one-liners. If nothing here is clip-worthy,
return an empty array.

Respond with ONLY a valid JSON array, no markdown and no explanation:
[{"start": 123.4, "end": 175.0, "title": "short punchy title", "reason": "why this works"}]

Use timestamps that actually appear below.

TRANSCRIPT EXCERPT:
${transcriptText}`;

    try {
      const content = await askGroq(prompt, apiKey, model);
      collected.push(...extractJsonArray(content));
    } catch (err) {
      console.warn(`[highlights] chunk ${i + 1}/${chunks.length} failed: ${err.message}`);
    }

    if (i < chunks.length - 1) await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  const clean = sanitize(collected, { videoEnd, minDur, maxDur }).slice(0, numClips);
  if (clean.length > 0) return clean;

  console.warn("[highlights] AI returned nothing usable - using evenly spaced fallback.");
  return evenlySpacedFallback(segments, { numClips, minDur, maxDur });
}

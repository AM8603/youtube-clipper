# Clipper — YouTube → captioned vertical clips

Node.js backend (Docker) + static frontend. Paste a YouTube link, get 9:16
clips with burned-in karaoke captions.

**Backend:** Back4app Containers · **Frontend:** Netlify · **AI:** Groq (free tier)

---

## ⚠️ Do this first

The `.env` file in your old zip contained a **real Groq API key**. That key is
now considered public. Go to <https://console.groq.com> → **API Keys** →
**delete that key** → create a new one. Never put the key in a file you commit
to GitHub; it goes in the host's environment variables instead. The new
`.gitignore` blocks `.env` so this can't happen again.

---

## What changed from your original code

| Problem | Why it broke deployment | Fix |
|---|---|---|
| `YT_DLP_PATH=C:\Users\...` in `.env` | Windows path; every Linux/Docker run failed instantly | Removed; Docker installs yt-dlp itself |
| Dockerfile downloaded the `yt-dlp` asset | That asset is a **Python** zipapp — `node:20-slim` has no Python, so downloads crashed at runtime | Downloads `yt-dlp_linux` (self-contained) |
| Font `Arial Black` | Doesn't exist on Linux → captions rendered blank/garbled on the server | `Liberation Sans` + fonts installed in the image |
| `execSync` for ffmpeg | Blocked Node's only thread, so status polling and health checks froze during every encode | Async `spawn` everywhere |
| Encoded each clip **twice** (cut, then burn subs) | 2× CPU and disk on a 0.25-CPU container | One ffmpeg pass |
| `cors()` wide open | Anyone could use your backend and burn your Groq quota | `ALLOWED_ORIGINS` allowlist |
| Relative clip URLs (`/output/x.mp4`) | Netlify frontend resolved them against Netlify, giving 404s | Absolute URLs built from the request host |
| Unlimited concurrent jobs | Two ffmpeg runs = instant OOM on 256 MB | Queue, concurrency 1 |
| `node_modules/`, `downloads/`, `output/`, `tools/yt-dlp.exe` in the zip | 442 MB repo; GitHub rejects files over 100 MB | `.gitignore` + `.dockerignore` |
| Raw `JSON.parse` on model output | A hallucinated timestamp produced 0-byte clips | Timestamps validated, clamped, deduped, plus a fallback |
| Nothing ever deleted | Container disk fills, app dies | Sources deleted after each job, clips expire |
| No input limits | A 3-hour video = guaranteed OOM / Groq 25 MB error | Duration cap + clear error messages |

Also added: progress stages, per-IP throttling, retries on Groq 429, graceful
shutdown, `/healthz`, cookie support for YouTube's bot check, and a rebuilt
frontend.

---

## Step 1 — Get a Groq API key (2 min)

1. Go to <https://console.groq.com> and sign in.
2. **API Keys** → **Create API Key**. Copy it (starts with `gsk_`).
3. Keep it in a notes app for now. It goes into Back4app in Step 4, **not** into any file.

## Step 2 — Put the code on GitHub (5 min)

Unzip this folder, then in a terminal inside it:

```bash
git init
git add .
git commit -m "Clipper: deployable version"
git branch -M main
```

Create an **empty** repo on github.com (no README, no .gitignore), then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Before pushing, run `git status` and confirm you do **not** see `.env`,
`node_modules`, `downloads`, `output`, or `tools`. If you do, the `.gitignore`
isn't being picked up — make sure it's in the same folder as `package.json`.

## Step 3 — Deploy the backend to Back4app Containers (10 min)

1. <https://containers.back4app.com> → sign up / log in.
2. **Create new app** → **Deploy from GitHub** → install the Back4app GitHub
   App and grant it access to your repo.
3. Pick your repo and the `main` branch. It will detect the `Dockerfile`
   automatically — leave the build settings alone.
4. **Port: `8080`** (must match `ENV PORT=8080` in the Dockerfile).
5. **Health check path: `/healthz`**
6. Add these **environment variables**:

   | Name | Value |
   |---|---|
   | `GROQ_API_KEY` | your new `gsk_...` key |
   | `PORT` | `8080` |
   | `ALLOWED_ORIGINS` | `*` for now — you'll tighten it in Step 6 |
   | `MAX_SOURCE_HEIGHT` | `720` |
   | `CLIP_WIDTH` | `720` |
   | `CLIP_HEIGHT` | `1280` |
   | `NUM_CLIPS` | `3` |
   | `MAX_VIDEO_MINUTES` | `15` |

7. **Deploy.** The first build takes ~4–6 minutes (it installs ffmpeg).
8. When it's green you get a URL like `https://yourapp-abc123.b4a.run`.
   Open `https://yourapp-abc123.b4a.run/healthz` — you should see
   `{"ok":true,...,"groqKey":true}`. If `groqKey` is `false`, the env var didn't save.

**Copy that URL.** You need it in the next step.

## Step 4 — Point the frontend at the backend (1 min)

Open `frontend/config.js` and set the one line:

```js
window.BACKEND_URL = "https://yourapp-abc123.b4a.run";
```

No trailing slash. Commit and push:

```bash
git add frontend/config.js && git commit -m "point frontend at backend" && git push
```

## Step 5 — Deploy the frontend to Netlify (3 min)

1. <https://app.netlify.com> → **Add new site** → **Import an existing project** → GitHub → your repo.
2. Netlify reads `netlify.toml`, so the settings are already correct:
   - Build command: *(empty)*
   - Publish directory: `frontend`
3. **Deploy.** You get `https://random-name-123.netlify.app`.
4. Optional: **Site configuration → Change site name** to something nicer.

## Step 6 — Lock down CORS (1 min, don't skip)

Back to Back4app → your app → **Environment variables** → change:

```
ALLOWED_ORIGINS = https://your-site.netlify.app
```

(exact URL, `https://`, no trailing slash — add a second comma-separated entry
if you also use a custom domain). Redeploy. Now only your site can use your
backend and your Groq quota.

## Step 7 — Test

Open your Netlify URL, paste a **short** YouTube video (3–10 minutes, clear
speech), and press **Make clips**. Expect 3–8 minutes on the free tier. The
progress bar shows the current stage; clips appear as they finish.

---

## Things that will bite you (read this before you panic)

**"YouTube blocked this server's IP with a bot check."**
YouTube frequently blocks cloud datacenter IPs. Fix it with cookies:
install the *Get cookies.txt LOCALLY* browser extension, export cookies while
logged in to youtube.com, open the file, copy **everything**, and paste it into
a Back4app environment variable named `YTDLP_COOKIES`. Redeploy. Use a throwaway
Google account — those cookies are a login.

**Free tier is genuinely small.** 0.25 CPU and 256 MB RAM. Video encoding is
the most CPU-heavy thing you can ask a container to do. Expect slow jobs and
occasional out-of-memory restarts on longer videos. Keep `MAX_VIDEO_MINUTES=15`
and `CLIP_HEIGHT=1280`. The $5/month Shared plan (0.5 CPU / 512 MB) is roughly
2× faster and much more stable — for a public product you'll want it.

**Free containers sleep / expire.** Back4app's free plan is meant for testing;
a free container's URL isn't guaranteed to stay up indefinitely. If your site
suddenly can't reach the backend, check the Back4app dashboard first. Paid
plans plus **Settings → Build & deploy → Autodeploy** give you an always-on app.

**Clips vanish after 2 hours.** Container disks are ephemeral — a restart wipes
them anyway. `CLIP_TTL_MINUTES` controls the cleanup. If you want clips to last,
upload them to object storage (Cloudflare R2 / S3) instead of the local disk.

**Jobs run one at a time.** By design. Two simultaneous ffmpeg encodes will kill
a small container. If two people submit at once, the second waits.

**Only public videos work.** Private, age-restricted, members-only, and
region-locked videos will fail with a clear message.

**Copyright.** Clipping someone else's video and reposting it can infringe their
rights. Fine for your own content or with permission; check before publishing.

---

## Running locally

```bash
npm install
cp .env.example .env     # then paste your GROQ_API_KEY into .env
```

Install ffmpeg and yt-dlp:

```bash
# macOS
brew install ffmpeg yt-dlp
# Ubuntu/Debian
sudo apt install ffmpeg && sudo pip install -U yt-dlp
# Windows (PowerShell, as admin)
choco install ffmpeg yt-dlp
```

Then either:

```bash
node cli.js "https://www.youtube.com/watch?v=VIDEO_ID"   # clips land in output/
npm start                                                 # http://localhost:8080
```

On Windows, if `yt-dlp` isn't on your PATH, set `YT_DLP_PATH` in `.env` to the
full path of `yt-dlp.exe`. **Leave that variable unset in production.**

Docker locally:

```bash
docker build -t clipper .
docker run -p 8080:8080 -e GROQ_API_KEY=gsk_xxx -e ALLOWED_ORIGINS=* clipper
```

## API

```
POST /api/clip        {"youtubeUrl": "..."}  ->  {"jobId": "..."}
GET  /api/clip/:jobId                        ->  {status, stage, progress, clips[], error?}
GET  /healthz                                ->  {ok, queued, busy, groqKey}
GET  /output/<file>.mp4                      ->  the finished clip
```

`status` is `queued` | `processing` | `done` | `error`.

## Project layout

```
server.js            Express API, job queue, cleanup
cli.js               run the pipeline without a server
Dockerfile           ffmpeg + fonts + yt-dlp + Node
netlify.toml         frontend deploy config
.env.example         copy to .env locally; on the host use env vars
src/runner.js        async process runner (replaces execSync)
src/downloader.js    yt-dlp
src/transcriber.js   ffmpeg audio + Groq Whisper
src/highlightFinder.js  Groq LLM picks moments, validates timestamps
src/clipper.js       one-pass cut + 9:16 crop + caption burn
src/subtitler.js     builds the .ass karaoke captions
frontend/index.html  the UI
frontend/config.js   the one line you edit after deploying
```

## Tuning

Every knob is an environment variable — change it in Back4app and redeploy, no
code edits. See `.env.example` for the full list with explanations.

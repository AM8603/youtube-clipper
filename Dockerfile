# Deploy this to Back4App, Render, Railway, Fly.io, or any Docker host.
# NOT compatible with Cloudflare Workers -- see README for why.
FROM node:20-slim

# ffmpeg is required for cutting clips + burning subtitles.
# yt-dlp is downloaded as a standalone binary below -- no Python needed.
#
# YT_DLP_CACHEBUST: yt-dlp releases fix YouTube-breakage constantly (YouTube
# changes their site often, and yt-dlp has to keep patching around it).
# Without this, Docker caches the curl step forever after the first build,
# silently freezing you on whatever version existed that day. Bump this
# value (any change works, e.g. today's date) whenever you rebuild and want
# a guaranteed-fresh yt-dlp binary.
ARG YT_DLP_CACHEBUST=2026-09-19
RUN apt-get update && apt-get install -y ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p downloads output

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

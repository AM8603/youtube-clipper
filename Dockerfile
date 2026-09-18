# Back4app Containers / Render / Railway / Fly.io compatible image.
FROM node:20-slim

# ffmpeg  -> cutting, reframing, burning subtitles
# fonts-* -> WITHOUT these the burned-in captions render as boxes/blank,
#            because slim images ship with zero fonts.
# yt-dlp_linux -> the SELF-CONTAINED build. The plain "yt-dlp" asset is a
#            Python zipapp and would crash here (no Python in node:20-slim).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-liberation \
      fonts-dejavu-core \
      curl \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
       -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN mkdir -p downloads output && chmod -R 777 downloads output

# Back4app: set the same port under App Settings -> Port.
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# tini reaps zombie ffmpeg/yt-dlp processes so the container doesn't leak PIDs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

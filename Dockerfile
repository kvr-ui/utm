# ── FOCAS lead server ─────────────────────────────────────────────
# Small, production image. The app uses only Node built-ins (global
# fetch), so there are no dependencies to install — Node 18+ is enough.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=7001

# Copy manifests first for better layer caching. If real dependencies
# are ever added, `npm ci` will install them from the lockfile.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source.
COPY . .

# Failed lead forwards are queued here for replay on the next start. The app
# runs as `node`, which can't write to /app, so give it its own directory
# (mount a volume here to keep the queue across redeploys).
ENV DEAD_LETTER_FILE=/app/data/failed-leads.jsonl
RUN mkdir -p /app/data && chown node:node /app/data

# Drop privileges — `node` user exists in the official image.
USER node

EXPOSE 7001

CMD ["node", "index.js"]

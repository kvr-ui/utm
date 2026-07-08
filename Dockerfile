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

# Drop privileges — `node` user exists in the official image.
USER node

EXPOSE 7001

CMD ["node", "index.js"]

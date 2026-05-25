# ─── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ─── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security
RUN addgroup -S canon && adduser -S canon -G canon

WORKDIR /app

# Copy deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server.js ./
COPY public/   ./public/
COPY package.json ./

# Own everything as the non-root user
RUN chown -R canon:canon /app
USER canon

EXPOSE 8847

ENV NODE_ENV=production \
    PORT=8847

CMD ["node", "server.js"]

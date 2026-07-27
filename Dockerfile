# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Builder
# -----------------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

# web/ must be present before `npm run build` — the build script also runs web:build.
COPY web ./web
RUN npm --prefix web install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production
# -----------------------------------------------------------------------------
FROM node:24-slim AS production

WORKDIR /app

# Create non-root user for security
RUN groupadd -r appgroup && useradd -r -g appgroup appuser

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# /app/data is the mounted RWR data root; /app/output holds the generated indexes.
RUN mkdir -p /app/data /app/output && chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/api/server.js"]

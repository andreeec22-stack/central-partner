# syntax=docker/dockerfile:1
# API image. Build from the repo root:
#   docker build -f apps/api/Dockerfile -t central-partner-api .
# On start it applies pending migrations (prisma migrate deploy, safe with
# several replicas: Prisma takes an advisory lock), then serves on $PORT.

FROM node:24-alpine AS base
# Prisma's engines need OpenSSL on Alpine (linux-musl-openssl-3.0.x).
RUN apk add --no-cache openssl
WORKDIR /app

# Every workspace manifest, so `npm ci` sees the lockfile as written.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY apps/api/prisma apps/api/prisma

# ── Build: all API dependencies, then TypeScript → dist ──────────────────────
FROM manifests AS build
RUN npm ci --workspace=@central-partner/api --include-workspace-root
COPY apps/api ./apps/api
RUN npm run db:generate -w @central-partner/api && npm run build -w @central-partner/api

# ── Production dependencies only (prisma CLI included, for migrations) ───────
FROM manifests AS prod-deps
RUN npm ci --omit=dev --workspace=@central-partner/api --include-workspace-root \
 && npm run db:generate -w @central-partner/api \
 && mkdir -p apps/api/node_modules \
 && npm cache clean --force

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production \
    PORT=3001 \
    LOCAL_STORAGE_DIR=/app/apps/api/uploads
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
# Local file storage (reports, attachments, logos) when no S3 bucket is set:
# the only writable path, owned by the unprivileged user. Mount a volume here.
RUN mkdir -p /app/apps/api/uploads && chown node:node /app/apps/api/uploads

USER node
WORKDIR /app/apps/api
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

# dumb-init forwards SIGTERM to node, which closes sockets, jobs and the DB pool.
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "/app/node_modules/.bin/prisma migrate deploy && exec node dist/index.js"]

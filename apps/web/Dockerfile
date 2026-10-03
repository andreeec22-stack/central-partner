# syntax=docker/dockerfile:1
# Web image: the built SPA served by nginx, which also proxies /api and
# /socket.io to the API container (same origin: the refresh cookie and the
# websocket need no CORS). Build from the repo root:
#   docker build -f apps/web/Dockerfile -t central-partner-web .

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
RUN npm ci --workspace=@central-partner/web --include-workspace-root
COPY apps/web ./apps/web
# Empty = same origin (through this nginx). Set them only if the API lives on another domain.
ARG VITE_API_URL=""
ARG VITE_SOCKET_URL=""
ENV VITE_API_URL=$VITE_API_URL VITE_SOCKET_URL=$VITE_SOCKET_URL
RUN npm run build -w @central-partner/web

FROM nginx:stable-alpine AS runtime
# The image's entrypoint renders /etc/nginx/templates/nginx.conf.template into
# /etc/nginx/nginx.conf, substituting only these variables (nginx's own
# $host, $uri... stay intact). Railway sets PORT; API_UPSTREAM and
# TRUST_EDGE_PROXY are set on the Railway service (see DEPLOYMENT_RAILWAY.md).
ENV PORT=80 \
    API_UPSTREAM=api:3001 \
    TRUST_EDGE_PROXY=false \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx \
    NGINX_ENVSUBST_FILTER="^(PORT|API_UPSTREAM)$"
COPY apps/web/nginx.conf.template /etc/nginx/templates/nginx.conf.template
COPY --chmod=755 apps/web/15-runtime-conf.sh /docker-entrypoint.d/15-runtime-conf.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["nginx", "-g", "daemon off;"]

# syntax=docker/dockerfile:1
#
# EXPERIMENTAL: the remote read-only MCP server (`dexe-mcp serve-http`).
# Runbook: docs/REMOTE.md. The stdio server (`npx dexe-mcp`) does not need this.
#
#   docker build -t dexe-mcp-read .
#   docker run --rm -p 127.0.0.1:8080:8080 \
#     -e DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com dexe-mcp-read

# ── build: compile TypeScript ───────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Only devDependencies carry install scripts (esbuild, for the plugin bundle),
# and tsc needs none of them.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── deps: production node_modules only ──────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DEXE_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The handshake reports the version from package.json.
COPY package.json ./
# The image's built-in unprivileged user. serve-http writes nothing to disk.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js", "serve-http"]

# syntax=docker/dockerfile:1
#
# EXPERIMENTAL: the remote read-only MCP server (`dexe-mcp serve-http`).
# Runbook: docs/REMOTE.md. The stdio server (`npx dexe-mcp`) does not need this.
#
#   docker build -t dexe-mcp-read .
#   docker run --rm -p 127.0.0.1:8080:8080 \
#     -e DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com \
#     -e DEXE_RPC_URL_MAINNET=… -e DEXE_SUBGRAPH_POOLS_URL=… (see docs/REMOTE.md) \
#     dexe-mcp-read

# node:22-slim, pinned by digest (multi-arch index, resolved 2026-10-12).
# Bump deliberately: docker buildx imagetools inspect node:22-slim
ARG NODE_IMAGE=node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ── build: compile TypeScript ───────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Only devDependencies carry install scripts (esbuild, for the plugin bundle),
# and tsc needs none of them.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── deps: production node_modules only ──────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ── runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# No package manager at runtime: nothing in the image installs or runs packages.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
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

# syntax=docker/dockerfile:1
#
# The read edition's remote server: `dexe-mcp-read serve-http` — every tool
# read-only, MCP Streamable HTTP, stateless. Pre-release until the
# connector-directory submission. Runbook: docs/REMOTE.md. The stdio servers
# (`npx dexe-mcp`, `npx -p @dexe-network/dexe-mcp dexe-mcp-read`) do not need this.
#
#   docker build -t dexe-mcp-read .
#   docker run --rm -p 127.0.0.1:8080:8080 \
#     -e DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com \
#     -e DEXE_RPC_URL_MAINNET=… -e DEXE_SUBGRAPH_POOLS_URL=… (see docs/REMOTE.md) \
#     dexe-mcp-read

# node:22-slim, pinned by digest (multi-arch index, resolved 2026-10-12).
# Bump deliberately: docker buildx imagetools inspect node:22-slim
ARG NODE_IMAGE=node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ── build: compile TypeScript, then bundle the read binary into one file ────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: tsc needs none, and esbuild loads its binary from the
# platform package npm installs (its postinstall only verifies that binary).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts/bundle-read.mjs ./scripts/
# dist/read/bin.js plus its five runtime packages (MCP SDK, ethers, zod,
# multiformats, p-limit) in one ES module. It imports no write module, so the
# write edition's code and dependencies are not in the image at all.
RUN npm run build && node scripts/bundle-read.mjs out/dist/read/bin.js

# ── runtime: node + one file ────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# No package manager at runtime: nothing in the image installs or runs packages.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production \
    PORT=8080 \
    DEXE_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/out/dist ./dist
# The dexe://graph-schema resource; the handshake version (package.json);
# the license that covers the bundled code's notices.
COPY docs/GRAPH.md ./docs/GRAPH.md
COPY package.json LICENSE ./
# The image's built-in unprivileged user. serve-http writes nothing to disk.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/read/bin.js", "serve-http"]

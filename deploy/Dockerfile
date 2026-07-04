# syntax=docker/dockerfile:1
# HellGraph super-peer — multi-stage build.
# NOTE: not built in CI here; validated by the local entrypoint smoke-test. Build with:
#   docker build -f deploy/Dockerfile -t <registry>/hellgraph-superpeer:<tag> .

# ---- build ----
FROM node:20-bookworm AS build
WORKDIR /app
# node-gyp toolchain for the native optional deps (hypercore/sodium-native, rocksdb)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsup.config.ts ./
COPY ts ./ts
RUN npm ci
RUN npm run build
# drop devDependencies (tsup/tsx/typescript) but KEEP prod + optional (hypercore/autobase/…)
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HELLGRAPH_HTTP_PORT=8850 \
    HELLGRAPH_STORAGE_DIR=/var/lib/hellgraph-superpeer
WORKDIR /app
RUN useradd -r -u 10001 -m hellgraph \
  && mkdir -p "$HELLGRAPH_STORAGE_DIR" && chown -R hellgraph "$HELLGRAPH_STORAGE_DIR"
COPY --from=build --chown=hellgraph:hellgraph /app/node_modules ./node_modules
COPY --from=build --chown=hellgraph:hellgraph /app/ts/dist ./ts/dist
COPY --from=build --chown=hellgraph:hellgraph /app/package.json ./package.json
COPY --chown=hellgraph:hellgraph deploy ./deploy
USER hellgraph
EXPOSE 8850
# Container-level liveness (k8s uses the probe in the manifest).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.HELLGRAPH_HTTP_PORT||8850) +'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "deploy/superpeer.mjs"]

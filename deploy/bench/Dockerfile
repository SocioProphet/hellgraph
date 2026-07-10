# syntax=docker/dockerfile:1
# HellGraph distributed-analytics benchmark — the boundary-halo PageRank runtime (dist_boundary).
# ONE image is every pod: HG_ROLE=coordinator | worker selects behaviour at runtime.
# Build (from repo root):
#   docker build -f deploy/bench/Dockerfile -t <registry>/hellgraph-bench:<tag> .

# ---- build ----
FROM rust:1.96-bookworm AS build
WORKDIR /src
# Copy the Rust workspace (all crates are members; the JS side is not needed for this image).
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
# Build both distributed runtimes: dist_boundary (coordinator-relay, the MVP default) and dist_p2p (pure
# peer-to-peer mesh, the >tens-of-nodes path — needs each worker to advertise its pod IP via HG_ADVERTISE,
# e.g. the Downward API POD_IP). Both pull hg_analytics + hg_core.
RUN cargo build --release -p hg_analytics --example dist_boundary --example dist_p2p \
  && cp target/release/examples/dist_boundary /usr/local/bin/dist_boundary \
  && cp target/release/examples/dist_p2p /usr/local/bin/dist_p2p

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
RUN useradd -r -u 10002 -m hg
COPY --from=build /usr/local/bin/dist_boundary /usr/local/bin/dist_boundary
COPY --from=build /usr/local/bin/dist_p2p /usr/local/bin/dist_p2p
USER hg
# Coordinator listens here; workers connect to it. Overridable via HG_LISTEN / HG_COORD.
# Default = the coordinator-relay MVP runtime; swap the k8s command to /usr/local/bin/dist_p2p for the
# peer-to-peer mesh at larger node counts.
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/dist_boundary"]

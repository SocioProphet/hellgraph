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
# Build only the boundary runtime example (pulls hg_analytics + hg_core).
RUN cargo build --release -p hg_analytics --example dist_boundary \
  && cp target/release/examples/dist_boundary /usr/local/bin/dist_boundary

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
RUN useradd -r -u 10002 -m hg
COPY --from=build /usr/local/bin/dist_boundary /usr/local/bin/dist_boundary
USER hg
# Coordinator listens here; workers connect to it. Overridable via HG_LISTEN / HG_COORD.
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/dist_boundary"]

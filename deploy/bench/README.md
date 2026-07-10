# HellGraph distributed-analytics benchmark (boundary-halo PageRank)

The Saturday cluster run. One container image (`dist_boundary`) is every pod; `HG_ROLE` picks coordinator
or worker at runtime. The coordinator generates a Graph500 (Kronecker/RMAT) graph, Fennel edge-cut
partitions it, ships each worker its shard over TCP, and drives a **boundary-only-halo** BSP PageRank —
only ghost values cross the wire each superstep, never the full O(n) vector. The result is verified
against single-graph PageRank (`max|Δ|` printed; expect ~1e-15).

This was proven locally first: `cargo run -p hg_analytics --release --example dist_boundary` runs the
identical code as N processes over loopback (8.6e-16 exact, 6.5× less wire than a full-broadcast BSP).

## What sizes the run

From the local dress rehearsal: **~126 bytes/edge resident**.

| edges | scale (ef=16) | nodes @ 16 GB | nodes @ 32 GB |
|-------|---------------|---------------|---------------|
| ~1B   | 26            | 8             | 4             |
| ~10B  | 29            | ~79           | ~40           |
| ~17B  | 30            | ~135          | ~68           |

Set `HG_SCALE` / `HG_SHARDS` in `k8s/configmap.yaml`. The **MVP proof is scale 26 / 8 shards (~1B edges)**
— that's the default.

## Run it

Prereqs: `kubectl` pointed at the target cluster, push access to `$REGISTRY`. The cluster itself is spun
up and torn down **separately and explicitly** (see below) — `run.sh` only manages the workload, and it
tears the workload down on exit (`spin up → work → TEAR DOWN`).

```bash
# 0. bring up a cluster (explicit, ephemeral — example; tear it down when done)
gcloud container clusters create hg-bench --num-nodes=8 --machine-type=e2-standard-4 --spot

# 1. run the benchmark (build → push → deploy → stream verified result → delete workload)
REGISTRY=us-docker.pkg.dev/PROJECT/hellgraph deploy/bench/run.sh

# 2. TEAR DOWN the cluster (do not leave it running)
gcloud container clusters delete hg-bench --quiet
```

`KEEP=1 ... run.sh` leaves the pods up for inspection (you then clean up by label `app=hg-bench`).

## Files

- `Dockerfile` — multi-stage Rust 1.96 build → slim runtime; one image, both roles.
- `k8s/configmap.yaml` — `HG_SHARDS` / `HG_SCALE` / `HG_EDGEFACTOR` / `HG_ITERS` (single source of truth).
- `k8s/coordinator.yaml` — headless Service (`hg-coordinator:9000`) + coordinator Job.
- `k8s/workers.yaml` — Indexed Job; each pod's `JOB_COMPLETION_INDEX` is its shard ordinal.
- `run.sh` — build/push/apply/stream/teardown; keeps worker fan-out == `HG_SHARDS`.

## Honest scope

- Verifies correctness (vs single-graph PageRank) and measures wire/step + wall time. It is **not** yet a
  head-to-head vs Neptune/TigerGraph on identical hardware — that's the next artifact.
- Coordinator is a single relay for the boundary pool (fine to tens of nodes). A pure peer-to-peer halo
  exchange (workers swap ghost slices directly) removes even that; noted for the >100-node runs.
- Boundary fraction shrinks with scale (measured: edge cut 23% → 15% from scale 14 → 20), so the wire
  advantage grows as the graph grows — the opposite of how a full-broadcast BSP degrades.

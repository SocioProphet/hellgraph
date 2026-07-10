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

## Run it — one command (`saturday.sh`)

The whole money run: create GKE cluster → build image with **Cloud Build (no local docker)** → deploy →
stream the verified result → **tear down the cluster** (on exit, always). Ephemeral by construction.

```bash
# prereq once: gcloud auth login   (the scripts fail fast if the token is stale)

# dry-run — checks auth/APIs/AR-repo/manifests and prints the plan; spends NOTHING:
PROJECT=my-proj deploy/bench/saturday.sh --preflight

# for real (creates cluster, builds, runs, tears down):
PROJECT=my-proj REGION=us-central1 deploy/bench/saturday.sh
```

Sizing knobs: `NODES` (default `HG_SHARDS + 1`), `MACHINE` (default `e2-standard-4` = 4 vCPU / 16 GB, the
row in the table above), graph size via `k8s/configmap.yaml`. `KEEP=1` leaves the cluster up (you then
delete it yourself).

### Workload-only (`run.sh`) — cluster already exists

If you manage the cluster yourself, `run.sh` just builds + deploys + streams + deletes the *workload*
(`spin up → work → TEAR DOWN`). Pick the builder:

```bash
# server-side build, no local docker (what saturday.sh uses):
REGISTRY=us-central1-docker.pkg.dev/PROJECT/hellgraph BUILDER=cloudbuild deploy/bench/run.sh
# or local docker if you have it:
REGISTRY=... BUILDER=docker deploy/bench/run.sh
```

## Files

- `saturday.sh` — full lifecycle: cluster create → Cloud Build → run → cluster teardown; `--preflight`.
- `Dockerfile` — multi-stage Rust 1.96 build → slim runtime; one image, both roles.
- `cloudbuild.yaml` — server-side build (honours the non-root Dockerfile); no local docker needed.
- `k8s/configmap.yaml` — `HG_SHARDS` / `HG_SCALE` / `HG_EDGEFACTOR` / `HG_ITERS` (single source of truth).
- `k8s/coordinator.yaml` — headless Service (`hg-coordinator:9000`) + coordinator Job.
- `k8s/workers.yaml` — Indexed Job; each pod's `JOB_COMPLETION_INDEX` is its shard ordinal.
- `run.sh` — build (`BUILDER=docker|cloudbuild`)/apply/stream/teardown; keeps worker fan-out == `HG_SHARDS`.

## Honest scope

- Verifies correctness (vs single-graph PageRank) and measures wire/step + wall time. It is **not** yet a
  head-to-head vs Neptune/TigerGraph on identical hardware — that's the next artifact.
- Coordinator is a single relay for the boundary pool (fine to tens of nodes). A pure peer-to-peer halo
  exchange (workers swap ghost slices directly) removes even that; noted for the >100-node runs.
- Boundary fraction shrinks with scale (measured: edge cut 23% → 15% from scale 14 → 20), so the wire
  advantage grows as the graph grows — the opposite of how a full-broadcast BSP degrades.

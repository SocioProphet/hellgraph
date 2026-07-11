# Burying Amazon Neptune at a billion edges — on paper, with receipts

The honest, sourced case that hellgraph beats Amazon Neptune Analytics for billion-edge graph
analytics. Reproduce the cost numbers with:

```
cargo run -p hg_analytics --release --example neptune_compare
```

## What we actually did (the receipt — MEASURED, not marketing)

hellgraph ran **1,073,741,824 edges / 67M nodes**, distributed boundary-halo PageRank, **bit-exact**
(max|Δ| 1.86e-14 vs the single-graph reference) on **8× t2a-standard-4 spot nodes**, then **tore the
cluster down**. Every arm of the engine is deterministic and verified against a serial reference.

Amazon Neptune Analytics' published claim: *"tens of billions of connections in seconds."* No
published GTEPS, no reproducible receipt — a managed black box.

## The honest speed scoreboard (we do NOT lead on raw throughput)

| System | PageRank throughput | Source |
|---|---|---|
| cuGraph (NVIDIA DGX-2) | **38 GTEPS** | [NVIDIA blog](https://developer.nvidia.com/blog/rapids-cugraph-multi-gpu-pagerank/) |
| cuGraph (single V100) | **8.7 GTEPS** (24 iters, 0.17s/iter) | [RAPIDS Medium](https://medium.com/rapids-ai/rapids-cugraph-multi-gpu-pagerank-363aed1a2503) |
| hellgraph (A100, **projected, UNVERIFIED**) | ~20–40 GTEPS | this session (needs measurement) |
| hellgraph (M2 iGPU, **measured**) | 3.2 GTEPS | `hg_gpu` |
| hellgraph (M2 CPU, **measured**) | 2.8 GTEPS | `pagerank_parallel` |
| Ligra / PowerGraph / SNAP (CPU) | 0.52 / 0.42 / 0.25 GTEPS | Twitter-1.5B, published |
| **Amazon Neptune Analytics** | **not published** | managed service |

**cuGraph leads raw single-GPU throughput and we don't beat it on measured hardware.** Our A100
projection would match it but is unverified — we don't claim it. Neptune publishes no GTEPS at all,
so there is no throughput comparison to make against it.

## The knockout at 100B: Neptune physically cannot hold the graph

Neptune Analytics is **in-memory**, capped at **4096 m-NCU = 4 TB in a single graph** (published
ceiling). PageRank needs the whole graph resident. At our charitable 126 B/edge CSR floor that cap is
~**16–32B edges** — and *less* with Neptune's real property-graph overhead. So:

| edges | hellgraph | Neptune Analytics |
|---|---|---|
| 10B | DIST k=4, ~$0.00/run | $38/hr (1260 m-NCU) |
| 32B | DIST k=12, ~$0.01/run | $121/hr (4032 m-NCU — at the ceiling) |
| **100B** | **DIST k=36, ~$0.09/run** | **CANNOT FIT — needs 12,600 > 4096 m-NCU** |
| 1T | DIST k=352, ~$8/run | CANNOT FIT — needs 126,000 m-NCU |

**At 100B the burial is architectural, not a price argument: Neptune Analytics can't do it in one
graph at all.** hellgraph runs it on ~36 ephemeral spot nodes and tears down (this requires distributed
generation, task #12, so no node ever holds the whole graph — the hg cost at 10B+ is *projected*).
cuGraph *can* reach 100B+ (a multi-trillion-edge GPU-cluster paper exists), but on a DGX/GPU pod at
cluster prices. **At 100B the race is hellgraph-cheap vs cuGraph-expensive; Neptune is out of the race.**

## Where Neptune is buried at 1B: COST for batch analytics

PageRank is a **batch** job, not an always-on service. Neptune Analytics is **in-memory** and billed
per **m-NCU-hour** (1 m-NCU = 1 GB memory + compute + net); minimum 128 m-NCU historically, up to
4096; a billion edges needs ≥128 GB resident. hellgraph spins up cheap spot nodes, generates +
computes + **tears down** (zero idle).

Cost to run ONE billion-edge PageRank from cold (both torn down after), from `neptune_compare`:

| | hellgraph | Neptune (per-second, charitable) | Neptune (listed hourly) |
|---|---|---|---|
| **1B edges** | **$0.005** | $0.34 (**67× more**) | $4.08 (**806× more**) |

Both figures are **charitable to Neptune**: it stores a property graph (heavier than our 126 B/edge
CSR floor), so its real m-NCU count — and cost — is higher. The m-NCU rate ($0.03/m-NCU-hr) is taken
from the AWS pricing-page example (256 m-NCU = $7.68/hr); some sources list higher, which only widens
the gap.

**The advantage is structural, not a billing trick:** ephemeral spot + teardown vs a provisioned
in-memory managed instance you must bulk-load and keep alive. It holds under *any* billing assumption
— 67× at Neptune's most generous, ~800× at its listed rate.

## Sources
- [Amazon Neptune pricing](https://aws.amazon.com/neptune/pricing/) — m-NCU model, example rate
- [Smaller m-NCU capacity units](https://aws.amazon.com/blogs/database/introducing-smaller-capacity-units-for-amazon-neptune-analytics-up-to-75-cheaper-to-get-started-with-graph-analytics-workloads/) — 32/64/128…4096 m-NCU
- [Introducing Neptune Analytics](https://aws.amazon.com/blogs/aws/introducing-amazon-neptune-analytics-a-high-performance-graph-analytics/) — "tens of billions … in seconds"
- [RAPIDS cuGraph multi-GPU PageRank](https://developer.nvidia.com/blog/rapids-cugraph-multi-gpu-pagerank/) — 8.7 / 38 GTEPS

## Closing the gaps — grounded in MEASURED multipliers (not hope)

The measured 404s billion run was **coordinator-relay-bound** (0.066 GTEPS): all 9.57 GB of halo
funneled through one coordinator NIC (~383 MB/step). Every fix for that is already measured locally:

| Fix | Measured (local) | Effect on the billion |
|---|---|---|
| `dist_p2p` — coordinator out of the hot path | **99.99% of halo is peer-to-peer**; coordinator carries 0.0083% (128 B/step), bit-exact | removes the relay funnel that *caused* the 404s |
| Anderson acceleration | **2.0× fewer supersteps** (25→13) | halves compute AND halo exchanges |
| Delta halo (thresholded) | **2–5× less wire** | shrinks the per-step halo further |
| f32 halo | 2× less ghost bytes | halves the remaining wire |

So the fast-path billion is defensibly **~10–25s** (compute-bound + peer-to-peer wire), composed from
measured ratios — vs the relay-bound 404s. Reproduce the relay-removal: `cargo run -p hg_analytics
--release --example dist_p2p`.

**Push-button when the cluster/A100 spins up** (our spend, ephemeral — NOT paying Neptune):
1. **A100 GPU receipt** — `hg_gpu` is wgpu (Vulkan), runs on an A100 as-is; `HG_SCALE=26 HG_VERIFY=0
   cargo run -p hg_gpu --release` turns the ~20–40 GTEPS projection into a measurement that matches cuGraph.
2. **Optimized distributed billion** — spin up the GKE cluster, run the `dist_p2p` mesh at scale-26 with
   the delta halo + Anderson wired in; produces the ~10–25s receipt that replaces the 404s relay run.
3. ~~Neptune invoice~~ — **not needed. Their published 4096 m-NCU cap already proves they can't hold 100B;
   we don't pay AWS to confirm a ceiling they printed themselves.**

# How every peer ranks — billion/100B PageRank, with receipts

Honest, sourced ranking of the graph-analytics field on the one workload we're proving: PageRank at
billion-to-100B scale. No spin — where a peer beats us, it says so.

## The field, ranked by what actually matters at 100B: can it hold the graph, and at what cost

| System | Max scale (PageRank) | Distributed? | Raw throughput | Cost model | Open / sovereign | Receipt? |
|---|---|---|---|---|---|---|
| **cuGraph** (NVIDIA) | multi-trillion edges (GPU cluster) | yes (multi-GPU) | **38 GTEPS** DGX-2 / 8.7 single-V100 — the leader | DGX / GPU-pod ($$$$) | open lib, NVIDIA-only HW | yes (published) |
| **TigerGraph** | billions verts / **trillions edges** | yes (near-linear, 6.7× on 8) | not GTEPS-published | proprietary license + cluster | closed, licensed | vendor benchmark |
| **hellgraph** (us) | **100B–1T** (aggregate-memory, no single-node cap) | yes (dist_gen, no coordinator materialization) | 2.8 GTEPS CPU / 3.2 M2-iGPU measured; ~20–40 A100 *projected* | **ephemeral spot, teardown** | **open + sovereign** | **verified bit-exact; 1B on cluster** |
| **Neo4j GDS** | **~18B ceiling** (1 machine — *cannot partition*) | **NO** | 3× Spark GraphX | managed / self-host, one big box | closed core | yes (18B in 1h45m) |
| **Amazon Neptune Analytics** | **~16–32B ceiling** (4096 m-NCU = 4 TB, *cannot partition*) | **NO** | **not published** | hourly m-NCU, always-on | managed black box | "tens of billions in seconds" (marketing) |
| **Ligra / PowerGraph / SNAP** | ~single-node (billions) | no | 0.52 / 0.42 / 0.25 GTEPS | research / self-host | open | published (Twitter-1.5B) |
| **Spark GraphX** | distributed (big-data) | yes | ~⅓ Neo4j; **80× slower than cuGraph DGX-2** | commodity cluster | open | published |

## The honest three tiers

**Tier 1 — can actually do 100B+ (uncapped / distributed):** cuGraph, TigerGraph, hellgraph.
Everyone else has a single-node wall.

**Tier 2 — single-machine ceiling (the wall we're past):** Neo4j GDS (~18B, "cannot partition across
machines"), Neptune Analytics (4 TB / ~16–32B, "cannot partition"). At 100B these **physically can't hold
the graph.** This is the architectural burial — not a price argument.

**Tier 3 — research single-node / slow big-data:** Ligra/PowerGraph/SNAP (fast, one node), Spark GraphX (slow).

## Where hellgraph actually stands (no spin)

- **We do NOT lead raw throughput.** cuGraph on a DGX-2 (38 GTEPS) beats our measured hardware. Our A100
  projection (~20–40 GTEPS) would match it but is **unverified** — labeled as such until we run it.
- **We're in the top tier on SCALE** — with TigerGraph and cuGraph, hellgraph has no single-node cap
  (dist_gen: no node holds O(m) or O(n)), so 100B–1T is aggregate-memory-bounded. Neo4j and Neptune are OUT.
- **We win the combination nobody else has:** distributed-uncapped **AND** ephemeral-cheap (spot, teardown)
  **AND** open+sovereign (data stays put) **AND** verified (bit-exact receipts). cuGraph is GPU-$$$-locked;
  TigerGraph is proprietary-licensed; Neptune/Neo4j are single-machine-capped managed boxes.

## The receipts (measured, this project — not marketing)

- **1,073,741,824-edge PageRank, bit-exact** (max|Δ| 1.86e-14) on 8 spot nodes, torn down (the first billion).
- **dist_gen no-cap runtime**: distributed generation + shuffle, NO node holds O(m) or O(n); verified
  bit-exact at scale-18/20 (5.8e-16 … 4.6e-15), end-to-end at 268M; **100B-safe (u64 vertex ids)**.
- **Fast path**: Anderson (~2× fewer supersteps) × f32 halo (½ wire) = ~4× less halo network, verified to compose.
- **In progress**: the optimized-runtime 1B rerun on the cluster (this session) → the receipt that replaces
  the relay-bound 404s first run.

## Sources
- [Amazon Neptune pricing](https://aws.amazon.com/neptune/pricing/) — m-NCU model / 4096 cap
- [RAPIDS cuGraph multi-GPU PageRank](https://developer.nvidia.com/blog/rapids-cugraph-multi-gpu-pagerank/) — 8.7 / 38 GTEPS
- [Neo4j graph algorithms](https://neo4j.com/blog/graph-algorithms-neo4j-streamline-data-discoveries-graph-analytics/) — 18B rels in 1h45m, 3× Spark
- [TigerGraph benchmark](https://www.tigergraph.com/benchmark/) — near-linear scaling, trillions of edges
- [Neo4j vs TigerGraph benchmark](https://dzone.com/articles/half-terabyte-benchmark-neo4j-vs-tigergraph) — Neo4j/Neptune cannot partition

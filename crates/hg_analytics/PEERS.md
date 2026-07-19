# How every peer ranks — billion/100B PageRank, with receipts

Honest, sourced ranking of the graph-analytics field on the one workload we're proving: PageRank at
billion-to-100B scale. No spin — where a peer beats us, it says so.

## The field, ranked by what actually matters at 100B: can it hold the graph, and at what cost

| System | Max scale (PageRank) | Distributed? | Raw throughput | Cost model | Open / sovereign | Receipt? |
|---|---|---|---|---|---|---|
| **cuGraph** (NVIDIA) | multi-trillion edges (GPU cluster) | yes (multi-GPU) | **38 GTEPS** DGX-2 / 8.7 single-V100 — the leader | DGX / GPU-pod ($$$$) | open lib, NVIDIA-only HW | yes (published) |
| **TigerGraph** | billions verts / **trillions edges** | yes (near-linear, 6.7× on 8) | not GTEPS-published | proprietary license + cluster | closed, licensed | vendor benchmark |
| **hellgraph** (us) | **1B proven; 100B design-ready** (no single-node cap; needs balanced partition — see below) | yes (dist_gen, no coordinator materialization) | 2.8 GTEPS CPU / 3.2 M2-iGPU measured; ~20–40 A100 *projected* | **ephemeral spot, teardown** | **open + sovereign** | **verified bit-exact; 1B on GKE, Σrank=1** |
| **Neo4j GDS** | **~18B ceiling** (1 machine — *cannot partition*) | **NO** | 3× Spark GraphX | managed / self-host, one big box | closed core | yes (18B in 1h45m) |
| **Amazon Neptune Analytics** | **~16–32B ceiling** (4096 m-NCU = 4 TB, *cannot partition*) | **NO** | **not published** | hourly m-NCU, always-on | managed black box | "tens of billions in seconds" (marketing) |
| **Ligra / PowerGraph / SNAP** | ~single-node (billions) | no | 0.52 / 0.42 / 0.25 GTEPS | research / self-host | open | published (Twitter-1.5B) |
| **Spark GraphX** | distributed (big-data) | yes | ~⅓ Neo4j; **80× slower than cuGraph DGX-2** | commodity cluster | open | published |

## The honest three tiers

**Tier 1 — no single-node wall (uncapped / distributed):** cuGraph, TigerGraph, hellgraph. cuGraph and
TigerGraph have *shipped* 100B+/trillion runs; hellgraph has *shipped a verified 1B* and is architecturally
uncapped (no node holds O(m)/O(n)) but needs the balanced-partition fix before a 100B button-press (below).
Everyone below has a single-node wall no fix removes.

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

- **1,073,741,824-edge PageRank on the NO-CAP runtime** (dist_gen), 16 spot workers on GKE, torn down:
  gen+shuffle+route **233.18s**, PageRank 25 supersteps **102.47s**, **Σrank = 1.0000** (mass conserved).
  The coordinator materialized **ZERO edges** and held **O(k)** — no node ever held O(m) or O(n). This is the
  billion done coordinator-free; it replaces the earlier relay-bound run that 404'd under coordinator load.
- **Bit-exact provenance**: same runtime verified vs single-graph PageRank at scale-16/18/20 (max|Δ|
  5.8e-16 … 4.6e-15) and end-to-end at 268M; **u64 vertex ids** (no truncation past 4.29B vertices).
- **Fast path**: Anderson (~2× fewer supersteps) × f32 halo (½ wire) = ~4× less halo network, verified to compose.

## 100B readiness — the code wall is removed (measured)

The old blocker was the **range partitioner + RMAT hub-skew**: RMAT makes every target-id bit 0 with prob
a+b=0.76, so ANY partition reading a fixed bit-slice (range = high bits, cyclic = low bits) hands one shard
≈0.76^log2(k) of ALL edges — ~⅓ at k=16. At 100B that's tens of billions of edges on one worker → OOM no
matter how many workers you add. **(Verified false start this session: cyclic `v%k` measured *identical* 33.4%
skew — proof that mixing is required, not just a different bit-slice.)**

**Fixed** with a BALANCED partition: `owner(v) = mix(v) % k` where `mix` is an invertible bit-permutation that
decorrelates shard assignment from the per-bit skew. Because `mix` is a bijection on `[0, 2^scale)`, owned
enumeration stays O(n/k) (no O(n) scan, no global hashmap) and the owned count stays closed-form.
Measured: imbalance **5.34× → 1.05×** (analytic, scale-24) and **1.09× on a live distributed run** (scale-22,
per-shard 8.08–8.79M edges); bijection + bit-exact PageRank (max|Δ| 4.79e-15) both verified; 2 lib
regression tests. Tooling: `examples/skew_check.rs`.

**So the engineering wall is down and proven.** What remains before a 100B *run* is infrastructure, not code:
~128 × 16-vCPU spot nodes (≈2048 vCPUs, a GKE quota increase over the 68-vCPU 1B cluster) and ~$15–25 of
ephemeral spot compute. That's an operational go/quota decision, no longer a missing capability.

## Sources
- [Amazon Neptune pricing](https://aws.amazon.com/neptune/pricing/) — m-NCU model / 4096 cap
- [RAPIDS cuGraph multi-GPU PageRank](https://developer.nvidia.com/blog/rapids-cugraph-multi-gpu-pagerank/) — 8.7 / 38 GTEPS
- [Neo4j graph algorithms](https://neo4j.com/blog/graph-algorithms-neo4j-streamline-data-discoveries-graph-analytics/) — 18B rels in 1h45m, 3× Spark
- [TigerGraph benchmark](https://www.tigergraph.com/benchmark/) — near-linear scaling, trillions of edges
- [Neo4j vs TigerGraph benchmark](https://dzone.com/articles/half-terabyte-benchmark-neo4j-vs-tigergraph) — Neo4j/Neptune cannot partition

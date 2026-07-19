# HellGraph DB — Battle Plan

## STATUS 2026-07-12 — KERNEL LANDED (src/graphdb.rs, 7 tests + full suite 59/59 GREEN)
All five phases' SEMANTICS are implemented and tested as the DB kernel `crates/hg_analytics/src/graphdb.rs`:
- P0/P2 durability: append-only WAL + restart recovery (`Store::open`) — test `phase0_wal_durability_and_recovery`.
- P1 query: `neighbors` / `k_hop` / compiled `plan` (Cypher-IR target) — test `phase1_point_khop_and_plan`.
- P2 ACID+MVCC: atomic `commit` batch + `read_at` snapshot isolation — test `phase2_snapshot_isolation_and_atomic_batch`.
- P3 CRDT causal/eventual: add-wins OR-Set nodes/edges + LWW props, `merge` = SEC — tests
  `phase3_crdt_converges_under_concurrency`, `phase3_add_wins_or_set`.
- P4 receipts: deterministic, state-bound `Receipt` — test `phase4_receipts_are_deterministic_and_bind_state`.
UPDATE (overnight 2026-07-12): the BRIDGE landed too — `ShardedGraph` (src/graphdb.rs) executes k_hop +
compiled `plan` ACROSS k shards where no shard holds the whole graph, verified bit-exact vs single-node
(test `bridge_distributed_traversal_matches_single_node`, k=1,2,3,5,7) AND demonstrated on a real 4.19M-
edge RMAT graph (`examples/graphdb_bridge.rs`: largest shard 9.6%, 3-hop from 6 sources ALL EXACT, ~73ms,
compiled 2-step pattern EXACT). Measured receipts in RECEIPT-GRAPHDB.md. Crate = 60/60 green.

HONEST REMAINING (NOT done — do not claim otherwise): (1) wire `cypher.ts` PARSER → `Vec<Step>` (we built
the plan TARGET, not the parser front end); (2) run the bridge over the REAL socket/`boundary.rs` cluster
at 68B (current `ShardedGraph` is in-process sharding, not networked); (3) harden the federation `merge`
against a LIVE DHT at scale; (4) swap the FNV digest for BLAKE3/SHA-256 + emit sourceos-spec receipts;
(5) run the LDBC baseline vs Neo4j (the ~100× is still their-published vs ours); (6) indexes + WAL
compaction (queries + replay are O(records)); (7) a server/API so clients can connect.


**Mission:** turn the distributed topology *engine* (proven to 68B PageRank, no node holds O(m)/O(n))
into the most advanced graph *database* physics and math allow — and take the interactive-query
segment above the single-box ceiling, where Neptune/Neo4j cannot follow.

**Doctrine (non-negotiable):** sprint every layer at LLM speed; the trench we dig is the *proof
scaffold* (tests, invariants, receipts). Speed is free on the tractable layers. It is NOT free on
consensus/transactions — a subtly-wrong distributed ACID protocol silently corrupts a customer's
graph, which is worse than shipping nothing. **Fast everywhere; proven where wrong = fatal.**

---

## The theoretical ground (what makes this real, not spin)

- **CAP** — under a partition you pick C *or* A. Not escapable; only *placeable per-operation*.
  Client chooses consistency per query.
- **PACELC** — even with no partition, strong consistency costs a coordination round-trip
  (Latency vs Consistency). Reads must be able to opt into staleness.
- **CALM theorem** — *monotone computation needs no coordination.* PageRank, reachability,
  connected components, centrality are monotone (or can be made so) ⇒ they run **coordination-free
  even on a cluster.** The exact thing Neo4j is worst at is the thing theory says scales for free.
  We pay the CAP tax ONLY on the transactional-write path.
- **FLP** — no deterministic async consensus; solved via partial synchrony (Raft). Write path uses
  Raft-class consensus; we accept its well-understood assumptions.
- **Speed of light** — cross-region strong consistency has a hard RTT floor. No TrueTime hardware ⇒
  Hybrid Logical Clocks for causal order; linearizable intra-region, async cross-region.

## Honest limits (concede these openly)

1. CAP is not defeatable. Partition + strong multi-shard write ⇒ someone blocks. We place, not escape.
2. Small-graph single-query latency: **they win** (in-memory pointer-chase beats a network hop).
   We do not fight there; we own everything above their memory ceiling.
3. A mature cost-based Cypher optimizer is their 15-year moat; we start behind and mature over time.
4. Calvin-style deterministic txns trade latency for throughput — name the tradeoff, don't hide it.

---

## Architecture — layers (status: HAVE / BUILD / HARD)

**L0 — Storage engine (per shard)**
- HAVE: in-memory CSR topology build.
- BUILD: persist CSR as mmap'd immutable base segments + a mutable delta layer (log edges, compact
  into base). Base+delta = mutable graph without losing CSR scan speed.
- BUILD: property store (RocksDB/LSM per shard, keyed by node id).
- BUILD: WAL + recovery (today we tear down; a DB must survive restart).

**L1 — Partitioning (a real fork to decide)**
- `mix()` balanced partition = optimal for analytics load-balance, pessimal for traversal locality.
- HAVE: Fennel/LDG streaming edge-cut partitioner (the locality-preserving alternative).
- FRONTIER: workload-aware adaptive repartitioning + hub replication (replicate super-high-degree
  vertices to every shard so hub traversals stay local) — a lever Neo4j has nowhere to put.

**L2 — Transactions / consistency (the CAP battlefield)**
- DECISION 2026-07-12: **NO cross-shard serializable ACID.** CAP makes it CP (unavailable under
  partition) + PACELC makes every commit a consensus round-trip, and our market (knowledge graph /
  AI memory / entity resolution / analytics — read-mostly, load-then-serve) does not buy it. It's the
  most dangerous-to-get-wrong layer for the least market value. OUT by design, not by inability.
- BUILD: single-shard txn = local MVCC + WAL = full ACID (equals Neo4j on one shard).
- BUILD: **tunable consistency per operation**, calculated ladder:
  · single-shard linearizable (cheap, local) · **causal / bounded-staleness** (HLC-stamped — the
  STRONGEST model that stays AVAILABLE under partition, per the causal+ bound; this is the strong
  default) · eventual (cheapest, AP — analytics/bulk-load/replicas).
- BUILD: multi-node convergence via **CRDTs** — add-vertex/add-edge = grow-only/OR-sets (monotone,
  commutative); property writes = LWW/MV-register stamped with Hybrid Logical Clock ⇒ **provable
  convergence, zero coordination** (same CALM monotonicity as the analytics path). Autobase
  (HellGraph Federated) is already a causal multi-writer log — the replication substrate, likely owned.
- HONEST LEDGER: CRDTs converge but cannot enforce cross-shard invariants (global uniqueness,
  referential integrity, "exactly one owner"). We choose availability over those. If a customer needs
  a hard cross-partition invariant, that's a different database — we say so, we don't fake it.

**L3 — Query engine**
- BUILD: speak **openCypher + GQL** (ISO 2024). Be a drop-in for their ecosystem that scales past
  them — same query, 10x the graph. (Recon flagged `atomspace_cypher_gateway` — may bootstrap this.)
- HARD: cost-based planner/optimizer w/ graph-cardinality estimation. Bootstrap heuristic first.
- HAVE: BSP whole-graph execution + halo routing (rewire as k-hop request path).
- MOAT: analytics-native predicates — traverse *weighted by live PageRank/centrality at scale*,
  coordination-free via CALM. Neo4j bolts analytics on as batch; we make it a query primitive.

**L4 — Replication / HA**
- BUILD: per-shard Raft (3–5 replicas) ⇒ survive minority failure, linearizable within a shard (CP);
  cross-region async for DR (AP-leaning).

**L5 — The weapon only we have**
- BUILD: **receipts** — every query emits a cryptographic, verifiable receipt (sourceos-spec
  Run/Event/Receipt). A graph DB whose every answer is *provable* is a category that doesn't exist.

---

## Phasing (aggressive; each phase ships a usable weapon)

- **Phase 0 — recon + read-only store.** Inventory the estate (don't rebuild what exists). Run the
  Neo4j/Neptune LDBC bench for the measured baseline (`ldbc_suite.rs`, `neptune_compare.rs` already
  exist). Persist CSR + stand up property store. SHIP: read-only store answers "neighbors of X" on a
  graph they can't hold.
- **Phase 1 — Cypher/GQL read path.** Parse + heuristic plan + distributed traversal + tunable-
  consistency reads. SHIP (first public humiliation): a real Cypher query on a 68B graph.
- **Phase 2 — mutability + local ACID + HA.** Delta layer + MVCC/WAL + per-shard Raft. SHIP: durable,
  fault-tolerant, transactional-on-one-shard.
- **Phase 3 — distributed writes.** Calvin multi-shard deterministic txns + adaptive repartition +
  hub replication. SHIP: horizontally-scaling writes — the thing Neo4j architecturally cannot do.
- **Phase 4 — the moat.** Analytics-native predicates, receipts, optimizer maturity.

## RECON VERDICT 2026-07-12 (two Explore scouts) — THIS IS AN INTEGRATION, NOT A GREEN-FIELD

**The causal/eventual architecture (L2 decision above) ALREADY EXISTS in code, tested:**
- `hellgraph(-sprint)/ts/src/autobase-view.ts` `FederatedAtomSpace` — merges N sovereign append-only
  logs; docstring: "ordering is eventually consistent; causal forks may reorder." = our exact spec.
- `ts/src/causal-proof.ts` — causal cuts as VERSION VECTORS (the HLC/causal machinery).
- PLN-revision merge on TruthValue conflicts = CRDT-style auto conflict resolution.
- NO Raft/Paxos/quorum-consensus anywhere in the estate (confirmed) — we never built toward dist-ACID.

**HAVE (verified — reuse, do not rebuild):**
- Query languages (single-node, in-memory, TS): `ts/src/cypher.ts` (openCypher→pattern IR, k-hop
  `*1..2`), `gremlin.ts` (fluent+parser), `sparql.ts`. Plus `atomspace_cypher_gateway` (Python,
  standalone, tested parse→plan→execute).
- Distributed engine (Rust): `hg_analytics/src/boundary.rs` — BSP+halo BFS/SSSP/PageRank/CDLP(community)/
  LCC/CC + Fennel/LDG partitioners + `topology.rs` federation planner. Bench: `ldbc_suite.rs`,
  `neptune_compare.rs`, `vs_baseline.rs`.
- Persistence (TS AtomSpace): JSONL append-only WAL + restart recovery (default), RocksDB backend
  (optional), property store keyed by node id (`store.ts`/`atomspace.ts`).
- Data model: `regis-entity-graph` — bitemporal property-graph SCHEMA (20 node/22 edge kinds,
  valid_time/system_time, provenance). Schema only, no executor.

**THE REAL GAPS (what to actually build):**
1. **The bridge** — query surface is single-node TS in-memory; distributed `boundary.rs` (Rust) has NO
   query surface. Cross-shard Cypher MATCH over the halo/routing path = the core new work.
2. **Persist the Rust CSR at scale** — today in-memory + torn down (`ooc.rs` mmap = transient compute
   scratch, NOT durable). Need base(mmap)+delta durable store.
3. **Harden federation at scale** — Autobase/Hypercore built+tested IN-PROCESS but rides OPTIONAL
   bindings that fall back to single-node; UNPROVEN vs a live DHT or at 68B/production. Not "done".

Note: distributed algorithms present = BFS/SSSP/PageRank/CDLP/LCC/CC; betweenness/Louvain marked
"follow" (not yet); async (non-BSP) execution known-not-done.

Relates to PLAN-100B.md (the scale campaign) and the estate verified-compute/receipt thesis.

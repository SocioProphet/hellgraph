# HellGraph Federated Sovereign Model v0.1

## Purpose

Specify the "managed HellGraph" offering as a **federation of sovereign, local-first
append-only logs** — not a central authority. Enterprise/collaborative clients get a shared
knowledge substrate while every participant retains local data sovereignty.

This spec supersedes any "central Neptune-style cluster" framing. The central store is a
**derived, rebuildable view** (a super-peer index) over the participants' logs, never a
source of truth.

## Positioning

- HellGraph stays **local-first**. Each participant is the sole writer of their own log.
- The shared store is a **causal linearization** of participants' logs, materialized on
  demand and rebuildable from the logs alone.
- Consistency is **causal / eventually consistent**, not globally coordinated. A global
  consensus layer is rejected: it would require an authority and therefore violate
  sovereignty. See "Consistency model" below.

## Conformance targets

Two external models are canonical. We conform to them; we do not fork or approximate them.

- **Distributed AtomSpace (DAS)** — the AtomSpace, the query API (MeTTa-integrated), and the
  pluggable Atom-DB backend abstraction. HellGraph's AtomSpace is already OpenCog-compatible;
  DAS is the distributed query/storage contract it presents.
- **Hypercore / Autobase / Hyperbee** (Holepunch) — the sovereign P2P substrate: signed
  append-only logs (Hypercore), multi-writer causal linearization (Autobase), indexed views
  (Hyperbee).

## Primitive mapping

HellGraph already owns the hard primitives; federation is a substrate swap, not a rewrite.

| HellGraph primitive (today)        | Federated equivalent                    | Note |
|------------------------------------|-----------------------------------------|------|
| Append-only **journal**            | a **Hypercore** (signed, per-participant)| the journal already *is* an append-only log |
| **Deterministic replay**           | **Autobase** view materialization        | replay is how a merged view is built from op-logs |
| Checkpoint                         | **Hyperbee** indexed-view snapshot       | |
| AtomSpace (OpenCog-compatible)     | **DAS** AtomSpace                        | already aligned |
| RocksDB backend                    | Hyperbee / **DAS Atom-DB backend**       | swap the local WAL for a hypercore-backed view |
| `StorageNodeClient` (SSE push/pull)| **Hypercore replication** (`pipe`)       | **RETIRE** — client→server pull makes the server an authority |

## Participant (the sovereign node)

- Owns one (or more) **Hypercore(s)**: an append-only, cryptographically signed log of
  AtomSpace mutations and valuations. The keypair is the participant's identity and write
  authority.
- Runs a local HellGraph kernel + AtomSpace. Its own log is authoritative for its own atoms.
- Holds **reference views** of peers' logs (read-only, verified by signature). It cannot
  write to a peer's log; it can only observe and index.
- Data never leaves the participant except as signed log blocks it chose to replicate.

## Super-peer (the "managed service")

A super-peer is **just another peer with more uptime and an index** — never a data owner:

- **Discovery / relay** — DHT + hole-punching so sovereign nodes find each other and
  replicate directly where possible.
- **Always-on Autobase indexer** — materializes the shared causal view (the merged
  AtomSpace). This is the "central store," but it is a derived, rebuildable Hyperbee view,
  not a source of truth. Loss of a super-peer loses no data.
- **DAS query endpoint** — MeTTa pattern-matching over the materialized view.
- **Hosted replicas (optional)** — availability for offline participants; holds only signed
  data it cannot forge or rewrite.

Sovereignty invariant: the super-peer can index and serve, never author or mutate a
participant's atoms. Every atom in the shared view traces to a signature on some
participant's Hypercore.

## Consistency model

- **Per-writer single-writer.** Each Hypercore has exactly one writer; its log is linear
  (local time). No intra-log coordination needed.
- **Cross-writer causal merge.** Autobase linearizes all writers into a causal DAG: nodes
  reference their predecessors, ordering is eventually consistent, causal forks may reorder
  previously-ordered ops as new information arrives.
- **No global clock, no quorum.** This is the "time" model: locally linear, globally
  frame-relative. It is the only model consistent with sovereignty.
- Proof and field-state obligations under this model are specified in
  `09_Proof_Under_Causal_Consistency_v0_1.md` (the crux — proofs bind to a causal cut).

## Query surface

- Reads default to a **causal cut** (`AT(cut)`) or the peer's current linearization
  (`LATEST`); see spec 09 for read semantics and proof frame-status reporting.
- The DAS/MeTTa query API is the conformance target. The current TS engine exposes
  Atomese + pattern-matcher; speaking the DAS query surface (or MeTTa directly) is the
  primary "align with DAS" work item.

## Migration from the current federation code

1. Introduce a Hypercore-backed `AtomSpaceBackend` alongside the RocksDB backend (same
   `AtomLogEntry` write/restore interface; the journal seam already fits).
2. Stand up an Autobase over N participant cores; materialize a Hyperbee view; project the
   HellGraph store over that view.
3. Replace `StorageNodeClient` change-feed federation with Hypercore replication.
4. Wrap the super-peer (discovery + indexer + DAS endpoint) as a deployable service.
5. Bind proof/field-state to causal cuts per spec 09 before any proof-sensitive workload.

## Delivery sequencing (business tiers)

Aligned to the tenancy/substrate decisions on record:

- **Tenancy:** dedicated sovereign nodes first → pooled/shared super-peers → blended tiers.
- **Substrate:** estate-hosted super-peer (GKE) first → BYOC data plane → design for
  air-gapped appliance and unified SaaS+BYOC control plane throughout.

The substrate progression is nearly free here: because participants are sovereign and the
super-peer is a derived index, "BYOC" and "air-gapped" are just *where the participant node
runs*, not a re-architecture.

## Non-negotiable rules (federation additions)

- The super-peer is never the source of truth; the participant logs are.
- No atom enters the shared view without a valid participant signature.
- Replication is symmetric and signed; no client→authority pull path.
- The shared view is always rebuildable from participant logs alone.
- Proof binds to a causal cut and is never silently downgraded (spec 09).

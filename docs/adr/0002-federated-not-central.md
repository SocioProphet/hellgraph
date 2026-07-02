# ADR-0002: Managed HellGraph is a sovereign federation, not a central authority

## Status

Accepted.

## Context

Enterprise/collaborative clients need a shared central knowledge store, not just a local
edge store. The obvious path — a managed, centralized, Neptune-style cluster that owns the
data — was considered and rejected. It would make the service the source of truth, which
contradicts HellGraph's local-first thesis and the participants' data-sovereignty
requirement (a group of sovereign parties collaborating while keeping their own data).

Two external models are already canonical in this space and must be conformed to rather
than reinvented:

- **Distributed AtomSpace (DAS)** — AtomSpace, MeTTa-integrated query API, pluggable
  Atom-DB backend.
- **Hypercore / Autobase / Hyperbee** — signed append-only logs, multi-writer causal
  linearization, indexed views.

## Decision

The managed offering is a **federation of sovereign, local-first append-only logs**. The
"central store" is a **super-peer**: a derived, rebuildable index over participants' logs,
never a data owner.

- Each participant owns a signed Hypercore; their log is authoritative for their atoms.
- The shared view is an Autobase causal linearization materialized as a Hyperbee, projected
  as a DAS-compatible AtomSpace.
- Consistency is causal / eventually consistent — no global clock, no quorum, no authority.
- Proof binds to a causal cut and is never silently downgraded (spec 09).

This supersedes any prior "single-writer global journal + Raft-later" framing, which
assumed a central authority.

## Rationale

- Sovereignty is preserved by construction: no atom enters the shared view without a
  participant signature; the super-peer cannot forge or rewrite.
- Little new kernel code: the append-only journal maps to a Hypercore, deterministic replay
  maps to Autobase view materialization, checkpoints map to Hyperbee snapshots.
- A global consensus layer would require an authority and therefore violate sovereignty;
  causal consistency is the only model consistent with the thesis.
- Graph scale-out for this workload is partitioning/replication, not multi-writer consensus;
  Raft is explicitly not pre-built.

## Consequences

- The existing `StorageNodeClient` change-feed federation (client→server pull) is retired in
  favor of symmetric, signed Hypercore replication.
- The DAS/MeTTa query surface becomes the conformance target for the query layer.
- Proof and field-state semantics under causal consistency are a release blocker for any
  proof-sensitive workload; specified in `docs/specs/09_Proof_Under_Causal_Consistency_v0_1.md`.
- Substrate progression (estate-hosted → BYOC → air-gapped) reduces to "where the
  participant node runs," not a re-architecture.
- Claims of DAS or Hypercore conformance must be test-backed before public/customer use.

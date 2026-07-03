# ADR-0003: The content data-plane composes onto HellGraph; egress is opt-in

## Status

Accepted.

## Context

Enterprise clients need a content/object data-plane around the knowledge graph: canonical
object storage with residency/ACLs, derived extraction/chunk/vector stores, retrieval,
retention + legal hold, policy-gated masking, and optional materialization of content to
frontier model Files APIs (Gemini/Claude/OpenAI). The question is whether this is a
separate system or part of the sovereign federation we already built
(`08_Federated_Sovereign_HellGraph_v0_1.md`).

## Decision

The content plane is **the same sovereign canonical+derived+policy spine applied to blobs**,
not a separate system. HellGraph is the knowledge/graph *projection*; the content plane is
the object *projection*; both share one policy + audit + retention governance.

- Canonical (L1 object store) is the only source of truth for content; derived extraction/
  chunk/vector stores (L2) are HellGraph's existing rebuildable views.
- The Audit Log reuses the evidence spine (a Hypercore), not a new store.
- The reversible field-masking policy is expressed and stored as a **HellGraph policy-graph**
  (processors/selectors/predicates as atoms), so policy is versioned, codex-sealed, provable.
- **Third-party egress is opt-in and default-off.** Vendor materialization (L3) and external
  connectors/web (L4) are enabled deliberately per tenant. With nothing opted in, the cell
  egresses nothing.
- **L3 MUST NOT precede L5.** Vendor materialization is admissible only under the Policy
  Engine (egress gate + masking before egress + TTL/GC on a disposable, re-materializable
  cache). Vendor materialization without the policy layer, or on by default, is a
  sovereignty violation.

Full seam map and lifecycle state model: `10_Content_Data_Plane_v0_1.md`.

## Rationale

- Reuse over reinvention: L2 (derived stores) already exists as `semantic.ts` + the
  AtomSpace; the Audit Log already exists as the evidence spine; "rebuildable" already
  exists as `materialize()`.
- Sovereignty by default: opt-in egress means the baseline product is fully local-first;
  cloud/vendor use is a deliberate, policy-gated, masked exception.
- Enterprise-legibility: the lifecycle FSM (retention, legal hold, deletion, residency)
  fills the exact compliance gaps identified against managed graph databases.

## Consequences

- L0 UX and external connectors are client/app scope, out of the HellGraph specs.
- Build order is fixed: seam spec → L5 governance → masking policy-graph → L3 (opt-in).
- Reversible masking blocks on a key-custody decision (per-tenant KMS vs sovereign/threshold
  keys); this is a release blocker for L3.
- Legal hold overrides retention; canonical deletion cascades to derived + vendor copies.

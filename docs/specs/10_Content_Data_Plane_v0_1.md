# HellGraph Content Data-Plane v0.1

## Purpose

Pin the content/object data-plane (ingest → extract → index → serve → retain/delete,
with vendor materialization and policy governance) onto the HellGraph sovereign
federation, and name the seams. This is the enterprise data-plane that makes the managed
offering *legally runnable*: residency, ACLs, retention, legal hold, deletion, and
policy-gated egress.

This spec composes with, and does not replace, the federation model
(`08_Federated_Sovereign_HellGraph_v0_1.md`) and proof-under-causal-consistency
(`09_Proof_Under_Causal_Consistency_v0_1.md`). See `ADR-0003`.

## Positioning: one canonical+derived+policy spine, two projections

The federation thesis is *sovereign canonical source of truth → derived, rebuildable view,
under policy*. The content plane is the **same spine applied to blobs**:

- **Knowledge projection** (already built): atoms are canonical in sovereign Hypercore
  logs; the Autobase-materialized AtomSpace is the derived, rebuildable view.
- **Content projection** (this spec): blobs are canonical in an object store; extraction /
  chunk / keyword / vector stores are the derived, rebuildable views.

Both are governed by one policy + audit + retention plane. HellGraph is therefore the
knowledge/graph *projection* of a single sovereign data architecture — not a separate
system from the content plane.

## Layer map (normative)

Layers follow the reference architecture. "EXISTS" = already in HellGraph/the estate;
"NEW" = to build; "SCOPE-OUT" = client/app concern, not this spec.

| Layer | Component | Status | Binding |
|---|---|---|---|
| **L0** | UX containers (Workspace / Collection / Thread) | SCOPE-OUT | client cockpit (Noetica) |
| **L1** | Canonical Object Store (BYOS, S3-compatible, cloud+edge) | NEW | blob source-of-truth; the content analogue of a sovereign participant log |
| **L1** | Metadata Catalog (versions, ACLs, residency) | NEW | governance-critical; MAY project into the graph as atoms |
| **L2** | Extraction / Chunk / Keyword / Vector stores | EXISTS | `semantic.ts` (chunk→embed→vector) + AtomSpace; "rebuildable" = `materialize()` |
| **L3** | Vendor Cache Manager → Gemini/Claude/OpenAI Files APIs (TTL/GC) | NEW · **OPT-IN, default-off** | disposable frontier-file cache; **gated by L5** |
| **L4** | Retrieval Engine (internal + connectors + web) | PARTLY EXISTS | internal SPARQL/Gremlin/semanticSearch EXISTS; external connectors + web are **OPT-IN, default-off** |
| **L4** | Provenance & Citations | EXISTS | codex manifests + proof-under-causal-cut + evidence spine |
| **L5** | Policy Engine (OPA/Cedar-style rules) | NEW | egress/deletion/caching gate; masking policy (below) |
| **L5** | Retention Scheduler (TTL, delete, legal hold) | NEW | drives the lifecycle FSM |
| **L5** | Audit Log (append-only) | EXISTS | the evidence spine / a Hypercore |
| **L6** | Tool Sandbox → Artifact Publisher (to canonical + optional vendor cache) | PARTLY EXISTS | agentplane; Publisher writes results back to L1, closing the loop |

## Content lifecycle (state model, normative)

Every content object moves through a governed state machine. Transitions are triggered by
processing steps or policy; the Retention Scheduler and Policy Engine own the branch edges.

```
IngestedRaw --(hash + MIME + encrypt + label)--> Normalized
Normalized  --(OCR / parsing / media frames)---> Extracted
Extracted   --(chunks + embeddings + kw index)-> Indexed
Indexed     --(retrieval + inference)----------> Served

Served      --(create vendor file handle, opt)-> VendorMaterialized --(TTL/GC)--> ExpiredVendorCache
ExpiredVendorCache --(re-materialize from canonical)--> VendorMaterialized
Served      --(abuse/safety exception)--------> FlaggedRetention --(window ends)--> Deleted
Served      --(litigation/regulatory hold)----> LegalHold --(hold released)------> Served
LegalHold   --(policy allows after release)---> Deleted
{Normalized, Extracted, Indexed} --(retention policy)--> Deleted
```

Rules:
- **Legal hold overrides retention.** While in `LegalHold`, no retention edge may delete
  the object. Release returns to `Served`; deletion is only reachable *after* release.
- **Derived states are rebuildable.** Deleting the canonical object (L1) invalidates its
  derived stores (L2) and vendor caches (L3); derived-only deletion is always safe.
- **The ingest edge (`hash + MIME + encrypt + label`) is the codex seal point.** The
  content-integrity manifest (codex) attaches at IngestedRaw→Normalized; drift is a
  syndrome on re-verify.

## Policy plane (L5)

- **Policy Engine.** OPA/Cedar-style rules evaluated at three chokepoints: **egress**
  (may this leave the cell / go to a vendor?), **deletion** (may this be deleted, or is it
  on hold?), **caching** (may a derived/vendor copy exist, and for how long?).
- **Retention Scheduler.** Owns TTL/delete/legal-hold transitions of the lifecycle FSM.
- **Audit Log.** Append-only; every policy decision, materialization, and deletion is a
  signed event. This IS the evidence spine — reuse the Hypercore append-only log, not a
  new store.

### Masking policy as a HellGraph policy-graph (normative)

Reversible, field-level, predicate-driven masking (the reference example) is expressed as
a **data-flow graph** and therefore lives natively in HellGraph:

```
JsonProcessor(root)
  --[selector "$.phones.home", predicate Exist(key="encrypt")]--> MaskProcessor   (encrypt in place)
  --[selector "$.phones.home", predicate Exist(key="decrypt")]--> UnmaskProcessor (decrypt in place)
```

Encoding: processors/selectors/predicates are atoms; edges are `EvaluationLink`s carrying
the selector + predicate as values. Consequences:
- The policy is **versioned, codex-sealed, and provable** like any subgraph.
- Masked values are delimited ciphertext in place (`{#…==#}`), so a masked payload is
  still valid JSON and round-trips losslessly on unmask.
- One unified policy supports both mask and unmask via the `encrypt`/`decrypt` predicate.

## Opt-in egress (default posture)

The sovereign, local-first path is the **default**. Every third-party-facing capability is
**opt-in and default-off**, enabled deliberately per tenant (and MAY be scoped per
collection/document):

- **L3 vendor materialization** (Gemini/Claude/OpenAI Files APIs) — default-off.
- **L4 external connectors + web retrieval** — default-off.

With nothing opted in, the cell egresses nothing: it is a fully sovereign store. Opting in
does not bypass policy — it merely makes egress *possible*, still subject to L5 below.

## The L3 ⇄ L5 coupling (the crux)

Even when opted in, vendor materialization (pushing content to frontier Files APIs) is
**egress to third-party clouds**. It is only admissible under L5:

- The Policy Engine MUST gate every vendor materialization at the **egress** chokepoint.
- Sensitive fields MUST be masked/tokenized (masking policy) before egress.
- The vendor cache MUST carry a TTL and be GC'd; canonical never leaves without a policy
  decision, and the vendor copy is disposable + re-materializable.

**Therefore L3 MUST NOT be built or enabled before L5**, and MUST remain opt-in.
Vendor materialization without the policy/masking layer — or on by default — is a
sovereignty violation.

## Key management (open decision — blocks reversible masking)

Reversible masking depends on recoverable key custody. Candidate models (decision pending):
- **Per-tenant KMS** (cloud KMS / Vault) — simplest; custody sits with the operator.
- **Sovereign / threshold keys** — participant-held or split so no single party (incl. the
  super-peer) can unmask alone; strongest sovereignty, most complex.

This is a release blocker for the masking policy and MUST be decided before L3.

## Scope & non-negotiables

- L0 UX and external connectors are client/app scope, not this spec.
- The Audit Log reuses the evidence spine; do not invent a parallel log.
- Legal hold overrides retention, always.
- Canonical (L1) is the only source of truth; L2/L3 are derived and disposable.
- **Sovereign/local-first is the default; vendor materialization (L3) and external
  connectors/web (L4) are OPT-IN and default-off**, deliberately enabled per tenant.
- No vendor egress without a policy decision; sensitive fields masked before egress.
- Content-integrity (codex) seals at ingest; provenance (proof-cut) travels with served
  results.

## Build sequence

1. **This spec** (seam map) — done.
2. **L5 governance**: Policy Engine + Retention Scheduler + lifecycle FSM (audit = existing
   evidence spine). The enterprise unlock and the safety layer everything else depends on.
3. **Masking policy-graph** (this spec) — the egress-safety mechanism; prerequisite for L3.
4. **L3 vendor materialization** — admissible only after 2 + 3.

## Open questions

- Metadata Catalog: standalone store vs projected into the graph as governance atoms.
- Residency enforcement: how the Policy Engine binds an object's residency label to
  allowable cell/vendor locations.
- Derived-store invalidation: cascade protocol when a canonical object is deleted or held.

# Truth Engine & Discourse Integration v0.1

## Purpose

Align HellGraph as the **Truth-Engine / Discourse-Graph substrate** for (a) the Telos
governance layer, (b) the discourse-hygiene application pipeline, and (c) Memini-style
associative memory — integrating with prophet-platform (runtime) and prophet-workspace /
sourceos-spec (contracts). This is an alignment/integration contract, not new capability.

## Three layers, one substrate

1. **Telos layer** (objectives + constraints). Keter (objective: intelligence serves human
   flourishing; constraints: non-domination, consent, dignity) → Da'at (policy interface: what
   counts as acceptable proof, what harms raise burden-of-proof). **It sets weights and
   thresholds; it MUST NOT assert truth.** → HellGraph `policy.ts` (deny-overrides gating,
   non-negotiables opt-in/legal-hold/residency/consent) + the KKO upper ontology.
2. **Truth Engine** (falsifiable, auditable). Artifact → Claim → Test-Obligation (required
   refutation channel) → Witness/Attestation (provenance + independence) → Truth Record
   (multi-valued; temporal; adversary-aware), looping Record → Claim. → codex (artifact
   integrity) + claims-as-atoms + proof-under-causal-cut (spec 09) + causal-cut provenance +
   the reflexive loop (spec 13).
3. **Discourse-hygiene pipeline** (application). Identity+Consent → Event Bus → {Argument
   Mining, Moderation, Retrieval+Attribution, Verification, RAG} → Discourse Graph DB, with a
   Hygiene Layer (LOGFALL/COGBIAS, Counter-Test Runner, Bias/Calibration Passport, Drift) and
   an Append-only Audit Ledger. → HellGraph is the **Discourse Graph DB** + the audit spine +
   the verification/proof substrate; the services + bus live on prophet-platform.

Memini (associative memory: fast/slow edges, spreading activation, consolidate/fade) →
HellGraph **ECAN** (STI=w_fast, LTI=w_slow, `stimulate`=co-occurrence write,
`spreadAttention`=read-path activation, VLTI/decay=consolidate/persist) + semantic pipeline.

## Component map

| Diagram element | HellGraph / estate | Repo |
|---|---|---|
| Telos (Keter/Da'at) | `policy.ts` + KKO + non-negotiables | hellgraph + sourceos-spec |
| Artifact / Claim / Test-Obligation / Witness / Truth Record | codex + atoms + proof-under-causal-cut + provenance + reflexive loop | hellgraph |
| Discourse Graph DB | HellGraph federation (cypher façade + CSKG ingest) | hellgraph |
| Event Bus / ICG / Identity+Consent | app orchestration + `auth.ts` + consent | prophet-platform + hellgraph |
| Argument Mining / Moderation / Retrieval+Attribution / Verification / RAG | Core pipeline services | prophet-platform / workspace |
| Hygiene Layer (LOGFALL/COGBIAS, CTEST, passports, drift) | provenance-fidelity-eval + reasoning-evidence-fabric | prophet-platform / Noetica |
| Append-only Audit Ledger | evidence spine (Hypercore) + `AuditSink` | hellgraph + sourceos-spec |
| Telemetry/OTEL, Model Registry | `metrics.ts` + platform OTEL + registry | prophet-platform |
| Memini (write/read/edge) | ECAN + semantic | hellgraph |

## Integration invariants (normative)

- **One evidence spine.** The discourse Audit Ledger, HellGraph `AuditSink`, the
  reasoning-evidence-fabric, and super-peer audit are ONE append-only sourceos-spec spine
  (ReasoningRun/Event/Receipt). No parallel ledgers.
- **Telos ≠ Truth.** Policy gates + sets thresholds; it MUST NOT assert or write a Truth Record
  verdict. Proof/codex asserts truth; proof is never silently downgraded (spec 09). Already
  enforced: `honorProof` withholds out-of-frame; policy only gates.
- **Sovereign graph ≠ event bus.** HellGraph (Hypercore/Autobase) is the sovereign, rebuildable
  graph-of-record; the Event Bus is application orchestration that emits INTO the graph + spine.
  Do not make the bus the graph authority, nor HellGraph an event bus.
- **Falsifiability = Test-Obligation.** Every Claim carries a required refutation channel =
  codex re-verify + counter-test + proof re-check under a read cut. A claim with no refutation
  channel is not admissible.
- **Spec-first contracts.** Discourse events (`ingress.discourse.v1`, `claim.parsed.v1`,
  `hygiene.*.v1`), the Truth Record, and the Calibration Passport are canonical sourceos-spec
  schemas (prophet-workspace).
- **Memini = ECAN.** The associative-memory read/write path uses HellGraph ECAN + semantic —
  no parallel memory engine.

## Discovered (2026-07-04): the contract-first architecture already exists

Recon of the estate (read-only) shows this is NOT greenfield — the layering is already built
and confirms HellGraph's role:
- **prophet-workspace** (`feat/personal-context-graph`) holds the canonical **CSKG contract**
  (`PersonalContextGraph.schema.json`): edges are `CSKGEdge {node1, relation, node2,
  provenance_refs, source_evidence_refs}`, every element provenance-bound to a WorkspaceSource
  (`workspace-source:*`), external-KG links reference-only (ProviderProjection). Its own
  description states: *"the runtime that ingests WorkspaceSource objects and writes HellGraph
  lives in memory-mesh; deployment (managed HellGraph service) lives in prophet-platform."*
- **sourceos-spec** (`docs/crdt-over-evidence-fabric`) is actively building the CRDT-over-
  evidence-fabric contract (our causal/evidence territory).
- **prophet-platform** (`feat/capability-membrane`) is mid-feature (deployment home; my lane).

**Consequence — conform, do not duplicate:** the discourse schema (`discourse.ts`) is a CSKG
relation vocabulary (SUPPORTS/REFUTES/CITES/…) over CSKG nodes, provenance-bound via `sourceRefs`
(WorkspaceSource ids) — DONE. New contracts MUST NOT be drafted in those repos in parallel with
the concurrent agents; the relation vocabulary is registered with the workspace contract owner.

## Open decisions

- **Truth Record cardinality.** Ours: 3-valued (POS/ZERO/NEG) + causal-cut (temporal) +
  tamper-detect (adversary-aware). "Multi-valued" applies to the record OVER TIME (many
  claims/verdicts/cuts), not to weakening a single non-downgradable proof. Confirm.
- **Repo homes (confirmed).** Truth-Engine substrate → hellgraph; CSKG runtime → memory-mesh;
  discourse services + bus + registries + managed HellGraph deployment → prophet-platform;
  contracts (CSKG, CRDT-over-evidence, Truth Record, passport) → prophet-workspace/sourceos-spec.
- **Register the discourse relation vocabulary** in the CSKG `relationVocabulary` — coordination
  item with the prophet-workspace contract owner (do not fork the contract).
- **Calibration/Bias Passport** = per-participant reasoning credential — reconcile with the
  Sacred-Capital / portable-reputation model (digital-soul).

## Next
Define the shared contracts (Truth Record, discourse events, passport) in sourceos-spec; deploy
services on prophet-platform; keep HellGraph the sovereign Truth-Engine substrate.

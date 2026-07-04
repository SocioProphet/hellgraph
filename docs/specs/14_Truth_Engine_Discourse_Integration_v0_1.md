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

## Open decisions

- **Truth Record cardinality.** Ours: 3-valued (POS/ZERO/NEG) + causal-cut (temporal) +
  tamper-detect (adversary-aware). "Multi-valued" applies to the record OVER TIME (many
  claims/verdicts/cuts), not to weakening a single non-downgradable proof. Confirm.
- **Repo homes.** Truth-Engine substrate → hellgraph; discourse services + bus + registries →
  prophet-platform; contracts + Truth Record + passport → prophet-workspace/sourceos-spec.
- **Claim/warrant/evidence atom schema.** Coordinate with the concurrent cypher + CSKG-ingest
  work (that IS the Discourse Graph DB ingest) so there is one atom schema, not two.
- **Calibration/Bias Passport** = per-participant reasoning credential — reconcile with the
  Sacred-Capital / portable-reputation model (digital-soul).

## Next
Define the shared contracts (Truth Record, discourse events, passport) in sourceos-spec; deploy
services on prophet-platform; keep HellGraph the sovereign Truth-Engine substrate.

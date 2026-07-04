# HellGraph Integration — Cross-Workstream Coordination

Multiple agents are concurrently building the same conceptual territory across repos. This note
is the convergence contract so we end with **one schema + one spine**, not duplicates. Authority:
`docs/specs/14_Truth_Engine_Discourse_Integration_v0_1.md`.

## Active workstreams (2026-07-04)

| repo · branch | workstream | converges on |
|---|---|---|
| **hellgraph** · main | federation + Truth-Engine substrate + `discourse.ts` schema + super-peer | this note |
| **prophet-workspace** · `feat/personal-context-graph` | CSKG contract (`PersonalContextGraph.schema.json`) | discourse relation vocabulary |
| **sourceos-spec** · `docs/crdt-over-evidence-fabric` | CRDT-over-evidence contract | causal-cut + proof (spec 09) |
| **prophet-platform** · `feat/capability-membrane` | capability gate + managed-HellGraph deployment | super-peer `deploy/` |
| **memory-mesh** | CSKG runtime (ingest WorkspaceSource → write HellGraph) | `discourse.ts` write API |

## Shared invariants — every workstream holds these (spec 14)

1. **One evidence spine** (sourceos-spec ReasoningRun/Event/Receipt). No parallel ledgers.
2. **Telos ≠ Truth** — policy gates + sets thresholds; proof/codex asserts, never downgraded.
3. **Sovereign graph (HellGraph) ≠ event bus** — the bus emits INTO the graph + spine.
4. **Falsifiability** — every Claim carries a Test-Obligation refutation channel.
5. **Provenance-bound** — every graph element → a `WorkspaceSource` (CSKG invariant).
6. **Memini = ECAN** — one associative-memory engine.

## Convergence actions (who does what)

1. **Discourse ↔ CSKG** *(workspace contract owner)* — HellGraph `discourse.ts` is already
   CSKG-conformant (CSKG nodes; `CSKGEdge` edges; `sourceRefs` = WorkspaceSource). **Register the
   discourse vocabulary in the CSKG contract**, don't fork it:
   - node types: `Claim, Warrant, Evidence, Attestation, TestObligation, TruthRecord`
   - relations: `SUPPORTS, REFUTES, CITES, WARRANTS, ATTESTS, REFUTATION_CHANNEL, RECORDS`
2. **CRDT-over-evidence ↔ causal-cut/proof** *(sourceos-spec owner)* — the CRDT merge MUST NOT
   silently resolve a proof. Align its merge with Autobase causal linearization + spec-09
   `honorProof` (a proof is frame-relative to a causal cut; a fork takes it out-of-frame → re-check,
   never downgrade to confidence). CRDT is for **eventually-consistent state**, not for verdicts.
3. **CSKG runtime writes HellGraph** *(memory-mesh)* — use the `discourse.ts` assert/record API
   (`assertClaim`/`addEvidence`/`recordTruth`), which enforces falsifiability + codex sealing, not
   raw atom writes.
4. **Deployment** *(prophet-platform lane)* — the managed HellGraph service = the super-peer;
   `deploy/` (Dockerfile + GKE + ArgoCD + CI) is ready. Pipeline services (argument mining,
   moderation, verification, hygiene) run here and emit onto the one spine.
5. **Truth Record cardinality** *(all)* — confirm: 3-valued (POS/ZERO/NEG) + causal-cut (temporal)
   + tamper-detect (adversary-aware); "multi-valued" = the record OVER TIME, not a weaker proof.

## Do-not-duplicate

- No second claim/evidence schema → use `discourse.ts` / the CSKG contract.
- No second evidence ledger → use the spine.
- No second memory engine → use ECAN.
- No second causal-merge → use Autobase + causal-cut.

## References
spec 14 (integration) · spec 09 (proof-under-causal-consistency) · `ts/src/discourse.ts` ·
prophet-workspace `PersonalContextGraph.schema.json` · sourceos-spec `crdt-over-evidence-fabric`.

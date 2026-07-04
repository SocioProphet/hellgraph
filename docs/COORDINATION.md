# HellGraph Integration — Cross-Workstream Coordination

Multiple agents are concurrently building the same conceptual territory across repos. This note
is the convergence contract so we end with **one schema + one spine**, not duplicates. Authority:
`docs/specs/14_Truth_Engine_Discourse_Integration_v0_1.md`.

## Security findings for the file owners (adversarial hardening epoch)

Epoch 3 went **cross-lane** (authorized) and closed the query-surface parser findings directly,
each with an attack test (`security-hardening5.test.ts`). The super-peer `/query` surface takes
untrusted SPARQL/Atomese/Turtle; these are the paths it reaches.

**FIXED in epoch 3:**
- **sparql.ts — user-regex ReDoS (HIGH). ✅** `FILTER regex(?x, "(a+)+$")` no longer hangs:
  `safeRegexTest` caps pattern (512) + input (8 KB) length and rejects the nested-quantifier
  backtracking shape (heuristic, linear-time detector; RE2 remains the fully-general fix). The
  tokenizer string literal is unrolled to `"[^"\\]*(?:\\.[^"\\]*)*"`. Also bounded the recursive
  FILTER-expression parser (`MAX_FILTER_DEPTH` 256) — `FILTER((((…))))` was a parse+eval overflow.
- **atomese.ts — tokenizer ReDoS + recursive-parser depth (MED). ✅** Tokenizer unrolled; `SParser`
  now carries a `MAX_PARSE_DEPTH` (512) guard (same class as the metta.ts fix). `parseAtomese` has
  no recovery catch, so deep nesting was an uncontrolled stack overflow → now a clean error.
- **turtle.ts — recursive-parser depth DoS (MED). ✅** `termFull` (the choke point all `[…]`/`(…)`
  nesting funnels through) bounds live stack depth (`MAX_TURTLE_DEPTH` 512); `parse()`'s
  statement-level catch recovers.
- **cypher.ts — variable-length path expansion (MED). ✅ already guarded** by the owner: unbounded
  `[*1..]` is rejected and `e.hi > maxHops` (default 3) throws before the expansion loop. No change.

**REMAINS — coordinate, don't clobber (security-agent's hot files, unpushed work):**
- **masking.ts — GCM nonce reuse at volume (MED).** `maskValue` uses a random 96-bit IV; one
  static key encrypting ~2^32 fields risks an IV collision, catastrophic for GCM (plaintext-XOR
  leak + forgery). Fix: bound encryptions per key + rotate before the birthday limit, or
  AES-GCM-SIV (nonce-misuse-resistant). Left to the owner to avoid conflicting with the in-flight
  scrypt-KDF work in this file.
- **auth.ts — no-exp tokens + empty/short secret (MED).** Enforce `exp` + a minimum secret length.
  Owner's file; same coordination reason.

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
4. **Deployment** *(prophet-platform lane)* — ALREADY MERGED (#691 mode-aware `hellgraph-service`
   image `local | super-peer` vendoring @socioprophet/hellgraph 0.4.3; `infra/k8s/hellgraph-
   superpeer/`, an emptyDir derived-index twin). **Alignment follow-up when it bumps past 0.4.3:**
   (a) switch probes `/health` → **`/livez`** (public liveness — `/health` will 401 once auth is
   enabled); (b) wire `HELLGRAPH_AUTH_SECRET` (currently runs OPEN); (c) optionally scrape
   `/metrics`. These endpoints (/livez, bearer auth, /metrics) shipped in the sprint work AFTER
   0.4.3. hellgraph `deploy/` (Dockerfile/GKE/ArgoCD/CI) is a reference; the estate image is
   `hellgraph-service` — reconcile the ghcr↔GAR naming (already noted in the deployment).
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

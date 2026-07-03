# Codex ↔ TriTRPC Reconciliation v0.1

## Purpose

Bind the codex implementation (`ts/src/codex.ts`, the GKG-CODEX formal layer) to TriTRPC's
frozen wire conventions so the two hand off together. Normative addendum to the GKG-CODEX
tech-spec (§16). Source of truth for TriTRPC claims: `SocioProphet/TriTRPC` unified v4.
`[repo-gated]` = depends on unverified/pending upstream state.

## Binding constraints (normative)

### Placement — a CTRL243 Path-B profile, never Path-A (§16.1)
Codex emits bytes in the TritPack243 out-of-band range (247–255), invalid in canonical
Path-A/Avro. A codex frame is therefore **not a Path-A payload**. It MUST ride as a
Path-B-family construct selected by the `CTRL243.profile` trit (reuse `profile=1` with a
sub-marker, or a newly allocated `profile`); MUST NOT occupy `profile=0`. Until the profile
value is allocated with the TriTRPC spec owner, codex frames are **Reference-only** and MUST
NOT enter the conformance tree. `[repo-gated]`

### Marker-band parity — default 9 is the only conformant rung (§16.2)
247–255 (fixed 9-core) collide with no valid payload byte. 243–246 are TritPack243 tail
bytes; rung 9 reuses all four as the self-describing tail, coinciding with their canonical
Path-B meaning — so **rung 9 (`marker_band.free = 9`) is the only rung that preserves
byte-parity with TritPack243/Stable-v1.** Rungs 10–12 repurpose tail bytes, forfeit parity,
MUST carry `parity: broken`, and MUST NOT be used on any Path-B-interop wire. (Codex v0 does
not implement the marker-band dial; this governs it when added.)

### Verdict & evidence are two axes (§16.4) — IMPLEMENTED
Status is two axes, not one; no third vocabulary:
- **Evidence tier** (how computed) → `CTRL243.evidence` `{exact, sampled, verified}`:
  T1 formal → exact; T2 empirical (SCT) → sampled; ρ cross-transform → verified.
- **Verdict** (outcome) → `State243.epistemic`: INTACT/lawful → POS; compound/unknown →
  ZERO; tamper/corruption → NEG.
`Syndrome` now carries both `verdict` and `evidence` (`codex.ts`); `evidenceTierOf()` maps
facets → tier (v0 formal = exact).

### topic23.v1 is the residue source (§16.3)
The `residue` facet over 22 topics + domain = 23 **is `topic23`**. The moduli {5,7,17,19}
and the topic↔residue crosswalk MUST derive from the **frozen `topic23.v1`**, schema-accessor
only — never a local copy or hardcoded indices. `topic23.v1` is currently unowned.
`[repo-gated]`

### Unbalanced ternary in v0 (§16.6)
Codex v0 MUST assume unbalanced `{0,1,2}` and MUST NOT reference balanced ternary as
existing. Future convergence (non-blocking): balanced ternary's native negation is the
`atbash` reflection operator (§7.2 stub, present in `codex.ts`). `[repo-gated]`

## Dependency ordering (§16.7) — the critical path

```
topic23.v1 ownership + freeze      (G4-pre; §16.3)  [upstream]
      ↓
Path-B scanner hardening           (shared prereq; §16.5)  [upstream]
      ↓
CTRL243 profile allocation for GKG (placement; §16.1)  [upstream]
      ↓
codex G3 (Node/Edge API) → G4 (fixture freeze)
```

## Status against this repo

**Applied here (no upstream dependency):**
- §16.4 — verdict/evidence two-axis split in `codex.ts` (`EvidenceTier`, `evidenceTierOf`,
  `Syndrome.evidence`); no third vocabulary.
- §16.8/§16.6 — `atbash` extension stub added; v0 stays unbalanced `{0,1,2}`.
- This binding recorded in the `codex.ts` header + this spec.

**Blocked upstream (SocioProphet/TriTRPC — cannot resolve in this repo):**
1. Allocate the `CTRL243.profile` value (or Path-B sub-marker) for codex.
2. Own + freeze `topic23.v1` (now blocking two consumers).
3. Path-B scanner hardening (shared prerequisite ahead of G3).
4. Resolve the balanced-ternary README claim (correct vs. scope).

**Consequence:** codex fixture-freeze (G4) and any move past G3 are **blocked on items 1–2**.
Until then the codex layer is Reference-only — it stays default-on/passive for internal
integrity (as shipped) but MUST NOT be treated as a frozen conformance target or emitted on a
Path-B-interop wire.

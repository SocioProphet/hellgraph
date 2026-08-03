# ADR-0004: The Crown — the Telos Layer is seated over the Truth Engine as a constitution

## Status

Accepted.

## Context

The estate now has all the constitutional pieces, built and merged, but nothing that seats
them as a **single ordered layer** with teeth. The owner's flow diagram states the order
plainly:

> **Telos Layer (Divine Plan as Objectives + Constraints) → Truth Engine (Falsifiable,
> Auditable)**

Two layers, one direction, one boundary. The Telos Layer sets *what we are for* (objectives)
and *what we will not do* (constraints); the Truth Engine determines *what is so* (falsifiable,
witnessed, auditable). The boundary is the whole point: **the layer that sets objectives cannot
be the layer that asserts truth.** A system whose objectives can also declare their own success
is not falsifiable — it is a control loop wearing a truth costume.

HellGraph already owns the Truth Engine implementation (`ts/src/discourse.ts`:
Artifact/Claim/Warrant/Evidence/Attestation/TestObligation/TruthRecord) and its alignment
contract (`docs/specs/14_Truth_Engine_Discourse_Integration_v0_1.md`, which already names the
three-layer structure and the `Telos ≠ Truth` invariant). What is missing is the *constitutional*
statement — the one that (a) says which existing, merged pieces ARE Keter, Da'at, and the Truth
Engine, and (b) encodes the cross-layer invariants as a check that goes red when the ordering is
violated. This ADR is that statement; `scripts/check-constitution.mjs` is its teeth.

This is a **consume-not-fork seating**: it references the merged pieces by repo/PR and asserts
the boundary between them. It does not re-implement or edit them.

## Decision

The estate is governed as a constitution with two seated layers and one non-negotiable boundary.

### Keter (Crown) — the objective and its constraints

The Crown objective is **"intelligence serves human flourishing"**, under the constraints
**non-domination, consent, dignity**. This is not a slogan; it is a specific, already-built
objective function: the **welfare-annealing objective** —
`economic-prophet welfare_annealing/` **WEA-1 (PR #59)**, the welfare-max-over-conserved-energy
model. It is explicitly **NOT a control-max objective**. The live objective data is served from
`prophet-platform/apps/agentic-os-api/app/data.py`.

Constitutional consequence: a Keter objective that maximises **control / domination / power /
compliance** rather than flourishing is the **SILENT-vs-welfare inversion**, and it is
**unconstitutional**. A control-max telos is void regardless of how well-formed the rest of the
record is.

### Da'at (Knowledge) — the policy interface that sets weights, never truth

Da'at is the policy interface: *what counts as acceptable proof, which harms raise the
burden of proof.* It **sets weights and thresholds** and it **CANNOT assert truth**. It is
seated on the already-merged policy surfaces:

- the **omnirisk / outcome-pricing** policy weights,
- **the-assay** grade thresholds,
- the **counter-test-gate**.

Constitutional consequence: a Da'at policy/weight record that manufactures a **POS / true**
verdict is void. This is the **same rule** as the SILENT epistemic firewall's
affirming-the-consequent guard — **evidence-intake-kernel #3** (merged this session): policy may
raise the burden of proof, weight it, and gate on it, but a threshold is not a verdict and a
weight is not a witness. Da'at sets weights only.

### Truth Engine — falsifiable, witnessed, auditable; the only layer that asserts truth

The Truth Engine is the flow
**Artifact → Claim → Test-Obligation → Witness/Attestation → Truth Record**
(multi-valued, temporal, adversary-aware), looping Record → Claim. It is seated on:

- `hellgraph/ts/src/discourse.ts` (the atom schema + `assertClaim`/`recordTruth` bindings) and
  spec 14,
- the **SILENT epistemic firewall** — evidence-intake-kernel **#2 / #3** (merged this session),
- the **Noetica counter-test detectors** — **PR #570** (merged),
- **Truth = Law × Evidence** — a verdict is admissible only as the product of an admissible
  policy frame (Law, from Da'at) and admitted evidence (never Law alone).

`discourse.ts` already enforces the *intra-record* laws structurally: `assertClaim` rejects a
claim with no refutation channel; `recordTruth` rejects a verdict with no witness/attestation or
no causal cut. This ADR adds the *cross-layer* constitutional laws that no single function sees.

### The map (seat, do not reinvent)

| Constitutional role | Merged piece being seated | Home |
|---|---|---|
| **Keter** objective — flourishing, not control | welfare-annealing WEA-1 (PR #59); live data `app/data.py` | economic-prophet / prophet-platform |
| **Da'at** — weights & thresholds, no truth | omnirisk/outcome-pricing weights · the-assay grades · counter-test-gate | prophet-platform / estate |
| **Truth Engine** — falsifiable/witnessed/auditable | `discourse.ts` + spec 14 · SILENT firewall (eik #2/#3) · Noetica counter-test (PR #570) · Truth = Law × Evidence | hellgraph / Noetica / eik |
| **Runtime that will produce Bias/Calibration Passports** | epistemic-governance Hygiene standard, ruleset **1.3.0** | sociosphere `standards/epistemic-governance/` |
| **Bias catalog cross-reference** | cognitive-bias catalog (set-1 backlog) | Noetica |

## Constitutional invariants (the teeth)

Encoded in `scripts/check-constitution.mjs` against the corpus
`scripts/constitution-fixtures.json`. Each invariant is checked in **both directions** — the
things it must admit are admitted, the things it must void are voided, *and for the declared
reason*. A void that fires for the wrong invariant fails as loudly as a missed void.

**VERIFIES (admits):**
- A TruthRecord that carries a **TestObligation** (refutation channel) **and** a
  **Witness/Attestation** (provenance + independence) **and** is **multi-valued + temporal +
  adversary-aware** is admitted (`T-admits`).
- A Keter record whose maximand is flourishing/welfare under the non-domination/consent/dignity
  constraints is admitted (`K1`).
- A Da'at record that sets weights/thresholds and asserts no verdict is admitted (`D1`).

**REJECTS (voids):**
- **`D1` — Da'at cannot assert truth.** A policy/weight record that manufactures a POS/true
  verdict is void (same rule as the firewall's affirming-the-consequent guard, eik #3).
- **`K1` — a control-telos is unconstitutional.** A Keter objective that is a
  control/domination objective rather than the flourishing/welfare objective (the
  SILENT-vs-welfare inversion) is void.
- **`K2`** — a flourishing objective that strips the required constraints is void.
- **`T1`** — a TruthRecord with **no TestObligation** is unfalsifiable → void (mirrors the
  Phase-0 counter-test gate; `discourse.ts assertClaim`).
- **`T2`** — a TruthRecord with **no Witness** is void (mirrors `discourse.ts recordTruth`,
  ≥1 attestation).
- **`T3`** — a **single-valued / atemporal / non-adversary-aware** TruthRecord is void where the
  constitution requires multi-valued + temporal + adversary-aware.

The checker also refuses a **degenerate corpus**: the suite must exercise both directions and
must fire both `D1` ("Da'at cannot assert truth") and `K1` ("control-telos is unconstitutional"),
so the two headline teeth can never be quietly removed while the check still reports green.

## Rationale

- **The ordering is the safety property.** Objectives that can grade their own truth are the
  definition of an unfalsifiable, self-confirming system. Seating Telos strictly *above* an
  auditable Truth Engine — and encoding the boundary as a check — is what makes "aligned"
  falsifiable rather than asserted.
- **Seat, don't reinvent.** Every piece already exists and is merged. The constitutional value
  is in *naming which piece is which layer* and *asserting the boundary between them*, not in new
  machinery. The validator is deterministic, stdlib-only `.mjs` (no `tsx`, no deps) so it is
  cheap and non-negotiable in CI — the same doctrine as the KKO provenance guard.
- **The teeth mirror `discourse.ts`, one level up.** `discourse.ts` guards a single record;
  this guards the layering. `T1`/`T2` deliberately restate `assertClaim`/`recordTruth` so the
  constitution and the runtime cannot silently disagree.

## Consequences

- A control-max objective, or a policy record that asserts truth, is a **constitutional
  violation** and fails CI, not a code-review nicety.
- The Truth Record cardinality question left open in spec 14 is settled *for constitutional
  purposes*: an admitted record must be multi-valued (a verdict *space*, not a single boolean),
  temporal (a `ts`), and adversary-aware — the 3-valued POS/ZERO/NEG + causal-cut +
  tamper-detect shape already in `discourse.ts` satisfies it.
- Two runtime gaps are recorded below as follow-up issues for @mdheller; they are seated **under**
  this constitution rather than left ambient.

## Follow-up issues (filed, seated under this constitution)

1. **Hygiene runtime is standard-rich / runtime-poor.** The epistemic-governance standard
   (ruleset 1.3.0) has no **CTEST runner**, no **bias-passport / calibration-passport producer**,
   and there is an **id-namespace drift** (Noetica `LOGFALL.ADHOMINEM.V1` 0.1.0 vs standard
   `LOGFALL.ADHOM.V2` 1.3.0). Until these exist, `T1`'s refutation channels and the passport
   credential are specified but not produced at runtime.
2. **XSEDE-PEP → estate program-execution-plan.** Promote the XSEDE-PEP program-execution-plan
   into the estate PEP, seated under this constitution (objectives from Keter, verdicts from the
   Truth Engine, weights from Da'at).

## References

- `docs/specs/14_Truth_Engine_Discourse_Integration_v0_1.md` — three-layer alignment contract.
- `ts/src/discourse.ts` — Truth-Engine atom schema + `assertClaim`/`recordTruth`.
- `scripts/check-constitution.mjs`, `scripts/constitution-fixtures.json` — the teeth.
- Merged pieces seated (consume-not-fork): welfare-annealing WEA-1 (economic-prophet PR #59);
  SILENT epistemic firewall (evidence-intake-kernel #2/#3); Noetica counter-test detectors
  (PR #570); the-assay grades / omnirisk weights / counter-test-gate; epistemic-governance
  Hygiene standard 1.3.0.

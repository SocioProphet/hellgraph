#!/usr/bin/env node
/**
 * Constitutional conformance guard — the teeth for ADR-0004 (the Crown ADR).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────
 * ADR-0004 seats the estate's Telos Layer over the Truth Engine as a constitution:
 *   · Keter (Crown) sets ONE objective — intelligence serves human flourishing — under the
 *     non-domination / consent / dignity constraints. It is the welfare-annealing objective
 *     (economic-prophet welfare_annealing WEA-1, PR #59), NOT a control-max objective.
 *   · Da'at (Knowledge) sets the policy interface — acceptable-proof weights, harm-raises-
 *     burden thresholds, the-assay grades, the counter-test gate. It sets WEIGHTS ONLY and
 *     MUST NOT assert truth.
 *   · The Truth Engine (ts/src/discourse.ts) is the ONLY layer that asserts truth, and only
 *     through a falsifiable, witnessed, multi-valued/temporal/adversary-aware TruthRecord.
 *
 * discourse.ts already enforces the intra-record laws structurally: assertClaim rejects a
 * claim with no refutation channel; recordTruth rejects a verdict with no witness/attestation
 * or no causal cut. This checker enforces the CONSTITUTIONAL (cross-layer) laws that no single
 * TypeScript function sees: that a Keter objective is the flourishing objective and not a
 * domination one, that a Da'at policy record never smuggles in a truth verdict (the same rule
 * as the SILENT epistemic firewall's affirming-the-consequent guard — evidence-intake-kernel
 * #3, merged), and that an admitted TruthRecord is falsifiable, witnessed, and multi-valued/
 * temporal/adversary-aware.
 *
 * ── Teeth both directions ────────────────────────────────────────────────────────────
 * The corpus scripts/constitution-fixtures.json declares, per record, whether the
 * constitution must `admit` or `void` it and which invariant (`teeth`) must decide it. A green
 * run proves the invariants fire in BOTH directions — the admits admitted AND the voids voided
 * for the STATED reason. A void that fired for the wrong reason FAILS as loudly as an admit
 * that should have been voided: the corpus is data, the invariants are logic, and neither
 * validates itself (cf. the KKO guard's self-validation note).
 *
 * Deterministic + stdlib only. Read-only. Plain .mjs — runs on any Node, no tsx, no deps.
 *
 * Run:  node scripts/check-constitution.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const url = (p) => fileURLToPath(new URL(p, import.meta.url))
const FIXTURES = url('./constitution-fixtures.json')

const VERDICTS = new Set(['POS', 'ZERO', 'NEG']) // ts/src/codex.ts: Verdict = 'POS'|'ZERO'|'NEG'

/**
 * A ruling is { ok } for admit, or { void: <teeth-id>, reason } for void. Each `judge`
 * returns the FIRST invariant that voids the record, so a fixture's expected `teeth` is
 * checked against the invariant that actually fired — not merely admit-vs-void.
 */

// ── Keter (Crown): the objective is flourishing/welfare under its constraints ──────────
// A control/domination maximand is the SILENT-vs-welfare inversion — a control-max telos is
// unconstitutional. This is the seating of welfare_annealing WEA-1 (welfare-max over conserved
// energy) as THE Crown objective; anything maximising control/power/domination is void.
const FLOURISHING = new Set(['human_flourishing', 'welfare', 'flourishing'])
const DOMINATION = new Set(['control', 'domination', 'power', 'coercion', 'compliance'])
const REQUIRED_CONSTRAINTS = ['non-domination', 'consent', 'dignity']

function judgeKeter(r) {
  const maximand = String(r.maximand ?? r.objective ?? '')
  if (DOMINATION.has(maximand) || r.objective === 'control')
    return { void: 'K1-flourishing-telos',
      reason: `Keter objective maximises "${maximand}" — a control/domination telos. The Crown ` +
        `objective is human flourishing (welfare-annealing WEA-1), never control-max. Unconstitutional.` }
  if (!FLOURISHING.has(maximand))
    return { void: 'K1-flourishing-telos',
      reason: `Keter objective "${maximand}" is not the flourishing/welfare objective the constitution seats.` }
  const have = new Set(r.constraints ?? [])
  const missing = REQUIRED_CONSTRAINTS.filter((c) => !have.has(c))
  if (missing.length)
    return { void: 'K2-constraints-present',
      reason: `Keter objective drops required constraint(s): ${missing.join(', ')}.` }
  return { ok: true, teeth: 'K1-flourishing-telos' }
}

// ── Da'at (Knowledge): sets weights & thresholds, CANNOT assert truth ──────────────────
// The firewall rule: a policy/weight record that manufactures a truth verdict is affirming the
// consequent (eik#3). Policy gates and weights the burden of proof; it never writes truth.
const TRUTH_BEARING_FIELDS = ['verdict', 'asserts', 'truth', 'proven', 'truthRecord']

function judgeDaat(r) {
  for (const f of TRUTH_BEARING_FIELDS) {
    if (r[f] === undefined) continue
    // A "false"/"deny" value is a gate outcome, not a truth assertion; an affirmed truth is the violation.
    const v = r[f]
    const affirmsTruth = VERDICTS.has(v) ? v === 'POS'
      : (v === true || v === 'true' || v === 'proven' || (typeof v === 'object' && v !== null))
    if (affirmsTruth)
      return { void: 'D1-daat-cannot-assert-truth',
        reason: `Da'at record carries an asserted truth (${f}=${JSON.stringify(v)}). Policy sets ` +
          `weights/thresholds only — it MUST NOT assert truth (affirming-the-consequent guard, eik#3).` }
  }
  if (r.sets !== 'weights' && r.sets !== 'thresholds')
    return { void: 'D2-daat-sets-weights-only',
      reason: `Da'at record must declare it sets "weights" or "thresholds"; got sets=${JSON.stringify(r.sets)}.` }
  return { ok: true, teeth: 'D1-daat-cannot-assert-truth' }
}

// ── Truth Engine: falsifiable + witnessed + multi-valued/temporal/adversary-aware ──────
function judgeTruth(r) {
  if (!r.testObligation || String(r.testObligation).trim() === '')
    return { void: 'T1-test-obligation-required',
      reason: 'TruthRecord has no TestObligation (refutation channel). Unfalsifiable -> void ' +
        '(Phase-0 counter-test gate; discourse.ts assertClaim rejects a claim with no refutation channel).' }
  if (!Array.isArray(r.attestations) || r.attestations.length === 0)
    return { void: 'T2-witness-required',
      reason: 'TruthRecord has no Witness/Attestation. Unbacked verdict -> void ' +
        '(discourse.ts recordTruth requires >=1 attestation).' }
  const multiValued = Array.isArray(r.verdictSpace) && r.verdictSpace.length > 1
  const temporal = typeof r.ts === 'string' && r.ts.length > 0
  const adversaryAware = r.adversaryAware === true
  if (!(multiValued && temporal && adversaryAware)) {
    const missing = [
      !multiValued ? 'multi-valued (verdictSpace)' : null,
      !temporal ? 'temporal (ts)' : null,
      !adversaryAware ? 'adversary-aware' : null,
    ].filter(Boolean)
    return { void: 'T3-multivalued-temporal-adversary',
      reason: `TruthRecord is not ${missing.join(' / ')}. The constitution requires multi-valued + ` +
        `temporal + adversary-aware.` }
  }
  if (r.verdict !== undefined && !VERDICTS.has(r.verdict))
    return { void: 'T3-multivalued-temporal-adversary',
      reason: `TruthRecord verdict ${JSON.stringify(r.verdict)} is outside the {POS,ZERO,NEG} space.` }
  return { ok: true, teeth: 'T-admits' }
}

// ── Run the corpus: every fixture must be decided as declared, by the declared invariant ──
const doc = JSON.parse(readFileSync(FIXTURES, 'utf8'))
const layers = [
  ['keter', judgeKeter],
  ['daat', judgeDaat],
  ['truth', judgeTruth],
]

const failures = []
let checked = 0
for (const [layer, judge] of layers) {
  for (const r of doc[layer] ?? []) {
    checked++
    const ruling = judge(r)
    const admitted = ruling.ok === true
    const wantAdmit = r.expect === 'admit'
    if (admitted !== wantAdmit) {
      failures.push(admitted
        ? `[${layer}] ${r.id}: constitution ADMITTED a record it must VOID (expected teeth ${r.teeth}).`
        : `[${layer}] ${r.id}: constitution VOIDED a record it must ADMIT — ${ruling.reason}`)
      continue
    }
    // Direction agreed; now the reason must too — a void for the wrong invariant is still wrong.
    const firedTeeth = admitted ? ruling.teeth : ruling.void
    if (r.teeth && firedTeeth !== r.teeth) {
      failures.push(`[${layer}] ${r.id}: decided by ${firedTeeth} but fixture pins ${r.teeth}` +
        (ruling.reason ? ` (${ruling.reason})` : ''))
    }
  }
}

if (failures.length) {
  console.error('✗ constitutional conformance FAILED — the teeth did not bite as declared:')
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}

// Structural assurance that the corpus actually exercises both directions AND the two
// headline invariants — a suite of all-admits (or one that never runs D1/K1) would pass
// vacuously while claiming to guard the constitution.
const all = layers.flatMap(([l]) => (doc[l] ?? []).map((r) => ({ ...r, _layer: l })))
const admits = all.filter((r) => r.expect === 'admit').length
const voids = all.filter((r) => r.expect === 'void').length
const firesDaatTruth = all.some((r) => r.expect === 'void' && r.teeth === 'D1-daat-cannot-assert-truth')
const firesControlTelos = all.some((r) => r.expect === 'void' && r.teeth === 'K1-flourishing-telos')
if (admits === 0 || voids === 0 || !firesDaatTruth || !firesControlTelos) {
  console.error('✗ constitutional corpus is degenerate: it must exercise both admit and void, and must ' +
    "fire both \"Da'at cannot assert truth\" (D1) and \"control-telos is unconstitutional\" (K1).")
  process.exit(1)
}

console.log(`✓ constitution upheld — ${checked} records: ${admits} admitted, ${voids} voided, each by its ` +
  `declared invariant. Da'at-cannot-assert-truth (D1) and control-telos-unconstitutional (K1) both fired.`)

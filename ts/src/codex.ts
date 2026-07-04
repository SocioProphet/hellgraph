/**
 * codex — coherence-encoding layer for the AtomSpace (GKG-CODEX formal layer, v0).
 *
 * Every node's content is embedded into several orthogonal spaces (the phi-registry).
 * The vector of embeddings is the content's MANIFEST. Re-deriving it and diffing yields
 * a SYNDROME that not only detects change but CLASSIFIES it — substitution / transposition
 * / spacing / structural — because each embedding is invariant to a different transform.
 * The residue facet is a Redundant Residue Number System (coprime moduli {5,7,17,19}):
 * real single-symbol error detection, not analogy.
 *
 * Scope (honest): certifies ENCODING INTEGRITY and CLASSIFIES CHANGE across formal facets.
 * NOT a semantic-truth oracle — two different texts can share a manifest, but they cannot
 * differ in letter-value, order, spacing, structure, or residue without the syndrome firing.
 *
 * CONFORMANCE: this is a byte-for-byte port of the reference oracle `gkg_codex.py`. It MUST
 * reproduce the frozen reference vectors (codex-vectors.json) exactly; that fixture is the
 * cross-implementation parity contract (cf. the TriTRPC byte-parity discipline). Latin v0.
 *
 * TriTRPC BINDING (docs/specs/12): GKG-CODEX rides as a Path-B-family CTRL243 profile, never
 * Path-A; status is TWO axes — verdict (State243.epistemic) + evidence (CTRL243.evidence), no
 * third vocabulary; residue moduli/topic23 must derive from the frozen topic23.v1. Ternary is
 * unbalanced {0,1,2} in v0. Fixture-freeze (G4) is BLOCKED upstream on CTRL243 profile
 * allocation + topic23.v1 ownership — this module stays Reference-only until then.
 */

import { createHash } from 'node:crypto'
import type { AtomSpace, AtomChangeEvent } from './atomspace.js'

// ─── Normalisation ───────────────────────────────────────────────────────────────
// Latin ASCII a=1..z=26; non-Latin content is out of v0 scope (future script facets).
function lettersOnly(t: string): string {
  let out = ''
  for (const c of t) if (c >= 'A' && c <= 'Z') out += c.toLowerCase(); else if (c >= 'a' && c <= 'z') out += c
  return out
}
function val(c: string): number {
  return c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 96 : 0
}

// ─── phi-registry (formal, deterministic) ────────────────────────────────────────
export const COPRIME_MODULI = [5, 7, 17, 19] as const

/** Σ letter values. Order-invariant, spacing-invariant. Catches substitution, structural. */
export function phiGematria(t: string): number {
  let s = 0
  for (const c of lettersOnly(t)) s += val(c)
  return s
}
/** Position-weighted sum. Order-SENSITIVE, spacing-invariant. Catches subst, transp, struct. */
export function phiSequence(t: string): number {
  const s = lettersOnly(t)
  let acc = 0
  for (let i = 0; i < s.length; i++) acc += (i + 1) * val(s[i]!)
  return acc
}
/** Whitespace-run widths. Sensitive to layout ONLY. */
export function phiSpacing(t: string): number[] {
  return (t.trim().match(/\s+/g) ?? []).map((g) => g.length)
}
/** Coarse size signature (n_letters, n_tokens). Structural-SENSITIVE. */
export function phiStructure(t: string): [number, number] {
  const trimmed = t.trim()
  return [lettersOnly(t).length, trimmed === '' ? 0 : trimmed.split(/\s+/).length]
}
/** RRNS redundant residues of the gematria value across coprime moduli. */
export function phiResidue(t: string): number[] {
  const g = phiGematria(t)
  return COPRIME_MODULI.map((m) => g % m)
}

export type Transform = 'substitution' | 'transposition' | 'spacing' | 'structural'
const SUBST: Transform = 'substitution'
const TRANSP: Transform = 'transposition'
const SPACING: Transform = 'spacing'
const STRUCT: Transform = 'structural'

type FacetValue = number | number[]
interface FacetDef { fn: (t: string) => FacetValue; catches: ReadonlySet<Transform> }

/** The formal facet registry. `catches` sensitivity profiles ARE the decoder. */
export const PHI: Record<string, FacetDef> = {
  gematria:  { fn: phiGematria,  catches: new Set([SUBST, STRUCT]) },
  sequence:  { fn: phiSequence,  catches: new Set([SUBST, TRANSP, STRUCT]) },
  spacing:   { fn: phiSpacing,   catches: new Set([SPACING, STRUCT]) },
  structure: { fn: phiStructure, catches: new Set([STRUCT]) },
  residue:   { fn: phiResidue,   catches: new Set([SUBST, STRUCT]) },
}
const FACET_ORDER = ['gematria', 'sequence', 'spacing', 'structure', 'residue'] as const

// ─── Manifest ─────────────────────────────────────────────────────────────────────
export interface Manifest {
  gematria: number
  sequence: number
  spacing: number[]
  structure: [number, number]
  residue: number[]
  _sha256: string
  _division?: number
}

/** Multi-space signature of content. `division` is graph-assigned at ingest, not derived. */
export function manifest(text: string, division?: number): Manifest {
  const m = {
    gematria: phiGematria(text),
    sequence: phiSequence(text),
    spacing: phiSpacing(text),
    structure: phiStructure(text),
    residue: phiResidue(text),
    _sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
  } as Manifest
  if (division !== undefined) m._division = division
  return m
}

// ─── Syndrome + decoder ─────────────────────────────────────────────────────────────
export type ChangeClass = 'INTACT' | Transform | 'compound/unknown'
/** Verdict — the State243.epistemic axis (TriTRPC reconciliation §16.4): WHAT the outcome is. */
export type Verdict = 'POS' | 'ZERO' | 'NEG'
/**
 * Evidence tier — the CTRL243.evidence axis (§16.4): HOW the manifest/syndrome was computed.
 * This is a SEPARATE axis from the verdict; GKG-CODEX MUST NOT introduce a third status
 * vocabulary. T1 deterministic formal facet → exact; T2 empirical (SCT) → sampled; ρ
 * cross-transform validated → verified.
 */
export type EvidenceTier = 'exact' | 'sampled' | 'verified'
export interface Syndrome {
  breaks: string[]
  intact: string[]
  class: ChangeClass
  verdict: Verdict
  evidence: EvidenceTier
  /** Byte-exact integrity: did the manifest sha match? False with class INTACT = a sub-formal
   *  change (digits/punctuation only — invisible to the letters-only formal facets). */
  exact: boolean
}

// Per-facet evidence tier. v0 formal facets are all T1 deterministic → 'exact'; empirical
// (sct) and ρ cross-transform facets shift this when added.
const FACET_EVIDENCE: Record<string, EvidenceTier> = {
  gematria: 'exact', sequence: 'exact', spacing: 'exact', structure: 'exact', residue: 'exact',
}
const TIER_RANK: Record<EvidenceTier, number> = { exact: 0, verified: 1, sampled: 2 }
/** The weakest evidence tier among the involved facets (exact strongest). */
export function evidenceTierOf(facets: Iterable<string>): EvidenceTier {
  let tier: EvidenceTier = 'exact'
  for (const f of facets) {
    const t = FACET_EVIDENCE[f] ?? 'sampled'
    if (TIER_RANK[t] > TIER_RANK[tier]) tier = t
  }
  return tier
}

// Canonical minimal syndromes → class (sorted-break key → class). Freezing this table
// freezes the semantics.
const CANONICAL: Record<string, Transform> = {
  'gematria|residue|sequence': SUBST,
  'sequence': TRANSP,
  'spacing': SPACING,
  'gematria|residue|sequence|spacing|structure': STRUCT,
}

function facetEq(a: FacetValue | undefined, b: FacetValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return a === b
}

export function classify(breaks: Set<string>): ChangeClass {
  if (breaks.size === 0) return 'INTACT'
  const key = [...breaks].sort().join('|')
  if (key in CANONICAL) return CANONICAL[key]!
  if (breaks.has('structure')) return STRUCT // any size change dominates
  // best-effort: the transform whose catch-set best matches the break-set
  let best: ChangeClass = 'compound/unknown'
  let score = -1
  for (const tf of [SUBST, TRANSP, SPACING, STRUCT]) {
    const catchers = new Set(Object.entries(PHI).filter(([, d]) => d.catches.has(tf)).map(([n]) => n))
    let inter = 0
    for (const n of catchers) if (breaks.has(n)) inter++
    let sym = 0
    for (const n of catchers) if (!breaks.has(n)) sym++
    for (const n of breaks) if (!catchers.has(n)) sym++
    const j = inter - sym * 0.1
    if (j > score) { best = tf; score = j }
  }
  return best
}

/** INTACT→POS · canonical single change class→NEG (tamper/corruption) · compound/unknown→ZERO. */
export function verdictOf(cls: ChangeClass): Verdict {
  if (cls === 'INTACT') return 'POS'
  if (cls === 'compound/unknown') return 'ZERO'
  return 'NEG'
}

/** Recompute the manifest of `currentText` and diff against a sealed base manifest. */
export function syndrome(base: Manifest, currentText: string): Syndrome {
  const cur = manifest(currentText)
  const breaks = new Set<string>()
  for (const k of FACET_ORDER) {
    if (!facetEq((base as unknown as Record<string, FacetValue>)[k], (cur as unknown as Record<string, FacetValue>)[k])) breaks.add(k)
  }
  const cls = classify(breaks)
  const intact = FACET_ORDER.filter((k) => !breaks.has(k))
  // Byte-exact backstop: the formal facets are letters-only, so a digits/punctuation-only
  // change can leave every formal facet intact. The manifest sha catches it → tamper (NEG).
  const exact = base._sha256 === cur._sha256
  const verdict: Verdict = cls === 'INTACT' && !exact ? 'NEG' : verdictOf(cls)
  return { breaks: [...breaks].sort(), intact, class: cls, verdict, evidence: evidenceTierOf(FACET_ORDER), exact }
}

// ─── Extension facets (declared, not implemented — registry contract, §7.2) ─────────
export const ERR_FACET_NOT_IMPLEMENTED = 'ERR_FACET_NOT_IMPLEMENTED'
export const ERR_MANIFEST_MISMATCH = 'ERR_MANIFEST_MISMATCH'
const notImpl = (facet: string) => (): never => { throw new Error(`${ERR_FACET_NOT_IMPLEMENTED}: ${facet}`) }
export const phiAbjad = notImpl('abjad (Arabic value table)')
export const phiIsopsephy = notImpl('isopsephy (Greek Milesian table)')
export const phiCjkIds = notImpl('cjk_ids (IDS decomposition → graph)')
export const phiSctTopology = notImpl('sct_topology (render-dependent, empirical)')
// atbash = reflection permutation (§7.2). Balanced-ternary-native negation would give it a
// hardware representation IF Path-B ever goes balanced (§16.6) — v0 assumes unbalanced {0,1,2}.
export const phiAtbash = notImpl('atbash (reflection permutation)')

// ─── AtomSpace integration — default-on passive seal ────────────────────────────────

const CODEX_KEY = 'codex:manifest'
const INTEGRITY_KEY = 'codex:integrity' // FULL sha256 — the manifest's _sha256 is 64-bit (oracle parity)

const fullHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')

/** Seal content onto an atom: the `codex:manifest` (parity) + a full-256-bit integrity hash.
 *  Passive: no structural change. */
export function sealAtomContent(space: AtomSpace, handle: string, content: string, division?: number): Manifest {
  const m = manifest(content, division)
  space.setValue(handle, CODEX_KEY, { kind: 'string', value: [JSON.stringify(m)] })
  space.setValue(handle, INTEGRITY_KEY, { kind: 'string', value: [fullHash(content)] })
  return m
}

/** Verify an atom's current content against its sealed manifest; classify any drift. */
export function verifyAtomContent(space: AtomSpace, handle: string, currentContent: string): Syndrome {
  const atom = space.getAtom(handle)
  const raw = atom?.values[CODEX_KEY]
  if (!raw || raw.kind !== 'string' || !raw.value[0]) throw new Error(`${ERR_MANIFEST_MISMATCH}: atom ${handle} is unsealed`)
  const syn = syndrome(JSON.parse(raw.value[0]) as Manifest, currentContent)
  // Full-256-bit backstop: the manifest's _sha256 is truncated to 64 bits, which is birthday-weak
  // for tamper-evidence (~2^32 to force a collision that also matches the formal facets). Compare
  // the full hash — any byte change, including one that fools the 64-bit manifest, forces NEG.
  const integ = atom!.values[INTEGRITY_KEY]
  if (integ?.kind === 'string' && integ.value[0] && fullHash(currentContent) !== integ.value[0]) {
    return { ...syn, exact: false, verdict: 'NEG' }
  }
  return syn
}

/**
 * Attach a passive, default-on sealer: every newly added Node atom is sealed at ingest,
 * with zero author behavior change. Content defaults to the atom's name; the sealer only
 * fires on live add_atom events (not on replay, where the seal is already persisted).
 * Returns an unsubscribe function.
 */
export function attachCodexSealer(
  space: AtomSpace,
  opts: { content?: (handle: string) => string | undefined } = {},
): () => void {
  const onChange = (ev: AtomChangeEvent): void => {
    if (ev.op !== 'add_atom') return
    const handle = ev.entry.payload['handle'] as string | undefined
    if (!handle) return
    const nameFromPayload = ev.entry.payload['name'] as string | undefined
    // AtomSpace emits 'change' BEFORE it indexes the atom, so the atom isn't yet queryable
    // or settable here. Defer the seal one microtask — by then the atom exists and setValue
    // can attach the manifest. Still passive: no author behavior change, no blocking.
    queueMicrotask(() => {
      if (!space.getAtom(handle)) return
      const content = opts.content ? opts.content(handle) : (space.getAtom(handle)?.name ?? nameFromPayload)
      if (content === undefined) return
      sealAtomContent(space, handle, content)
    })
  }
  space.on('change', onChange)
  return () => { space.off('change', onChange) }
}

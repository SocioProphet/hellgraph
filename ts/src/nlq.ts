/**
 * NLQ — the typed-plan compiler: a natural-language question becomes a SEALED, provenance-carrying
 * plan over a registry of typed Semantic Actions, without ever executing anything.
 *
 * The pipeline, end to end:
 *
 *   question
 *     → deterministic tokenization (spans preserved — every downstream claim points back at chars)
 *     → ontology-annotated tokens (pluggable annotators; lexicon + KKO-semantic ship built in)
 *     → side-effect-free RESTRICTED SEARCH over the typed action registry (bounded depth + beam)
 *     → sense-metric-ranked variant plans (coverage · groundedness · similarity)
 *     → the winning plan emitted as a sealed receipt bound to the graph snapshot
 *
 * What makes it a *typed* compiler rather than a prompt: actions are discovered and composed by
 * TYPE. An annotated concept T binds an input declared as U exactly when `isA(T, U)` in the
 * AtomSpace `TypeLattice` — so `:ContactList` satisfies a `:List` slot by subsumption, and nothing
 * satisfies a slot it is not under. The registry is the vendored `SemanticAction` contract from
 * `sourceos-spec` (PR #210), validated at declare time against the schema's own bytes, whose
 * SHA-256 is asserted at import: a drifted contract fails LOUDLY at load, never silently at plan time.
 *
 * Three rules the search obeys, all inherited from the contract's normative purity rule:
 *
 *   1. **Purity.** Search never mutates the store. It reads the type lattice and the snapshot and
 *      returns; `store.version()` is identical before and after. Nothing is executed to find out
 *      what it would return — applicability is decided statically, by type.
 *   2. **Effects are proposed, never taken.** An action declaring `sideEffects: 'effect-request'`
 *      is a LEAF OF THE DATAFLOW: it is never offered as an input provider, because consuming its
 *      output is what would imply running it. It therefore only ever appears as the plan root,
 *      carrying an `EffectRequestProposal` with `status: 'proposed'` — so the MPCC lifecycle
 *      (EffectRequest → EffectDecision → EffectRecord; decision before action) is never bypassed.
 *      Its own arguments may still be computed by pure actions ("resolve the list, then PROPOSE
 *      sending to it"): computing an argument is not taking the effect.
 *   3. **Mentions are not values.** A concept annotated in the text is evidence that a *type* is in
 *      play, not that a *value* is in hand. Non-literal slots must therefore be filled by an action
 *      that produces the value or by a declared registry default — which is precisely what forces
 *      "contact lists in my org" to DECOMPOSE into `GetContactLists ← GetOrganization` instead of
 *      collapsing into one node with an imaginary argument. Literal slots (types under
 *      `NLQ_LITERAL_TYPE`) are the exception: there the span text IS the value.
 *
 * The sense metric ranks variants on three axes, with explicit weights carried in the result:
 *
 *   • coverage     — content tokens the plan actually consumes, over content tokens available.
 *   • groundedness — 1 − creativity. Every plan node NOT grounded in a token span or a registry
 *     default is an invention, so it is routed through `admitClaim` as a `model-generated` claim and
 *     the node's weight becomes the admissibility discount (×0.5 by default). The creativity penalty
 *     IS the opinion discount — one mechanism, not a parallel heuristic. If the admissibility context
 *     excludes opinion outright, the invented node is inadmissible and the whole variant is dropped:
 *     an excluded claim carries weight 0 and "must not enter the reasoning context at all".
 *   • similarity   — structural alignment: how well the plan's pre-order walk tracks the left-to-right
 *     order of the spans it consumed (English questions tend to run outer-intent → inner-argument, so
 *     a plan that reads in question order is the better reading of the question). A stated prior, not
 *     a law — it is one weighted axis, never a filter.
 *
 * The result seals exactly like `enrich` / `explore`: sha256 over the ranked output plus the
 * `{seq,nodes,edges}` snapshot, where `seq` is the store's monotonic logical clock — the real
 * receipt binding (counts alone collide; the clock does not). The pinned contract digest is sealed
 * in too, so a receipt names the exact action contract it was compiled against. Same inputs against
 * the same graph state ⇒ byte-identical seal.
 */
import { createHash } from 'node:crypto'
import type { HellGraphStore } from './store'
import type { TypeLattice } from './atomspace'
import { admitClaim, type AdmissibilityContext, type AdmissibilityDecision } from './claim-admissibility'
import { cosineSim, type EmbedFn } from './semantic'
import {
  SEMANTIC_ACTION_SCHEMA_TEXT,
  SEMANTIC_ACTION_SCHEMA_SHA256,
  SEMANTIC_ACTION_SPEC_VERSION,
} from './semantic-action-data'

// ─── Vendored contract: sha-asserted at import ──────────────────────────────────

/** A parsed JSON Schema object. Exported with `validateAgainst`, which takes one. */
export type SchemaObj = Record<string, unknown>

// ─── format: one list, and it IS the list of checks that exist ──────────────────

/** `format: "uri"` — require an absolute URI (a scheme). Rejects bare `:Thing` shorthand. */
function isAbsoluteUri(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(s)
}

/**
 * Length of `month` in `year`, by the proleptic Gregorian calendar.
 *
 * Computed rather than asked of `Date`: `Date.UTC(year, …)` maps a two-digit year onto 19xx, so
 * `Date.UTC(50, 2, 0)` answers for 1950 — a wrong answer this function must not inherit for the
 * years `\d{4}` admits.
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return DAYS_IN_MONTH[month - 1] as number
}

/**
 * `format: "date-time"` — an ISO-8601 date-time in its RFC-3339 profile: date, `T`, time, and an
 * EXPLICIT offset (`Z` or ±HH:MM). A bare date (`2026-07-29`) names a day, not an instant, and does
 * not pass. (The violation message below says "ISO-8601 date-time"; the two names are used for the
 * same rule throughout, and RFC 3339 is the profile that makes the offset mandatory.)
 *
 * Shape is necessary but NOT sufficient. A purely structural regex accepts `2026-99-99T99:99:99Z`,
 * which has the right punctuation and names no time — so a value that no clock could ever produce
 * would satisfy a check whose entire purpose is that a declared format is an enforced one. The
 * component ranges are therefore checked too, and the day against the real length of that month in
 * that year, so `2026-02-30` is rejected rather than waved through.
 */
function isIsoDateTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(s)
  if (m === null) return false
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  if (Number(m[4]) > 23 || Number(m[5]) > 59) return false
  // 60 is a leap second, which RFC 3339 permits (`23:59:60Z`).
  if (Number(m[6]) > 60) return false
  // Present together or not at all — the regex alternation guarantees it.
  if (m[7] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false
  return true
}

/**
 * Every `format` this validator genuinely enforces, with the phrase its violation reads as.
 *
 * This map is the SINGLE source of truth for both halves of the guard: `validateAgainst` enforces
 * through it, and `assertSupportedKeywords` admits a declared `format` only if it has a key here.
 * Adding a name to the accept-list without writing the check is therefore not expressible — the
 * accept-list IS the set of checks. (A vacuous check that rejects nothing is still expressible;
 * `nlq.test.ts` demands a rejected counter-example per format, which closes that door.)
 *
 * A Map, not an object: `'constructor' in {}` is true, and a prototype key must never read as an
 * implemented format.
 */
const FORMAT_CHECKS: ReadonlyMap<string, { check: (s: string) => boolean; expected: string }> = new Map([
  ['date-time', { check: isIsoDateTime, expected: 'an ISO-8601 date-time' }],
  ['uri', { check: isAbsoluteUri, expected: 'an absolute URI' }],
])

/**
 * True when a vendored contract may declare `format: <name>` — i.e. when `validateAgainst`
 * implements it.
 *
 * A FUNCTION over `FORMAT_CHECKS`, not an exported collection. This was
 * `export const IMPLEMENTED_FORMATS: ReadonlySet<string>`, and `ReadonlySet` is a compile-time
 * fiction: the runtime value is a live `Set`, so `(IMPLEMENTED_FORMATS as Set<string>).add('email')`
 * widened the accept-list without adding a check — and `validateAgainst` skips a format it has no
 * entry for, so `format: "email"` then passed the bar and was enforced by nobody. That is the exact
 * declared-unenforced gap this module exists to close, reachable from outside the module.
 * (Copilot review on #37, low-confidence channel.) Asking `FORMAT_CHECKS` on every call means the
 * accept-list cannot be widened without adding the check that defines it.
 */
export function isImplementedFormat(format: string): boolean {
  return FORMAT_CHECKS.has(format)
}

/**
 * The implemented `format` names, as a fresh sorted snapshot.
 *
 * A new array per call AND frozen: `readonly string[]` is erased at runtime exactly as
 * `ReadonlySet` was, so the freeze is what makes a mutation attempt fail loudly (in strict mode,
 * which every module here is) instead of silently succeeding on a copy the caller then believes in.
 */
export function implementedFormats(): readonly string[] {
  return Object.freeze([...FORMAT_CHECKS.keys()].sort())
}

/**
 * True when `value` satisfies `format: <name>`. THROWS for a format nothing implements — asking
 * about an unenforced format must never quietly answer "fine". This is the one door for a call site
 * that needs a contract's format checked before it builds the object it will validate.
 */
export function matchesFormat(format: string, value: string): boolean {
  const f = FORMAT_CHECKS.get(format)
  if (f === undefined) {
    throw new Error(
      `nlq: format '${format}' is not implemented by validateAgainst ` +
      `(implemented: ${implementedFormats().join(', ')})`)
  }
  return f.check(value)
}

/**
 * Keywords carrying validation semantics that `validateAgainst` implements. Anything else that could
 * change what validates ($ref, allOf, anyOf, …) must fail LOUDLY at import rather than silently
 * validate less than the contract says — the registry's whole claim is conformance.
 *
 * `format` is deliberately absent: it is admitted by VALUE, not by name (see `FORMAT_CHECKS` and the
 * explicit branch in `assertSupportedKeywords`). Listing the bare keyword would clear this bar for
 * `format: "email"` and then enforce nothing — the exact silent under-enforcement the bar exists to
 * prevent. Its absence is also fail-safe: delete that branch and `format` becomes an unknown
 * keyword, which throws.
 */
const SUPPORTED_KEYWORDS = new Set([
  'type', 'const', 'enum', 'pattern', 'minLength', 'required',
  'properties', 'additionalProperties', 'items', 'uniqueItems',
])
/** Pure annotations — no validation effect; safe to ignore. */
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples'])

/**
 * Assert a vendored schema uses only keywords `validateAgainst` implements. Exported because every
 * vendored sourceos-spec contract in the engine (SemanticAction here, EffectRequest in
 * `vendor-graph.ts`) must clear the same bar at import: a contract using an unimplemented keyword
 * fails LOUDLY rather than silently validating less than it says.
 *
 * `format` is checked by VALUE, not by name. `format: "email"` names a keyword the validator has,
 * carrying a constraint it does not implement — passing it on the strength of the keyword would be
 * this guard failing at its own job, so the value must satisfy `isImplementedFormat`, which reads
 * `FORMAT_CHECKS` itself rather than any exported copy of its keys.
 */
export function assertSupportedKeywords(schema: unknown, at: string): void {
  if (Array.isArray(schema)) { schema.forEach((v, i) => assertSupportedKeywords(v, `${at}[${i}]`)); return }
  if (schema === null || typeof schema !== 'object') return
  for (const [k, v] of Object.entries(schema as SchemaObj)) {
    if (k === 'properties' && v && typeof v === 'object') {
      for (const [pk, pv] of Object.entries(v as SchemaObj)) assertSupportedKeywords(pv, `${at}.properties.${pk}`)
      continue
    }
    if (k === 'items' || k === 'additionalProperties') { assertSupportedKeywords(v, `${at}.${k}`); continue }
    if (k === 'format') {
      if (typeof v !== 'string' || !isImplementedFormat(v)) {
        throw new Error(
          `nlq: schema format ${JSON.stringify(v)} at ${at} is declared by the contract but is NOT ` +
          `implemented by validateAgainst (implemented: ${implementedFormats().join(', ')}) — ` +
          'a declared format that nothing checks validates less than the contract says; implement it ' +
          'in nlq.ts (and its tests) before re-vendoring a schema that declares it')
      }
      continue
    }
    if (SUPPORTED_KEYWORDS.has(k) || ANNOTATION_KEYWORDS.has(k)) continue
    throw new Error(
      `nlq: schema keyword '${k}' at ${at} is outside the implemented validation subset — extend the ` +
      'validator in nlq.ts (and its tests) before re-vendoring a schema that uses it')
  }
}

function loadContract(): SchemaObj {
  const bytes = Buffer.from(SEMANTIC_ACTION_SCHEMA_TEXT, 'utf8')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== SEMANTIC_ACTION_SCHEMA_SHA256) {
    throw new Error(
      `nlq: vendored SemanticAction.json drifted: sha256 ${actual} != pinned ${SEMANTIC_ACTION_SCHEMA_SHA256}; ` +
      're-vendor byte-identical from sourceos-spec and re-run scripts/gen-semantic-action.mjs')
  }
  const schema = JSON.parse(bytes.toString('utf8')) as SchemaObj
  assertSupportedKeywords(schema, 'SemanticAction')
  return schema
}

/** The vendored SemanticAction JSON Schema, sha-verified at import. */
export const SEMANTIC_ACTION_SCHEMA: Readonly<SchemaObj> = Object.freeze(loadContract())

/** Identity of the contract every registered action is validated against — sealed into receipts. */
export interface ContractRef {
  schema: string
  specVersion: string
  sha256: string
}

export const SEMANTIC_ACTION_CONTRACT: Readonly<ContractRef> = Object.freeze({
  schema: String(SEMANTIC_ACTION_SCHEMA['$id'] ?? 'SemanticAction.json'),
  specVersion: SEMANTIC_ACTION_SPEC_VERSION,
  sha256: SEMANTIC_ACTION_SCHEMA_SHA256,
})

// ─── Minimal 2020-12 validator (the subset the contract uses) ───────────────────

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * Validate `value` against the implemented 2020-12 subset of `schema`, appending violations to
 * `errs`. Shared by every vendored-contract validator in the engine so there is ONE validation
 * subset, guarded by ONE `assertSupportedKeywords` bar — never two that can drift apart.
 * `format` is enforced for every entry in `FORMAT_CHECKS`, and the bar refuses a contract declaring
 * any other one — so for anything that cleared import, a declared format is an enforced format.
 */
export function validateAgainst(schema: SchemaObj, value: unknown, at: string, errs: string[]): void {
  const t = schema['type']
  if (typeof t === 'string') {
    const actual = jsonTypeOf(value)
    if (actual !== t) { errs.push(`${at}: expected type ${t}, got ${actual}`); return }
  }
  if ('const' in schema && value !== schema['const']) {
    errs.push(`${at}: must equal ${JSON.stringify(schema['const'])}`)
  }
  const en = schema['enum']
  if (Array.isArray(en) && !en.includes(value)) {
    errs.push(`${at}: must be one of ${JSON.stringify(en)}`)
  }
  if (typeof value === 'string') {
    const p = schema['pattern']
    if (typeof p === 'string' && !new RegExp(p).test(value)) errs.push(`${at}: does not match pattern ${p}`)
    const ml = schema['minLength']
    if (typeof ml === 'number' && value.length < ml) errs.push(`${at}: shorter than minLength ${ml}`)
    const fmt = schema['format']
    if (typeof fmt === 'string') {
      // `assertSupportedKeywords` refuses a contract declaring a format with no check, so `f` is
      // present for every schema that cleared import. A hand-built schema that skipped the bar
      // degrades to unchecked rather than throwing mid-validation: the bar polices formats, not this.
      const f = FORMAT_CHECKS.get(fmt)
      if (f !== undefined && !f.check(value)) errs.push(`${at}: '${value}' is not ${f.expected}`)
    }
  }
  if (Array.isArray(value)) {
    const items = schema['items']
    if (items && typeof items === 'object') {
      value.forEach((v, i) => validateAgainst(items as SchemaObj, v, `${at}[${i}]`, errs))
    }
    if (schema['uniqueItems'] === true) {
      const seen = new Set<string>()
      for (const v of value) {
        const k = JSON.stringify(v)
        if (seen.has(k)) { errs.push(`${at}: items must be unique`); break }
        seen.add(k)
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const req = schema['required']
    if (Array.isArray(req)) for (const k of req) if (!(k in obj)) errs.push(`${at}: missing required property '${k}'`)
    const props = (schema['properties'] ?? {}) as SchemaObj
    for (const k of Object.keys(obj).sort()) {
      const ps = props[k]
      if (ps && typeof ps === 'object') validateAgainst(ps as SchemaObj, obj[k], `${at}.${k}`, errs)
      else if (schema['additionalProperties'] === false) errs.push(`${at}: unexpected property '${k}'`)
    }
  }
}

// ─── SemanticAction — the vendored contract, in TypeScript ──────────────────────

export type Cardinality = 'one' | 'many'
export type SideEffects = 'none' | 'effect-request'
export type ConstraintKind = 'subClassOf' | 'instanceOf' | 'sameAs'

export interface SemanticActionInput {
  name: string
  /** Ontology concept URI typing bindable values. A value binds when its type `isA` this concept. */
  typeRef: string
  required: boolean
  cardinality: Cardinality
}

export interface SemanticActionOutput {
  typeRef: string
  cardinality: Cardinality
}

export interface SemanticActionConstraint {
  kind: ConstraintKind
  /** A declared input name, or the literal string `output`. */
  subject: string
  typeRef: string
}

export interface SemanticActionRegistryMeta {
  owner: string
  /** Deprecated actions stay resolvable for replaying old plans but are never offered to new searches. */
  deprecated: boolean
}

/** A declarative, typed action registration — mirrors `schemas/SemanticAction.json` exactly. */
export interface SemanticActionDef {
  id: string
  type: 'SemanticAction'
  specVersion: string
  name: string
  version: string
  inputs: SemanticActionInput[]
  output: SemanticActionOutput
  constraints: SemanticActionConstraint[]
  executorRef: string
  sideEffects: SideEffects
  registry: SemanticActionRegistryMeta
}

/**
 * Validate a candidate action against the vendored schema, plus the two invariants the contract
 * documents but JSON Schema cannot express (the "family validator" rules): input names are unique
 * within an action, and every constraint subject resolves to a declared input or to `output`.
 * Returns the (possibly empty) list of violations — never throws.
 */
export function validateSemanticAction(def: unknown): string[] {
  const errs: string[] = []
  validateAgainst(SEMANTIC_ACTION_SCHEMA as SchemaObj, def, 'SemanticAction', errs)
  if (errs.length > 0) return errs
  const d = def as SemanticActionDef
  const names = new Set<string>()
  for (const i of d.inputs) {
    if (names.has(i.name)) errs.push(`SemanticAction.inputs: duplicate input name '${i.name}'`)
    names.add(i.name)
  }
  for (const c of d.constraints) {
    if (c.subject !== 'output' && !names.has(c.subject)) {
      errs.push(`SemanticAction.constraints: subject '${c.subject}' resolves to no declared input (nor 'output')`)
    }
  }
  return errs
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

/**
 * The typed action registry. `declare` validates against the vendored contract and REJECTS anything
 * that does not conform, so an ill-formed action can never reach plan search. Stored defs are deep
 * frozen: the registry a search reads cannot be mutated underneath it.
 */
export class ActionRegistry {
  private readonly byId = new Map<string, SemanticActionDef>()
  private readonly byName = new Map<string, SemanticActionDef>()

  /** Validate and register. Throws on a contract violation or on an id/name collision. */
  declare(def: SemanticActionDef): SemanticActionDef {
    const errs = validateSemanticAction(def)
    if (errs.length > 0) {
      const ref = typeof (def as { id?: unknown })?.id === 'string' ? (def as { id: string }).id : '<unidentified>'
      throw new Error(`nlq: action ${ref} violates the SemanticAction contract: ${errs.join('; ')}`)
    }
    if (this.byId.has(def.id)) throw new Error(`nlq: action id '${def.id}' is already registered (identity is never reused)`)
    if (this.byName.has(def.name)) throw new Error(`nlq: action name '${def.name}' is already registered`)
    const stored = deepFreeze(JSON.parse(JSON.stringify(def)) as SemanticActionDef)
    this.byId.set(stored.id, stored)
    this.byName.set(stored.name, stored)
    return stored
  }

  /** Resolve by id or by registry name. */
  get(ref: string): SemanticActionDef | undefined {
    return this.byId.get(ref) ?? this.byName.get(ref)
  }

  has(ref: string): boolean { return this.get(ref) !== undefined }

  /** All registrations, id-sorted (deterministic). Deprecated ones are excluded unless asked for. */
  list(opts: { includeDeprecated?: boolean } = {}): SemanticActionDef[] {
    const all = [...this.byId.values()]
    const kept = opts.includeDeprecated === true ? all : all.filter((a) => !a.registry.deprecated)
    return kept.sort((a, b) => a.id.localeCompare(b.id))
  }

  get size(): number { return this.byId.size }
}

// ─── Tokenization ──────────────────────────────────────────────────────────────

export interface Token {
  /** Surface text exactly as it appears in the question. */
  text: string
  /** Lowercased form used for matching. */
  norm: string
  /** Character offsets into the question, `[start, end)`. */
  start: number
  end: number
  /** 0-based position in the token stream. */
  index: number
  /** Function word — carries no content, so it is excluded from the coverage denominator. */
  stop: boolean
}

/**
 * Closed-class English function words. Deliberately conservative: quantity words ("how", "many",
 * "count") are NOT stop words, because they are exactly the tokens that select a counting action and
 * should be rewarded as coverage when a plan consumes them.
 */
export const NLQ_STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did',
  'do', 'does', 'for', 'from', 'get', 'give', 'had', 'has', 'have', 'i', 'in', 'into', 'is', 'it',
  'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'show', 'that', 'the', 'their', 'them',
  'there', 'these', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'will', 'with', 'would',
  'you', 'your',
])

/**
 * Deterministic, dependency-free tokenizer. Splits on Unicode letter/number runs and preserves the
 * exact character span of every token, so every downstream claim can point back at the question.
 * No external NLP: the compiler must be sovereign and reproducible, and a tokenizer whose output
 * depends on a model version cannot seal.
 */
export function tokenizeQuestion(question: string): Token[] {
  const tokens: Token[] = []
  const re = /[\p{L}\p{N}]+/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(question)) !== null) {
    const text = m[0]
    const norm = text.toLowerCase()
    tokens.push({ text, norm, start: m.index, end: m.index + text.length, index: tokens.length, stop: NLQ_STOP_WORDS.has(norm) })
  }
  return tokens
}

// ─── Annotation ────────────────────────────────────────────────────────────────

export interface TokenSpan {
  /** Character offsets into the question, `[start, end)`. */
  start: number
  end: number
  /** The question text covered by the span. */
  text: string
  /** Token stream positions covered, ascending. */
  tokenIndices: number[]
}

export interface TokenAnnotation {
  tokenSpan: TokenSpan
  /**
   * What the span refers to: an ontology concept URI, or a registered action's id/name when the span
   * evokes the action directly ("how many" → the counting action). One annotation type; which of the
   * two it is falls out of registry resolution, so there is no second vocabulary to keep in sync.
   */
  conceptRef: string
  /** Which annotator produced it (`lexicon`, `kko-semantic`, or a caller's own). */
  source: string
  /** Annotator confidence in [0,1]. Carried through to provenance; does not gate the search. */
  confidence: number
}

export interface AnnotationContext {
  question: string
  registry: ActionRegistry
  lattice: TypeLattice
  store: HellGraphStore
}

/** Pluggable annotator. May be async (the KKO-semantic one embeds). */
export type Annotator = (
  tokens: readonly Token[],
  ctx: AnnotationContext,
) => TokenAnnotation[] | Promise<TokenAnnotation[]>

/** A concept and the surface terms that evoke it. `conceptRef` may also be an action id or name. */
export interface ConceptLexiconEntry {
  conceptRef: string
  terms: string[]
}

function spanOf(tokens: readonly Token[], question: string, from: number, to: number): TokenSpan {
  const first = tokens[from]!
  const last = tokens[to]!
  const idx: number[] = []
  for (let i = from; i <= to; i++) idx.push(i)
  return { start: first.start, end: last.end, text: question.slice(first.start, last.end), tokenIndices: idx }
}

/** Split a URI's local name into lowercase words: `…#ContactList` → `['contact','list']`. */
function localNameWords(uri: string): string[] {
  const local = uri.split('#').pop()!.split('/').pop()!.split(':').pop() ?? uri
  return local
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

/** Naive English plural of the final word, so `ContactList` also matches "contact lists". */
function pluralize(words: string[]): string[] | undefined {
  const last = words[words.length - 1]
  if (last === undefined || last.length === 0) return undefined
  const plural = /[^aeiou]y$/.test(last) ? last.slice(0, -1) + 'ies'
    : /(s|x|z|ch|sh)$/.test(last) ? last + 'es'
      : last + 's'
  if (plural === last) return undefined
  return [...words.slice(0, -1), plural]
}

/**
 * Built-in annotator #1 — lexicon. Matches (a) every `typeRef` mentioned anywhere in the registry
 * (inputs, output, constraints) by its local name plus a naive plural, (b) every action by its
 * registry name's local part, and (c) any caller-supplied lexicon entry, which is how domain
 * vocabulary that does not fall out of a URI ("org", "how many") gets in.
 *
 * Longest match wins and matched positions are not re-matched, so "contact lists" beats "contact"
 * and "how many" beats "many". Explicit lexicon terms outrank derived ones on confidence.
 */
export function lexiconAnnotator(lexicon: ConceptLexiconEntry[] = []): Annotator {
  return (tokens, ctx) => {
    interface Term { words: string[]; conceptRef: string; confidence: number }
    const terms: Term[] = []
    const push = (words: string[], conceptRef: string, confidence: number): void => {
      if (words.length > 0) terms.push({ words, conceptRef, confidence })
    }
    for (const entry of lexicon) {
      for (const t of entry.terms) push(t.toLowerCase().split(/\s+/).filter((w) => w.length > 0), entry.conceptRef, 1)
    }
    const typeRefs = new Set<string>()
    for (const a of ctx.registry.list()) {
      for (const i of a.inputs) typeRefs.add(i.typeRef)
      typeRefs.add(a.output.typeRef)
      for (const c of a.constraints) typeRefs.add(c.typeRef)
      // Action names are dot-namespaced (`crm.get_contact_lists`) — the local part is the handle.
      push(localNameWords(a.name.split('.').pop() ?? a.name), a.id, 0.8)
    }
    for (const tr of [...typeRefs].sort()) {
      const words = localNameWords(tr)
      push(words, tr, 0.8)
      const plural = pluralize(words)
      if (plural) push(plural, tr, 0.8)
    }
    // Longest match first; among equal-length matches the explicitly curated lexicon term outranks a
    // term derived from a URI's local name (domain vocabulary beats a mechanical split — in a CRM,
    // "list" means a contact list). Remaining ties broken deterministically, so the seal never
    // depends on registry insertion order.
    terms.sort((a, b) =>
      b.words.length - a.words.length ||
      b.confidence - a.confidence ||
      a.conceptRef.localeCompare(b.conceptRef) ||
      a.words.join(' ').localeCompare(b.words.join(' ')))

    const out: TokenAnnotation[] = []
    const taken = new Set<number>()
    for (const term of terms) {
      for (let i = 0; i + term.words.length <= tokens.length; i++) {
        let ok = true
        for (let j = 0; j < term.words.length; j++) {
          if (taken.has(i + j) || tokens[i + j]!.norm !== term.words[j]) { ok = false; break }
        }
        if (!ok) continue
        for (let j = 0; j < term.words.length; j++) taken.add(i + j)
        out.push({
          tokenSpan: spanOf(tokens, ctx.question, i, i + term.words.length - 1),
          conceptRef: term.conceptRef,
          source: 'lexicon',
          confidence: term.confidence,
        })
      }
    }
    return out.sort((a, b) => a.tokenSpan.start - b.tokenSpan.start || a.conceptRef.localeCompare(b.conceptRef))
  }
}

export interface KkoSemanticOptions {
  /** Concepts to match against. Defaults to the registry's typeRefs (+ KKO classes in the store). */
  concepts?: ConceptLexiconEntry[]
  /** Cosine floor for an annotation to be emitted. Default 0.75. */
  minSimilarity?: number
  /** Longest span, in tokens, considered for embedding. Default 3. */
  maxSpanTokens?: number
  /** Also draw concept labels from `KkoClass` nodes loaded in the store. Default true. */
  useStoreKko?: boolean
}

/** Concept lexicon drawn from the KKO classes loaded into the store by `loadKkoIntoAtomSpace`. */
export function kkoConceptLexicon(store: HellGraphStore): ConceptLexiconEntry[] {
  const out: ConceptLexiconEntry[] = []
  for (const n of store.nodesByLabel('KkoClass')) {
    const terms = new Set<string>()
    const label = n.properties['label']
    if (typeof label === 'string' && label.length > 0) terms.add(label.toLowerCase())
    terms.add(localNameWords(n.id).join(' '))
    out.push({ conceptRef: n.id, terms: [...terms].filter((t) => t.length > 0).sort() })
  }
  return out.sort((a, b) => a.conceptRef.localeCompare(b.conceptRef))
}

/**
 * Built-in annotator #2 — KKO-semantic. Embeds candidate spans and the concept vocabulary with the
 * engine's own `EmbedFn` (the same injectable embedder `semantic.ts` defines — reused, never
 * duplicated) and annotates a span with its nearest concept above `minSimilarity`, scored by the
 * engine's `cosineSim`. Concepts come from the registry's typeRefs and, when present, the KKO
 * classes already loaded in the store — so the ontology the graph carries is the ontology the
 * compiler annotates against.
 *
 * Every embedding is memoized by text within a call, so the cost is (distinct spans + concepts),
 * not their product.
 */
export function kkoSemanticAnnotator(embed: EmbedFn, opts: KkoSemanticOptions = {}): Annotator {
  const minSimilarity = opts.minSimilarity ?? 0.75
  const maxSpanTokens = opts.maxSpanTokens ?? 3
  return async (tokens, ctx) => {
    let concepts = opts.concepts
    if (concepts === undefined) {
      const typeRefs = new Set<string>()
      for (const a of ctx.registry.list()) {
        for (const i of a.inputs) typeRefs.add(i.typeRef)
        typeRefs.add(a.output.typeRef)
      }
      concepts = [...typeRefs].sort().map((tr) => ({ conceptRef: tr, terms: [localNameWords(tr).join(' ')] }))
      if (opts.useStoreKko !== false) concepts = [...concepts, ...kkoConceptLexicon(ctx.store)]
    }
    const memo = new Map<string, number[]>()
    const embedOnce = async (text: string): Promise<number[]> => {
      const hit = memo.get(text)
      if (hit) return hit
      const v = await embed(text)
      memo.set(text, v)
      return v
    }

    const conceptVecs: { conceptRef: string; vec: number[] }[] = []
    for (const c of concepts) {
      for (const term of c.terms) {
        const vec = await embedOnce(term)
        if (vec.length > 0) conceptVecs.push({ conceptRef: c.conceptRef, vec })
      }
    }
    if (conceptVecs.length === 0) return []

    const out: TokenAnnotation[] = []
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.stop) continue
      for (let len = 1; len <= maxSpanTokens && i + len <= tokens.length; len++) {
        const span = spanOf(tokens, ctx.question, i, i + len - 1)
        const vec = await embedOnce(span.text.toLowerCase())
        if (vec.length === 0) continue
        let best: { conceptRef: string; score: number } | undefined
        for (const c of conceptVecs) {
          const score = cosineSim(vec, c.vec)
          if (score >= minSimilarity && (best === undefined || score > best.score || (score === best.score && c.conceptRef < best.conceptRef))) {
            best = { conceptRef: c.conceptRef, score }
          }
        }
        if (best) out.push({ tokenSpan: span, conceptRef: best.conceptRef, source: 'kko-semantic', confidence: best.score })
      }
    }
    return out.sort((a, b) =>
      a.tokenSpan.start - b.tokenSpan.start || a.tokenSpan.end - b.tokenSpan.end || a.conceptRef.localeCompare(b.conceptRef))
  }
}

// ─── Plans ─────────────────────────────────────────────────────────────────────

/** Root of the literal type family: slots typed under it take the span text AS the value. */
export const NLQ_LITERAL_TYPE = 'urn:srcos:nlq:Literal'

export type BindingKind = 'annotation' | 'action' | 'default' | 'unbound'

/** Witness that a bound type satisfies a declared slot type — the subsumption that licensed the bind. */
export interface SubsumptionWitness {
  /** The bound value's type. */
  concept: string
  /** The declared slot (or constraint) type it satisfies. */
  satisfies: string
  /** True when the types are identical; false when subsumption did the work (polymorphism). */
  direct: boolean
}

export interface PlanBinding {
  /** Declared input name. */
  input: string
  typeRef: string
  cardinality: Cardinality
  required: boolean
  kind: BindingKind
  /** Type of the bound value (annotation concept, sub-plan output, or default). */
  conceptRef?: string
  /** Span the value came from — literal bindings and annotation bindings only. */
  tokenSpan?: TokenSpan
  /** Literal value lifted straight out of the question text. */
  literal?: string
  /** Label of the registry default that supplied the value. */
  defaultLabel?: string
  /** Sub-plan producing this input (`kind: 'action'`). */
  via?: PlanNode
  subsumption?: SubsumptionWitness
}

export type GroundingKind = 'token-span' | 'registry-default' | 'ungrounded'
export type UngroundedReason = 'no-token-span' | 'unbound-required-input'

export interface PlanGrounding {
  kind: GroundingKind
  tokenSpan?: TokenSpan
  conceptRef?: string
  /** Annotator that grounded the node (`kind: 'token-span'`). */
  source?: string
  confidence?: number
  /** Registry default that grounded the node (`kind: 'registry-default'`). */
  defaultLabel?: string
  /** Why the node counts as invented (`kind: 'ungrounded'`). */
  reason?: UngroundedReason
  /**
   * Admissibility ruling on an ungrounded node, filed as a `model-generated` claim. The node's
   * contribution to groundedness IS `decision.weight` — the creativity penalty and the opinion
   * discount are one mechanism.
   */
  admissibility?: AdmissibilityDecision
}

/** A proposed effect — never executed at search time. Emitted only for effect-request leaves. */
export interface EffectRequestProposal {
  /** Executor that would emit the EffectRequest. */
  executorRef: string
  /** What the executor proposes (the contract URI in the action's `output.typeRef`). */
  proposes: string
  /** Arguments the request would carry. */
  arguments: { input: string; conceptRef?: string; literal?: string; tokenSpan?: TokenSpan }[]
  /** Always `proposed`: an EffectDecision must precede any world change. */
  status: 'proposed'
}

export interface PlanNode {
  /** Deterministic path id: `n0`, `n0.items`, `n0.items.list`, … */
  nodeId: string
  actionId: string
  actionName: string
  outputTypeRef: string
  outputCardinality: Cardinality
  sideEffects: SideEffects
  grounding: PlanGrounding
  bindings: PlanBinding[]
  effectRequest?: EffectRequestProposal
}

/** Pre-order (root first) walk of a plan tree. */
export function planNodes(node: PlanNode): PlanNode[] {
  const out: PlanNode[] = [node]
  for (const b of node.bindings) if (b.via) out.push(...planNodes(b.via))
  return out
}

// ─── Sense metric ──────────────────────────────────────────────────────────────

export interface SenseWeights {
  coverage: number
  groundedness: number
  similarity: number
}

export const DEFAULT_SENSE_WEIGHTS: Readonly<SenseWeights> = Object.freeze({
  coverage: 0.5,
  groundedness: 0.3,
  similarity: 0.2,
})

export interface SenseMetric {
  /** Content tokens the plan consumes, over content tokens available. */
  coverage: number
  /** Mean admissibility-discounted node weight; 1.0 when every node is grounded. */
  groundedness: number
  /** `1 − groundedness`. The invention penalty, expressed as the admissibility discount. */
  creativity: number
  /** Pre-order/left-to-right concordance of the spans the plan consumes. */
  similarity: number
  /** `coverage·w.coverage + groundedness·w.groundedness + similarity·w.similarity`. */
  composite: number
  weights: SenseWeights
  contentTokens: number
  consumedContentTokens: number
  nodes: number
  groundedNodes: number
  ungroundedNodes: number
  /** One entry per ungrounded node — the admissibility ruling that produced its discount. */
  admissibility: { nodeId: string; actionId: string; reason: UngroundedReason; weight: number }[]
}

/** Per-node provenance: token span → concept → action. */
export interface NodeProvenance {
  nodeId: string
  actionId: string
  actionName: string
  tokenSpan?: TokenSpan
  conceptRef?: string
  source?: string
  grounded: boolean
  /** Contribution to groundedness: 1.0 grounded, else the admissibility discount. */
  weight: number
}

export interface PlanVariant {
  plan: PlanNode
  senseMetric: SenseMetric
  /** 1-based rank in the composite ordering. */
  rank: number
  provenance: NodeProvenance[]
}

export interface NlqCompilation {
  question: string
  method: string
  /** The action contract the registry validated against — schema `$id`, specVersion, pinned digest. */
  contract: ContractRef
  tokens: Token[]
  annotations: TokenAnnotation[]
  /** `seq` = the store's monotonic logical clock — the receipt's real binding to graph state. */
  snapshot: { seq: number; nodes: number; edges: number }
  weights: SenseWeights
  /** Ranked best-first. */
  variants: PlanVariant[]
  /** `variants[0]`, or null when nothing type-checked. */
  winner: PlanVariant | null
  /** sha256 over the ranked output + snapshot + contract digest (proof-carrying). */
  hash: string
}

// ─── Options ───────────────────────────────────────────────────────────────────

/** An ambient typed value the registry vouches for (e.g. "the requester's current organization"). */
export interface RegistryDefault {
  typeRef: string
  label: string
}

export interface NlqOptions {
  /** Annotators to run. Default: `[lexiconAnnotator()]`. */
  annotators?: Annotator[]
  /** Ambient typed values. They bind slots AND ground the actions that produce their type. */
  defaults?: RegistryDefault[]
  /** Extra literal types, beyond everything under `NLQ_LITERAL_TYPE`. */
  literalTypes?: string[]
  /** Max plan depth; root is depth 0. Default 4. */
  maxDepth?: number
  /** Alternatives kept per expansion point. Default 8. */
  beamWidth?: number
  /** Variants kept in the result. Default 12. */
  maxVariants?: number
  /** Sense-metric weights. Default `DEFAULT_SENSE_WEIGHTS`. */
  weights?: Partial<SenseWeights>
  /**
   * Admissibility context for ungrounded (invented) plan nodes, filed as `model-generated` claims.
   * Set `allowOpinion: false` to forbid invention outright — variants containing an inadmissible
   * node are dropped entirely.
   */
  admissibility?: AdmissibilityContext
}

export const DEFAULT_MAX_DEPTH = 4
export const DEFAULT_BEAM_WIDTH = 8
export const DEFAULT_MAX_VARIANTS = 12

const METHOD = 'restricted-search(typed-unification,beam)/sense(coverage,groundedness,similarity)'

// ─── Restricted search ─────────────────────────────────────────────────────────

interface SearchCtx {
  question: string
  tokens: Token[]
  /** Search view of the annotations: deduped by (span, conceptRef), highest confidence kept. */
  annotations: TokenAnnotation[]
  registry: ActionRegistry
  lattice: TypeLattice
  defaults: RegistryDefault[]
  literalTypes: string[]
  maxDepth: number
  beamWidth: number
  /** Token indices already covered by SOME annotation — the rest are free literal material. */
  annotatedTokens: Set<number>
}

function isA(lattice: TypeLattice, sub: string, sup: string): boolean {
  return lattice.isA(sub, sup)
}

function isLiteralType(ctx: SearchCtx, typeRef: string): boolean {
  return ctx.literalTypes.includes(typeRef) || isA(ctx.lattice, typeRef, NLQ_LITERAL_TYPE)
}

function witness(concept: string, satisfies: string): SubsumptionWitness {
  return { concept, satisfies, direct: concept === satisfies }
}

/** Cardinality: a single value fills a set slot, but a set never fills a single slot. */
function cardinalityOk(slot: Cardinality, provided: Cardinality): boolean {
  return !(slot === 'one' && provided === 'many')
}

/**
 * Applicability constraints, checked STATICALLY against the ontology — no execution, no values.
 * `instanceOf` is necessarily approximated by the same subsumption check at plan-search time: with
 * no bound values in hand there is no individual to test membership of. Documented, not silently
 * conflated — an executor re-checks it for real once values exist.
 */
function constraintsOk(ctx: SearchCtx, action: SemanticActionDef, inputName: string, boundType: string): boolean {
  for (const c of action.constraints) {
    if (c.subject !== inputName) continue
    if (c.kind === 'sameAs') { if (boundType !== c.typeRef) return false; continue }
    if (!isA(ctx.lattice, boundType, c.typeRef)) return false
  }
  return true
}

function outputConstraintsOk(ctx: SearchCtx, action: SemanticActionDef): boolean {
  for (const c of action.constraints) {
    if (c.subject !== 'output') continue
    if (c.kind === 'sameAs') { if (action.output.typeRef !== c.typeRef) return false; continue }
    if (!isA(ctx.lattice, action.output.typeRef, c.typeRef)) return false
  }
  return true
}

/** Candidate bindings for one input slot, in priority order, beam-limited. */
function slotCandidates(
  ctx: SearchCtx,
  action: SemanticActionDef,
  slot: SemanticActionInput,
  nodeId: string,
  depth: number,
  path: ReadonlySet<string>,
): PlanBinding[] {
  const out: PlanBinding[] = []
  const base = { input: slot.name, typeRef: slot.typeRef, cardinality: slot.cardinality, required: slot.required }

  if (isLiteralType(ctx, slot.typeRef)) {
    // Literal slot: the span text IS the value. Explicitly typed literal annotations first, then any
    // free content token the annotators did not claim — the unmatched text is the string argument.
    for (const a of ctx.annotations) {
      if (!isA(ctx.lattice, a.conceptRef, slot.typeRef)) continue
      if (!constraintsOk(ctx, action, slot.name, a.conceptRef)) continue
      out.push({ ...base, kind: 'annotation', conceptRef: a.conceptRef, tokenSpan: a.tokenSpan, literal: a.tokenSpan.text, subsumption: witness(a.conceptRef, slot.typeRef) })
    }
    if (constraintsOk(ctx, action, slot.name, slot.typeRef)) {
      for (const t of ctx.tokens) {
        if (t.stop || ctx.annotatedTokens.has(t.index)) continue
        out.push({
          ...base,
          kind: 'annotation',
          conceptRef: slot.typeRef,
          tokenSpan: { start: t.start, end: t.end, text: t.text, tokenIndices: [t.index] },
          literal: t.text,
          subsumption: witness(slot.typeRef, slot.typeRef),
        })
      }
    }
  } else {
    // Non-literal slot: a MENTION IS NOT A VALUE. Only a registry default or an action that produces
    // the value may fill it — this is what forces decomposition instead of an imaginary argument.
    for (const d of ctx.defaults) {
      if (!isA(ctx.lattice, d.typeRef, slot.typeRef)) continue
      if (!constraintsOk(ctx, action, slot.name, d.typeRef)) continue
      out.push({ ...base, kind: 'default', conceptRef: d.typeRef, defaultLabel: d.label, subsumption: witness(d.typeRef, slot.typeRef) })
    }
    if (depth < ctx.maxDepth) {
      for (const provider of ctx.registry.list()) {
        // An effect-request action is never an input provider: consuming its output would mean
        // running it, and the MPCC lifecycle requires an EffectDecision first.
        if (provider.sideEffects !== 'none') continue
        if (path.has(provider.id)) continue // no cycles
        if (!isA(ctx.lattice, provider.output.typeRef, slot.typeRef)) continue
        if (!cardinalityOk(slot.cardinality, provider.output.cardinality)) continue
        if (!constraintsOk(ctx, action, slot.name, provider.output.typeRef)) continue
        if (!outputConstraintsOk(ctx, provider)) continue
        for (const sub of expandAction(ctx, provider, `${nodeId}.${slot.name}`, depth + 1, new Set([...path, provider.id]))) {
          out.push({ ...base, kind: 'action', conceptRef: provider.output.typeRef, via: sub, subsumption: witness(provider.output.typeRef, slot.typeRef) })
        }
      }
    }
  }

  if (out.length === 0) out.push({ ...base, kind: 'unbound' })
  // Order candidates by grounding quality BEFORE the beam cut, so the cut never silently discards the
  // grounded binding in favour of an invented one that merely sorted earlier.
  const rankOf = (b: PlanBinding): number => {
    if (b.kind === 'annotation') return 0
    if (b.kind === 'default') return 1
    if (b.kind === 'action') return b.via !== undefined && b.via.grounding.kind !== 'ungrounded' ? 2 : 3
    return 4
  }
  out.sort((a, b) =>
    rankOf(a) - rankOf(b) ||
    (a.tokenSpan?.start ?? Number.MAX_SAFE_INTEGER) - (b.tokenSpan?.start ?? Number.MAX_SAFE_INTEGER) ||
    (a.conceptRef ?? '').localeCompare(b.conceptRef ?? '') ||
    JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return out.slice(0, ctx.beamWidth)
}

/** Grounding of a node: a token span that evokes the action or annotates its output type, else a
 *  registry default that vouches for the output type, else nothing — an invention. */
function groundNode(ctx: SearchCtx, action: SemanticActionDef): PlanGrounding {
  const evoking = ctx.annotations
    .filter((a) => a.conceptRef === action.id || a.conceptRef === action.name)
    .sort((a, b) => b.confidence - a.confidence || a.tokenSpan.start - b.tokenSpan.start)[0]
  if (evoking) {
    return { kind: 'token-span', tokenSpan: evoking.tokenSpan, conceptRef: evoking.conceptRef, source: evoking.source, confidence: evoking.confidence }
  }
  const byOutput = ctx.annotations
    .filter((a) => isA(ctx.lattice, a.conceptRef, action.output.typeRef))
    .sort((a, b) => b.confidence - a.confidence || a.tokenSpan.start - b.tokenSpan.start)[0]
  if (byOutput) {
    return { kind: 'token-span', tokenSpan: byOutput.tokenSpan, conceptRef: byOutput.conceptRef, source: byOutput.source, confidence: byOutput.confidence }
  }
  const dflt = ctx.defaults.find((d) => isA(ctx.lattice, d.typeRef, action.output.typeRef))
  if (dflt) return { kind: 'registry-default', conceptRef: dflt.typeRef, defaultLabel: dflt.label }
  return { kind: 'ungrounded', reason: 'no-token-span' }
}

function effectProposal(action: SemanticActionDef, bindings: PlanBinding[]): EffectRequestProposal {
  return {
    executorRef: action.executorRef,
    proposes: action.output.typeRef,
    arguments: bindings
      .filter((b) => b.kind !== 'unbound')
      .map((b) => {
        const arg: EffectRequestProposal['arguments'][number] = { input: b.input }
        if (b.conceptRef !== undefined) arg.conceptRef = b.conceptRef
        if (b.literal !== undefined) arg.literal = b.literal
        if (b.tokenSpan !== undefined) arg.tokenSpan = b.tokenSpan
        return arg
      }),
    status: 'proposed',
  }
}

/** All alternative sub-plans rooted at `action`, beam-limited. PURE — reads types, writes nothing. */
function expandAction(
  ctx: SearchCtx,
  action: SemanticActionDef,
  nodeId: string,
  depth: number,
  path: ReadonlySet<string>,
): PlanNode[] {
  if (!outputConstraintsOk(ctx, action)) return []
  const grounding = groundNode(ctx, action)
  // An effect-request action is a LEAF OF THE DATAFLOW: nothing may consume its output, which is
  // enforced in `slotCandidates` by refusing it as an input provider — so it can only ever be the
  // plan root, and search never has a reason to run it. Its own arguments may still be computed by
  // pure actions; that is the normal MPCC shape ("resolve the list, then PROPOSE sending to it"),
  // and it is the consumption of an effect's output, not the computation of its arguments, that
  // would breach search-time purity.
  const proposesEffect = action.sideEffects === 'effect-request'

  const perSlot: PlanBinding[][] = []
  for (const slot of action.inputs) perSlot.push(slotCandidates(ctx, action, slot, nodeId, depth, path))

  // Bounded cartesian product across slots.
  let combos: PlanBinding[][] = [[]]
  for (const cands of perSlot) {
    const next: PlanBinding[][] = []
    for (const combo of combos) {
      for (const c of cands) {
        if (next.length >= ctx.beamWidth) break
        next.push([...combo, c])
      }
      if (next.length >= ctx.beamWidth) break
    }
    combos = next
  }

  const nodes: PlanNode[] = []
  for (const bindings of combos) {
    const unmet = bindings.some((b) => b.required && b.kind === 'unbound')
    // A required slot that cannot be filled is invention even when the action itself was named in the
    // question: the plan asserts a value it has no way to source, so it is ruled on as a claim.
    const finalGrounding: PlanGrounding = unmet
      ? { kind: 'ungrounded', reason: 'unbound-required-input' }
      : { ...grounding }
    const node: PlanNode = {
      nodeId,
      actionId: action.id,
      actionName: action.name,
      outputTypeRef: action.output.typeRef,
      outputCardinality: action.output.cardinality,
      sideEffects: action.sideEffects,
      grounding: finalGrounding,
      bindings,
    }
    if (proposesEffect) node.effectRequest = effectProposal(action, bindings)
    nodes.push(node)
  }
  return nodes.slice(0, ctx.beamWidth)
}

/** Root candidates: actions the question actually evokes, best-evidence first. */
function candidateRoots(ctx: SearchCtx): SemanticActionDef[] {
  const scored: { action: SemanticActionDef; score: number }[] = []
  for (const action of ctx.registry.list()) {
    let score = 0
    for (const a of ctx.annotations) {
      if (a.conceptRef === action.id || a.conceptRef === action.name) score += 2
      else if (isA(ctx.lattice, a.conceptRef, action.output.typeRef)) score += 1
    }
    if (score > 0) scored.push({ action, score })
  }
  if (scored.length === 0) {
    // Nothing in the question names anything the registry knows: offer every action rather than
    // returning nothing, and let the sense metric say how poor the fit is.
    return ctx.registry.list().slice(0, ctx.beamWidth)
  }
  scored.sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id))
  return scored.slice(0, ctx.beamWidth).map((s) => s.action)
}

// ─── Scoring ───────────────────────────────────────────────────────────────────

function scoreVariant(
  ctx: SearchCtx,
  plan: PlanNode,
  weights: SenseWeights,
  admissibility: AdmissibilityContext,
): { senseMetric: SenseMetric; provenance: NodeProvenance[] } | undefined {
  const nodes = planNodes(plan)
  const contentTokenIdx = new Set(ctx.tokens.filter((t) => !t.stop).map((t) => t.index))

  const consumed = new Set<number>()
  const orderedSpans: number[] = []
  const provenance: NodeProvenance[] = []
  const admissibilityRows: SenseMetric['admissibility'] = []
  let weightSum = 0
  let groundedNodes = 0
  let ungroundedNodes = 0

  for (const node of nodes) {
    const g = node.grounding
    if (g.tokenSpan) {
      for (const i of g.tokenSpan.tokenIndices) consumed.add(i)
      orderedSpans.push(g.tokenSpan.start)
    }
    for (const b of node.bindings) {
      if (b.tokenSpan) for (const i of b.tokenSpan.tokenIndices) consumed.add(i)
    }

    if (g.kind === 'ungrounded') {
      ungroundedNodes++
      const reason: UngroundedReason = g.reason ?? 'no-token-span'
      // The invention is filed as evidence, not waved through: a plan node with no anchor in the
      // question is a model-generated claim, and the admissibility chain rules on it.
      const decision = admitClaim({
        id: `${node.nodeId}:${node.actionId}`,
        text: `plan node '${node.actionName}' was introduced by the planner (${reason})`,
        provenance: { sourceKind: 'model-generated' },
      }, admissibility)
      if (!decision.admitted) return undefined // weight 0 — must not enter the reasoning context
      g.admissibility = decision
      weightSum += decision.weight
      admissibilityRows.push({ nodeId: node.nodeId, actionId: node.actionId, reason, weight: decision.weight })
      provenance.push({
        nodeId: node.nodeId, actionId: node.actionId, actionName: node.actionName,
        grounded: false, weight: decision.weight,
      })
    } else {
      groundedNodes++
      weightSum += 1
      const row: NodeProvenance = {
        nodeId: node.nodeId, actionId: node.actionId, actionName: node.actionName,
        grounded: true, weight: 1,
      }
      if (g.tokenSpan) row.tokenSpan = g.tokenSpan
      if (g.conceptRef !== undefined) row.conceptRef = g.conceptRef
      if (g.source !== undefined) row.source = g.source
      provenance.push(row)
    }
  }

  const contentTokens = contentTokenIdx.size
  let consumedContent = 0
  for (const i of consumed) if (contentTokenIdx.has(i)) consumedContent++
  const coverage = contentTokens === 0 ? 1 : consumedContent / contentTokens

  const groundedness = nodes.length === 0 ? 1 : weightSum / nodes.length
  const creativity = 1 - groundedness

  // Similarity: concordance of the pre-order walk with question order.
  let concordant = 0
  let pairs = 0
  for (let i = 0; i < orderedSpans.length; i++) {
    for (let j = i + 1; j < orderedSpans.length; j++) {
      pairs++
      if (orderedSpans[i]! <= orderedSpans[j]!) concordant++
    }
  }
  const similarity = pairs === 0 ? 1 : concordant / pairs

  const composite = coverage * weights.coverage + groundedness * weights.groundedness + similarity * weights.similarity

  return {
    senseMetric: {
      coverage, groundedness, creativity, similarity, composite, weights,
      contentTokens, consumedContentTokens: consumedContent,
      nodes: nodes.length, groundedNodes, ungroundedNodes,
      admissibility: admissibilityRows,
    },
    provenance,
  }
}

function sealed(rec: Omit<NlqCompilation, 'hash'>): NlqCompilation {
  return { ...rec, hash: 'sha256:' + createHash('sha256').update(JSON.stringify(rec)).digest('hex') }
}

// ─── Entry point ───────────────────────────────────────────────────────────────

/**
 * Compile a natural-language question into ranked, sealed typed plans over `registry`.
 *
 * PURE with respect to the graph: the store is read for the type lattice and the snapshot and is
 * never written. Nothing in the registry is executed — plans are proposed, and effect-request
 * actions only ever appear as leaves carrying an `EffectRequestProposal`.
 */
export async function compileQuestion(
  store: HellGraphStore,
  registry: ActionRegistry,
  question: string,
  opts: NlqOptions = {},
): Promise<NlqCompilation> {
  const lattice = store.atomspace().types
  const weights: SenseWeights = { ...DEFAULT_SENSE_WEIGHTS, ...(opts.weights ?? {}) }
  const snapshot = { seq: store.version(), nodes: store.allNodes().length, edges: store.edgeCount() }
  const tokens = tokenizeQuestion(question)

  const annotators = opts.annotators ?? [lexiconAnnotator()]
  const annCtx: AnnotationContext = { question, registry, lattice, store }
  const raw: TokenAnnotation[] = []
  for (const annotate of annotators) raw.push(...await annotate(tokens, annCtx))
  const annotations = raw.sort((a, b) =>
    a.tokenSpan.start - b.tokenSpan.start || a.tokenSpan.end - b.tokenSpan.end ||
    a.conceptRef.localeCompare(b.conceptRef) || a.source.localeCompare(b.source))

  // Search view: one annotation per (span, concept) — the best-confidence one. The full annotation
  // list stays in the result for provenance; the search must not double-count the same evidence.
  const bySpanConcept = new Map<string, TokenAnnotation>()
  for (const a of annotations) {
    const k = `${a.tokenSpan.start}:${a.tokenSpan.end}:${a.conceptRef}`
    const prev = bySpanConcept.get(k)
    if (!prev || a.confidence > prev.confidence) bySpanConcept.set(k, a)
  }
  const searchAnnotations = [...bySpanConcept.values()].sort((a, b) =>
    a.tokenSpan.start - b.tokenSpan.start || a.conceptRef.localeCompare(b.conceptRef))

  const annotatedTokens = new Set<number>()
  for (const a of searchAnnotations) for (const i of a.tokenSpan.tokenIndices) annotatedTokens.add(i)

  const ctx: SearchCtx = {
    question,
    tokens,
    annotations: searchAnnotations,
    registry,
    lattice,
    defaults: [...(opts.defaults ?? [])].sort((a, b) => a.typeRef.localeCompare(b.typeRef)),
    literalTypes: [...(opts.literalTypes ?? [])],
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    beamWidth: opts.beamWidth ?? DEFAULT_BEAM_WIDTH,
    annotatedTokens,
  }

  const admissibility = opts.admissibility ?? {}
  const scored: PlanVariant[] = []
  for (const root of candidateRoots(ctx)) {
    for (const plan of expandAction(ctx, root, 'n0', 0, new Set([root.id]))) {
      const s = scoreVariant(ctx, plan, weights, admissibility)
      if (!s) continue // an inadmissible invented node drops the whole variant
      scored.push({ plan, senseMetric: s.senseMetric, rank: 0, provenance: s.provenance })
    }
  }

  // Deterministic ordering: composite, then coverage, then fewer nodes, then plan shape.
  scored.sort((a, b) =>
    b.senseMetric.composite - a.senseMetric.composite ||
    b.senseMetric.coverage - a.senseMetric.coverage ||
    a.senseMetric.nodes - b.senseMetric.nodes ||
    JSON.stringify(a.plan).localeCompare(JSON.stringify(b.plan)))
  const variants = scored.slice(0, opts.maxVariants ?? DEFAULT_MAX_VARIANTS)
  variants.forEach((v, i) => { v.rank = i + 1 })

  return sealed({
    question,
    method: METHOD,
    contract: { ...SEMANTIC_ACTION_CONTRACT },
    tokens,
    annotations,
    snapshot,
    weights,
    variants,
    winner: variants[0] ?? null,
  })
}

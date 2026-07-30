import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { OPINION_WEIGHT_MULTIPLIER } from './claim-admissibility'
import { SEMANTIC_ACTION_SCHEMA_SHA256 } from './semantic-action-data'
import {
  ActionRegistry,
  assertSupportedKeywords,
  compileQuestion,
  kkoConceptLexicon,
  kkoSemanticAnnotator,
  lexiconAnnotator,
  matchesFormat,
  planNodes,
  tokenizeQuestion,
  validateAgainst,
  validateSemanticAction,
  DEFAULT_SENSE_WEIGHTS,
  implementedFormats,
  isImplementedFormat,
  NLQ_LITERAL_TYPE,
  SEMANTIC_ACTION_CONTRACT,
  SEMANTIC_ACTION_SCHEMA,
  type ConceptLexiconEntry,
  type PlanNode,
  type SchemaObj,
  type SemanticActionDef,
} from './nlq'

// ─── EBA-style fixture: a toy CRM registry over a small subsumption lattice ─────
//
//   Thing ─┬─ List ── ContactList          Name ⊑ NLQ_LITERAL_TYPE (span text IS the value)
//          ├─ Mailing
//          ├─ Organization
//          └─ Number

const NS = 'https://example.org/crm#'
const T = (n: string): string => NS + n
const THING = T('Thing'), LIST = T('List'), CONTACT_LIST = T('ContactList'), MAILING = T('Mailing')
const ORG = T('Organization'), NUMBER = T('Number'), NAME = T('Name')
const EFFECT_REQUEST = 'https://schemas.srcos.ai/v2/EffectRequest.json'

const GET_CONTACT_LISTS = 'urn:srcos:semantic-action:crm.get_contact_lists'
const GET_ORGANIZATION = 'urn:srcos:semantic-action:crm.get_organization'
const GET_MAILINGS_BY_LIST = 'urn:srcos:semantic-action:crm.get_mailings_by_list'
const FIND_LIST_BY_NAME = 'urn:srcos:semantic-action:crm.find_list_by_name'
const NUMBER_OF = 'urn:srcos:semantic-action:crm.number_of'
const COUNT = 'urn:srcos:semantic-action:crm.count'
const SEND_MAILING = 'urn:srcos:semantic-action:crm.send_mailing'

type ActionSpec = Partial<SemanticActionDef> & { name: string }

function act(o: ActionSpec): SemanticActionDef {
  return {
    id: `urn:srcos:semantic-action:${o.name}`,
    type: 'SemanticAction',
    specVersion: '0.1.0',
    version: '1.0.0',
    inputs: [],
    constraints: [],
    executorRef: `urn:srcos:connector:${o.name.replace(/[._]/g, '-')}`,
    sideEffects: 'none',
    registry: { owner: 'urn:srcos:agent:nlq-test', deprecated: false },
    output: { typeRef: THING, cardinality: 'one' },
    ...o,
  } as SemanticActionDef
}

function crmStore(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace('nlq', false))
  const types = store.atomspace().types
  types.declare(LIST, [THING])
  types.declare(CONTACT_LIST, [LIST])
  types.declare(MAILING, [THING])
  types.declare(ORG, [THING])
  types.declare(NUMBER, [THING])
  types.declare(NAME, [NLQ_LITERAL_TYPE])
  return store
}

function crmRegistry(): ActionRegistry {
  const r = new ActionRegistry()
  r.declare(act({ name: 'crm.get_contact_lists', inputs: [{ name: 'org', typeRef: ORG, required: true, cardinality: 'one' }], output: { typeRef: CONTACT_LIST, cardinality: 'many' } }))
  r.declare(act({ name: 'crm.get_organization', output: { typeRef: ORG, cardinality: 'one' } }))
  r.declare(act({ name: 'crm.get_mailings_by_list', inputs: [{ name: 'list', typeRef: CONTACT_LIST, required: true, cardinality: 'one' }], output: { typeRef: MAILING, cardinality: 'many' } }))
  r.declare(act({ name: 'crm.find_list_by_name', inputs: [{ name: 'name', typeRef: NAME, required: true, cardinality: 'one' }], output: { typeRef: CONTACT_LIST, cardinality: 'one' } }))
  r.declare(act({ name: 'crm.number_of', inputs: [{ name: 'items', typeRef: THING, required: true, cardinality: 'many' }], output: { typeRef: NUMBER, cardinality: 'one' } }))
  // Count is polymorphic over subClassOf :List — the constraint is what makes it accept a ContactList.
  r.declare(act({ name: 'crm.count', inputs: [{ name: 'list', typeRef: LIST, required: true, cardinality: 'one' }], constraints: [{ kind: 'subClassOf', subject: 'list', typeRef: LIST }], output: { typeRef: NUMBER, cardinality: 'one' } }))
  r.declare(act({ name: 'crm.send_mailing', inputs: [{ name: 'list', typeRef: CONTACT_LIST, required: true, cardinality: 'one' }], output: { typeRef: EFFECT_REQUEST, cardinality: 'one' }, sideEffects: 'effect-request' }))
  return r
}

/** Domain vocabulary a URI split cannot produce: "org", "how many", and CRM's sense of "list". */
const LEXICON: ConceptLexiconEntry[] = [
  { conceptRef: ORG, terms: ['org', 'orgs'] },
  { conceptRef: NUMBER, terms: ['how many', 'number of'] },
  { conceptRef: CONTACT_LIST, terms: ['list', 'lists'] },
]

const ANNOTATORS = [lexiconAnnotator(LEXICON)]

/** `NumberOf→GetMailingsByList→FindListByName` as a flat pre-order chain of action ids. */
function chain(plan: PlanNode): string[] {
  return planNodes(plan).map((n) => n.actionId)
}

function bindingOf(node: PlanNode, input: string): NonNullable<ReturnType<typeof findBinding>> {
  const b = findBinding(node, input)
  assert.ok(b, `expected a binding for input '${input}' on ${node.actionName}`)
  return b
}

function findBinding(node: PlanNode, input: string): PlanNode['bindings'][number] | undefined {
  return node.bindings.find((b) => b.input === input)
}

// ─── The vendored contract ─────────────────────────────────────────────────────

test('the vendored SemanticAction contract is sha-asserted at import and named in receipts', () => {
  // Importing nlq.ts at all proves the assertion passed; pin the digest so a silent re-vendor fails.
  assert.equal(SEMANTIC_ACTION_CONTRACT.sha256, SEMANTIC_ACTION_SCHEMA_SHA256)
  assert.equal(SEMANTIC_ACTION_CONTRACT.sha256, 'fd01c834f5ca9bbaf524ea777a37cdd7fecdb3a12468b46b18de3244bc741eda')
  assert.equal(SEMANTIC_ACTION_CONTRACT.specVersion, '0.1.0')
  assert.equal(SEMANTIC_ACTION_CONTRACT.schema, 'https://schemas.srcos.ai/v2/SemanticAction.json')
})

test('a schema-invalid action definition is rejected at declare time', () => {
  const r = new ActionRegistry()
  const cases: { why: string; def: unknown; match: RegExp }[] = [
    { why: 'id violates the URN pattern', def: act({ name: 'crm.bad', id: 'crm-bad' } as ActionSpec), match: /does not match pattern/ },
    { why: 'wrong discriminator', def: act({ name: 'crm.bad2', type: 'Action' } as unknown as ActionSpec), match: /must equal "SemanticAction"/ },
    { why: 'wrong specVersion const', def: act({ name: 'crm.bad3', specVersion: '0.2.0' }), match: /must equal "0\.1\.0"/ },
    { why: 'name violates the lowercase pattern', def: act({ name: 'CRM.Bad' }), match: /does not match pattern/ },
    { why: 'version is not semver', def: act({ name: 'crm.bad4', version: 'v1' }), match: /does not match pattern/ },
    { why: 'sideEffects outside the closed enum', def: act({ name: 'crm.bad5', sideEffects: 'direct' } as unknown as ActionSpec), match: /must be one of/ },
    { why: 'typeRef is not an absolute URI', def: act({ name: 'crm.bad6', output: { typeRef: ':ContactList', cardinality: 'one' } }), match: /not an absolute URI/ },
    { why: 'cardinality outside the closed enum', def: act({ name: 'crm.bad7', output: { typeRef: THING, cardinality: 'lots' } } as unknown as ActionSpec), match: /must be one of/ },
    { why: 'undeclared extra property', def: { ...act({ name: 'crm.bad8' }), extra: 1 }, match: /unexpected property 'extra'/ },
    { why: 'registry metadata missing', def: (() => { const d = act({ name: 'crm.bad9' }) as Partial<SemanticActionDef>; delete d.registry; return d })(), match: /missing required property 'registry'/ },
  ]
  for (const c of cases) {
    assert.throws(() => r.declare(c.def as SemanticActionDef), c.match, c.why)
  }
  assert.equal(r.size, 0, 'nothing invalid reached the registry')
})

test('contract invariants JSON Schema cannot express are enforced too', () => {
  const dupInput = act({
    name: 'crm.dup',
    inputs: [
      { name: 'list', typeRef: LIST, required: true, cardinality: 'one' },
      { name: 'list', typeRef: CONTACT_LIST, required: false, cardinality: 'one' },
    ],
  })
  assert.deepEqual(
    validateSemanticAction(dupInput),
    ["SemanticAction.inputs: duplicate input name 'list'"])

  const danglingSubject = act({
    name: 'crm.dangling',
    inputs: [{ name: 'list', typeRef: LIST, required: true, cardinality: 'one' }],
    constraints: [{ kind: 'subClassOf', subject: 'lst', typeRef: LIST }],
  })
  assert.match(validateSemanticAction(danglingSubject)[0] ?? '', /subject 'lst' resolves to no declared input/)

  // `output` is always a legal constraint subject.
  assert.deepEqual(validateSemanticAction(act({
    name: 'crm.ok',
    constraints: [{ kind: 'subClassOf', subject: 'output', typeRef: THING }],
  })), [])
})

test('the registry resolves by id or name, refuses collisions, and hides deprecated actions', () => {
  const r = crmRegistry()
  assert.equal(r.size, 7)
  assert.equal(r.get(GET_CONTACT_LISTS)?.name, 'crm.get_contact_lists')
  assert.equal(r.get('crm.get_contact_lists')?.id, GET_CONTACT_LISTS)
  assert.equal(r.get('nope'), undefined)
  assert.throws(() => r.declare(act({ name: 'crm.get_contact_lists' })), /already registered/)

  r.declare(act({ name: 'crm.legacy_count', output: { typeRef: NUMBER, cardinality: 'one' }, registry: { owner: 'urn:srcos:agent:nlq-test', deprecated: true } }))
  assert.equal(r.size, 8)
  assert.ok(!r.list().some((a) => a.name === 'crm.legacy_count'), 'deprecated actions are not offered')
  assert.ok(r.list({ includeDeprecated: true }).some((a) => a.name === 'crm.legacy_count'), 'but stay resolvable for replay')
  // …and never reach a plan.
  const ids = r.list().map((a) => a.id)
  assert.deepEqual([...ids].sort(), ids, 'list() is id-sorted (deterministic)')
})

test('stored action definitions are frozen — a search cannot be mutated underneath', () => {
  const r = crmRegistry()
  const def = r.get(GET_CONTACT_LISTS)!
  assert.ok(Object.isFrozen(def))
  assert.ok(Object.isFrozen(def.inputs), 'nested structures are frozen too, not just the top level')
  assert.ok(Object.isFrozen(def.inputs[0]))
  // Mutating a frozen object throws in strict mode and is silently ignored in sloppy mode; assert the
  // property that holds either way — the registry's copy is unchanged.
  try { (def as { sideEffects: string }).sideEffects = 'effect-request' } catch { /* strict mode */ }
  assert.equal(r.get(GET_CONTACT_LISTS)!.sideEffects, 'none')
  assert.throws(() => { def.inputs.push({ name: 'x', typeRef: THING, required: false, cardinality: 'one' }) }, TypeError)
  assert.equal(r.get(GET_CONTACT_LISTS)!.inputs.length, 1)
})

// ─── format: declared ⇒ enforced ───────────────────────────────────────────────

/**
 * The formats the validator is expected to implement, each with a value it must ACCEPT and one it
 * must REJECT.
 *
 * Written out literally, on purpose. Deriving this list from `implementedFormats()` would make the
 * tests below a tautology — they would go green for a format that reached the accept-list and was
 * never implemented, which is exactly the bug this section exists to catch. So adding a format
 * forces a row here, and the row forces a counter-example, which is what keeps a stub check that
 * returns `true` for everything from being smuggled in behind an accepted name.
 */
const EXPECTED_FORMATS: ReadonlyArray<{ format: string; accepts: string; rejects: string }> = [
  { format: 'date-time', accepts: '2026-07-29T00:00:00Z', rejects: '2026-07-29' },
  { format: 'uri', accepts: 'https://schemas.srcos.ai/v2/SemanticAction.json', rejects: ':ContactList' },
]

/** Every `format` value a schema declares, at any depth. Independent of the validator's own walk. */
function declaredFormats(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) { for (const v of node) declaredFormats(v, into); return into }
  if (node === null || typeof node !== 'object') return into
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'format' && typeof v === 'string') into.add(v)
    else declaredFormats(v, into)
  }
  return into
}

test('the format accept-list is exactly the set of formats that have a check', () => {
  assert.deepEqual(
    [...implementedFormats()].sort(),
    EXPECTED_FORMATS.map((f) => f.format).sort(),
    'a format reached the accept-list without a row — and a counter-example — in this test')
})

test('every accepted format has TEETH: it accepts the good value and rejects the bad one', () => {
  for (const { format, accepts, rejects } of EXPECTED_FORMATS) {
    const schema: SchemaObj = { type: 'string', format }

    const clean: string[] = []
    validateAgainst(schema, accepts, 'v', clean)
    assert.deepEqual(clean, [], `${format}: '${accepts}' should validate clean`)

    const errs: string[] = []
    validateAgainst(schema, rejects, 'v', errs)
    assert.equal(errs.length, 1,
      `${format}: '${rejects}' must be rejected — a format that rejects nothing is declared, not enforced`)

    // The same rule asked directly, so a call site cannot get a second opinion.
    assert.equal(matchesFormat(format, accepts), true, format)
    assert.equal(matchesFormat(format, rejects), false, format)
  }
})

/**
 * Copilot review finding on #37. A structural regex accepts the right punctuation, not a time:
 * `2026-99-99T99:99:99Z` cleared the old check. A format check that admits values no clock can
 * produce is shape-matching wearing enforcement's clothes, which is the thing this whole section
 * exists to prevent — so the ranges, and the calendar, are asserted here.
 */
test('date-time rejects impossible instants, not just the wrong shape', () => {
  const IMPOSSIBLE = [
    '2026-99-99T99:99:99Z',   // the value that cleared the purely structural regex
    '2026-13-01T00:00:00Z',   // month 13
    '2026-00-01T00:00:00Z',   // month 0
    '2026-02-30T00:00:00Z',   // February 30 — shape-valid, calendar-impossible
    '2026-04-31T00:00:00Z',   // April has 30 days
    '2026-01-32T00:00:00Z',   // day 32
    '2026-01-00T00:00:00Z',   // day 0
    '2026-01-01T24:00:00Z',   // hour 24
    '2026-01-01T00:60:00Z',   // minute 60
    '2026-01-01T00:00:61Z',   // second 61 (60 is a permitted leap second)
    '2026-01-01T00:00:00+99:00', // offset hours out of range
    '2026-01-01T00:00:00+00:99', // offset minutes out of range
  ]
  for (const bad of IMPOSSIBLE) {
    assert.equal(matchesFormat('date-time', bad), false, `${bad} must not pass as an instant`)
    const errs: string[] = []
    validateAgainst({ type: 'string', format: 'date-time' }, bad, 'v', errs)
    assert.equal(errs.length, 1, `${bad} must be reported as a violation`)
  }

  // …and the real ones still pass, including the leap second and a genuine leap day.
  for (const good of [
    '2026-07-29T00:00:00Z',
    '2024-02-29T12:00:00Z',      // 2024 is a leap year
    '2000-02-29T00:00:00Z',      // divisible by 400 — a leap year
    '2026-12-31T23:59:60Z',      // leap second, permitted by RFC 3339
    '2026-01-01T00:00:00.123Z',
    '2026-01-01T00:00:00-05:00',
  ]) {
    assert.equal(matchesFormat('date-time', good), true, `${good} is a real instant and must pass`)
  }

  // 1900 is NOT a leap year (divisible by 100, not by 400) — the rule `Date.UTC` would have got
  // wrong for a two-digit year is exercised at both ends.
  assert.equal(matchesFormat('date-time', '1900-02-29T00:00:00Z'), false)
  assert.equal(matchesFormat('date-time', '1900-02-28T00:00:00Z'), true)
})

/**
 * Copilot review finding on #37, low-confidence channel — and the sharpest one on this PR.
 *
 * The accept-list used to be `export const IMPLEMENTED_FORMATS: ReadonlySet<string>`. `ReadonlySet`
 * is erased at runtime, so a caller could `.add()` to it and widen what the bar admits WITHOUT
 * adding a check. `validateAgainst` skips any format it has no entry for, so the smuggled name then
 * cleared import and was enforced by nobody — the module's own failure mode, reachable from outside
 * it. The accept-list is now a function over `FORMAT_CHECKS`, so there is nothing to mutate.
 */
test('the accept-list cannot be widened from outside — there is no mutable copy of it', () => {
  const before = implementedFormats()
  assert.ok(!isImplementedFormat('email'), 'precondition: email is not implemented')

  // Whatever a caller is handed, mutating it must not widen the bar. (A fresh array per call, so
  // this mutates a copy and nothing else.)
  assert.throws(() => { (before as string[]).push('email') }, TypeError,
    'the snapshot handed to callers must be frozen')

  assert.equal(isImplementedFormat('email'), false, 'the bar must still refuse email')
  assert.deepEqual(implementedFormats(), before, 'a later snapshot must be unchanged')
  assert.throws(() => assertSupportedKeywords({ type: 'string', format: 'email' }, 'T'),
    /is NOT implemented/, 'and a contract declaring it must still be refused at import')

  // Two snapshots must not be the same object, or handing one out leaks the source of truth.
  assert.notEqual(implementedFormats(), implementedFormats(), 'each call returns a fresh array')
  assert.deepEqual(implementedFormats(), implementedFormats(), '…with equal contents')
})

test('a contract declaring an UNIMPLEMENTED format fails LOUDLY at the import bar', () => {
  const withEmail: SchemaObj = {
    type: 'object',
    properties: { contact: { type: 'string', format: 'email' } },
  }
  assert.throws(
    () => assertSupportedKeywords(withEmail, 'T'),
    /format "email" at T\.properties\.contact is declared by the contract but is NOT implemented/)

  // Why the bar has to be the thing that rejects it: silence is the failure mode. Bypass the bar and
  // the declared constraint simply is not applied — no error, no signal, less validation than the
  // contract claims. That is the gap; the throw above is the whole fix.
  const errs: string[] = []
  validateAgainst(withEmail, { contact: 'definitely not an email' }, 'T', errs)
  assert.deepEqual(errs, [], 'unenforced when the bar is skipped — which is precisely why it must reject')

  for (const bogus of ['uuid', 'ipv4', 'hostname', 'URI', '', 'constructor', 'toString']) {
    assert.throws(() => assertSupportedKeywords({ type: 'string', format: bogus }, 'T'),
      /is NOT implemented/, `format: ${JSON.stringify(bogus)} must not clear the bar`)
  }
  assert.throws(() => assertSupportedKeywords({ type: 'string', format: 7 }, 'T'), /is NOT implemented/)
  assert.throws(() => matchesFormat('email', 'a@b.example'), /not implemented by validateAgainst/)
})

test('SemanticAction declares only formats that are enforced, and its uri format bites', () => {
  // Importing nlq.ts at all ran the bar over this schema; assert it explicitly so the claim is
  // stated rather than implied, and pin what the contract actually declares.
  assertSupportedKeywords(SEMANTIC_ACTION_SCHEMA as SchemaObj, 'SemanticAction')
  const declared = declaredFormats(SEMANTIC_ACTION_SCHEMA)
  assert.deepEqual([...declared].sort(), ['uri'], 'the contract declares format: uri and nothing else')
  for (const f of declared) assert.ok(isImplementedFormat(f), `${f} is declared but not implemented`)

  // …and the real contract's own `format: uri` (on `typeRef`) rejects the bare `:Thing` shorthand,
  // not just a synthetic schema built in this file.
  const good = act({ name: 'crm.fmt' }) as unknown as Record<string, unknown>
  const clean: string[] = []
  validateAgainst(SEMANTIC_ACTION_SCHEMA as SchemaObj, good, 'SemanticAction', clean)
  assert.deepEqual(clean, [], 'baseline: a well-formed action conforms')

  const errs: string[] = []
  validateAgainst(SEMANTIC_ACTION_SCHEMA as SchemaObj,
    { ...good, output: { typeRef: ':ContactList', cardinality: 'one' } }, 'SemanticAction', errs)
  assert.ok(errs.some((e) => /not an absolute URI/.test(e)), errs.join('; '))
})

// ─── Tokenization + annotation ─────────────────────────────────────────────────

test('the tokenizer is deterministic and preserves exact character spans', () => {
  const q = 'How many mailings on list Acme?'
  const tokens = tokenizeQuestion(q)
  assert.deepEqual(tokens.map((t) => t.norm), ['how', 'many', 'mailings', 'on', 'list', 'acme'])
  for (const t of tokens) assert.equal(q.slice(t.start, t.end), t.text, 'span round-trips to the surface text')
  assert.deepEqual(tokens.map((t) => t.stop), [false, false, false, true, false, false])
  assert.deepEqual(tokenizeQuestion(q), tokens, 'same input ⇒ same tokens')
  assert.deepEqual(tokenizeQuestion(''), [])
})

test('lexicon annotation: longest match wins and curated terms outrank URI-derived ones', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'show me all contact lists in my org', { annotators: ANNOTATORS })
  const ann = r.annotations.map((a) => [a.tokenSpan.text, a.conceptRef, a.confidence] as const)
  assert.deepEqual(ann, [['contact lists', CONTACT_LIST, 0.8], ['org', ORG, 1]])
  // "contact lists" (2 tokens, derived-plural) beat the 1-token "lists" → :List.
  assert.ok(!r.annotations.some((a) => a.conceptRef === LIST))

  // Curated "list" → :ContactList beats the URI-derived "list" → :List at the same span length.
  const r2 = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  const listAnn = r2.annotations.find((a) => a.tokenSpan.text === 'list')
  assert.equal(listAnn?.conceptRef, CONTACT_LIST)
  assert.equal(listAnn?.confidence, 1)
  assert.equal(r2.annotations.find((a) => a.tokenSpan.text === 'how many')?.conceptRef, NUMBER)
  assert.equal(r2.annotations.find((a) => a.tokenSpan.text === 'mailings')?.conceptRef, MAILING, 'derived plural matches')
})

// ─── The headline decompositions ───────────────────────────────────────────────

test('"show me all contact lists in my org" decomposes into GetContactLists ← GetOrganization', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'show me all contact lists in my org', { annotators: ANNOTATORS })
  const w = r.winner
  assert.ok(w)
  assert.deepEqual(chain(w.plan), [GET_CONTACT_LISTS, GET_ORGANIZATION])

  // A mention is not a value: the :Organization slot was filled by an ACTION, not by the "org" span.
  const org = bindingOf(w.plan, 'org')
  assert.equal(org.kind, 'action')
  assert.equal(org.via?.actionId, GET_ORGANIZATION)
  assert.deepEqual(org.subsumption, { concept: ORG, satisfies: ORG, direct: true })

  // Every content token consumed, nothing invented.
  assert.equal(w.senseMetric.coverage, 1)
  assert.equal(w.senseMetric.consumedContentTokens, 3)
  assert.equal(w.senseMetric.contentTokens, 3)
  assert.equal(w.senseMetric.creativity, 0)
  assert.equal(w.senseMetric.groundedness, 1)
  assert.equal(w.senseMetric.composite, 1)

  // Per-node provenance: token span → concept → action.
  assert.deepEqual(w.provenance.map((p) => [p.tokenSpan?.text, p.conceptRef, p.actionId]), [
    ['contact lists', CONTACT_LIST, GET_CONTACT_LISTS],
    ['org', ORG, GET_ORGANIZATION],
  ])
  assert.ok(w.provenance.every((p) => p.grounded && p.weight === 1))
})

test('"how many mailings on list X" yields NumberOf → GetMailingsByList → FindListByName', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  const w = r.winner
  assert.ok(w)
  assert.deepEqual(chain(w.plan), [NUMBER_OF, GET_MAILINGS_BY_LIST, FIND_LIST_BY_NAME])

  // The set-valued Mailing output fills NumberOf's `many` slot by subsumption (:Mailing ⊑ :Thing).
  const items = bindingOf(w.plan, 'items')
  assert.equal(items.kind, 'action')
  assert.deepEqual(items.subsumption, { concept: MAILING, satisfies: THING, direct: false })

  // The literal slot lifts the span text straight out of the question — "Acme" is the value.
  const find = planNodes(w.plan)[2]!
  const name = bindingOf(find, 'name')
  assert.equal(name.kind, 'annotation')
  assert.equal(name.literal, 'Acme')
  assert.equal(name.tokenSpan?.text, 'Acme')
  assert.equal(name.typeRef, NAME)

  assert.equal(w.senseMetric.coverage, 1, 'all five content tokens consumed')
  assert.equal(w.senseMetric.creativity, 0)
  assert.equal(w.senseMetric.similarity, 1, 'plan pre-order tracks question order')
})

// ─── Typed unification ─────────────────────────────────────────────────────────

test('subClassOf polymorphism is accepted where the direct type differs', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  // Count declares :List and constrains subClassOf :List; FindListByName produces :ContactList.
  const poly = r.variants.find((v) => chain(v.plan)[0] === COUNT && chain(v.plan)[1] === FIND_LIST_BY_NAME)
  assert.ok(poly, 'the polymorphic Count(:List) ← FindListByName(:ContactList) variant is produced')
  const list = bindingOf(poly.plan, 'list')
  assert.equal(list.typeRef, LIST, 'the slot is declared as the SUPERtype')
  assert.equal(list.conceptRef, CONTACT_LIST, 'and was filled by a SUBtype')
  assert.deepEqual(list.subsumption, { concept: CONTACT_LIST, satisfies: LIST, direct: false })
})

test('type-mismatched bindings are never produced', async () => {
  const store = crmStore()
  const lattice = store.atomspace().types
  const r = await compileQuestion(store, crmRegistry(), 'how many mailings in my org', { annotators: ANNOTATORS })
  assert.ok(r.variants.length > 0)

  let checked = 0
  for (const v of r.variants) {
    for (const node of planNodes(v.plan)) {
      for (const b of node.bindings) {
        if (b.kind === 'unbound') continue
        assert.ok(b.conceptRef, 'a bound slot always records the bound type')
        assert.ok(lattice.isA(b.conceptRef, b.typeRef),
          `${node.actionName}.${b.input}: ${b.conceptRef} does not satisfy ${b.typeRef}`)
        checked++
      }
      // :Organization is not under :ContactList — that binding must never appear.
      const bad = node.bindings.find((x) => x.typeRef === CONTACT_LIST && x.conceptRef === ORG)
      assert.equal(bad, undefined, 'an Organization is never bound into a ContactList slot')
    }
  }
  assert.ok(checked > 0, 'the invariant was actually exercised')
})

test('a set-valued output never fills a single-valued slot', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many contact lists in my org', { annotators: ANNOTATORS })
  // GetContactLists produces `many` ContactList; Count's `list` slot is `one`. Type-compatible
  // (:ContactList ⊑ :List) but cardinality-incompatible — so the pairing must never appear.
  for (const v of r.variants) {
    for (const node of planNodes(v.plan)) {
      for (const b of node.bindings) {
        if (b.cardinality === 'one' && b.via) {
          assert.equal(b.via.outputCardinality, 'one',
            `${node.actionName}.${b.input} is single-valued but was fed a set from ${b.via.actionName}`)
        }
      }
    }
  }
})

// ─── Effects are proposed, never taken ─────────────────────────────────────────

test('an effect-request action is a dataflow leaf: plan root only, proposal only, never a provider', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'send mailing to list Acme', { annotators: ANNOTATORS })
  const w = r.winner
  assert.ok(w)
  assert.equal(w.plan.actionId, SEND_MAILING)
  assert.equal(w.plan.sideEffects, 'effect-request')

  // It carries a PROPOSAL, never a result.
  assert.equal(w.plan.effectRequest?.status, 'proposed')
  assert.equal(w.plan.effectRequest?.proposes, EFFECT_REQUEST)
  assert.equal(w.plan.effectRequest?.executorRef, 'urn:srcos:connector:crm-send-mailing')
  assert.deepEqual(w.plan.effectRequest?.arguments.map((a) => a.input), ['list'])

  // Its argument was still computed by a PURE action — computing an argument is not taking the effect.
  assert.equal(bindingOf(w.plan, 'list').via?.actionId, FIND_LIST_BY_NAME)

  // Across every variant: an effect action is only ever the root and is never consumed as an input.
  for (const v of r.variants) {
    for (const node of planNodes(v.plan)) {
      if (node.sideEffects === 'effect-request') {
        assert.equal(node.nodeId, 'n0', 'an effect-request action can only be the plan root')
        assert.ok(node.effectRequest, 'and always carries its proposal')
      }
      for (const b of node.bindings) {
        assert.notEqual(b.via?.sideEffects, 'effect-request', 'an effect output is never consumed')
      }
    }
  }
})

// ─── Sense metric ──────────────────────────────────────────────────────────────

test('ranking flip: the higher-coverage, lower-creativity plan beats the ungrounded one', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  const w = r.winner!
  // The loser invents GetOrganization — nothing in the question mentions an org.
  const invented = r.variants.find((v) => chain(v.plan).includes(GET_ORGANIZATION))
  assert.ok(invented, 'an ungrounded-node variant IS explored')

  assert.ok(w.senseMetric.coverage > invented.senseMetric.coverage, 'winner consumes more of the question')
  assert.ok(w.senseMetric.creativity < invented.senseMetric.creativity, 'and invents less')
  assert.ok(w.senseMetric.composite > invented.senseMetric.composite)
  assert.ok(w.rank < invented.rank)
  assert.equal(w.senseMetric.ungroundedNodes, 0)
  assert.ok(invented.senseMetric.ungroundedNodes > 0)

  // Ranks are dense, 1-based, and monotone in composite.
  assert.deepEqual(r.variants.map((v) => v.rank), r.variants.map((_, i) => i + 1))
  for (let i = 1; i < r.variants.length; i++) {
    assert.ok(r.variants[i - 1]!.senseMetric.composite >= r.variants[i]!.senseMetric.composite)
  }
})

test('the creativity penalty IS the admissibility discount — one mechanism, not two', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  const invented = r.variants.find((v) => v.senseMetric.ungroundedNodes > 0)
  assert.ok(invented)

  const node = planNodes(invented.plan).find((n) => n.grounding.kind === 'ungrounded')!
  const decision = node.grounding.admissibility
  assert.ok(decision, 'every invented node carries its admissibility ruling')
  assert.equal(decision.admitted, true)
  assert.equal(decision.weight, OPINION_WEIGHT_MULTIPLIER, 'the node weight IS the opinion discount')
  assert.ok(decision.steps.some((s) => s.gate === 'opinion' && /model-generated/.test(s.reason)))

  // groundedness is the mean node weight, so it falls out of the discount rather than paralleling it.
  const m = invented.senseMetric
  const expected = (m.groundedNodes * 1 + m.ungroundedNodes * OPINION_WEIGHT_MULTIPLIER) / m.nodes
  assert.ok(Math.abs(m.groundedness - expected) < 1e-12)
  assert.ok(Math.abs(m.creativity - (1 - m.groundedness)) < 1e-12)
  assert.deepEqual(m.admissibility.map((a) => [a.reason, a.weight]), [['no-token-span', OPINION_WEIGHT_MULTIPLIER]])
})

test('forbidding opinion drops the inventing variants and keeps the grounded ones', async () => {
  const q = 'how many mailings on list Acme'
  const permissive = await compileQuestion(crmStore(), crmRegistry(), q, { annotators: ANNOTATORS })
  const strict = await compileQuestion(crmStore(), crmRegistry(), q, { annotators: ANNOTATORS, admissibility: { allowOpinion: false } })

  assert.ok(permissive.variants.some((v) => v.senseMetric.ungroundedNodes > 0))
  assert.equal(strict.variants.filter((v) => v.senseMetric.ungroundedNodes > 0).length, 0,
    'an inadmissible node carries weight 0 — the variant must not enter the context at all')
  assert.ok(strict.variants.length > 0 && strict.variants.length < permissive.variants.length)
  // The winner was fully grounded, so forbidding opinion does not change it.
  assert.deepEqual(chain(strict.winner!.plan), chain(permissive.winner!.plan))
})

test('a registry default grounds a node that would otherwise be an invention', async () => {
  const q = 'how many contact lists'
  const bare = await compileQuestion(crmStore(), crmRegistry(), q, { annotators: ANNOTATORS })
  const withDefault = await compileQuestion(crmStore(), crmRegistry(), q, {
    annotators: ANNOTATORS,
    defaults: [{ typeRef: ORG, label: 'the requester current organization' }],
  })

  const orgNodeOf = (c: typeof bare): PlanNode | undefined =>
    c.variants.flatMap((v) => planNodes(v.plan)).find((n) => n.actionId === GET_ORGANIZATION)

  assert.equal(orgNodeOf(bare)?.grounding.kind, 'ungrounded', 'nothing in the question mentions an org')
  assert.equal(orgNodeOf(withDefault)?.grounding.kind, 'registry-default')
  assert.equal(orgNodeOf(withDefault)?.grounding.defaultLabel, 'the requester current organization')

  // The default can also fill the slot directly, with no sub-action at all.
  const direct = withDefault.variants.find((v) => findBinding(v.plan, 'org')?.kind === 'default'
    || v.plan.bindings.some((b) => b.via && findBinding(b.via, 'org')?.kind === 'default'))
  assert.ok(direct, 'an ambient typed value binds a non-literal slot without inventing an action')
})

test('the sense metric carries its explicit weights and the composite recomputes from them', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  assert.deepEqual(r.weights, DEFAULT_SENSE_WEIGHTS)
  for (const v of r.variants) {
    const m = v.senseMetric
    assert.deepEqual(m.weights, DEFAULT_SENSE_WEIGHTS)
    const recomputed = m.coverage * m.weights.coverage + m.groundedness * m.weights.groundedness + m.similarity * m.weights.similarity
    assert.ok(Math.abs(m.composite - recomputed) < 1e-12, 'composite is exactly the weighted sum')
    for (const axis of [m.coverage, m.groundedness, m.creativity, m.similarity, m.composite]) {
      assert.ok(axis >= 0 && axis <= 1, 'every axis is normalized')
    }
    assert.equal(m.groundedNodes + m.ungroundedNodes, m.nodes)
  }

  // Re-weighting is caller-visible and actually moves the ranking arithmetic.
  const coverageOnly = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', {
    annotators: ANNOTATORS,
    weights: { coverage: 1, groundedness: 0, similarity: 0 },
  })
  assert.deepEqual(coverageOnly.weights, { coverage: 1, groundedness: 0, similarity: 0 })
  assert.equal(coverageOnly.winner!.senseMetric.composite, coverageOnly.winner!.senseMetric.coverage)
})

// ─── Purity + seal ─────────────────────────────────────────────────────────────

test('the search is PURE — compiling never mutates the store', async () => {
  const store = crmStore()
  store.addNode('acme', ['Organization'], { name: 'Acme' })
  const before = { seq: store.version(), nodes: store.allNodes().length, edges: store.edgeCount() }

  for (const q of ['show me all contact lists in my org', 'how many mailings on list Acme', 'send mailing to list Acme', '']) {
    await compileQuestion(store, crmRegistry(), q, { annotators: ANNOTATORS })
  }

  assert.equal(store.version(), before.seq, 'the logical clock did not advance — nothing was written')
  assert.equal(store.allNodes().length, before.nodes)
  assert.equal(store.edgeCount(), before.edges)
})

test('the result is sealed like enrich/explore and the seal is deterministic', async () => {
  const q = 'how many mailings on list Acme'
  const a = await compileQuestion(crmStore(), crmRegistry(), q, { annotators: ANNOTATORS })
  const b = await compileQuestion(crmStore(), crmRegistry(), q, { annotators: ANNOTATORS })

  assert.match(a.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(a.hash, b.hash, 'same inputs against the same graph state ⇒ byte-identical seal')
  assert.deepEqual(a.snapshot, { seq: 0, nodes: 0, edges: 0 })
  assert.equal(a.method, 'restricted-search(typed-unification,beam)/sense(coverage,groundedness,similarity)')
  assert.equal(a.contract.sha256, SEMANTIC_ACTION_SCHEMA_SHA256, 'the receipt names the contract it compiled against')

  // The seal binds to the store's logical clock, so graph state moves it.
  const store = crmStore()
  const c1 = await compileQuestion(store, crmRegistry(), q, { annotators: ANNOTATORS })
  store.addNode('n', ['Thing'], {})
  const c2 = await compileQuestion(store, crmRegistry(), q, { annotators: ANNOTATORS })
  assert.notEqual(c1.hash, c2.hash)
  assert.ok(c2.snapshot.seq > c1.snapshot.seq)

  // And a different question seals differently.
  const other = await compileQuestion(crmStore(), crmRegistry(), 'show me all contact lists in my org', { annotators: ANNOTATORS })
  assert.notEqual(a.hash, other.hash)
})

test('a question the registry cannot serve still returns a sealed, honest result', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'what is the weather tomorrow', { annotators: ANNOTATORS })
  assert.match(r.hash, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(r.annotations, [], 'nothing in the question names anything the registry knows')
  // Rather than fabricate a grounding, every offered plan is marked as entirely invented and scores
  // its own poor fit: no node claims a token span, and coverage stays low.
  assert.ok(r.variants.length > 0)
  assert.ok(r.variants.every((v) => v.senseMetric.groundedNodes === 0))
  assert.ok(r.variants.every((v) => v.senseMetric.creativity === 1 - OPINION_WEIGHT_MULTIPLIER))
  assert.ok(r.variants.every((v) => v.senseMetric.coverage < 0.5))
  assert.ok(r.variants.flatMap((v) => planNodes(v.plan)).every((n) => n.grounding.tokenSpan === undefined))

  // And when invention is forbidden, the compiler declines outright instead of guessing.
  const strict = await compileQuestion(crmStore(), crmRegistry(), 'what is the weather tomorrow', {
    annotators: ANNOTATORS,
    admissibility: { allowOpinion: false },
  })
  assert.deepEqual(strict.variants, [])
  assert.equal(strict.winner, null)
  assert.match(strict.hash, /^sha256:[0-9a-f]{64}$/, 'a refusal is sealed too')

  const empty = await compileQuestion(crmStore(), crmRegistry(), '', { annotators: ANNOTATORS })
  assert.deepEqual(empty.tokens, [])
  assert.match(empty.hash, /^sha256:[0-9a-f]{64}$/)
})

// ─── The KKO-semantic annotator ────────────────────────────────────────────────

/** Deterministic, offline stand-in for an EmbedFn — a character histogram. No network in tests. */
const fakeEmbed = async (text: string): Promise<number[]> => {
  const v = new Array<number>(64).fill(0)
  for (const ch of text.toLowerCase().replace(/[^a-z]/g, '')) v[ch.charCodeAt(0) % 64]! += 1
  return v
}

test('the KKO-semantic annotator annotates through an injected EmbedFn and compiles', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', {
    annotators: [kkoSemanticAnnotator(fakeEmbed, { minSimilarity: 0.9 })],
  })
  assert.ok(r.annotations.length > 0, 'spans were matched to concepts by embedding similarity')
  assert.ok(r.annotations.every((a) => a.source === 'kko-semantic'))
  assert.ok(r.annotations.every((a) => a.confidence >= 0.9 && a.confidence <= 1))
  assert.ok(r.annotations.some((a) => a.tokenSpan.text === 'mailings' && a.conceptRef === MAILING))
  assert.ok(r.winner, 'and the annotations drive a real plan')
  assert.deepEqual(chain(r.winner.plan), [GET_MAILINGS_BY_LIST, FIND_LIST_BY_NAME])

  // An embedder that returns nothing degrades to no annotations rather than throwing.
  const dead = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings', {
    annotators: [kkoSemanticAnnotator(async () => [])],
  })
  assert.deepEqual(dead.annotations, [])
})

test('kkoConceptLexicon draws its vocabulary from the KKO classes loaded in the store', () => {
  const store = crmStore()
  assert.deepEqual(kkoConceptLexicon(store), [], 'no KKO loaded ⇒ empty lexicon, not a crash')

  const kkoNs = 'http://kbpedia.org/ontologies/kko#'
  store.addNode(kkoNs + 'Monads', ['KkoClass'], { short: 'kko:Monads', label: 'Monads' })
  store.addNode(kkoNs + 'ContactList', ['KkoClass'], { short: 'kko:ContactList' })
  const lex = kkoConceptLexicon(store)
  assert.deepEqual(lex, [
    { conceptRef: kkoNs + 'ContactList', terms: ['contact list'] },
    { conceptRef: kkoNs + 'Monads', terms: ['monads'] },
  ])
})

test('annotators compose: lexicon + semantic merge, and provenance keeps every annotator on record', async () => {
  const r = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', {
    annotators: [lexiconAnnotator(LEXICON), kkoSemanticAnnotator(fakeEmbed, { minSimilarity: 0.9 })],
  })
  const sources = new Set(r.annotations.map((a) => a.source))
  assert.deepEqual([...sources].sort(), ['kko-semantic', 'lexicon'])
  // Annotations are span-ordered for readability of the receipt.
  for (let i = 1; i < r.annotations.length; i++) {
    assert.ok(r.annotations[i - 1]!.tokenSpan.start <= r.annotations[i]!.tokenSpan.start)
  }
  // The winner is unchanged: the search deduplicates identical (span, concept) evidence rather than
  // double-counting it just because two annotators agreed.
  const lexOnly = await compileQuestion(crmStore(), crmRegistry(), 'how many mailings on list Acme', { annotators: ANNOTATORS })
  assert.deepEqual(chain(r.winner!.plan), chain(lexOnly.winner!.plan))
})

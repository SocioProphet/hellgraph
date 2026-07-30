import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['HELLGRAPH_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'hg-sec7-'))

import { getHellGraph } from './store.js'
import { getAtomSpace } from './atomspace.js'
import { runSparql } from './sparql.js'
import { runGremlin } from './gremlin.js'
import { runCypher } from './cypher.js'
import { sanitizeLogValue, LOG_FIELD_MAX } from './log-safe.js'

const g = getHellGraph()
g.addNode('n:1', ['Person'], { name: 'Ada', age: 30 })
g.addNode('n:2', ['Person'], { name: 'Alan', age: 40 })

/** Keys that alias a member of Object.prototype — the whole attack surface in one list. */
const HOSTILE_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']

const ownKeys = (o: object): string[] => Object.getOwnPropertyNames(o)
const isOwnData = (o: object, k: string): boolean => {
  const d = Object.getOwnPropertyDescriptor(o, k)
  return d !== undefined && 'value' in d
}

// ─── Attack 16: remote property injection through query-derived key names ──────────────────
// CodeQL js/remote-property-injection, alert 34 (ts/src/sparql.ts:628, HIGH).
// A SPARQL variable name is attacker-controlled: the tokenizer accepts /\?[A-Za-z0-9_]+/, so
// `?__proto__` and `?constructor` are expressible verbatim in a query body posted to
// /api/graph/sparql. On a plain-object Binding that reaches Object.prototype three ways —
// a swallowed write, an inherited read, and a spuriously-true `in`. All three are asserted.

test('SECURITY: GROUP BY ?__proto__ writes an own data property and cannot clobber a prototype', () => {
  const r = runSparql(g, 'SELECT ?__proto__ (COUNT(?s) AS ?n) WHERE { ?s ?p ?__proto__ } GROUP BY ?__proto__')

  assert.ok(r.bindings.length > 0, 'a variable named ?__proto__ must still match rows, not silently return zero')
  for (const b of r.bindings) {
    assert.ok(isOwnData(b, '__proto__'), '__proto__ must be stored as an OWN DATA property, not routed to the setter')
    assert.equal(Object.getPrototypeOf(b), Object.prototype, 'the row prototype must be untouched')
    assert.ok(JSON.stringify(b).includes('__proto__'), 'a DECLARED variable must appear in the serialized row')
  }
  // The declared variable list and the row keys must agree — the silent-wrong failure mode is a
  // column promised in `variables` and then absent from every row.
  for (const v of r.variables) {
    assert.ok(r.bindings.every((b) => ownKeys(b).includes(v)), `declared variable ${v} missing from a row`)
  }
})

test('SECURITY: an aggregate aliased to ?__proto__ lands in the row instead of being swallowed', () => {
  const r = runSparql(g, 'SELECT (COUNT(?s) AS ?__proto__) WHERE { ?s ?p ?o }')
  assert.deepEqual(r.variables, ['__proto__'])
  assert.equal(r.bindings.length, 1)
  const row = r.bindings[0]!
  assert.ok(isOwnData(row, '__proto__'), 'COUNT(...) AS ?__proto__ must produce a real own property')
  assert.equal(typeof (row as Record<string, unknown>)['__proto__'], 'number', 'and it must hold the count')
})

test('SECURITY: an unbound hostile variable reads as null, never as an inherited function', () => {
  for (const key of HOSTILE_KEYS) {
    for (const q of [
      `SELECT ?${key} (COUNT(?s) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?${key}`, // aggregate path (line 628)
      `SELECT ?${key} WHERE { ?s ?p ?o }`,                                    // plain projection path
    ]) {
      for (const b of runSparql(g, q).bindings) {
        const v = (b as Record<string, unknown>)[key]
        assert.notEqual(typeof v, 'function', `?${key} leaked an inherited function into a binding (${q})`)
        assert.equal(v, null, `?${key} is unbound and must read as null (${q})`)
      }
    }
  }
})

test('SECURITY: a hostile variable name still unifies — matchTriple must not see an inherited key', () => {
  // The `in` failure mode: `'__proto__' in binding` is true on a plain object that bound nothing,
  // so unify() compares the candidate against Object.prototype, fails, and the query returns zero
  // rows. `?__proto__` must behave exactly like any other variable name.
  const hostile = runSparql(g, 'SELECT ?__proto__ WHERE { ?s ?p ?__proto__ }').bindings.length
  const control = runSparql(g, 'SELECT ?ordinary WHERE { ?s ?p ?ordinary }').bindings.length
  assert.equal(hostile, control, '?__proto__ must match the same rows as any ordinary variable name')
  assert.ok(hostile > 0, 'and that must not be zero')
})

test('SECURITY: no query surface pollutes the global Object.prototype', () => {
  const probe = () => ({} as Record<string, unknown>)
  for (const key of HOSTILE_KEYS) {
    runSparql(g, `SELECT ?${key} (COUNT(?s) AS ?n) WHERE { ?s ?p ?${key} } GROUP BY ?${key}`)
    runSparql(g, `SELECT (COUNT(?s) AS ?${key}) WHERE { ?s ?p ?o }`)
  }
  assert.equal(probe()['polluted'], undefined, 'Object.prototype must carry no attacker key')
  assert.equal(Object.getPrototypeOf({}), Object.prototype)
  assert.equal(typeof ({} as Record<string, unknown>)['toString'], 'function', 'and must remain intact')
})

// ─── Attack 17: the same pattern in the sibling query surfaces ─────────────────────────────

test('SECURITY: Gremlin values()/has() read own properties only — no inherited function leaks', () => {
  for (const key of HOSTILE_KEYS) {
    const vals = runGremlin(g, `g.V().values("${key}")`).values as unknown[]
    assert.ok(
      !vals.some((v) => typeof v === 'function'),
      `g.V().values("${key}") handed back an Object.prototype function as if it were graph data`,
    )
    assert.equal(vals.length, 0, `no node stores "${key}", so the traversal must yield nothing`)
    // has() must not match on an inherited member either.
    const matched = runGremlin(g, `g.V().has("${key}","x").values("name")`).values as unknown[]
    assert.equal(matched.length, 0, `has("${key}", …) matched a node that never stored it`)
  }
})

test('SECURITY: Cypher RETURN of a hostile variable yields own data, not a prototype member', () => {
  const as = getAtomSpace()
  // NB `__proto__` is included for the OWN-PROPERTY assertion only. Its projected value is ''
  // because Cypher reserves a leading `_` for internal IR variables (`_leading` behaves
  // identically) — that naming convention is pre-existing and unrelated to this alert.
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf']) {
    const r = runCypher(as, `MATCH (${key}:Person) RETURN ${key} LIMIT 5`) as {
      columns: string[]
      rows: Record<string, string>[]
    }
    assert.ok(r.rows.length > 0, `MATCH (${key}:Person) must still match — a hostile name is just a name`)
    for (const row of r.rows) {
      assert.ok(isOwnData(row, key), `a DECLARED column ${key} must be an own data property of the row`)
      assert.equal(Object.getPrototypeOf(row), Object.prototype, 'row prototype untouched')
      assert.notEqual(typeof row[key], 'function', `${key} leaked an inherited function`)
    }
  }
})

test('SECURITY: an unsupplied Cypher $param named for a prototype member resolves empty', () => {
  const as = getAtomSpace()
  // Store a node whose name is EXACTLY what Object.prototype.constructor stringifies to. With a
  // plain-object params lookup, `$constructor` resolves to that inherited function, stringifies,
  // and matches this node — a row the caller never asked for, from a parameter never supplied.
  const bait = String(Object)
  getHellGraph().addNode('n:bait', ['Person'], { name: bait })

  const injected = runCypher(as, 'MATCH (n:Person) WHERE n.name = $constructor RETURN n LIMIT 5', {}) as {
    rows: Record<string, string>[]
  }
  assert.equal(injected.rows.length, 0, 'an unsupplied $param must match nothing, not a stringified prototype function')

  // Control: a supplied parameter of the same name must still work normally.
  const supplied = runCypher(as, 'MATCH (n:Person) WHERE n.name = $constructor RETURN n LIMIT 5', {
    constructor: bait,
  }) as { rows: Record<string, string>[] }
  assert.equal(supplied.rows.length, 1, 'a genuinely supplied parameter named "constructor" must still resolve')
})

// ─── Attack 18: log-entry forgery at the log boundary ──────────────────────────────────────
// CodeQL js/log-injection, alert 28 (ts/src/super-peer.ts:318, MEDIUM). Receipts and audit
// records in this estate are read back as evidence, so a log line an attacker can SHAPE lets
// them author entries a later reader attributes to the system.

const C = String.fromCharCode

/**
 * What a log READER can be made to misrender.
 *
 * Written as an explicit enumeration, deliberately NOT as the Unicode categories
 * `sanitizeLogValue` happens to strip. The first version of this constant was
 * `/[\p{Cc}\p{Zl}\p{Zp}]/u` — character-for-character the implementation's own class — so the
 * general assertions below could not fail for anything the implementation had omitted. They
 * were decoration that looked like coverage, and `\p{Cf}` survived behind them: U+202E and
 * U+200B passed the whole suite.
 *
 * So this list is derived from the consumer's behaviour instead. Each range is here because of
 * what it does to a reader or a parser, not because of which category it belongs to. If the
 * implementation later drops a class this list still names, these tests go red — which is the
 * only arrangement in which they are worth running.
 */
const UNSAFE_IN_A_LOG_FIELD = new RegExp(
  '[' +
  '\\u0000-\\u001F' +  // C0: NUL truncates C-string consumers, ESC drives ANSI, VT/FF/CR/LF break
  '\\u007F-\\u009F' +  // DEL + C1 controls; U+0085 NEL is a real terminator to Unicode readers
  '\\u00AD' +          // SOFT HYPHEN — invisible; splits a token so a search never matches it
  '\\u061C' +          // ARABIC LETTER MARK — bidi control
  '\\u200B-\\u200F' +  // ZWSP/ZWNJ/ZWJ/LRM/RLM — invisible, or reorder the rest of the field
  '\\u2028\\u2029' +   // LINE / PARAGRAPH SEPARATOR
  '\\u202A-\\u202E' +  // bidi embed/override — the Trojan Source class
  '\\u2066-\\u2069' +  // bidi isolates
  '\\uFEFF' +          // BOM / ZWNBSP — invisible
  ']', 'u')

/** Kept under the old name so the assertions below read as before. */
const LINE_BREAKING = UNSAFE_IN_A_LOG_FIELD

const FORGERY_VECTORS: [string, string][] = [
  ['LF', C(0x0a)],
  ['CR', C(0x0d)],
  ['CRLF', C(0x0d) + C(0x0a)],
  ['VT (vertical tab)', C(0x0b)],
  ['FF (form feed)', C(0x0c)],
  ['NEL U+0085', C(0x85)],
  ['LS U+2028', C(0x2028)],
  ['PS U+2029', C(0x2029)],
  ['NUL', C(0x00)],
  ['ANSI CSI erase-line', C(0x1b) + '[2K' + C(0x1b) + '[1G'],
  // Forge the READING of the line rather than the line itself. None of these contain a
  // terminator, so every CR/LF-shaped defence lets them straight through.
  ['RLO U+202E (Trojan Source)', C(0x202e)],
  ['LRO U+202D', C(0x202d)],
  ['RLE U+202B', C(0x202b)],
  ['bidi isolate U+2066', C(0x2066)],
  ['bidi isolate pop U+2069', C(0x2069)],
  ['RLM U+200F', C(0x200f)],
  ['ZWSP U+200B', C(0x200b)],
  ['ZWNJ U+200C', C(0x200c)],
  ['SOFT HYPHEN U+00AD', C(0xad)],
  ['BOM U+FEFF', C(0xfeff)],
  ['ARABIC LETTER MARK U+061C', C(0x61c)],
]

test('SECURITY: no control character can forge a second log line', () => {
  for (const [name, sep] of FORGERY_VECTORS) {
    const payload = `benign${sep}[super-peer] audit: admitted=attacker`
    const out = sanitizeLogValue(payload)

    assert.ok(!LINE_BREAKING.test(out), `${name}: a line-breaking/control character survived sanitization`)
    assert.equal(out.split(/\r|\n/u).length, 1, `${name}: output split into more than one line`)
    // The forged text may remain as inert characters — what must NOT survive is the separator
    // that turns it into its own record.
    assert.ok(out.startsWith('benign'), `${name}: the real field content must be preserved`)
    assert.ok(out.includes('\\x') || out.includes('\\u') || out.includes('\\r') || out.includes('\\n'),
      `${name}: the neutralized character must be VISIBLE, so a reader can see it was there`)
  }
})

test('SECURITY: an attacker-shaped SPARQL parse error logs as exactly one line', () => {
  // End-to-end shape of alert 28: POST /query with a hostile query, the parse error embeds the
  // offending token verbatim, and that message is what super-peer's catch block logs.
  for (const [, sep] of FORGERY_VECTORS) {
    const query = `SELECT ?s WHERE { ?s ?p ?o } GROUP "x${sep}[super-peer] request error: none"`
    let message = ''
    try {
      runSparql(g, query)
      continue // parsed without error; nothing reaches the log for this vector
    } catch (e) {
      message = (e as Error).message
    }
    const logged = sanitizeLogValue(message)
    assert.ok(!LINE_BREAKING.test(logged), 'the logged line must contain no line-breaking character')
    assert.equal(logged.split(/\r|\n/u).length, 1, 'one error must produce exactly one log line')
  }
})

test('SECURITY: log fields are bounded and non-string input is coerced safely', () => {
  const flood = 'A'.repeat(50_000) + C(0x0a) + 'forged'
  const out = sanitizeLogValue(flood)
  assert.ok(out.length <= LOG_FIELD_MAX + '[truncated]'.length, 'a single field cannot flood the log')
  assert.ok(!LINE_BREAKING.test(out))

  for (const weird of [undefined, null, 42, { toString: () => 'x' + C(0x0a) + 'forged' }]) {
    const s = sanitizeLogValue(weird)
    assert.equal(typeof s, 'string')
    assert.ok(!LINE_BREAKING.test(s), 'coerced non-string input must be sanitized too')
  }
})

test('SECURITY: sanitizing leaves ordinary log text untouched', () => {
  const ordinary = "SPARQL parse error: expected 'BY', got 'LIMIT' (offset 42) — 100% ok"
  assert.equal(sanitizeLogValue(ordinary), ordinary, 'the sanitizer must not mangle normal messages')
})

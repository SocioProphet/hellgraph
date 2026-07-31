#!/usr/bin/env node
/**
 * safe-dict gate — the untrusted-key dictionary convention, mechanized.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────
 * `ts/src/safe-dict.ts` ends its docstring with a rule:
 *
 *     NB: object spread (`{ ...dict }`) and object literals re-attach Object.prototype.
 *     Use cloneDict / mergeDicts, never a spread, to carry one of these forward.
 *
 * That rule was a COMMENT, and a comment caught nothing. In the very PR that introduced
 * safe-dict.ts, `ts/src/patternMatcher.ts` had its interior converted to null-prototype
 * groundings and its OUTPUT row left as
 *
 *     const row: Record<string, string> = {}
 *     for (const v of variables) row[v] = …
 *
 * keyed by pattern variable names that arrive from query text. `row['__proto__'] = v` is an
 * ordinary assignment: it walks the prototype chain, finds Object.prototype's inherited
 * `__proto__` SETTER, and the write is swallowed — leaving a column DECLARED in `variables`
 * and absent from every row. It was caught by a human reading the diff (454a2c8), which is
 * not a control. This script is the control.
 *
 * ── What it enforces, in the query surfaces that key objects by names off the wire ───
 *   R1  A normal-prototype object must never take a COMPUTED-key assignment.
 *       `o = {}` / `Object.assign({}, …)` / `Object.fromEntries(…)` / `toPlainRow(…)` all
 *       produce Object.prototype-bearing objects; a later `o[expr] = v` on one of those is
 *       the swallowed-write bug above. Key-is-a-string-literal writes are fine (trusted key).
 *       R1 is SYNTACTIC — it reads how the value was CONSTRUCTED, not how it was declared — so
 *       renaming the type, an `as` cast, dropping the annotation, a deferred `row = {}`, or an
 *       intermediate alias variable do not evade it (all six are fixtures). That matters: the
 *       real regression was typed `Record<string, string>`, not `Binding`/`Grounding`/`RRow`,
 *       so a type-name-keyed rule would have shipped green against the actual bug.
 *
 *   R2  No object spread. `{ ...dict }` copies the entries but re-attaches Object.prototype,
 *       which restores the inherited-read and `'x' in dict` failure modes safe-dict.ts
 *       documents. Array spread `[...xs]` and call spread `f(...xs)` are untouched.
 *
 *   R3  No object literal in a position typed as one of the untrusted-key dictionaries
 *       (Binding, Grounding, RRow, SafeDict) — declaration, parameter default, `as` cast,
 *       `satisfies`, or a return against an annotated return type. Use emptyDict() /
 *       cloneDict() / mergeDicts() / toPlainRow().
 *
 *   R4  Coverage assertions, so the gate cannot quietly stop covering things:
 *       every canonical surface still exists, every tracked type name still resolves to a
 *       declaration, and the guarded set is non-empty.
 *
 * ── What this does NOT catch (read this before trusting it) ──────────────────────────
 * A floor under the convention, not a proof of it. Known holes, roughly by likelihood:
 *
 *   · The READ mode. `props[key]` off a normal-prototype object returns inherited FUNCTIONS
 *     (`values("constructor")` really does hand back the Object constructor). That was
 *     gremlin.ts's half of the CodeQL alert, and this gate scores gremlin.ts CLEAN both
 *     before and after that fix — a dynamic read is indistinguishable from a legitimate one
 *     without knowing the object's provenance. `ownValue()` there is still only a convention.
 *   · The `in` mode. `'__proto__' in binding` on a prototype-bearing object is not detected.
 *   · Laundering across a function boundary. R1 is intra-procedural: pass `{}` to a helper
 *     that performs the computed write and neither end is flagged on its own. In practice
 *     such a helper's parameter is usually typed as one of the tracked dictionaries, so R3
 *     fires at the call site — but a `Record<string, …>` parameter would slip through.
 *   · Files outside the guarded set. A new query surface is covered the moment it imports
 *     safe-dict, and not before.
 *   · Runtime re-attachment: `Object.setPrototypeOf(d, Object.prototype)`, `structuredClone`,
 *     `JSON.parse(JSON.stringify(d))`, or a round trip through a library.
 *   · Someone editing this file. There is deliberately NO magic-comment escape hatch, so
 *     relaxing the rule has to appear as a change to the RULE, in the diff, under review.
 *
 * ── The gate proves its own teeth ────────────────────────────────────────────────────
 * A checker that only ever goes green proves nothing. FIXTURES below is a table of sources
 * that MUST be flagged (including the verbatim pre-fix patternMatcher loop) and sources that
 * MUST NOT be, and the self-test runs before every scan: if the rule engine is gutted, the
 * must-fail fixtures stop being flagged and this exits non-zero with the real files clean.
 * ts/src/safe-dict-gate.test.ts drives the same table from `npm test`.
 *
 * Read-only. Scans ts/src; lives in scripts/, so it never scans itself.
 *
 * Run:  node scripts/check-safe-dict.mjs      (npm run check:safe-dict)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// ─────────────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────────────

/** The query surfaces that key objects by names taken from untrusted input. */
export const CANONICAL_SURFACES = ['sparql.ts', 'cypher.ts', 'gremlin.ts', 'patternMatcher.ts']

/** Dictionary type names whose values must never be object literals. */
export const TRACKED_TYPES = ['Binding', 'Grounding', 'RRow', 'SafeDict']

/** Where each tracked name must still be declared — a rename must break the gate loudly. */
const TRACKED_TYPE_HOMES = {
  Binding: 'types.ts',
  Grounding: 'patternMatcher.ts',
  RRow: 'cypher.ts',
  SafeDict: 'safe-dict.ts',
}

/**
 * Expressions that yield an object WITH Object.prototype. A computed-key assignment onto one
 * of these is the swallowed-write bug. `toPlainRow`/`Object.fromEntries` are the sanctioned way
 * to MATERIALIZE a finished row (CreateDataProperty, so hostile names land correctly) — but the
 * result still carries Object.prototype, so writing to it afterwards is back to square one.
 */
const PLAIN_PROTO_CALLS = new Set(['Object.assign', 'Object.fromEntries', 'toPlainRow'])

// ─────────────────────────────────────────────────────────────────────────────────────
// AST helpers
// ─────────────────────────────────────────────────────────────────────────────────────

/** Strip parens / `as` / `satisfies` / `<T>x` / `!` so a cast cannot launder a literal. */
function unwrap(node) {
  let n = node
  for (;;) {
    if (!n) return n
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
        ts.isTypeAssertionExpression?.(n) || ts.isSatisfiesExpression?.(n)) { n = n.expression; continue }
    return n
  }
}

/** Dotted text of a callee, e.g. `Object.assign`, `toPlainRow`. */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return `${calleeName(expr.expression)}.${expr.name.text}`
  return ''
}

/**
 * Is the annotated value ITSELF one of the tracked dictionaries (or an array/union of them)?
 *
 * Deliberately NOT a free descent: `{ variables: string[]; bindings: Binding[] }` is a
 * fixed-shape result record that happens to CONTAIN dictionaries, and returning an object
 * literal for it is correct. Matching the name at any depth flagged exactly that
 * (`return { variables, bindings }` in sparql.ts) on this checker's first run — the sort of
 * false positive that gets a gate switched off. So: reference, array-of, or union-of only.
 */
function dictionaryTypeOf(typeNode) {
  const n = typeNode
  if (!n) return null
  if (ts.isParenthesizedTypeNode(n)) return dictionaryTypeOf(n.type)
  if (ts.isArrayTypeNode(n)) return dictionaryTypeOf(n.elementType)
  if (ts.isUnionTypeNode(n) || ts.isIntersectionTypeNode(n)) {
    for (const m of n.types) { const hit = dictionaryTypeOf(m); if (hit) return hit }
    return null
  }
  if (ts.isTypeReferenceNode(n)) {
    const name = ts.isIdentifier(n.typeName) ? n.typeName.text : n.typeName.right.text
    return TRACKED_TYPES.includes(name) ? name : null
  }
  return null
}

/** An object literal reachable as a seed: `{}`, or an array literal holding one (`[{}]`). */
function objectLiteralSeed(expr) {
  const e = unwrap(expr)
  if (!e) return null
  if (ts.isObjectLiteralExpression(e)) return e
  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) {
      const inner = unwrap(ts.isSpreadElement(el) ? el.expression : el)
      if (inner && ts.isObjectLiteralExpression(inner)) return inner
    }
  }
  return null
}

/** If `expr` produces a normal-prototype object, say how; otherwise null. */
function plainProtoOrigin(expr) {
  const e = unwrap(expr)
  if (!e) return null
  if (ts.isObjectLiteralExpression(e)) return 'an object literal'
  if (ts.isCallExpression(e)) {
    const name = calleeName(e.expression)
    if (!PLAIN_PROTO_CALLS.has(name)) return null
    // Object.assign(target, …) is only plain-prototype when the TARGET is; `Object.assign(
    // Object.create(null), src)` is exactly what cloneDict does and must stay clean.
    if (name === 'Object.assign') {
      const target = unwrap(e.arguments[0])
      return target && ts.isObjectLiteralExpression(target) ? 'Object.assign() onto an object literal' : null
    }
    return `${name}()`
  }
  return null
}

/** Keys the source itself fixes — not attacker-controlled, so writing them is fine. */
function isLiteralKey(node) {
  return !!node && (ts.isStringLiteral(node) || ts.isNumericLiteral(node) ||
                    ts.isNoSubstitutionTemplateLiteral(node) ||
                    (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)))
}

const OPENS_SCOPE = (n) =>
  ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseBlock(n) ||
  ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) ||
  ts.isFunctionLike(n) || ts.isClassLike(n)

// ─────────────────────────────────────────────────────────────────────────────────────
// The scanner
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Scan one TypeScript source. Returns a list of `{ rule, line, col, message }`.
 * Exported so the test suite can drive it against fixtures and against the real files.
 */
export function scanSource(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const violations = []
  let nodeCount = 0

  const at = (node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return { line: line + 1, col: character + 1 }
  }
  const report = (rule, node, message) => violations.push({ rule, file: fileName, ...at(node), message })

  // Lexical scopes: name -> how that binding's value was constructed (if plain-prototype).
  const scopes = [new Map()]
  const lookup = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name)
    return undefined
  }
  /** Re-point an EXISTING binding (`row = {}` after `let row`), in the scope that declared it. */
  const reassign = (name, origin) => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) { scopes[i].set(name, origin); return }
  }

  /**
   * How was this expression's value constructed? Follows plain identifier aliases, so
   * `const row = {}; const alias = row; alias[k] = v` does not launder the origin. Depth-capped
   * because the scope map is being built during the same walk.
   */
  const originOf = (expr, depth = 0) => {
    const direct = plainProtoOrigin(expr)
    if (direct) return direct
    const e = unwrap(expr)
    if (depth < 4 && e && ts.isIdentifier(e)) {
      const via = lookup(e.text)
      if (via) return `${via} (aliased through \`${e.text}\`)`
    }
    return null
  }

  const walk = (node) => {
    nodeCount++
    const opened = OPENS_SCOPE(node)
    if (opened) scopes.push(new Map())

    // ── record plain-prototype bindings (for R1) ──────────────────────────────────────
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const origin = node.initializer ? originOf(node.initializer) : null
      // Declare in the ENCLOSING scope: a `const` inside a block belongs to that block, which
      // is the scope we pushed for the block itself, i.e. the current top of the stack.
      scopes[scopes.length - 1].set(node.name.text, origin)
    }
    // `let row; … row = {}` — a bare assignment re-points the binding just as a seed would.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)) {
      reassign(node.left.text, originOf(node.right))
    }

    // ── R1: computed-key assignment onto a normal-prototype object ───────────────────
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
         (node.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment)) &&
        ts.isElementAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        !isLiteralKey(node.left.argumentExpression)) {
      const name = node.left.expression.text
      const origin = lookup(name)
      if (origin) {
        report('R1', node,
          `\`${name}\` is ${origin} — it has Object.prototype — and takes a computed-key write ` +
          `\`${name}[…] = …\`. If that key can be "__proto__" the assignment hits the inherited ` +
          `SETTER and is SWALLOWED: the column is declared and absent from every row. ` +
          `Build it with emptyDict() (writable, null-prototype) or toPlainRow(entries) (materialize once).`)
      }
    }

    // ── R2: object spread ────────────────────────────────────────────────────────────
    if (ts.isSpreadAssignment(node)) {
      report('R2', node,
        `object spread \`{ ...${node.expression.getText(sf).slice(0, 40)} }\` re-attaches Object.prototype ` +
        `to a dictionary keyed by untrusted names. Use cloneDict() / mergeDicts() (safe-dict.ts).`)
    }

    // ── R3: object literal in a tracked-dictionary-typed position ────────────────────
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) {
      const tracked = dictionaryTypeOf(node.type)
      const seed = node.initializer && objectLiteralSeed(node.initializer)
      if (tracked && seed) {
        report('R3', seed, `object literal used as a \`${tracked}\`. Object literals carry Object.prototype; ` +
          `use emptyDict() / cloneDict() / mergeDicts() / toPlainRow() (safe-dict.ts).`)
      }
    }
    if ((ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) && dictionaryTypeOf(node.type)) {
      const seed = objectLiteralSeed(node.expression)
      if (seed) {
        report('R3', seed, `object literal cast to \`${dictionaryTypeOf(node.type)}\`. A cast does not change the ` +
          `prototype — use emptyDict() / cloneDict() / mergeDicts() (safe-dict.ts).`)
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      let fn = node.parent
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
      const tracked = fn && dictionaryTypeOf(fn.type)
      const seed = objectLiteralSeed(node.expression)
      if (tracked && seed) {
        report('R3', seed, `object literal returned as \`${tracked}\`. Object literals carry Object.prototype; ` +
          `use emptyDict() / cloneDict() / mergeDicts() / toPlainRow() (safe-dict.ts).`)
      }
    }

    ts.forEachChild(node, walk)
    if (opened) scopes.pop()
  }

  walk(sf)
  // Non-enumerable: callers do `assert.deepEqual(scanSource(…), [])`, and an enumerable extra
  // property on the array would make a clean scan compare unequal to `[]`.
  Object.defineProperty(violations, 'nodeCount', { value: nodeCount })
  return violations
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Self-test fixtures — the gate's own red-then-green proof
// ─────────────────────────────────────────────────────────────────────────────────────

export const FIXTURES = [
  {
    id: 'prefix-patternMatcher-row',
    expect: 'flagged',
    rule: 'R1',
    why: 'the verbatim regression: PR #34 left the OUTPUT row on a plain object (fixed in 454a2c8)',
    code: `
      declare const variables: string[]; declare const g: Record<string, string>
      declare const as: { getAtom(h: string): { name?: string; type: string } | undefined }
      export function f() {
        const row: Record<string, string> = {}
        for (const v of variables) { const atom = g[v] ? as.getAtom(g[v]) : undefined; row[v] = atom ? (atom.name ?? atom.type) : '' }
        return row
      }`,
  },
  {
    id: 'prefix-row-untyped',
    expect: 'flagged',
    rule: 'R1',
    why: 'dropping the type annotation entirely must not evade the rule (R1 is syntactic)',
    code: `declare const k: string
      export function f() { const row = {}; (row as Record<string, string>)[k] = 'x'; return row }
      export function g2() { const row2 = {}; row2[k as any] = 1; return row2 }`,
  },
  {
    id: 'prefix-row-cast-launder',
    expect: 'flagged',
    rule: 'R1',
    why: 'an `as` cast on the initializer must not launder an object literal',
    code: `declare const k: string
      export function f() { const row = {} as Record<string, string>; row[k] = 'x'; return row }`,
  },
  {
    id: 'objectassign-launder',
    expect: 'flagged',
    rule: 'R1',
    why: 'Object.assign({}, src) is cloneDict without the null prototype',
    code: `declare const k: string; declare const src: Record<string, string>
      export function f() { const row = Object.assign({}, src); row[k] = 'x'; return row }`,
  },
  {
    id: 'toplainrow-then-write',
    expect: 'flagged',
    rule: 'R1',
    why: 'toPlainRow materializes correctly but returns a normal prototype — writing to it afterwards is unsafe again',
    code: `declare function toPlainRow(e: Iterable<readonly [string, string]>): Record<string, string>
      declare const k: string; declare const entries: [string, string][]
      export function f() { const row = toPlainRow(entries); row[k] = 'x'; return row }`,
  },
  {
    id: 'alias-launder',
    expect: 'flagged',
    rule: 'R1',
    why: 'an intermediate variable must not launder the origin',
    code: `declare const k: string
      export function f() { const row = {}; const alias = row; const alias2 = alias; alias2[k as any] = 1; return row }`,
  },
  {
    id: 'deferred-assignment',
    expect: 'flagged',
    rule: 'R1',
    why: '`let row; row = {}` is the same seed as `let row = {}`',
    code: `declare const k: string
      export function f() { let row: Record<string, string> | undefined; row = {}; row[k] = 'x'; return row }`,
  },
  {
    id: 'spread-carry-forward',
    expect: 'flagged',
    rule: 'R2',
    why: 'the exact shape the docstring forbids: carrying a dictionary forward through a spread',
    code: `type Grounding = Record<string, string>
      declare const term: { name: string }; declare const handle: string
      export function f(binding: Grounding): Grounding { return { ...binding, [term.name]: handle } }`,
  },
  {
    id: 'spread-alias-launder',
    expect: 'flagged',
    rule: 'R2',
    why: 'renaming the type does not help — R2 does not look at types at all',
    code: `type Whatever = Record<string, string>
      export function f(b: Whatever): Whatever { const alias = b; return { ...alias } }`,
  },
  {
    id: 'typed-empty-seed',
    expect: 'flagged',
    rule: 'R3',
    why: 'a Grounding[] seeded with a plain [{}] — the pre-#34 patternMatcher entry point',
    code: `type Grounding = Record<string, string>
      export function f() { let groundings: Grounding[] = [{}]; return groundings }`,
  },
  {
    id: 'typed-rrow-literal',
    expect: 'flagged',
    rule: 'R3',
    why: 'the pre-#34 cypher row seed',
    code: `type RRow = Record<string, string | number>
      export function f() { const rr: RRow = {}; return rr }`,
  },
  {
    id: 'typed-cast-literal',
    expect: 'flagged',
    rule: 'R3',
    why: 'an `as Binding` cast on an object literal',
    code: `type Binding = Record<string, string>
      export function f() { return {} as Binding }`,
  },
  {
    id: 'typed-return-literal',
    expect: 'flagged',
    rule: 'R3',
    why: 'returning an object literal against an annotated dictionary return type',
    code: `type Binding = Record<string, string>
      export function f(): Binding { return {} }`,
  },

  // ── must stay clean ───────────────────────────────────────────────────────────────
  {
    id: 'sanctioned-construction',
    expect: 'clean',
    why: 'the fixed code: emptyDict/cloneDict/mergeDicts/toPlainRow',
    code: `type Grounding = Record<string, string>
      declare function emptyDict<V>(): Record<string, V>
      declare function cloneDict<V>(s: Record<string, V>): Record<string, V>
      declare function mergeDicts<V>(a: Record<string, V>, b: Record<string, V>): Record<string, V>
      declare function toPlainRow<V>(e: Iterable<readonly [string, V]>): Record<string, V>
      declare const variables: string[]; declare const k: string; declare const h: string
      export function f(binding: Grounding, other: Grounding) {
        let gs: Grounding[] = [emptyDict<string>()]
        const bound = cloneDict(binding); bound[k] = h
        const merged = mergeDicts(binding, other)
        const row = toPlainRow(variables.map((v) => [v, binding[v] ?? ''] as const))
        return { gs, bound, merged, row }
      }`,
  },
  {
    id: 'empty-bodies-and-regexes',
    expect: 'clean',
    why: 'proves this is an AST check, not a grep: `{}` here is a method body and a regex character class',
    code: `export class P {
        constructor(private tokens: string[]) {}
        re = /[(){}.,;]/g
        noop(): void {}
      }`,
  },
  {
    id: 'array-and-call-spread',
    expect: 'clean',
    why: 'array spread and call spread are not object spread',
    code: `declare const xs: number[]; declare function g(...a: number[]): void
      export function f() { const s = [...xs].sort(); g(...xs); return [...s, ...xs] }`,
  },
  {
    id: 'literal-key-write',
    expect: 'clean',
    why: 'the key is fixed by the source — nothing untrusted reaches it',
    code: `export function f() { const o: Record<string, number> = {}; o['a'] = 1; o["b"] = 2; o[0] = 3; return o }`,
  },
  {
    id: 'plain-param-defaults',
    expect: 'clean',
    why: 'runCypher(params = {}, opts = {}) — caller-supplied bags that are only ever read via ownValue()',
    code: `type CypherOptions = { maxRows?: number }
      export function runCypher(q: string, params: Record<string, string> = {}, opts: CypherOptions = {}) { return [q, params, opts] }`,
  },
  {
    id: 'map-then-fromentries',
    expect: 'clean',
    why: 'build in a Map, materialize once — no computed write onto a prototype-bearing object',
    code: `declare const variables: string[]; declare const s: Record<string, string>
      export function f() { const m = new Map<string, string>(); for (const v of variables) m.set(v, s[v] ?? ''); return Object.fromEntries(m) }`,
  },
  {
    id: 'result-record-containing-dicts',
    expect: 'clean',
    why: 'a fixed-shape result record that CONTAINS dictionaries — sparql.ts aggregate()\'s ' +
         '`return { variables, bindings }`. This checker flagged it on its first run; the fixture keeps it fixed.',
    code: `type Binding = Record<string, string>
      declare const variables: string[]; declare const bindings: Binding[]
      export function aggregate(): { variables: string[]; bindings: Binding[] } { return { variables, bindings } }`,
  },
  {
    id: 'null-prototype-direct',
    expect: 'clean',
    why: 'Object.create(null) / Object.assign(Object.create(null), …) are the primitives safe-dict is built on',
    code: `declare const k: string; declare const src: Record<string, string>
      export function f() { const d = Object.create(null) as Record<string, string>; d[k] = 'x'
        const c = Object.assign(Object.create(null), src) as Record<string, string>; c[k] = 'y'; return [d, c] }`,
  },
]

// ─────────────────────────────────────────────────────────────────────────────────────
// Self-test: run the table, and fail if the rules have lost their teeth
// ─────────────────────────────────────────────────────────────────────────────────────

/** Returns a list of self-test failures (empty when the rule engine behaves). */
export function runSelfTest() {
  const failures = []
  for (const fx of FIXTURES) {
    const found = scanSource(`selftest/${fx.id}.ts`, fx.code)
    if (fx.expect === 'flagged') {
      if (found.length === 0) {
        failures.push(`${fx.id}: MUST be flagged (${fx.rule}) and was NOT — ${fx.why}`)
      } else if (fx.rule && !found.some((v) => v.rule === fx.rule)) {
        failures.push(`${fx.id}: expected ${fx.rule}, got ${[...new Set(found.map((v) => v.rule))].join('+')} — ${fx.why}`)
      }
    } else if (found.length > 0) {
      failures.push(`${fx.id}: MUST stay clean and was flagged ${found.map((v) => `${v.rule}@${v.line}`).join(', ')} — ${fx.why}`)
    }
  }
  return failures
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Guarded-file discovery
// ─────────────────────────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../ts/src/', import.meta.url))

/**
 * The canonical four, plus anything else that has adopted safe-dict — so a new query surface
 * is covered the moment it imports the convention, rather than when someone remembers to
 * edit this list. `.test.ts` and safe-dict.ts itself are excluded.
 */
export function guardedFiles(srcDir = SRC) {
  const found = new Set()
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'safe-dict.ts') continue
    if (CANONICAL_SURFACES.includes(f)) { found.add(f); continue }
    const text = readFileSync(srcDir + f, 'utf8')
    if (/\bfrom\s+['"]\.\/safe-dict(?:\.js)?['"]/.test(text)) found.add(f)
  }
  return [...found].sort()
}

// ─────────────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────────────

function main() {
  const problems = []

  // ── the gate must prove it can fail, before it is allowed to pass anything ──
  const selfTestFailures = runSelfTest()
  if (selfTestFailures.length) {
    console.error('✗ safe-dict gate SELF-TEST failed — the rule engine no longer detects what it claims to.')
    console.error('  A checker that cannot go red is not a check. Fix the rules, do not relax the fixtures.')
    for (const f of selfTestFailures) console.error(`    · ${f}`)
    process.exit(1)
  }

  // ── R4: coverage assertions ──
  for (const f of CANONICAL_SURFACES) {
    if (!existsSync(SRC + f)) {
      problems.push(`R4  ts/src/${f} does not exist. A guarded query surface was renamed or removed and the ` +
        `gate silently stopped covering it — update CANONICAL_SURFACES in scripts/check-safe-dict.mjs.`)
    }
  }
  for (const [type, home] of Object.entries(TRACKED_TYPE_HOMES)) {
    const path = SRC + home
    if (!existsSync(path) || !new RegExp(`\\b(type|interface)\\s+${type}\\b`).test(readFileSync(path, 'utf8'))) {
      problems.push(`R4  type \`${type}\` is no longer declared in ts/src/${home}. R3 keys on that NAME, so a ` +
        `rename turns the rule into a no-op — update TRACKED_TYPES/TRACKED_TYPE_HOMES.`)
    }
  }

  const files = guardedFiles()
  if (files.length === 0) problems.push('R4  the guarded file set is EMPTY — this scan verified nothing.')

  // ── scan ──
  let nodes = 0
  for (const f of files) {
    const found = scanSource(`ts/src/${f}`, readFileSync(SRC + f, 'utf8'))
    nodes += found.nodeCount
    for (const v of found) problems.push(`${v.rule}  ts/src/${f}:${v.line}:${v.col}  ${v.message}`)
  }

  if (problems.length) {
    console.error(`✗ safe-dict gate: ${problems.length} violation(s) — ` +
      `ts/src/safe-dict.ts's "never a spread, never a plain literal" rule is not being kept.\n`)
    for (const p of problems) console.error(`  ${p}\n`)
    process.exit(1)
  }

  console.log(
    `✓ safe-dict gate — ${files.length} guarded surface(s) [${files.join(', ')}], ` +
    `${nodes.toLocaleString()} AST nodes, rules R1–R4 clean; ` +
    `self-test: ${FIXTURES.filter((f) => f.expect === 'flagged').length} must-fail / ` +
    `${FIXTURES.filter((f) => f.expect === 'clean').length} must-pass fixtures all behaved.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

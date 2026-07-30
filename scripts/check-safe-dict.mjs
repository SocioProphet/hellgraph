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
 *       declaration, the graph property bag is still called `properties`, and the guarded
 *       set is non-empty.
 *
 *   R5  The READ mode. A COMPUTED-key READ off an object that carries Object.prototype:
 *       `props[key]` returns inherited FUNCTIONS, so `g.V().values("constructor")` really
 *       does hand back the Object constructor as if it were stored graph data, and
 *       `has("constructor", …)` compares against one. That was gremlin.ts's half of the
 *       original CodeQL alert (js/remote-property-injection) and R1–R4 scored gremlin.ts
 *       ZERO both before and after the fix.
 *
 *       R5 is ORIGIN-DIRECTED, not "any computed read" — the four guarded surfaces contain
 *       57 computed element accesses and almost all of them are array indexing
 *       (`tokens[pos]`, `row[i]`) or reads off dictionaries R3 already guarantees are
 *       null-prototype (`binding[term.name]`). Flagging those would be 57 false positives
 *       and one switched-off gate. Two base forms are flagged, both provenance-known:
 *
 *         (a) `<expr>.properties[k]` — the graph's own property bag. `GraphNode.properties`
 *             and `GraphEdge.properties` (types.ts) are `Record<string, PropertyValue>`
 *             built by `store.addNode()` from a caller-supplied object literal, so they
 *             carry Object.prototype, and their KEYS arrive in query text. This is the
 *             gremlin.ts pattern, verbatim.
 *         (b) an identifier whose construction R1 already tracks as plain-prototype (`{}`,
 *             `Object.assign({}, …)`, `Object.fromEntries(…)`, `toPlainRow(…)`), read with
 *             a computed key. Same scope machinery as R1, so aliasing, casts and deferred
 *             assignment do not launder a read any more than they launder a write.
 *
 *       Literal keys are trusted, exactly as in R1. Assignment TARGETS belong to R1, so the
 *       two rules never double-report the same node. The fix is `ownValue(bag, key)` — a
 *       CALL, not an element access, so fixed code stops matching the rule instead of
 *       needing an exemption from it. There is no allowlist.
 *
 * ── What this does NOT catch (read this before trusting it) ──────────────────────────
 * A floor under the convention, not a proof of it. Known holes, roughly by likelihood:
 *
 *   · R5's bag set is ONE MEMBER NAME, `.properties`. It is the only untrusted-keyed,
 *     prototype-bearing bag in this engine's type surface, and R4 fails loudly if it is
 *     renamed — but a NEW such bag under a different name is not covered until it is added
 *     here. `atom.values[…]` is deliberately not in the set: it is an Atom's Value map, read
 *     with source-fixed constants, not with names off the wire.
 *   · R5 says nothing about a computed read off a bag reached through a FUNCTION PARAMETER
 *     typed `Record<string, …>`. Provenance is unknown there — the caller may have passed a
 *     null-prototype dictionary — and guessing in either direction is worse than the stated
 *     gap. R3 is the compensating control: a parameter typed as a tracked dictionary is
 *     guaranteed null-prototype at every construction site, so reading it computed is safe.
 *   · R5 does not chase a bag through a local alias of a MEMBER access:
 *     `const p = node.properties; p[key]` is form (b) with an origin R1 does not record,
 *     because `node.properties` is not one of the tracked constructors. `p` would have to be
 *     seeded from `{}` for R5 to see it. The direct `node.properties[key]` — the shape the
 *     alert was actually about, and the shape the fluent traversal code naturally writes —
 *     IS caught.
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
 * Member names that hold an untrusted-keyed bag on an object WITH Object.prototype — the base
 * of a computed read that R5 flags.
 *
 * `properties` is the graph's own bag: `GraphNode.properties` / `GraphEdge.properties` are
 * `Record<string, PropertyValue>` (types.ts), materialized by `store.addNode()` from a
 * caller-supplied object literal, and keyed by names that arrive in query text —
 * `g.V().values(k)`, `has(k, v)`, `order(k)`. Kept to the one name deliberately: this is a
 * NAME-keyed rule and a name-keyed rule that guesses is a false-positive generator.
 */
const PROTO_BEARING_BAGS = new Set(['properties'])

/** Where each bag must still be declared — a rename must break R5 loudly, not silently. */
const BAG_HOMES = { properties: { file: 'types.ts', owners: ['GraphNode', 'GraphEdge'] } }

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

/**
 * Is this element access being WRITTEN rather than read? R1 owns writes; R5 owns reads, and
 * the two must not both report the same node. Covers `o[k] = v`, `o[k] += v`, `o[k]++` and
 * `delete o[k]` — everything that is not a value-producing read.
 */
function isAssignmentTarget(node) {
  const p = node.parent
  if (!p) return false
  if (ts.isBinaryExpression(p) && p.left === node &&
      (p.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
       (p.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment))) return true
  if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && p.operand === node) {
    return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
  }
  return ts.isDeleteExpression(p)
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

    // ── R5: computed-key READ off a normal-prototype object ──────────────────────────
    // Origin-directed, like R1. Two base forms, both with KNOWN provenance:
    //   (a) `<expr>.properties[k]`  — the graph's property bag (PROTO_BEARING_BAGS)
    //   (b) `o[k]` where `o` is a binding R1 already tracks as plain-prototype
    // Reads only: an assignment target is R1's, so the two never report the same node.
    if (ts.isElementAccessExpression(node) && !isLiteralKey(node.argumentExpression) &&
        !isAssignmentTarget(node)) {
      const base = unwrap(node.expression)
      let what = null
      if (base && ts.isPropertyAccessExpression(base) && PROTO_BEARING_BAGS.has(base.name.text)) {
        what = `\`${base.getText(sf).slice(0, 40)}\` is a \`.${base.name.text}\` bag — ` +
          `built from an object literal, so it carries Object.prototype`
      } else if (base && ts.isIdentifier(base)) {
        const origin = lookup(base.text)
        if (origin) what = `\`${base.text}\` is ${origin} — it has Object.prototype`
      }
      if (what) {
        report('R5', node,
          `${what} — and takes a computed-key READ \`${node.getText(sf).slice(0, 48)}\`. ` +
          `Keys like "constructor" / "toString" / "valueOf" are not stored data but they RESOLVE, ` +
          `so the read hands back an inherited FUNCTION as if it were a graph value ` +
          `(js/remote-property-injection). Read it with ownValue(bag, key) (safe-dict.ts), which ` +
          `returns undefined for anything not stored as an OWN property.`)
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
    exclusive: true, // and R5 must NOT also fire: a computed WRITE is R1's, and only R1's
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

  // ── R5: the READ mode ─────────────────────────────────────────────────────────────
  {
    id: 'prefix-gremlin-values',
    expect: 'flagged',
    rule: 'R5',
    why: 'the VERBATIM pre-ownValue gremlin.ts read — the other half of the CodeQL alert, which ' +
         'R1-R4 scored zero on both before and after the fix',
    code: `
      type PropertyValue = string | number | boolean
      interface GraphNode { id: string; labels: string[]; properties: Record<string, PropertyValue> }
      interface GraphEdge { id: string; label: string; properties: Record<string, PropertyValue> }
      type Traverser = GraphNode | GraphEdge | PropertyValue
      declare function isNode(t: Traverser): t is GraphNode
      declare function isEdge(t: Traverser): t is GraphEdge
      declare function looseEq(a: unknown, b: unknown): boolean
      export class T {
        constructor(private current: Traverser[]) {}
        values(key: string) {
          return this.current.map((t) => (isNode(t) || isEdge(t)) ? t.properties[key] : t).filter((v) => v !== undefined)
        }
        has(nodes: GraphNode[], key: string, value: PropertyValue) {
          return nodes.filter((n) => looseEq(n.properties[key], value))
        }
        order(key: string, desc = false) {
          return [...this.current].sort((a, b) => {
            const av = isNode(a) || isEdge(a) ? a.properties[key] : a
            const bv = isNode(b) || isEdge(b) ? b.properties[key] : b
            return desc ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
          })
        }
      }`,
  },
  {
    id: 'read-off-plain-seed',
    expect: 'flagged',
    rule: 'R5',
    why: 'form (b): a computed read off a binding R1 already knows is plain-prototype',
    code: `declare const k: string
      export function f() { const bag = Object.fromEntries([['a', 1]]); return bag[k] }`,
  },
  {
    id: 'read-alias-launder',
    expect: 'flagged',
    rule: 'R5',
    why: 'an alias must not launder a READ any more than it launders a write',
    code: `declare const k: string
      export function f() { const bag = {}; const alias = bag; return (alias as Record<string, number>)[k] }`,
  },
  {
    id: 'read-in-condition',
    expect: 'flagged',
    rule: 'R5',
    why: 'a read in a predicate is still a read — this is `has(key, value)`, where the inherited ' +
         'function becomes the left-hand side of a comparison',
    code: `interface GraphNode { properties: Record<string, string> }
      declare const nodes: GraphNode[]; declare const key: string; declare const value: string
      export function f() { return nodes.filter((n) => n.properties[key] === value) }`,
  },

  // ── must stay clean ───────────────────────────────────────────────────────────────
  {
    id: 'ownvalue-read',
    expect: 'clean',
    why: 'the FIX: ownValue(bag, key) is a call, not an element access — fixed code stops matching ' +
         'the rule rather than needing an exemption from it',
    code: `type PropertyValue = string | number
      interface GraphNode { properties: Record<string, PropertyValue> }
      declare function ownValue<V>(s: Record<string, V> | undefined, k: string): V | undefined
      declare const nodes: GraphNode[]; declare const key: string
      export function f() { return nodes.map((n) => ownValue(n.properties, key)) }`,
  },
  {
    id: 'array-index-read',
    expect: 'clean',
    why: 'the reason R5 is origin-directed: the guarded surfaces are full of `tokens[pos]` and ' +
         '`row[i]`, and flagging those would be 57 false positives and one switched-off gate',
    code: `declare const tokens: string[]; declare const rows: number[][]
      export class P { private pos = 0
        peek() { return tokens[this.pos] }
        next() { return tokens[this.pos++] }
        cell(i: number, j: number) { return rows[i]![j] } }`,
  },
  {
    id: 'read-off-null-prototype-dict',
    expect: 'clean',
    why: 'reading a Binding/Grounding computed is SAFE — R3 guarantees every construction site is ' +
         'emptyDict/cloneDict/mergeDicts, so there is no prototype to inherit from. This is what ' +
         'sparql.ts and patternMatcher.ts do on nearly every line',
    code: `type Binding = Record<string, string>
      declare function emptyDict<V>(): Record<string, V>
      declare const term: { name: string }
      export function f(binding: Binding) { const fresh: Binding = emptyDict<string>(); return [binding[term.name], fresh[term.name]] }`,
  },
  {
    id: 'literal-key-read',
    expect: 'clean',
    why: 'a source-fixed key on a property bag is trusted, the same way a literal-key WRITE is',
    code: `interface GraphNode { properties: Record<string, string> }
      declare const n: GraphNode
      export function f() { return [n.properties['name'], n.properties["type"]] }`,
  },
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
      } else if (fx.exclusive && found.some((v) => v.rule !== fx.rule)) {
        // Two rules reporting one node is a real defect, not a harmless duplicate: the same line
        // appears twice in the failure list under two different diagnoses, and whichever is read
        // first is the one that gets acted on.
        failures.push(`${fx.id}: expected ONLY ${fx.rule}, also got ` +
          `${[...new Set(found.filter((v) => v.rule !== fx.rule).map((v) => v.rule))].join('+')} — ${fx.why}`)
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

  // R5 keys on a member NAME, so a rename turns it into a no-op exactly the way a type rename
  // would neuter R3. Assert the bag is still declared, and still declared on its owners.
  for (const [bag, { file, owners }] of Object.entries(BAG_HOMES)) {
    const path = SRC + file
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const missing = owners.filter((owner) => {
      const decl = new RegExp(`\\binterface\\s+${owner}\\b[\\s\\S]*?\\n}`).exec(text)
      return !decl || !new RegExp(`^\\s*${bag}\\??\\s*:`, 'm').test(decl[0])
    })
    if (missing.length) {
      problems.push(`R4  \`${bag}\` is no longer declared on ${missing.join(', ')} in ts/src/${file}. R5 keys on ` +
        `that MEMBER NAME, so a rename turns the READ-mode rule into a no-op — update ` +
        `PROTO_BEARING_BAGS/BAG_HOMES in scripts/check-safe-dict.mjs.`)
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
    `${nodes.toLocaleString()} AST nodes, rules R1–R5 clean; ` +
    `self-test: ${FIXTURES.filter((f) => f.expect === 'flagged').length} must-fail / ` +
    `${FIXTURES.filter((f) => f.expect === 'clean').length} must-pass fixtures all behaved.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

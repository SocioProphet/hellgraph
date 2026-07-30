/**
 * Null-prototype dictionaries for untrusted keys.
 *
 * Every query surface in this engine keys a plain object BY NAMES THAT CAME OFF THE WIRE:
 * SPARQL solution bindings by variable name, Cypher rows by variable / RETURN alias, Cypher
 * `$params` by parameter name, Gremlin property lookups by property key, pattern-matcher
 * groundings by pattern variable. On an ordinary `{}` every such name that collides with a
 * member of Object.prototype is a live wire (js/remote-property-injection), in three distinct
 * ways — all three are real, and the middle one is the easiest to miss:
 *
 *   WRITE   `row['__proto__'] = v` hits the inherited accessor instead of defining a property.
 *           The column is DECLARED in the response and then absent from every row: a
 *           silently-wrong result, not an error.
 *
 *   READ    `props['constructor']` / `props['toString']` return inherited FUNCTIONS. Those
 *           escape into query results as if they were data (`g.V().values("constructor")`
 *           really does hand back the Object constructor), and feed comparisons that then
 *           match rows no user ever stored.
 *
 *   `in`    `'__proto__' in binding` is true on an object that bound nothing. Unification
 *           then compares the candidate against Object.prototype, fails, and the query
 *           silently returns ZERO rows.
 *
 * A null-prototype object has no inherited members, so a variable named ?__proto__ or
 * ?constructor is simply an ordinary variable — which is what every one of these query
 * languages says it is. That is why this is the fix rather than rejecting such names:
 * rejecting them would trade one silently-wrong answer for a different one.
 *
 * NB: object spread (`{ ...dict }`) and object literals re-attach Object.prototype. Use
 * cloneDict / mergeDicts, never a spread, to carry one of these forward.
 *
 * ── That NB is ENFORCED, not merely stated ──────────────────────────────────────────────
 * `scripts/check-safe-dict.mjs` (`npm run check:safe-dict`, and driven from `npm test` by
 * `ts/src/safe-dict-gate.test.ts`, so it sits on the required `build-and-verify-dist` check)
 * parses the query surfaces — sparql.ts, cypher.ts, gremlin.ts, patternMatcher.ts, plus any
 * file that imports this one — and fails the build on:
 *
 *   R1  a computed-key assignment onto a normal-prototype object: `o = {}` (or
 *       Object.assign({}, …) / Object.fromEntries(…) / toPlainRow(…)) then `o[expr] = v`.
 *   R2  any object spread.
 *   R3  an object literal in a position typed Binding / Grounding / RRow / SafeDict —
 *       declaration, parameter default, `as` cast, `satisfies`, or annotated return.
 *   R4  coverage: those surfaces still exist, those type names still resolve, and the graph
 *       property bag R5 keys on is still called `properties`.
 *   R5  the READ mode: a computed-key READ off an object that carries Object.prototype —
 *       `node.properties[expr]` (the graph's own bag), or a local seeded from `{}` /
 *       Object.assign({}, …) / Object.fromEntries(…) / toPlainRow(…). `ownValue()` is the
 *       fix, and it is a CALL rather than an element access, so corrected code stops
 *       matching the rule instead of needing an exemption from it.
 *
 * The NB was a comment for exactly one commit, and in that commit it was already violated:
 * patternMatcher.ts kept `const row: Record<string, string> = {}` for its OUTPUT row, so
 * `row['__proto__'] = v` hit the inherited setter and the WRITE mode above shipped for real
 * (fixed in 454a2c8 — found by a human reading the diff, which is not a control). R1 is
 * deliberately SYNTACTIC rather than keyed on the type name, because that regression was
 * typed `Record<string, string>`: a rule watching only the four names would have been green
 * against the actual bug.
 *
 * What the gate does NOT catch is listed at the top of the script — chiefly the `in` mode
 * (`'__proto__' in binding`), any laundering through a function boundary, a computed read off
 * a bag reached through a `Record<string, …>` PARAMETER (provenance unknown at that point),
 * and a prototype-bearing bag under a member name other than `properties`. It is a floor
 * under the convention, not a proof of it.
 */

/** A dictionary whose keys are untrusted. Structurally a Record; semantically null-prototype. */
export type SafeDict<V> = Record<string, V>

/** A fresh dictionary with no inherited members. */
export function emptyDict<V>(): SafeDict<V> {
  return Object.create(null) as SafeDict<V>
}

/** Copy `src`'s own entries into a fresh null-prototype dictionary. */
export function cloneDict<V>(src: SafeDict<V>): SafeDict<V> {
  return Object.assign(Object.create(null), src) as SafeDict<V>
}

/** Merge two dictionaries into a fresh null-prototype one; `b` wins collisions. */
export function mergeDicts<V>(a: SafeDict<V>, b: SafeDict<V>): SafeDict<V> {
  return Object.assign(Object.create(null), a, b) as SafeDict<V>
}

/**
 * Read a key that came from untrusted input, from an object that may have a normal prototype.
 * Returns undefined for anything not stored as an OWN property, so `constructor`, `toString`
 * and friends read as "absent" rather than as inherited functions.
 */
export function ownValue<V>(src: Record<string, V> | undefined, key: string): V | undefined {
  if (!src) return undefined
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined
}

/**
 * Materialize an output row for consumers: a NORMAL-prototype object, so callers get a plain
 * JSON-shaped value, but built with Object.fromEntries — which uses CreateDataProperty, so even
 * a `__proto__` key lands as a real own data property instead of invoking the inherited setter.
 */
export function toPlainRow<V>(entries: Iterable<readonly [string, V]>): Record<string, V> {
  return Object.fromEntries(entries) as Record<string, V>
}

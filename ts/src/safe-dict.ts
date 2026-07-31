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

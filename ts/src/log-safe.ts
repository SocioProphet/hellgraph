/**
 * Log-boundary sanitizer.
 *
 * Every log line this estate writes is potential evidence: receipts, audit records and
 * operator forensics are all read back as fact. A log line an attacker can *shape* is
 * therefore worse here than in a typical application — it does not merely add noise, it
 * lets an attacker author entries a later reader attributes to the system.
 *
 * A log record is line-oriented, so the whole attack reduces to "get a line terminator into
 * a field". Stripping CR/LF alone is NOT enough. The previous guard in super-peer.ts did
 * exactly that — `.replace(/[\r\n\t]+/g, ' ')` — and still let all of these through:
 *
 *   U+000B VT, U+000C FF   line breaks to many log viewers and pagers
 *   U+0085 NEL             a C1 line break; a real terminator to Unicode-aware readers
 *   U+2028 LS, U+2029 PS   line/paragraph separators; break lines in JS-based tooling
 *   U+0000 NUL             truncates the record in C-string consumers
 *   U+001B ESC             ANSI CSI: `ESC[2K ESC[1G` erases the real line and rewrites it,
 *                          so an operator tailing the log sees the forged text and never
 *                          sees what it replaced
 *
 * Breaking the line is not the only way to forge one. A record is only evidence once a HUMAN
 * reads it, so anything that changes what the reader sees is in scope too — `\p{Cf}` format
 * characters do exactly that without touching a single line terminator:
 *
 *   U+202E RLO             the Trojan Source class. `admitted=` + RLO + `resu` renders as
 *   U+202A-U+202D          `admitted=user` while the bytes say something else, so an auditor
 *   U+2066-U+2069          reading the log and a tool grepping it disagree about its content
 *   U+200B ZWSP, U+FEFF    invisible: splits `admitted` so a search for it never matches
 *   U+200E LRM, U+200F RLM reorder the remainder of the field
 *   U+00AD SOFT HYPHEN     invisible token split, same effect as ZWSP
 *
 * The rule is therefore a category allow-list, not a deny-list of specific characters:
 * `\p{Cc}` (every C0 control, DEL, every C1 control — so NUL, ESC, VT, FF, NEL are all in),
 * `\p{Zl}` / `\p{Zp}` (U+2028 / U+2029), and `\p{Cf}` (every bidi control, every zero-width,
 * the BOM) are rendered as a VISIBLE escape. Visible rather than deleted, so a reader can tell
 * something was neutralized instead of silently being handed a laundered line.
 *
 * A category allow-list is the point: it is chosen so that a character nobody thought of is
 * covered by the CLASS it belongs to. `\p{Cf}` was the category originally missed — the tests
 * did not catch it because their assertion was written from this same set, so it could not
 * fail for anything this set omitted. See the note above `UNSAFE_IN_A_LOG_FIELD` in
 * security-hardening7.test.ts: that regex is deliberately derived from what a READER can be
 * made to misrender, never from what this function happens to strip.
 */

/**
 * Render one control character as a visible, unambiguous escape.
 *
 * `codePointAt`, not `charCodeAt`: \p{Cf} reaches beyond the BMP (U+13430-U+1343F Egyptian
 * format controls, U+1BCA0-U+1BCA3), and the `u`-flagged class matches those as a whole code
 * point. `charCodeAt(0)` would report only the HIGH SURROGATE, printing `\ud80d` for U+13430.
 * The character is neutralized either way — the replace consumes the whole match — but the
 * escape is the forensic record of what was neutralized, and naming the wrong code point
 * defeats the reason these are made visible instead of deleted.
 */
function escapeControl(ch: string): string {
  const code = ch.codePointAt(0) ?? 0
  const hex = code.toString(16)
  if (code <= 0xff) return '\\x' + hex.padStart(2, '0')
  return code <= 0xffff ? '\\u' + hex.padStart(4, '0') : '\\u{' + hex + '}'
}

/** Hard cap so one request cannot flood the log (and so a record stays greppable). */
export const LOG_FIELD_MAX = 500

/**
 * Coerce any value to a string WITHOUT being able to throw.
 *
 * `String(value)` is not total, and both failing cases are reachable from this module's callers:
 *
 *   - `String(Object.create(null))` throws `TypeError: Cannot convert object to primitive value`
 *     — it has no inherited `toString`/`valueOf`. `safe-dict.ts` hands out exactly such
 *     dictionaries throughout the engine, so one reaching a log boundary is not hypothetical.
 *   - a value whose own `toString` throws.
 *
 * Either would throw from INSIDE `super-peer`'s catch block, replacing the 500 response with an
 * unhandled error — the sanitizer would become the outage. A log boundary must never be a
 * secondary failure path, and the guarantee below says "any input whatsoever".
 *
 * `Object.prototype.toString.call` is used for the fallback tag because it reads the internal
 * class directly and never invokes user code; the outer guard covers exotic proxies.
 */
function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    try {
      return `[unstringifiable ${Object.prototype.toString.call(value)}]`
    } catch {
      return '[unstringifiable]'
    }
  }
}

/**
 * Render an untrusted value as a single-line, unforgeable log field.
 *
 * Guarantees, for any input whatsoever:
 *   - the result contains no character that can terminate or truncate a log line, and none that
 *     can rewrite one — whether by driving the terminal (ANSI CSI) or by reordering/hiding what
 *     a human reads (bidi overrides, zero-width characters)
 *   - the result is at most `max` characters, plus an explicit truncation marker
 *   - it returns; it never throws, whatever it is handed (see `coerceToString`)
 */
export function sanitizeLogValue(value: unknown, max: number = LOG_FIELD_MAX): string {
  const raw = coerceToString(value)
  // Bound the work, not just the output: the escape passes below are attacker-reachable
  // (this runs at log boundaries on values like parse errors) and every char can only
  // EXPAND under escaping (never shrink), so slicing the input to `max` still leaves at
  // least `max` chars for the final truncation to work with -- the output is identical to
  // running the full pipeline unsliced and truncating after, for any input up to `max`
  // chars past this point. Without this, a multi-MB value pays for two full-string regex
  // passes and a per-character escape call before the one-line cap discards nearly all of
  // it -- the sanitizer meant to bound abuse becomes itself an unbounded-cost boundary.
  const bounded = raw.length > max ? raw.slice(0, max) : raw
  const escaped = bounded
    // CR and LF first, and individually. Besides being the obvious vector, this exact shape
    // — a global replace of a constant string — is the barrier CodeQL's js/log-injection
    // recognises. A quantified character class such as /[\r\n\t]+/g is not recognised, which
    // is why the previous guard kept alerting even though it did remove newlines.
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    // Everything else that can break, truncate or rewrite a line — including \p{Cf}, which
    // rewrites what the READER sees (bidi override, zero-width) without touching a terminator.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/gu, escapeControl)
  return escaped.length > max ? escaped.slice(0, max) + '[truncated]' : escaped
}

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

/** Render one control character as a visible, unambiguous escape. */
function escapeControl(ch: string): string {
  const code = ch.charCodeAt(0)
  const hex = code.toString(16)
  return code <= 0xff ? '\\x' + hex.padStart(2, '0') : '\\u' + hex.padStart(4, '0')
}

/** Hard cap so one request cannot flood the log (and so a record stays greppable). */
export const LOG_FIELD_MAX = 500

/**
 * Render an untrusted value as a single-line, unforgeable log field.
 *
 * Guarantees, for any input whatsoever:
 *   - the result contains no character that can terminate or truncate a log line, and none that
 *     can rewrite one — whether by driving the terminal (ANSI CSI) or by reordering/hiding what
 *     a human reads (bidi overrides, zero-width characters)
 *   - the result is at most `max` characters, plus an explicit truncation marker
 */
export function sanitizeLogValue(value: unknown, max: number = LOG_FIELD_MAX): string {
  const raw = typeof value === 'string' ? value : String(value)
  const escaped = raw
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

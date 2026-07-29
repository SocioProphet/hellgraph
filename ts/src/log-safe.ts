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
 * The rule is therefore a category allow-list, not a deny-list of specific characters:
 * `\p{Cc}` (every C0 control, DEL, every C1 control — so NUL, ESC, VT, FF, NEL are all in)
 * plus `\p{Zl}` / `\p{Zp}` (U+2028 / U+2029) are rendered as a VISIBLE escape. Visible
 * rather than deleted, so a reader can tell something was neutralized instead of silently
 * being handed a laundered line.
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
 *   - the result contains no character that can terminate, truncate or rewrite a log line
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
    // Everything else that can break, truncate or rewrite a line.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, escapeControl)
  return escaped.length > max ? escaped.slice(0, max) + '[truncated]' : escaped
}

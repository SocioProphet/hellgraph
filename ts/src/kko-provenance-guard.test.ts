/**
 * Regression tests for `scripts/check-kko-provenance.mjs` — the gate itself, not the ontology.
 *
 * Why these exist: the byte-count check in that script used to read
 *     const declaredBytes = Number((doc.match(/\*\*Bytes:\*\*\s*([\d,]+)/) || [])[1] || '0')
 *     if (declaredBytes && bytes.length !== declaredBytes) die(...)
 * so a PROVENANCE.md with no parseable **Bytes:** produced 0, `if (0 && …)` never fired, and the
 * comparison silently evaporated — while the run still printed a success line quoting the file's
 * OWN byte count as though it had been verified against the record. The gate reported that it had
 * checked something it had not checked.
 *
 * A test suite for a gate has to prove teeth in BOTH directions: that the real record still
 * passes, and that each specific corruption still fails. Asserting only the happy path is how a
 * check that cannot fail gets to look healthy forever.
 *
 * These drive the REAL script as a subprocess rather than re-declaring its regexes here — a test
 * that re-implements the thing it is testing agrees with itself by construction and proves
 * nothing. The script resolves every path relative to its own file URL, so each case runs in a
 * throwaway root: a copy of the script, a copy of the record under test, and symlinks back to the
 * real .n3 and ts/ tree. The repo's own ontology/kko/PROVENANCE.md is never written to.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const guardName = 'check-kko-provenance.mjs'
const guardPath = path.join(repo, 'scripts', guardName)
const recordPath = path.join(repo, 'ontology', 'kko', 'PROVENANCE.md')
const n3Path = path.join(repo, 'ontology', 'kko', 'kko-2.10.n3')

/** Run the guard against a rewritten record. Returns its exit code and combined output. */
const runGuard = (mutate: (doc: string) => string): { code: number; out: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-kko-guard-'))
  try {
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, 'ontology', 'kko'), { recursive: true })
    fs.copyFileSync(guardPath, path.join(root, 'scripts', guardName))
    fs.symlinkSync(n3Path, path.join(root, 'ontology', 'kko', 'kko-2.10.n3'))
    fs.symlinkSync(path.join(repo, 'ts'), path.join(root, 'ts'))
    fs.writeFileSync(
      path.join(root, 'ontology', 'kko', 'PROVENANCE.md'),
      mutate(fs.readFileSync(recordPath, 'utf-8')),
    )
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', guardName)], {
      cwd: repo, // so `--import tsx` resolves from the repo's node_modules
      encoding: 'utf-8',
    })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/**
 * String surgery that must actually bite. If PROVENANCE.md is reworded so a needle stops
 * matching, the mutation would no-op and the case would "pass" by testing an unmodified
 * document — the same silently-skipped-check failure this file exists to prevent.
 */
const rewrite = (doc: string, from: string, to: string): string => {
  assert.ok(doc.includes(from), `test fixture is stale: PROVENANCE.md no longer contains ${JSON.stringify(from)}`)
  return doc.split(from).join(to)
}

const BYTES_LINE = '**Bytes:** 327,797'
const PIN_LINE = '@ commit `3f888b397255b69d1439fd95823e97011ed9440b` (branch `master`)'
const PIN_URL = '/SocioProphet/kbpedia/3f888b397255b69d1439fd95823e97011ed9440b/'
const OTHER_SHA256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const OTHER_SHA1 = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee'

// ─── control: the gate must still accept the real record ──────────────────────────
// A checker that has been "hardened" into rejecting the genuine artifact is worse than the bug.
test('the committed PROVENANCE.md passes the guard unchanged', () => {
  const { code, out } = runGuard((d) => d)
  assert.equal(code, 0, out)
  assert.match(out, /✓ KKO provenance verified/)
})

// ─── the byte count is required, and the comparison is unconditional ──────────────
test('a PROVENANCE.md with no **Bytes:** line FAILS (it must not skip the byte check)', () => {
  const { code, out } = runGuard((d) => rewrite(d, `${BYTES_LINE}\n`, ''))
  assert.equal(code, 1, `expected the guard to fail, got:\n${out}`)
  assert.match(out, /does not declare a parseable \*\*Bytes:\*\*/)
  // The old code printed the success line here, quoting the file's own length as verified.
  assert.doesNotMatch(out, /provenance verified/)
})

test('a malformed **Bytes:** FAILS rather than defaulting to 0', () => {
  const { code, out } = runGuard((d) => rewrite(d, BYTES_LINE, '**Bytes:** abc'))
  assert.equal(code, 1, `expected the guard to fail, got:\n${out}`)
  assert.match(out, /does not declare a parseable \*\*Bytes:\*\*/)
  assert.doesNotMatch(out, /provenance verified/)
})

test('a **Bytes:** that disagrees with the artifact FAILS', () => {
  const { code, out } = runGuard((d) => rewrite(d, BYTES_LINE, '**Bytes:** 999,999'))
  assert.equal(code, 1, `expected the guard to fail, got:\n${out}`)
  assert.match(out, /is 327797 bytes, PROVENANCE\.md declares 999999/)
})

// ─── the commit pin is found by its label, not by "some 40-hex run exists" ────────
test('an unpinned source FAILS even when an unrelated 40-hex sha appears in the record', () => {
  const { code, out } = runGuard((d) => {
    let s = rewrite(d, PIN_LINE, '@ `master`')
    s = rewrite(s, PIN_URL, '/SocioProphet/kbpedia/master/')
    return rewrite(s, '## What it is', `**Consumer pin landed in commit** \`${OTHER_SHA1}\`.\n\n## What it is`)
  })
  assert.equal(code, 1, `expected the guard to fail, got:\n${out}`)
  assert.match(out, /pins no commit sha/)
})

test('a second sha256 recorded alongside the genuine pin does not break the pin check', () => {
  const { code, out } = runGuard((d) =>
    rewrite(d, '## What it is', `**Consumer copy SHA-256:** \`${OTHER_SHA256}\`\n\n## What it is`),
  )
  assert.equal(code, 0, out)
  assert.match(out, /✓ KKO provenance verified/)
})

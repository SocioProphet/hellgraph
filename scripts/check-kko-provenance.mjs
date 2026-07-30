#!/usr/bin/env node
/**
 * KKO vendored-ontology provenance guard.
 *
 * ── Why this exists (W12 inventory hygiene, 2026-07) ─────────────────────────────────
 * `ontology/kko/PROVENANCE.md` is the best provenance record in the estate — source, licence,
 * version IRI, byte count, sha256. It is also, until this script, verified by NOTHING. The
 * digest was a line in a Markdown file: correct, and connected to no check. Two consumers
 * (prophet-platform's owl-reasoner and nugget-extractor's KKO type refs) pin the SAME digest and
 * now assert it at import, so the engine — the artifact's source of truth — was the one copy
 * where drift would have gone unnoticed.
 *
 * ── What it enforces ─────────────────────────────────────────────────────────────────
 *   1. `ontology/kko/kko-2.10.n3` still hashes to the sha256 recorded in PROVENANCE.md, and is
 *      still the recorded byte length. The doc is the source of the expectation, so the doc and
 *      the artifact can never silently disagree. **SHA-256:** and **Bytes:** are both REQUIRED
 *      fields: a record that omits or mangles one FAILS this gate. It does not skip the
 *      comparison and report success — see the note above the byte check for why that distinction
 *      is the whole point of the script.
 *   2. PROVENANCE.md pins a COMMIT, not just a branch. `@ master` is a moving reference: re-run
 *      the retrieval later and you may get different bytes while claiming the same provenance.
 *      The pin is recognised by its label — ``commit `<40-hex>` `` — not by "some 40-hex run
 *      appears somewhere in the document".
 *   3. The generated `ts/src/kko-data.ts` is exactly what `scripts/gen-kko.mjs` produces from
 *      that .n3 — i.e. the ontology the engine actually SHIPS derives from the vendored source.
 *      A hand-edit to kko-data.ts, or a re-vendored .n3 without a regeneration, otherwise leaves
 *      the runtime ontology silently diverged from the file whose provenance we publish.
 *      (Same doctrine as this repo's existing ts/dist staleness gate — a generated artifact must
 *      be reproducible from its source, or the source is not the source.)
 *
 * Read-only: it regenerates into memory and compares. It never writes ts/src.
 *
 * Run:  node --import tsx scripts/check-kko-provenance.mjs
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const url = (p) => fileURLToPath(new URL(p, import.meta.url))

const n3Path = url('../ontology/kko/kko-2.10.n3')
const mdPath = url('../ontology/kko/PROVENANCE.md')
const dataPath = url('../ts/src/kko-data.ts')

// ── 1) the artifact matches the digest ITS OWN provenance record declares ──
const doc = readFileSync(mdPath, 'utf8')
const declared = (doc.match(/\*\*SHA-256:\*\*\s*`([0-9a-f]{64})`/) || [])[1]
if (!declared) die('ontology/kko/PROVENANCE.md does not declare a **SHA-256:** `<64hex>` — the record must state what the artifact should be')

const bytes = readFileSync(n3Path)
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== declared)
  die(`vendored KKO TBox DRIFTED: sha256 ${actual} != ${declared} declared in ontology/kko/PROVENANCE.md.\n` +
      `  This digest is pinned by consumers too (prophet-platform apps/owl-reasoner asserts it at import).\n` +
      `  Re-vendor, then update PROVENANCE.md AND every consumer pin in the same change.`)

// The byte count is a REQUIRED field and the comparison below is UNCONDITIONAL.
// This used to read `Number(… || '0')` guarded by `if (declaredBytes && …)`. A missing or
// unparseable **Bytes:** therefore became 0, `if (0 && …)` never fired, and the byte check
// silently evaporated — while the run still printed
//     ✓ KKO provenance verified — d907919fb40f20ed… (327,797 bytes)
// quoting the file's OWN length as though it had been checked against the record. A check that
// disappears when its input goes missing is worse than no check at all: it manufactures the
// evidence that it ran. Absent or malformed input must FAIL, exactly the way the missing
// **SHA-256:** case above already fails. (Same disease as the commit-pin note below.)
const declaredBytesText = (doc.match(/\*\*Bytes:\*\*\s*([0-9][0-9,]*)/) || [])[1]
const declaredBytes = declaredBytesText === undefined ? NaN : Number(declaredBytesText.replace(/,/g, ''))
if (!Number.isSafeInteger(declaredBytes))
  die('ontology/kko/PROVENANCE.md does not declare a parseable **Bytes:** <count> — the record must state what the artifact should be')
if (bytes.length !== declaredBytes)
  die(`vendored KKO TBox is ${bytes.length} bytes, PROVENANCE.md declares ${declaredBytes}`)

// ── 2) the source must be PINNED, not a moving branch ref ──
// The pin is located by its LABEL — ``commit `<40-hex>` `` — not by scanning the document for a
// bare 40-hex run. An unanchored scan does not answer "is the source pinned?", it answers "does
// any 40-hex string appear anywhere in this file?", and those come apart: a sha1 of some other
// artifact, another repo's commit sha, a hash sitting inside an unrelated URL, all satisfy it
// while the source line still reads `@ master`. The check would pass by accident and report a pin
// that is not there.
// Two details are load-bearing:
//   · the (?![0-9a-f]) tail — without it the pattern accepts the first 40 characters of a 64-char
//     sha256 that happens to be labelled `commit`;
//   · the digest strip below — so the artifact's own sha256 can never be the thing that supplies
//     its own pin, even if this pattern is loosened later.
// (A checker that validates itself validates nothing; this repo's estate has been bitten by
// exactly that shape before — including by the byte check a few lines above, which until
// 2026-07-30 switched ITSELF off whenever PROVENANCE.md stopped declaring a byte count, and went
// on printing a success line that named the bytes it had not verified. Absent input must fail,
// never skip.)
const withoutDigest = doc.split(declared).join('')
const commitPin = (withoutDigest.match(/\b[Cc]ommit\s+`?([0-9a-f]{40})(?![0-9a-f])/) || [])[1]
if (!commitPin)
  die('ontology/kko/PROVENANCE.md pins no commit sha. "@ master" is a MOVING reference — the same ' +
      'retrieval later can return different bytes and still claim this provenance. ' +
      'Pin the commit, and record it in the form: commit `<40-hex-sha>`')
for (const needle of ['SocioProphet/kbpedia', 'CC-BY-4.0'])
  if (!doc.includes(needle)) die(`ontology/kko/PROVENANCE.md does not record ${needle}`)

// ── 3) the SHIPPED ontology is reproducible from the vendored source ──
// Imported lazily and by URL so this file stays plain .mjs; needs `node --import tsx`.
const { parseKko } = await import('../ts/src/kko.ts')
const onto = parseKko(bytes.toString('utf8'))
onto.classes.sort((a, b) => a.iri.localeCompare(b.iri))   // same deterministic order gen-kko.mjs uses

const rows = onto.classes
  .map((c) => {
    const label = c.label !== undefined ? `, label: ${JSON.stringify(c.label)}` : ''
    return `  { iri: ${JSON.stringify(c.iri)}${label}, subClassOf: ${JSON.stringify(c.subClassOf)} },`
  })
  .join('\n')

const expected = `// GENERATED by scripts/gen-kko.mjs from ontology/kko/kko-2.10.n3 — do not edit by hand.
// KKO ${onto.version} · ${onto.classes.length} classes. Regenerate after re-vendoring KKO.
import type { KkoClass } from './kko'

export const KKO_VERSION = ${JSON.stringify(onto.version)}
export const KKO_CLASSES: KkoClass[] = [
${rows}
]
`

if (readFileSync(dataPath, 'utf8') !== expected)
  die('ts/src/kko-data.ts is NOT what scripts/gen-kko.mjs produces from ontology/kko/kko-2.10.n3.\n' +
      '  The ontology the engine ships has diverged from the vendored file whose provenance we publish.\n' +
      "  Run: node --import tsx scripts/gen-kko.mjs   then commit ts/src/kko-data.ts")

console.log(`✓ KKO provenance verified — ${actual.slice(0, 16)}… (${bytes.length.toLocaleString()} bytes), ` +
            `${onto.classes.length} classes ${onto.version}; ts/src/kko-data.ts reproduces from source`)

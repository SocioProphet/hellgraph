# KKO — KBpedia Knowledge Ontology (vendored)

**File:** `kko-2.10.n3`
**SHA-256:** `d907919fb40f20ed39a7fde0e8d114027449d9354a1976ce8248db5634cb7b07`
**Bytes:** 327,797
**KKO ontology version:** v2.00 (`owl:versionIRI <http://kbpedia.org/kbpedia/v200>`)
**Namespace:** `http://kbpedia.org/ontologies/kko#`
**Retrieved:** 2026-07-19 · **Provenance re-verified against upstream:** 2026-07-29

## Source (sovereign, pinned)
Vendored from the estate's sovereign fork, not upstream directly:
- **`SocioProphet/kbpedia`** @ commit `3f888b397255b69d1439fd95823e97011ed9440b` (branch `master`),
  path `versions/2.10/kko-demo.n3`
  (raw: `https://raw.githubusercontent.com/SocioProphet/kbpedia/3f888b397255b69d1439fd95823e97011ed9440b/versions/2.10/kko-demo.n3`)
- Upstream: **`KBpedia/kbpedia`** (the org formerly known as Cognonto).

This record previously cited `@ master`. A branch name is a MOVING reference, not a pin: the same
retrieval run later can return different bytes while still claiming this provenance. `master` has
not moved since 2019-04-09, so the two resolve identically today — which is exactly why the
difference stays invisible until it isn't. `scripts/check-kko-provenance.mjs` now refuses a record
that pins no commit.

## What it is
The **KKO upper ontology** — the Peircean-grounded typology structure that types the KBpedia
Knowledge Graph. This file carries the KKO TBox: **203 `owl:Class` declarations, 167
`rdfs:subClassOf` axioms**. It is the class hierarchy loaded into the HellGraph AtomSpace
`TypeLattice` by `ts/src/kko.ts`. (It does not include the full ~58k reference-concept ABox —
that is a separate, much larger artifact and a later increment.)

## License / attribution
KBpedia and the KKO are released under **CC-BY-4.0**.
© Michael K. Bergman and Fred Giasson (Cognonto Corporation / KBpedia).
Attribution required; see <https://kbpedia.org> and <https://creativecommons.org/licenses/by/4.0/>.
This vendored copy preserves that attribution and does not modify the ontology content.

## Where this record is ENFORCED
Until 2026-07-29 everything above was verified by **nothing** — the sha256 was a correct line in a
Markdown file, connected to no check. `scripts/check-kko-provenance.mjs` (npm run `check:kko`, run
in `ts-ci`) now asserts, on every PR:

1. `kko-2.10.n3` still hashes to the **SHA-256** declared above, and is still the declared byte
   length. The record is the source of the expectation, so record and artifact cannot silently
   disagree.
2. This file pins a **commit**, not a branch.
3. `ts/src/kko-data.ts` is exactly what `scripts/gen-kko.mjs` reproduces from this `.n3` — so the
   ontology the engine actually SHIPS derives from the vendored file whose provenance is published
   here. (Same doctrine as the repo's `ts/dist` staleness gate: a generated artifact must be
   reproducible from its source, or the source is not the source.)

**This digest is load-bearing beyond this repo.** prophet-platform vendors byte-identical copies of
this TBox (`apps/owl-reasoner/src/owl_reasoner/data/kko-2.10.n3`) and pins the SAME constant,
asserted at import. Moving this digest without moving the consumers' is the drift these gates
exist to catch — change them in one PR each, never independently.

## Regeneration
The compact hierarchy consumed by the engine (`ts/src/kko-data.ts`) is generated from this file
by `scripts/gen-kko.mjs` (parses with the engine's own `parseTurtle`). Re-run after re-vendoring
a newer KKO version and commit both the `.n3` and the regenerated `kko-data.ts`.

Re-vendoring checklist:
1. Copy the new `.n3` from the pinned `SocioProphet/kbpedia` path; update the commit pin above.
2. `shasum -a 256 ontology/kko/kko-2.10.n3` → update **SHA-256** and **Bytes** above.
3. `node --import tsx scripts/gen-kko.mjs` → commit the regenerated `ts/src/kko-data.ts`.
4. `npm run check:kko` must pass, then update the consumer pins listed above.

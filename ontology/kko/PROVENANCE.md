# KKO — KBpedia Knowledge Ontology (vendored)

**File:** `kko-2.10.n3`
**SHA-256:** `d907919fb40f20ed39a7fde0e8d114027449d9354a1976ce8248db5634cb7b07`
**Bytes:** 327,797
**KKO ontology version:** v2.00 (`owl:versionIRI <http://kbpedia.org/kbpedia/v200>`)
**Namespace:** `http://kbpedia.org/ontologies/kko#`
**Retrieved:** 2026-07-19

## Source (sovereign)
Vendored from the estate's sovereign fork, not upstream directly:
- **`SocioProphet/kbpedia`** @ `master`, path `versions/2.10/kko-demo.n3`
  (raw: `https://raw.githubusercontent.com/SocioProphet/kbpedia/master/versions/2.10/kko-demo.n3`)
- Upstream: **`KBpedia/kbpedia`** (the org formerly known as Cognonto).

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

## Regeneration
The compact hierarchy consumed by the engine (`ts/src/kko-data.ts`) is generated from this file
by `scripts/gen-kko.mjs` (parses with the engine's own `parseTurtle`). Re-run after re-vendoring
a newer KKO version and commit both the `.n3` and the regenerated `kko-data.ts`.

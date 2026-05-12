# Phase 6 Next Steps

## Highest-value next move

Replace the provisional authored rows used in tests with the real 26-slot canonical basis.

## Why

This phase removes the structural excuse for not doing so:

- the runtime no longer hardcodes the provisional pack
- the runtime no longer hardcodes the placeholder operator interface
- the canonical pack path can fail fast on incomplete mappings

## Immediate implementation targets

1. Populate `CanonicalPackDraft` row-by-row from the real basis.
2. Encode the real operator calculus as one or more `FieldOperatorSemantics` implementations.
3. Add a migration test that proves provisional-to-canonical slot mapping produces the intended runtime pack.
4. Only after that, move upward into query surface and RDF-star projection.

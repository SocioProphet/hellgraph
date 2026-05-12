# Canonical Pack Migration Skeleton

The current runtime still uses `FieldPack-0001-Provisional`.

This phase adds a **coded migration skeleton** rather than inventing the canonical basis.

## What the skeleton captures

For each of the 26 slots, we now carry:

- slot index
- provisional dimension name
- canonical name placeholder
- canonical domain placeholder
- status (`Unmapped`, `Mapped`, `Deprecated`, `Split`, `Merged`)
- notes

## Why this matters

This lets us wire tooling and migration discipline now without pretending we know the canonical basis when we do not.

The next implementation move is to replace the placeholders row-by-row from the real basis manuscript and then produce:

- `FieldPack-0001-Canonical`
- `PackMigrationPlan-0001`
- runtime operator bindings keyed to canonical slot semantics

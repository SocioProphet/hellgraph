# FieldPack Migration and Kernel Integration

## Migration goals

We need to move from `FieldPack-0001-Provisional` to `FieldPack-0001-Canonical` without silent semantic drift.

## Rules

1. Slot order is stable unless an explicit migration map says otherwise.
2. Every changed slot must record:
   - previous provisional meaning,
   - canonical meaning,
   - transformation rule,
   - whether historical replay remains valid.
3. Basis fingerprint changes are mandatory for any semantic change.
4. Historical `FieldValue` objects must keep the old fingerprint; they are not rewritten in place.

## Kernel integration rules

`field.current` and `proof.current` should be committed on the same transaction boundary whenever possible.

This phase implements that behavior in-memory by committing multiple valuations in one transaction. That gives us:
- one visible snapshot for the cycle result,
- one visibility boundary for recommendation/policy gates,
- and one replay step for deterministic cycle evaluation.

## Next persistence seam

The next phase should add a durable valuation log and checkpoint manifest. The API shape here is designed so the in-memory store can be replaced by a disk-backed MVCC store later.

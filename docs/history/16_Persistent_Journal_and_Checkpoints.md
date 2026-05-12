# Persistent journal and checkpoint model

## Journal

The journal is append-only and line-oriented.

Record classes:

- `NODE`
- `LINK`
- `BATCH`
- `ART`
- `VAL`
- `ENDBATCH`

This allows deterministic replay into a fresh `SpaceStore`.

## Checkpoint

The checkpoint is a full materialized snapshot:

- `META`
- `NODE`
- `LINK`
- `ART`
- `VAL`

The checkpoint loader reconstructs the visible history and counters.

## Current limitations

- No compaction plan yet.
- No checksum block framing yet.
- No fsync durability contract yet.
- No concurrent writers.

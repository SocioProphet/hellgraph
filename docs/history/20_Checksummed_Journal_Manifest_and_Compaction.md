# Checksummed Journal, Manifest, and Compaction

## Journal format

Header:

- `HGLJ2`

Frame structure:

- `FRAME	<seq>	<kind>	<txn>	<payload_count>	<checksum>`
- `<payload line 1>`
- `...`
- `<payload line N>`
- `END	<seq>`

Checksum is FNV-1a 64 over the payload lines joined with `
`.

This makes corruption detectable during replay while keeping the format simple and inspectable.

## Manifest sidecar

Header:

- `HGMF1`

Tracked metadata:

- checksum scheme
- checkpoint path
- last replayed txn
- last checkpoint txn
- last frame sequence
- compacted frame count

The manifest is not authoritative truth. The journal/checkpoint remain primary. The manifest is a fast-load planning aid and integrity/debugging aid.

## Checkpoint format

Header:

- `HGCK2`

Carries:

- store metadata line (`META`)
- atoms
n- artifacts
- value envelopes

## Compaction flow

1. Save checkpoint from current in-memory store.
2. Update manifest with checkpoint metadata.
3. Rewrite journal to header-only form.
4. Reset frame sequence to zero.
5. Reopen by loading checkpoint and replaying any post-checkpoint frames.

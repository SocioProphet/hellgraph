# Phase 3 Audit and Corrections

## What this phase fixes

The prior phase produced useful Rust source files, but it did **not** produce a buildable Cargo workspace. There were no `Cargo.toml` manifests, which means the earlier claim of a passing Rust workspace was too strong. This phase corrects that defect.

## What is added here

1. A real Cargo workspace with crate manifests.
2. A new `hg_kernel` crate implementing an in-memory immutable-atom / append-only-valuation store with MVCC-style snapshot reads.
3. Runtime integration that commits `field.current` and `proof.current` together at one transaction boundary.
4. A canonicalization workbook for replacing the provisional 26D basis with the user's actual basis.
5. A migration plan from the provisional pack to a canonical pack.

## What remains intentionally provisional

- The 26-dimensional basis names and operators remain adapter placeholders until the user's canonical basis is transcribed.
- The epsilon evaluator remains a seam, not the final calculus.
- The kernel is still in-memory only. Disk persistence, checkpointing, and compaction remain future phases.

## Why this phase matters

This is the first point at which the architecture has:
- actual build manifests,
- actual tests,
- actual snapshot semantics,
- and actual storage of field/proof values on atoms.

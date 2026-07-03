/**
 * causal-proof — proof binding under causal consistency (docs/specs/09).
 *
 * The kernel law: proof is NEVER silently downgraded to confidence. Under the federated
 * model the shared AtomSpace is an Autobase linearization of many sovereign logs, and
 * that order is eventually consistent — causal forks can reorder previously-ordered ops.
 * A proof computed against one linearization must therefore be honored ONLY within the
 * causal frame it was derived against; outside it the proof is explicitly out-of-frame
 * and must be re-checked, never degraded to a probability.
 *
 * This module is the pure, deterministic core of that contract (spec 09 §"Proof binding"
 * and the P1–P5 invariants). It is decoupled from Autobase: it operates on op ids and
 * causal cuts, so it is exhaustively unit-testable. FederatedAtomSpace supplies the real
 * cuts and linearization (see currentCut()/linearization()).
 */

// ─── Op identity & causal cuts ───────────────────────────────────────────────────

/** A writer's Hypercore public key (hex) — the participant's identity. */
export type WriterKey = string

/** One operation, identified by its writer and that writer's 1-based local sequence.
 *  A writer's own log is linear, so (writer, seq) is a total order per writer. */
export interface OpId { writer: WriterKey; seq: number }

/** A causal cut: a version vector over writers. `cut[writer] = n` means "all ops of
 *  `writer` with seq ≤ n are observed." Absent/0 means none observed from that writer. */
export type CausalCut = Record<WriterKey, number>

export const opIdStr = (op: OpId): string => `${op.writer}:${op.seq}`

/** Is `op` inside `cut`? (i.e. observed within this frame) */
export function opInCut(op: OpId, cut: CausalCut): boolean {
  return (cut[op.writer] ?? 0) >= op.seq
}

/** Componentwise max — the causal join of two cuts (their least common superset). */
export function cutJoin(a: CausalCut, b: CausalCut): CausalCut {
  const out: CausalCut = { ...a }
  for (const [w, n] of Object.entries(b)) out[w] = Math.max(out[w] ?? 0, n)
  return out
}

/** Does `a` causally subsume `b`? (a ≥ b componentwise — a observes everything b does) */
export function cutSubsumes(a: CausalCut, b: CausalCut): boolean {
  for (const [w, n] of Object.entries(b)) if ((a[w] ?? 0) < n) return false
  return true
}

export function cutEquals(a: CausalCut, b: CausalCut): boolean {
  return cutSubsumes(a, b) && cutSubsumes(b, a)
}

/** The cut implied by observing an ordered op list: the max seq seen per writer. */
export function cutFromOrder(order: OpId[]): CausalCut {
  const out: CausalCut = {}
  for (const op of order) out[op.writer] = Math.max(out[op.writer] ?? 0, op.seq)
  return out
}

/** True when the cut observes nothing (no writer has any op). */
export function cutIsEmpty(cut: CausalCut): boolean {
  for (const n of Object.values(cut)) if (n > 0) return false
  return true
}

// ─── Proof artifacts ─────────────────────────────────────────────────────────────

export type FrameStatus = 'in-frame' | 'out-of-frame'

export interface ProofArtifact {
  /** What the checker asserts. */
  statement: string
  /** The checker's verdict, true ONLY within `derivedAgainst`. Never a probability. */
  verdict: boolean
  /** REQUIRED (P1): the causal frame this proof is true in. */
  derivedAgainst: CausalCut
  /** The specific ops the checker read, in the linearization order it observed. */
  dependencyOps: OpId[]
}

/**
 * Construct a frame-bound proof (spec 09 §"Proof binding contract").
 * Enforces P1 (non-empty frame) and dependency coverage: every dependency op MUST lie
 * within `derivedAgainst`, and they are recorded in observed order. Throws otherwise —
 * a proof that cannot name its frame is not a proof.
 */
export function bindProof(args: {
  statement: string
  verdict: boolean
  derivedAgainst: CausalCut
  dependencyOps: OpId[]
}): ProofArtifact {
  if (cutIsEmpty(args.derivedAgainst)) {
    throw new Error('bindProof: derivedAgainst must be a non-empty causal cut (P1)')
  }
  for (const op of args.dependencyOps) {
    if (!opInCut(op, args.derivedAgainst)) {
      throw new Error(`bindProof: dependency ${opIdStr(op)} lies outside derivedAgainst`)
    }
  }
  return {
    statement: args.statement,
    verdict: args.verdict,
    derivedAgainst: { ...args.derivedAgainst },
    dependencyOps: [...args.dependencyOps],
  }
}

/**
 * Evaluate a proof against a read cut and the current linearization — the ONLY sanctioned
 * way to consume a proof (spec 09 §"Read semantics", invariants P2/P4/P5).
 *
 * Returns an explicit frame status. When in-frame, the recorded verdict is surfaced.
 * When out-of-frame (a dependency is unobserved at the read cut, or a causal fork reordered
 * the dependency set), the verdict is WITHHELD — never converted to a confidence value.
 * That withholding is the whole point: the caller must re-check, not degrade.
 *
 * @param currentOrder the current linearization (op ids in order); may extend beyond readCut.
 */
export function honorProof(
  proof: ProofArtifact,
  readCut: CausalCut,
  currentOrder: OpId[],
): { status: FrameStatus; verdict?: boolean } {
  // 1. Presence: every dependency must be observed at the read cut.
  for (const dep of proof.dependencyOps) {
    if (!opInCut(dep, readCut)) return { status: 'out-of-frame' }
  }
  // 2. Order preservation: the dependency set must appear in the same relative order in
  //    the current linearization (restricted to what the read cut observes). A causal
  //    fork that reorders any dependency pair takes the proof out-of-frame.
  const depKeys = new Set(proof.dependencyOps.map(opIdStr))
  const observed = currentOrder
    .filter((op) => opInCut(op, readCut) && depKeys.has(opIdStr(op)))
    .map(opIdStr)
  const expected = proof.dependencyOps.map(opIdStr)
  if (observed.length !== expected.length) return { status: 'out-of-frame' }
  for (let i = 0; i < expected.length; i++) {
    if (observed[i] !== expected[i]) return { status: 'out-of-frame' }
  }
  // In-frame: append-only growth beyond the dependency set never reaches here (P4).
  return { status: 'in-frame', verdict: proof.verdict }
}

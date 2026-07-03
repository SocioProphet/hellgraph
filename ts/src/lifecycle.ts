/**
 * lifecycle — the content-object lifecycle state machine (data-plane spec 10, L5).
 *
 * Every content object moves through a governed FSM: ingest → normalize → extract → index →
 * serve, with branches to vendor materialization (opt-in), flagged retention, legal hold,
 * and deletion. The Retention Scheduler and Policy Engine (policy.ts) own the branch edges;
 * this module is the pure, validated state model they drive.
 *
 * Non-negotiable enforced structurally: LEGAL HOLD OVERRIDES RETENTION. A held object sits
 * in `LegalHold`, which has NO retention-delete edge — the only ways out are release
 * (→Served) or delete-after-release (guarded on holdReleased). So retention can never
 * delete a held object; it must be released first.
 */

export type ContentState =
  | 'IngestedRaw'
  | 'Normalized'
  | 'Extracted'
  | 'Indexed'
  | 'Served'
  | 'VendorMaterialized'
  | 'ExpiredVendorCache'
  | 'FlaggedRetention'
  | 'LegalHold'
  | 'Deleted'

export type Trigger =
  | 'normalize' | 'extract' | 'index' | 'serve'
  | 'vendor_materialize' | 'reuse_handle' | 'ttl_gc' | 'rematerialize'
  | 'flag_abuse' | 'window_ends'
  | 'legal_hold' | 'hold_release' | 'delete_after_release'
  | 'retention_delete'

/** Object context the FSM guards read. Timestamps are epoch-ms; absent = not scheduled. */
export interface ContentObject {
  id: string
  state: ContentState
  vendorOptIn?: boolean
  holdReleased?: boolean
  ttlAt?: number
  flaggedWindowEndsAt?: number
  retentionDeleteAt?: number
  residency?: string
  sensitiveFields?: string[]
}

interface Edge {
  to: ContentState
  trigger: Trigger
  /** Opt-in required (vendor/egress). */
  requiresOptIn?: boolean
  /** Extra guard on object context. */
  guard?: (o: ContentObject) => boolean
}

const RETENTION_DELETE: Edge = { to: 'Deleted', trigger: 'retention_delete' }

// The transition table. Note: LegalHold has NO retention_delete edge (the structural
// enforcement of "legal hold overrides retention").
export const TRANSITIONS: Record<ContentState, Edge[]> = {
  IngestedRaw: [{ to: 'Normalized', trigger: 'normalize' }],
  Normalized: [{ to: 'Extracted', trigger: 'extract' }, RETENTION_DELETE],
  Extracted: [{ to: 'Indexed', trigger: 'index' }, RETENTION_DELETE],
  Indexed: [{ to: 'Served', trigger: 'serve' }, RETENTION_DELETE],
  Served: [
    { to: 'VendorMaterialized', trigger: 'vendor_materialize', requiresOptIn: true },
    { to: 'FlaggedRetention', trigger: 'flag_abuse' },
    { to: 'LegalHold', trigger: 'legal_hold' },
    RETENTION_DELETE,
  ],
  VendorMaterialized: [
    { to: 'Served', trigger: 'reuse_handle' },
    { to: 'ExpiredVendorCache', trigger: 'ttl_gc' },
  ],
  ExpiredVendorCache: [{ to: 'VendorMaterialized', trigger: 'rematerialize', requiresOptIn: true }],
  FlaggedRetention: [{ to: 'Deleted', trigger: 'window_ends' }],
  LegalHold: [
    { to: 'Served', trigger: 'hold_release' },
    { to: 'Deleted', trigger: 'delete_after_release', guard: (o) => o.holdReleased === true },
  ],
  Deleted: [],
}

/** Delete-type triggers must pass the policy delete-gate (policy.ts) before applying. */
export const DELETE_TRIGGERS = new Set<Trigger>(['retention_delete', 'window_ends', 'delete_after_release'])

export function edgeFor(state: ContentState, trigger: Trigger): Edge | undefined {
  return TRANSITIONS[state].find((e) => e.trigger === trigger)
}

/** Can this object take this trigger? (edge exists, opt-in satisfied, guard passes). */
export function canTransition(o: ContentObject, trigger: Trigger): boolean {
  const e = edgeFor(o.state, trigger)
  if (!e) return false
  if (e.requiresOptIn && !o.vendorOptIn) return false
  if (e.guard && !e.guard(o)) return false
  return true
}

/** Apply a trigger, returning the new state. Throws on an illegal transition. */
export function applyTransition(o: ContentObject, trigger: Trigger): ContentState {
  const e = edgeFor(o.state, trigger)
  if (!e) throw new Error(`illegal transition: ${o.state} --${trigger}--> ?`)
  if (e.requiresOptIn && !o.vendorOptIn) throw new Error(`transition ${trigger} requires opt-in`)
  if (e.guard && !e.guard(o)) throw new Error(`transition ${trigger} guard failed`)
  return e.to
}

/**
 * Validate the model invariants (used in tests / at startup):
 * - Deleted is terminal.
 * - LegalHold has no retention_delete edge (legal hold overrides retention).
 * - every edge target is a known state.
 */
export function validateModel(): { ok: true } {
  if (TRANSITIONS.Deleted.length !== 0) throw new Error('Deleted must be terminal')
  if (TRANSITIONS.LegalHold.some((e) => e.trigger === 'retention_delete')) {
    throw new Error('invariant violated: LegalHold must not have a retention_delete edge')
  }
  for (const [, edges] of Object.entries(TRANSITIONS)) {
    for (const e of edges) if (!(e.to in TRANSITIONS)) throw new Error(`unknown target state ${e.to}`)
  }
  return { ok: true }
}

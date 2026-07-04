/**
 * policy — the L5 policy engine, retention scheduler, and audit (data-plane spec 10).
 *
 * The Policy Engine evaluates decisions at three chokepoints — egress, delete, cache —
 * with the sovereignty non-negotiables baked in as always-on deny rules that user policy
 * cannot override (deny-overrides):
 *   - egress is OPT-IN and default-deny (no vendor/connector egress unless opted in);
 *   - legal hold overrides retention (delete denied while held and not released);
 *   - sensitive fields carry a mask obligation before egress.
 *
 * The Retention Scheduler computes due lifecycle transitions; the Governor applies them
 * gated by the delete decision, and every decision + transition is an append-only audit
 * event. In production the AuditSink binds to the evidence spine (a Hypercore); here it
 * defaults to in-memory so it is testable.
 */

import {
  applyTransition, canTransition, DELETE_TRIGGERS, edgeFor,
  type ContentObject, type ContentState, type Trigger,
} from './lifecycle.js'

// ─── Policy model ────────────────────────────────────────────────────────────────
export type PolicyAction = 'egress' | 'delete' | 'cache'
export type Effect = 'allow' | 'deny'

export interface PolicyContext {
  action: PolicyAction
  object: ContentObject & { legalHold?: boolean; connectorOptIn?: boolean }
  target?: { kind: 'vendor' | 'connector' | 'internal'; id?: string; region?: string; allowedResidencies?: string[] }
}

export interface Decision { effect: Effect; reason: string; obligations: string[] }

// Declarative conditions (OPA/Cedar-flavored, rules-as-data).
export type Condition =
  | { attr: string; op: 'eq' | 'ne' | 'truthy' | 'falsy' | 'in'; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }

export interface Rule {
  id: string
  action: PolicyAction | '*'
  effect: Effect
  when?: Condition
  obligations?: string[]
}
export interface Policy { rules: Rule[] }

function getPath(ctx: PolicyContext, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), ctx)
}

export function evalCondition(cond: Condition, ctx: PolicyContext): boolean {
  if ('all' in cond) return cond.all.every((c) => evalCondition(c, ctx))
  if ('any' in cond) return cond.any.some((c) => evalCondition(c, ctx))
  if ('not' in cond) return !evalCondition(cond.not, ctx)
  const v = getPath(ctx, cond.attr)
  switch (cond.op) {
    case 'eq': return v === cond.value
    case 'ne': return v !== cond.value
    case 'truthy': return Boolean(v)
    case 'falsy': return !v
    case 'in': return Array.isArray(cond.value) && (cond.value as unknown[]).includes(v)
  }
}

// The baseline rules — always evaluated first. The denies are non-negotiable (deny-overrides,
// so no user rule can weaken them); the allows flip opted-in egress on (a user deny can still
// override to be MORE restrictive).
const BASELINE: Rule[] = [
  // Legal hold overrides retention. (non-negotiable)
  { id: 'legal-hold-blocks-delete', action: 'delete', effect: 'deny',
    when: { all: [{ attr: 'object.legalHold', op: 'truthy' }, { attr: 'object.holdReleased', op: 'falsy' }] } },
  // Vendor/connector egress requires opt-in. (non-negotiable)
  { id: 'vendor-egress-requires-optin', action: 'egress', effect: 'deny',
    when: { all: [{ attr: 'target.kind', op: 'eq', value: 'vendor' }, { attr: 'object.vendorOptIn', op: 'falsy' }] } },
  { id: 'connector-egress-requires-optin', action: 'egress', effect: 'deny',
    when: { all: [{ attr: 'target.kind', op: 'eq', value: 'connector' }, { attr: 'object.connectorOptIn', op: 'falsy' }] } },
  // Opting in flips egress on (still subject to a user deny and to mask obligations).
  { id: 'vendor-egress-optin-allow', action: 'egress', effect: 'allow',
    when: { all: [{ attr: 'target.kind', op: 'eq', value: 'vendor' }, { attr: 'object.vendorOptIn', op: 'truthy' }] } },
  { id: 'connector-egress-optin-allow', action: 'egress', effect: 'allow',
    when: { all: [{ attr: 'target.kind', op: 'eq', value: 'connector' }, { attr: 'object.connectorOptIn', op: 'truthy' }] } },
]

const DEFAULT_EFFECT: Record<PolicyAction, Effect> = { egress: 'deny', delete: 'allow', cache: 'allow' }

/** Triggers that push content to a vendor — gated by the opt-in egress decision. */
const VENDOR_EGRESS_TRIGGERS = new Set<Trigger>(['vendor_materialize', 'rematerialize'])

/** Evaluate a decision. deny-overrides; non-negotiables win; egress carries mask obligations. */
export function decide(ctx: PolicyContext, policy: Policy = { rules: [] }): Decision {
  const rules = [...BASELINE, ...policy.rules].filter(
    (r) => (r.action === ctx.action || r.action === '*') && (!r.when || evalCondition(r.when, ctx)),
  )
  const deny = rules.find((r) => r.effect === 'deny')
  if (deny) return { effect: 'deny', reason: deny.id, obligations: [] }

  const allows = rules.filter((r) => r.effect === 'allow')
  const effect: Effect = allows.length > 0 ? 'allow' : DEFAULT_EFFECT[ctx.action]
  const reason = allows.length > 0 ? allows.map((r) => r.id).join(',') : `default:${effect}`

  // Residency compliance: when the egress target declares its approved residencies
  // (target.allowedResidencies — supplied by the layer that knows the target, e.g. the vendor
  // cache), content whose residency is not approved is denied and NOT user-overridable. If no
  // approval set is declared, residency is not evaluated at this call site.
  if (effect === 'allow' && ctx.action === 'egress' && ctx.object.residency && ctx.target?.allowedResidencies) {
    if (!ctx.target.allowedResidencies.includes(ctx.object.residency)) {
      return { effect: 'deny', reason: 'residency-mismatch', obligations: [] }
    }
  }

  const obligations: string[] = []
  if (effect === 'allow') for (const r of allows) obligations.push(...(r.obligations ?? []))
  // Sensitive fields MUST be masked before any egress (spec 10 non-negotiable).
  if (effect === 'allow' && ctx.action === 'egress') {
    for (const f of ctx.object.sensitiveFields ?? []) obligations.push(`mask:${f}`)
  }
  return { effect, reason, obligations: [...new Set(obligations)] }
}

// ─── Audit (append-only) ─────────────────────────────────────────────────────────
export interface AuditEvent {
  ts: number
  kind: 'decision' | 'transition' | 'blocked'
  objectId: string
  action?: PolicyAction
  effect?: Effect
  from?: ContentState
  to?: ContentState
  trigger?: Trigger
  reason?: string
  obligations?: string[]
}
export interface AuditSink { append(e: AuditEvent): void }

/** Default sink — in production, bind to the evidence spine (a Hypercore). */
export class InMemoryAuditLog implements AuditSink {
  private readonly log: AuditEvent[] = []
  append(e: AuditEvent): void { this.log.push(e) }
  entries(): AuditEvent[] { return [...this.log] }
}

// ─── Retention scheduler ─────────────────────────────────────────────────────────
export interface DueTransition { trigger: Trigger; to: ContentState }

/** Lifecycle transitions that are due for an object at time `now` (epoch-ms). */
export function dueTransitions(o: ContentObject, now: number): DueTransition[] {
  const out: DueTransition[] = []
  if (o.state === 'VendorMaterialized' && o.ttlAt !== undefined && o.ttlAt <= now) {
    out.push({ trigger: 'ttl_gc', to: 'ExpiredVendorCache' })
  }
  if (o.state === 'FlaggedRetention' && o.flaggedWindowEndsAt !== undefined && o.flaggedWindowEndsAt <= now) {
    out.push({ trigger: 'window_ends', to: 'Deleted' })
  }
  const retentionStates: ContentState[] = ['Normalized', 'Extracted', 'Indexed', 'Served']
  if (retentionStates.includes(o.state) && o.retentionDeleteAt !== undefined && o.retentionDeleteAt <= now) {
    out.push({ trigger: 'retention_delete', to: 'Deleted' })
  }
  return out
}

// ─── Governor — composes policy + lifecycle + audit ──────────────────────────────
export class Governor {
  constructor(
    private readonly policy: Policy = { rules: [] },
    private readonly audit: AuditSink = new InMemoryAuditLog(),
  ) {}

  get auditLog(): AuditSink { return this.audit }

  /** Evaluate + audit a policy decision. */
  decide(ctx: PolicyContext): Decision {
    const d = decide(ctx, this.policy)
    this.audit.append({ ts: Date.now(), kind: 'decision', objectId: ctx.object.id, action: ctx.action, effect: d.effect, reason: d.reason, obligations: d.obligations })
    return d
  }

  /**
   * Apply a lifecycle trigger, gated: delete-type triggers must pass the delete decision
   * (so legal hold blocks them). Mutates and returns the object; audits the outcome.
   */
  transition(o: ContentObject & { legalHold?: boolean }, trigger: Trigger): ContentObject {
    if (DELETE_TRIGGERS.has(trigger)) {
      const d = decide({ action: 'delete', object: o }, this.policy)
      if (d.effect === 'deny') {
        this.audit.append({ ts: Date.now(), kind: 'blocked', objectId: o.id, from: o.state, trigger, reason: d.reason })
        return o
      }
    }
    // Vendor materialization is egress — gate it on the opt-in egress decision too.
    if (VENDOR_EGRESS_TRIGGERS.has(trigger)) {
      const d = decide({ action: 'egress', object: o, target: { kind: 'vendor' } }, this.policy)
      if (d.effect === 'deny') {
        this.audit.append({ ts: Date.now(), kind: 'blocked', objectId: o.id, from: o.state, trigger, reason: d.reason })
        return o
      }
    }
    if (!canTransition(o, trigger)) {
      const e = edgeFor(o.state, trigger)
      this.audit.append({ ts: Date.now(), kind: 'blocked', objectId: o.id, from: o.state, trigger, reason: e ? 'guard/opt-in failed' : 'no edge' })
      return o
    }
    const from = o.state
    o.state = applyTransition(o, trigger)
    this.audit.append({ ts: Date.now(), kind: 'transition', objectId: o.id, from, to: o.state, trigger })
    return o
  }

  /** Run all due retention transitions for an object at `now`, gated + audited. */
  runRetention(o: ContentObject & { legalHold?: boolean }, now: number): ContentObject {
    for (const due of dueTransitions(o, now)) this.transition(o, due.trigger)
    return o
  }
}

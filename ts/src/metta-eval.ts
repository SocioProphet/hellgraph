/**
 * metta-eval — MeTTa term-rewriting / evaluation (DAS conformance, beyond `match`).
 *
 * `match` (metta.ts) queries the space; this adds MeTTa's COMPUTATION model: equality rules
 * `(= <lhs> <rhs>)` rewrite expressions, plus a few grounded operations (arithmetic). An
 * expression is reduced to normal form by eagerly reducing children, applying grounded ops,
 * then applying the first matching rule — repeated under a step budget (so non-terminating
 * rewrites return safely instead of hanging).
 *
 *   (= (double $x) (+ $x $x))
 *   !(double 21)   ⇒   42
 */

import { parseSExpr, parseProgram, matchPattern, serialize, instantiate, type SExpr, type MettaBinding } from './metta.js'
import type { AtomSpace } from './atomspace.js'

export interface MettaRule { lhs: SExpr; rhs: SExpr }

/** A MeTTa program's equality rules. */
export class MettaRuleset {
  readonly rules: MettaRule[] = []
  /** Add a `(= <lhs> <rhs>)` rule from text. Non-equality expressions are ignored. */
  add(ruleText: string): this {
    const e = parseSExpr(ruleText)
    if (e.kind === 'list' && e.items[0]?.kind === 'sym' && e.items[0].name === '=' && e.items.length === 3) {
      this.rules.push({ lhs: e.items[1]!, rhs: e.items[2]! })
    }
    return this
  }
  static from(...ruleTexts: string[]): MettaRuleset {
    const rs = new MettaRuleset()
    for (const t of ruleTexts) rs.add(t)
    return rs
  }
}

// ─── Pure S-expr unification (rule LHS with $vars ⇄ a concrete term) ──────────────────
function unifyS(pattern: SExpr, term: SExpr, b: MettaBinding): MettaBinding | null {
  if (pattern.kind === 'var') {
    const prior = b.get(pattern.name)
    if (prior) return serialize(prior) === serialize(term) ? b : null
    const nb = new Map(b)
    nb.set(pattern.name, term)
    return nb
  }
  if (pattern.kind === 'sym') return term.kind === 'sym' && term.name === pattern.name ? b : null
  if (term.kind !== 'list' || term.items.length !== pattern.items.length) return null
  let cur: MettaBinding | null = b
  for (let i = 0; i < pattern.items.length && cur; i++) cur = unifyS(pattern.items[i]!, term.items[i]!, cur)
  return cur
}

// ─── Grounded operations ──────────────────────────────────────────────────────────────
const isNum = (e: SExpr): e is { kind: 'sym'; name: string } => e.kind === 'sym' && /^-?\d+$/.test(e.name)
const num = (n: number): SExpr => ({ kind: 'sym', name: String(n) })

/** Reduce a grounded op `(<op> a b)` over integer symbols, or null if not applicable. */
function grounded(e: SExpr): SExpr | null {
  if (e.kind !== 'list' || e.items.length !== 3) return null
  const [op, a, b] = e.items
  if (op?.kind !== 'sym' || !isNum(a!) || !isNum(b!)) return null
  const x = Number(a.name), y = Number(b.name)
  switch (op.name) {
    case '+': return num(x + y)
    case '-': return num(x - y)
    case '*': return num(x * y)
    default: return null
  }
}

function reduce(expr: SExpr, rules: MettaRule[], budget: { n: number }): SExpr {
  if (budget.n <= 0 || expr.kind !== 'list') return expr
  // Eagerly reduce children to normal form.
  const e: SExpr = { kind: 'list', items: expr.items.map((it) => reduce(it, rules, budget)) }
  // Grounded operation?
  const g = grounded(e)
  if (g) { budget.n--; return reduce(g, rules, budget) }
  // First matching equality rule.
  for (const r of rules) {
    const bnd = unifyS(r.lhs, e, new Map())
    if (bnd) { budget.n--; return reduce(instantiate(r.rhs, bnd), rules, budget) }
  }
  return e
}

/** Reduce an S-expression to normal form under a ruleset. */
export function evalSExpr(expr: SExpr, ruleset: MettaRuleset, maxSteps = 10_000): SExpr {
  return reduce(expr, ruleset.rules, { n: maxSteps })
}

/** Evaluate a MeTTa expression to normal form under a ruleset. `maxSteps` bounds rewrites. */
export function evalMetta(exprText: string, ruleset: MettaRuleset, maxSteps = 10_000): string {
  return serialize(evalSExpr(parseSExpr(exprText), ruleset, maxSteps))
}

const isForm = (e: SExpr, head: string): e is { kind: 'list'; items: SExpr[] } =>
  e.kind === 'list' && e.items[0]?.kind === 'sym' && e.items[0].name === head

/**
 * Run a whole MeTTa program against a space: `(= …)` forms accumulate as rules, `(match …)`
 * forms query the space, and any other top-level expression is evaluated against the rules so
 * far. Returns the outputs (from match + eval forms), in order — the unified DAS/MeTTa surface.
 */
export function runMettaProgram(space: AtomSpace, programText: string): string[] {
  const ruleset = new MettaRuleset()
  const out: string[] = []
  for (const form of parseProgram(programText)) {
    if (isForm(form, '=') && form.items.length === 3) {
      ruleset.rules.push({ lhs: form.items[1]!, rhs: form.items[2]! })
    } else if (isForm(form, 'match')) {
      const pattern = form.items[2]
      const template = form.items[3] ?? pattern
      if (pattern && template) for (const b of matchPattern(space, pattern)) out.push(serialize(instantiate(template, b)))
    } else {
      out.push(serialize(evalSExpr(form, ruleset)))
    }
  }
  return out
}

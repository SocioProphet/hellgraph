import { AtomSpace, nodeHandle, type Atom, type Handle } from './atomspace'

/**
 * Pattern Matcher — native hypergraph query over the AtomSpace.
 *
 * A pattern is a conjunction of clauses (link templates) containing variables.
 * The matcher finds every grounding: an assignment of variables to atoms that
 * makes all clauses simultaneously present in the space. Variables may carry a
 * type restriction (TypedVariable), resolved through the type lattice.
 *
 * This subsumes SPARQL basic graph patterns — clauses are full hypergraph
 * templates (any arity, links over links), not just binary triples — and is the
 * substrate the OpenCog BindLink/GetLink semantics map onto.
 */

export type PatternTerm =
  | { kind: 'var'; name: string; type?: string }
  | { kind: 'node'; type: string; name: string }
  | { kind: 'link'; type: string; outgoing: PatternTerm[] }

export interface Pattern {
  /** Conjunctive clauses — all must match. Each is a link template. */
  clauses: Extract<PatternTerm, { kind: 'link' }>[]
  /** Variable names to project; defaults to all variables seen. */
  select?: string[]
}

/** var name → bound handle. */
export type Grounding = Record<string, Handle>

export interface MatchResult {
  variables: string[]
  /** Each grounding, with variables resolved to readable atom labels. */
  results: Record<string, string>[]
  /** Raw handle groundings. */
  groundings: Grounding[]
  evaluatedAtSeq: number
}

// ─── Builder helpers (ergonomic pattern construction) ──────────────────────────

export const V = (name: string, type?: string): PatternTerm => ({ kind: 'var', name, type })
export const N = (type: string, name: string): PatternTerm => ({ kind: 'node', type, name })
export const L = (type: string, ...outgoing: PatternTerm[]): Extract<PatternTerm, { kind: 'link' }> => ({ kind: 'link', type, outgoing })

// ─── Matcher ───────────────────────────────────────────────────────────────────

export function findMatches(as: AtomSpace, pattern: Pattern): MatchResult {
  let groundings: Grounding[] = [{}]

  for (const clause of pattern.clauses) {
    const next: Grounding[] = []
    const candidates = as.getByType(clause.type) // includes subtypes via lattice
    for (const g of groundings) {
      for (const cand of candidates) {
        const merged = unifyLink(as, clause, cand, g)
        if (merged) next.push(merged)
      }
    }
    groundings = next
    if (groundings.length === 0) break
  }

  // Deduplicate groundings
  const seen = new Set<string>()
  groundings = groundings.filter((g) => {
    const key = JSON.stringify(Object.entries(g).sort())
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const variables = pattern.select ?? collectVars(pattern.clauses)
  const results = groundings.map((g) => {
    const row: Record<string, string> = {}
    for (const v of variables) {
      const atom = g[v] ? as.getAtom(g[v]) : undefined
      row[v] = atom ? (atom.name ?? atom.type) : ''
    }
    return row
  })

  return { variables, results, groundings, evaluatedAtSeq: as.logicalClock }
}

function unifyLink(as: AtomSpace, pattern: Extract<PatternTerm, { kind: 'link' }>, atom: Atom, binding: Grounding): Grounding | null {
  if (!as.types.isA(atom.type, pattern.type)) return null
  const out = atom.outgoing ?? []
  if (out.length !== pattern.outgoing.length) return null
  let current: Grounding | null = binding
  for (let i = 0; i < pattern.outgoing.length; i++) {
    current = unifyTerm(as, pattern.outgoing[i], out[i], current)
    if (!current) return null
  }
  return current
}

function unifyTerm(as: AtomSpace, term: PatternTerm, handle: Handle, binding: Grounding): Grounding | null {
  switch (term.kind) {
    case 'var': {
      if (term.name in binding) return binding[term.name] === handle ? binding : null
      if (term.type) {
        const atom = as.getAtom(handle)
        if (!atom || !as.types.isA(atom.type, term.type)) return null
      }
      return { ...binding, [term.name]: handle }
    }
    case 'node':
      return nodeHandle(term.type, term.name) === handle ? binding : null
    case 'link': {
      const atom = as.getAtom(handle)
      if (!atom?.outgoing) return null
      return unifyLink(as, term, atom, binding)
    }
  }
}

function collectVars(clauses: PatternTerm[]): string[] {
  const vars = new Set<string>()
  const walk = (t: PatternTerm) => {
    if (t.kind === 'var') vars.add(t.name)
    else if (t.kind === 'link') t.outgoing.forEach(walk)
  }
  clauses.forEach(walk)
  return Array.from(vars)
}

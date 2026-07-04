/**
 * metta — a MeTTa-style `match` query surface over the AtomSpace (DAS conformance).
 *
 * The Distributed AtomSpace (DAS) query API is MeTTa-integrated; our engine speaks Atomese +
 * a pattern matcher but not MeTTa. This module adds the core DAS query primitive — pattern
 * `match` over the metagraph — using MeTTa S-expression syntax:
 *
 *   (match &self (InheritanceLink $x (ConceptNode Mammal)) $x)
 *
 * A pattern is a link expression whose children are node references, nested link patterns, or
 * $variables. Node vs link is resolved via the type lattice: `(ConceptNode Mammal)` is a NODE
 * reference (type + name); `(InheritanceLink …)` is a LINK (type + outgoing). A bare symbol
 * also matches a node by name. `match` unifies against the space, binds variables, and
 * instantiates the template (default = the pattern) per solution.
 *
 * Classic-OpenCog reading of MeTTa (typed Links/Nodes), matching the AtomSpace the federation
 * materializes — so the super-peer can expose a DAS/MeTTa endpoint over the merged view.
 */

import type { AtomSpace, Atom, Handle } from './atomspace.js'

// ─── S-expression model ─────────────────────────────────────────────────────────────
export type SExpr =
  | { kind: 'sym'; name: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: SExpr[] }

const sym = (name: string): SExpr => ({ kind: 'sym', name })

export function parseSExpr(text: string): SExpr {
  const toks = text.match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  const parse = (): SExpr => {
    const t = toks[i++]
    if (t === undefined) throw new Error('metta: unexpected end of input')
    if (t === '(') {
      const items: SExpr[] = []
      while (toks[i] !== ')') {
        if (i >= toks.length) throw new Error('metta: unbalanced parens')
        items.push(parse())
      }
      i++ // consume ')'
      return { kind: 'list', items }
    }
    if (t === ')') throw new Error('metta: unexpected )')
    return t.startsWith('$') ? { kind: 'var', name: t.slice(1) } : { kind: 'sym', name: t }
  }
  return parse()
}

export function serialize(e: SExpr): string {
  switch (e.kind) {
    case 'sym': return e.name
    case 'var': return '$' + e.name
    case 'list': return '(' + e.items.map(serialize).join(' ') + ')'
  }
}

// ─── Atom ⇄ S-expr ───────────────────────────────────────────────────────────────────
/** Ground an atom to an S-expr: a Node → its name symbol; a Link → (Type child…). */
function atomToSExpr(space: AtomSpace, handle: Handle): SExpr {
  const atom = space.getAtom(handle)
  if (!atom) return sym('?')
  if (atom.outgoing && atom.outgoing.length > 0) {
    return { kind: 'list', items: [sym(atom.type), ...atom.outgoing.map((h) => atomToSExpr(space, h))] }
  }
  return sym(atom.name ?? atom.type)
}

// ─── Unification (pattern ⇄ atom) ─────────────────────────────────────────────────────
export type MettaBinding = Map<string, SExpr>

function bindConsistent(binding: MettaBinding, name: string, value: SExpr): MettaBinding | null {
  const prior = binding.get(name)
  if (prior && serialize(prior) !== serialize(value)) return null // inconsistent binding
  const next = new Map(binding)
  next.set(name, value)
  return next
}

/** Unify a pattern against a concrete atom handle, threading variable bindings. */
function unify(space: AtomSpace, pattern: SExpr, handle: Handle, binding: MettaBinding): MettaBinding | null {
  const atom = space.getAtom(handle)
  if (!atom) return null
  if (pattern.kind === 'var') return bindConsistent(binding, pattern.name, atomToSExpr(space, handle))
  if (pattern.kind === 'sym') {
    // A bare leaf symbol matches a Node by name (or a typeless atom by type).
    return (atom.name ?? atom.type) === pattern.name ? binding : null
  }
  // list → node reference (NodeType Name) or link pattern (LinkType child…), by the lattice.
  const head = pattern.items[0]
  if (!head || head.kind !== 'sym' || atom.type !== head.name) return null
  if (space.types.isNode(head.name)) {
    const nameItem = pattern.items[1]
    if (!nameItem) return atom.name !== undefined ? binding : null
    if (nameItem.kind === 'var') return bindConsistent(binding, nameItem.name, sym(atom.name ?? ''))
    return nameItem.kind === 'sym' && atom.name === nameItem.name ? binding : null
  }
  const children = pattern.items.slice(1)
  const out = atom.outgoing ?? []
  if (out.length !== children.length) return null
  let b: MettaBinding | null = binding
  for (let k = 0; k < children.length && b; k++) b = unify(space, children[k]!, out[k]!, b)
  return b
}

/** Find every binding under which `pattern` (a link expression) matches an atom in the space. */
export function matchPattern(space: AtomSpace, pattern: SExpr): MettaBinding[] {
  if (pattern.kind !== 'list') throw new Error('metta: a match pattern must be a link expression')
  const head = pattern.items[0]
  if (!head || head.kind !== 'sym') throw new Error('metta: pattern head must be a link type symbol')
  const children = pattern.items.slice(1)
  const solutions: MettaBinding[] = []
  for (const candidate of space.getByType(head.name, false) as Atom[]) {
    const out = candidate.outgoing ?? []
    if (out.length !== children.length) continue
    let b: MettaBinding | null = new Map()
    for (let k = 0; k < children.length && b; k++) b = unify(space, children[k]!, out[k]!, b)
    if (b) solutions.push(b)
  }
  return solutions
}

/** Instantiate a template S-expr under a binding (substitute bound variables). */
export function instantiate(template: SExpr, binding: MettaBinding): SExpr {
  switch (template.kind) {
    case 'sym': return template
    case 'var': return binding.get(template.name) ?? template
    case 'list': return { kind: 'list', items: template.items.map((it) => instantiate(it, binding)) }
  }
}

/**
 * Evaluate a MeTTa query. Supports `(match <space-ref> <pattern> [<template>])`; the space-ref
 * (e.g. &self) is ignored (one space). Returns the instantiated templates as MeTTa strings.
 * A bare pattern is treated as `(match &self <pattern> <pattern>)`.
 */
export function runMetta(space: AtomSpace, text: string): string[] {
  const expr = parseSExpr(text)
  if (expr.kind === 'list' && expr.items[0]?.kind === 'sym' && expr.items[0].name === 'match') {
    const pattern = expr.items[2]
    const template = expr.items[3] ?? pattern
    if (!pattern) throw new Error('metta: (match <space> <pattern> [<template>])')
    return matchPattern(space, pattern).map((b) => serialize(instantiate(template, b)))
  }
  return matchPattern(space, expr).map((b) => serialize(instantiate(expr, b)))
}

/** Programmatic variant: bindings as plain records (var → grounded MeTTa string). */
export function matchBindings(space: AtomSpace, patternText: string): Record<string, string>[] {
  return matchPattern(space, parseSExpr(patternText)).map((b) => {
    const rec: Record<string, string> = {}
    for (const [k, v] of b) rec[k] = serialize(v)
    return rec
  })
}

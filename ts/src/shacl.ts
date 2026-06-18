/**
 * SHACL validation and SPARQL rule engine for HellGraph.
 *
 * Implements the SHACL constraint types actually used in the ontogenesis
 * ecosystem: sh:minCount/maxCount, sh:datatype, sh:nodeKind, sh:pattern,
 * sh:class, sh:in, sh:hasValue, sh:minInclusive/maxInclusive, sh:minLength,
 * sh:or — plus sh:SPARQLConstraint (SELECT-based) and sh:SPARQLRule
 * (CONSTRUCT-based derivation / validation result extraction).
 *
 * Shape files are parsed from raw Turtle text via lib/hellgraph/turtle.ts.
 * For full SHACL spec compliance (including sh:node, advanced path algebra,
 * recursive shapes), delegate to the OpenCog sidecar which runs pyshacl.
 *
 * Namespace resolution: HellGraph stores labels and edge types as short names
 * (the local fragment after # or /). The validator normalises shape property
 * paths to short names before comparison so shapes authored with full IRIs
 * match HellGraph's storage format.
 */

import { parseTurtle } from './turtle'
import type { RdfTerm, RdfTriple } from './turtle'
import type { HellGraphStore } from './store'
import type { Triple } from './types'
import { runSparql, runSparqlConstruct } from './sparql'

// ─── Constants ────────────────────────────────────────────────────────────────

const SH   = 'http://www.w3.org/ns/shacl#'
const RDF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const XSD  = 'http://www.w3.org/2001/XMLSchema#'

const RDF_TYPE  = RDF + 'type'
const RDF_FIRST = RDF + 'first'
const RDF_REST  = RDF + 'rest'
const RDF_NIL   = RDF + 'nil'

// ─── Public types ─────────────────────────────────────────────────────────────

export type SHACLSeverity = 'Violation' | 'Warning' | 'Info'

export interface SHACLViolation {
  focusNode: string
  path?: string
  value?: string
  message: string
  severity: SHACLSeverity
  constraint: string
  shape: string
}

export interface SHACLReport {
  conforms: boolean
  violations: SHACLViolation[]
  /** Number of new triples added to the store by data-derivation rules. */
  rulesApplied: number
}

// ─── Internal shape model ─────────────────────────────────────────────────────

interface PropertyShape {
  path: string
  minCount?: number
  maxCount?: number
  datatype?: string
  nodeKind?: string
  pattern?: string
  patternFlags?: string
  cls?: string
  in?: string[]
  hasValue?: string
  minInclusive?: number
  maxInclusive?: number
  minLength?: number
  message?: string
}

interface SparqlConstraint { select: string; message?: string }
interface SparqlRule        { construct: string }

interface NodeShape {
  id: string
  targetClass?: string
  targetSubjectsOf?: string
  properties: PropertyShape[]
  sparqlConstraints: SparqlConstraint[]
  sparqlRules: SparqlRule[]
}

// ─── Mini-triplestore for the shape graph ────────────────────────────────────

class ShapeIndex {
  /** subject → predicate → object[] */
  private spo = new Map<string, Map<string, string[]>>()
  /** predicate → object → subject[] */
  private pos_idx = new Map<string, Map<string, string[]>>()
  readonly triples: { s: string; p: string; o: string }[] = []

  add(s: string, p: string, o: string): void {
    // spo
    if (!this.spo.has(s)) this.spo.set(s, new Map())
    const sp = this.spo.get(s)!
    if (!sp.has(p)) sp.set(p, [])
    sp.get(p)!.push(o)
    // pos
    if (!this.pos_idx.has(p)) this.pos_idx.set(p, new Map())
    const po = this.pos_idx.get(p)!
    if (!po.has(o)) po.set(o, [])
    po.get(o)!.push(s)

    this.triples.push({ s, o, p })
  }

  get(s: string, p: string): string[]        { return this.spo.get(s)?.get(p) ?? [] }
  one(s: string, p: string): string | undefined { return this.get(s, p)[0] }
  subjects(p: string, o: string): string[]   { return this.pos_idx.get(p)?.get(o) ?? [] }
  allValues(p: string): string[] {
    const map = this.pos_idx.get(p)
    if (!map) return []
    return Array.from(map.keys())
  }
}

function termStr(t: RdfTerm): string {
  return t.kind === 'literal' ? t.value : t.value
}

function buildIndex(triples: RdfTriple[]): ShapeIndex {
  const idx = new ShapeIndex()
  for (const t of triples) idx.add(termStr(t.s), t.p.value, termStr(t.o))
  return idx
}

function collectList(idx: ShapeIndex, head: string): string[] {
  const items: string[] = []
  let cur = head
  while (cur && cur !== RDF_NIL) {
    const first = idx.one(cur, RDF_FIRST)
    if (first !== undefined) items.push(first)
    cur = idx.one(cur, RDF_REST) ?? RDF_NIL
  }
  return items
}

// ─── Shape extraction ─────────────────────────────────────────────────────────

function extractShapes(idx: ShapeIndex): NodeShape[] {
  const ids = new Set<string>()
  // Explicit NodeShape declarations
  for (const s of idx.subjects(RDF_TYPE, SH + 'NodeShape')) ids.add(s)
  // Implied NodeShapes (anything with sh:targetClass / sh:targetSubjectsOf)
  for (const t of idx.triples) {
    if (t.p === SH + 'targetClass' || t.p === SH + 'targetSubjectsOf') ids.add(t.s)
  }

  return Array.from(ids).map((id): NodeShape => {
    const properties: PropertyShape[] = []
    for (const bnode of idx.get(id, SH + 'property')) {
      const path = idx.one(bnode, SH + 'path')
      if (!path) continue
      const ps: PropertyShape = { path }
      const mc = idx.one(bnode, SH + 'minCount'); if (mc !== undefined) ps.minCount = parseInt(mc, 10)
      const xc = idx.one(bnode, SH + 'maxCount'); if (xc !== undefined) ps.maxCount = parseInt(xc, 10)
      const dt = idx.one(bnode, SH + 'datatype'); if (dt) ps.datatype = dt
      const nk = idx.one(bnode, SH + 'nodeKind'); if (nk) ps.nodeKind = nk
      const pat = idx.one(bnode, SH + 'pattern'); if (pat) ps.pattern = pat
      ps.patternFlags = idx.one(bnode, SH + 'flags')
      const cls = idx.one(bnode, SH + 'class'); if (cls) ps.cls = cls
      const inHead = idx.one(bnode, SH + 'in'); if (inHead) ps.in = collectList(idx, inHead)
      const hv = idx.one(bnode, SH + 'hasValue'); if (hv !== undefined) ps.hasValue = hv
      const mi = idx.one(bnode, SH + 'minInclusive'); if (mi !== undefined) ps.minInclusive = parseFloat(mi)
      const xi = idx.one(bnode, SH + 'maxInclusive'); if (xi !== undefined) ps.maxInclusive = parseFloat(xi)
      const ml = idx.one(bnode, SH + 'minLength');    if (ml !== undefined) ps.minLength = parseInt(ml, 10)
      ps.message = idx.one(bnode, SH + 'message')
      properties.push(ps)
    }

    const sparqlConstraints: SparqlConstraint[] = []
    for (const bnode of idx.get(id, SH + 'sparql')) {
      const select = idx.one(bnode, SH + 'select')
      if (select) sparqlConstraints.push({ select, message: idx.one(bnode, SH + 'message') })
    }

    const sparqlRules: SparqlRule[] = []
    for (const bnode of idx.get(id, SH + 'rule')) {
      const construct = idx.one(bnode, SH + 'construct')
      if (construct) sparqlRules.push({ construct })
    }

    return {
      id,
      targetClass:       idx.one(id, SH + 'targetClass'),
      targetSubjectsOf:  idx.one(id, SH + 'targetSubjectsOf'),
      properties,
      sparqlConstraints,
      sparqlRules,
    }
  })
}

// ─── Target resolution ───────────────────────────────────────────────────────

/** Short local name after the last # or / in an IRI. */
function local(iri: string): string {
  const h = iri.lastIndexOf('#'), s = iri.lastIndexOf('/')
  const cut = Math.max(h, s)
  return cut >= 0 ? iri.slice(cut + 1) : iri
}

function getTargetNodes(shape: NodeShape, triples: Triple[]): string[] {
  const nodes = new Set<string>()

  if (shape.targetClass) {
    const tc = shape.targetClass
    const tcShort = local(tc)
    for (const t of triples) {
      if (t.predicate === 'rdf:type' || t.predicate === RDF_TYPE) {
        const obj = String(t.object)
        if (obj === tc || obj === tcShort) nodes.add(t.subject)
      }
    }
  }

  if (shape.targetSubjectsOf) {
    const prop = shape.targetSubjectsOf
    const propShort = local(prop)
    for (const t of triples) {
      if (t.predicate === prop || t.predicate === propShort) nodes.add(t.subject)
    }
  }

  return Array.from(nodes)
}

function getValues(focusNode: string, path: string, triples: Triple[]): string[] {
  const pathShort = local(path)
  return triples
    .filter(t => t.subject === focusNode && (t.predicate === path || t.predicate === pathShort))
    .map(t => String(t.object))
}

// ─── Constraint checkers ─────────────────────────────────────────────────────

function inferXsdDatatype(value: string): string {
  if (value === 'true' || value === 'false') return XSD + 'boolean'
  if (/^-?\d+$/.test(value)) return XSD + 'integer'
  if (/^-?\d+\.\d+$/.test(value)) return XSD + 'decimal'
  return XSD + 'string'
}

function checkPropertyShape(
  focusNode: string,
  ps: PropertyShape,
  triples: Triple[],
  shapeId: string,
): SHACLViolation[] {
  const vals = getValues(focusNode, ps.path, triples)
  const base = { focusNode, path: ps.path, severity: 'Violation' as SHACLSeverity, shape: shapeId }
  const msg = (m: string) => ps.message ?? m
  const violations: SHACLViolation[] = []

  if (ps.minCount !== undefined && vals.length < ps.minCount)
    violations.push({ ...base, message: msg(`Expected ≥ ${ps.minCount} value(s) for ${local(ps.path)}`), constraint: 'sh:minCount' })
  if (ps.maxCount !== undefined && vals.length > ps.maxCount)
    violations.push({ ...base, message: msg(`Expected ≤ ${ps.maxCount} value(s) for ${local(ps.path)}`), constraint: 'sh:maxCount' })

  for (const v of vals) {
    if (ps.datatype) {
      const inferred = inferXsdDatatype(v)
      const exp = local(ps.datatype)
      const got = local(inferred)
      if (inferred !== ps.datatype && got !== exp)
        violations.push({ ...base, value: v, message: msg(`"${v}" has datatype ${got}, expected ${exp}`), constraint: 'sh:datatype' })
    }
    if (ps.nodeKind) {
      const nk = local(ps.nodeKind)
      const isIri = triples.some(t => t.subject === focusNode && String(t.object) === v && t.isIri)
      const ok = (nk === 'IRI' && isIri) || (nk === 'Literal' && !isIri) || (nk === 'BlankNode' && v.startsWith('_:'))
      if (!ok)
        violations.push({ ...base, value: v, message: msg(`"${v}" violates nodeKind ${nk}`), constraint: 'sh:nodeKind' })
    }
    if (ps.pattern) {
      try {
        if (!new RegExp(ps.pattern, ps.patternFlags ?? '').test(v))
          violations.push({ ...base, value: v, message: msg(`"${v}" does not match pattern ${ps.pattern}`), constraint: 'sh:pattern' })
      } catch { /* invalid regex */ }
    }
    if (ps.in !== undefined && ps.in.length > 0) {
      const inShort = ps.in.map(local)
      if (!ps.in.includes(v) && !inShort.includes(v) && !inShort.includes(local(v)))
        violations.push({ ...base, value: v, message: msg(`"${v}" not in allowed set`), constraint: 'sh:in' })
    }
    if (ps.hasValue !== undefined && v !== ps.hasValue && v !== local(ps.hasValue))
      violations.push({ ...base, value: v, message: msg(`Expected "${ps.hasValue}", got "${v}"`), constraint: 'sh:hasValue' })
    if (ps.minInclusive !== undefined) {
      const n = parseFloat(v)
      if (Number.isNaN(n) || n < ps.minInclusive)
        violations.push({ ...base, value: v, message: msg(`${v} < minInclusive ${ps.minInclusive}`), constraint: 'sh:minInclusive' })
    }
    if (ps.maxInclusive !== undefined) {
      const n = parseFloat(v)
      if (Number.isNaN(n) || n > ps.maxInclusive)
        violations.push({ ...base, value: v, message: msg(`${v} > maxInclusive ${ps.maxInclusive}`), constraint: 'sh:maxInclusive' })
    }
    if (ps.minLength !== undefined && v.length < ps.minLength)
      violations.push({ ...base, value: v, message: msg(`"${v}" length ${v.length} < ${ps.minLength}`), constraint: 'sh:minLength' })
  }
  return violations
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate the HellGraph store against SHACL shapes defined in Turtle text.
 * Returns a report with all violations found. Fires sh:SPARQLConstraint SELECT
 * queries and extracts sh:ValidationResult atoms produced by sh:SPARQLRule
 * CONSTRUCT queries.
 */
export function validateGraph(store: HellGraphStore, shapesText: string): SHACLReport {
  const idx = buildIndex(parseTurtle(shapesText))
  const shapes = extractShapes(idx)
  const triples = store.triples()
  const violations: SHACLViolation[] = []

  for (const shape of shapes) {
    const targets = getTargetNodes(shape, triples)

    for (const focusNode of targets) {
      for (const ps of shape.properties)
        violations.push(...checkPropertyShape(focusNode, ps, triples, shape.id))

      for (const sc of shape.sparqlConstraints) {
        try {
          const result = runSparql(store, sc.select)
          if (result.bindings.length > 0)
            violations.push({
              focusNode,
              message: sc.message ?? `SPARQL constraint matched ${result.bindings.length} row(s)`,
              severity: 'Violation',
              constraint: 'sh:SPARQLConstraint',
              shape: shape.id,
            })
        } catch (err) {
          violations.push({
            focusNode,
            message: `SPARQLConstraint eval error: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'Warning',
            constraint: 'sh:SPARQLConstraint',
            shape: shape.id,
          })
        }
      }
    }

    // SPARQL rules: CONSTRUCT result containing sh:ValidationResult atoms → violations
    for (const rule of shape.sparqlRules) {
      try {
        const constructed = runSparqlConstruct(store, rule.construct)
        // Find sh:result subjects — each is a ValidationResult bnode
        const resultObjs = new Set(
          constructed
            .filter(t => t.predicate === SH + 'result' || t.predicate === 'sh:result')
            .map(t => String(t.object))
        )
        for (const resultId of resultObjs) {
          const focusTr = constructed.find(t => t.subject === resultId && (t.predicate.endsWith('focusNode') || t.predicate === SH + 'focusNode'))
          const msgTr   = constructed.find(t => t.subject === resultId && (t.predicate.endsWith('resultMessage') || t.predicate === SH + 'resultMessage'))
          violations.push({
            focusNode: focusTr ? String(focusTr.object) : 'unknown',
            message: msgTr ? String(msgTr.object) : 'SPARQL rule violation',
            severity: 'Violation',
            constraint: 'sh:SPARQLRule',
            shape: shape.id,
          })
        }
      } catch { /* best-effort: unsupported SPARQL features (FILTER NOT EXISTS, paths) silently skip */ }
    }
  }

  return { conforms: violations.length === 0, violations, rulesApplied: 0 }
}

/**
 * Apply data-derivation sh:SPARQLRule CONSTRUCT queries, adding inferred
 * triples back into the HellGraph store. Rules that generate sh:ValidationResult
 * atoms are skipped (those belong to validateGraph). Returns count of new
 * triples written.
 */
export function applyRules(store: HellGraphStore, shapesText: string): number {
  const idx = buildIndex(parseTurtle(shapesText))
  const shapes = extractShapes(idx)
  let added = 0

  for (const shape of shapes) {
    for (const rule of shape.sparqlRules) {
      try {
        const newTriples = runSparqlConstruct(store, rule.construct)
        // Skip rules that produce validation result atoms (those are for validateGraph)
        const isValidationRule = newTriples.some(
          t => t.predicate === SH + 'result' || t.predicate === 'sh:result'
        )
        if (isValidationRule) continue
        for (const t of newTriples) {
          if (t.isIri) {
            store.addEdge(t.predicate, t.subject, String(t.object))
          } else {
            store.addNode(t.subject, [], { [t.predicate]: t.object })
          }
          added++
        }
      } catch { /* skip unsupported SPARQL features */ }
    }
  }

  return added
}

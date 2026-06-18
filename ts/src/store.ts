import { AtomSpace, getAtomSpace, nodeHandle, type Atom, type Handle, type Value } from './atomspace'
import type { GraphNode, GraphEdge, Triple, LogEntry, PropertyValue } from './types'

/**
 * HellGraphStore — a binary labeled-property-graph façade over the canonical
 * AtomSpace metagraph (atomspace.ts). It does NOT hold independent state: every
 * node/edge is projected from atoms, so there is exactly one source of truth.
 *
 * Encoding (the standard RDF/property-graph-in-AtomSpace form):
 *   - GraphNode(id, labels, properties)
 *       → ConceptNode(name = id)
 *         labels stored as a string Value "graph:labels"
 *         each property stored as a Value "prop:<key>"
 *   - GraphEdge(label, from, to, properties)
 *       → EvaluationLink( PredicateNode(label),
 *                         ListLink( ConceptNode(from), ConceptNode(to) ) )
 *         edge properties stored as Values on the EvaluationLink
 *
 * Higher-arity hyperedges and Link-over-Link metagraph structure live natively
 * in the AtomSpace and are reached through that API or the pattern matcher; this
 * façade exposes only the binary projection the SPARQL/Gremlin engines consume.
 */

const ENTITY = 'ConceptNode'
const PRED = 'PredicateNode'
const LABELS_KEY = 'graph:labels'
const PROP_PREFIX = 'prop:'

function encodeValue(v: PropertyValue): Value | null {
  if (v === null) return null
  if (typeof v === 'number') return { kind: 'float', value: [v] }
  if (typeof v === 'boolean') return { kind: 'string', value: [v ? 'true' : 'false'] }
  return { kind: 'string', value: [v] }
}

function decodeValue(val: Value | undefined): PropertyValue {
  if (!val) return null
  if (val.kind === 'float') return val.value[0] ?? null
  const s = val.value[0] ?? ''
  if (s === 'true') return true
  if (s === 'false') return false
  return String(s)
}

export class HellGraphStore {
  constructor(private as: AtomSpace) {}

  // ─── Projection helpers ─────────────────────────────────────────────────

  private projectNode(atom: Atom): GraphNode {
    const labelsVal = atom.values[LABELS_KEY]
    const labels = labelsVal?.kind === 'string' ? labelsVal.value : []
    const properties: Record<string, PropertyValue> = {}
    for (const [k, v] of Object.entries(atom.values)) {
      if (k.startsWith(PROP_PREFIX)) properties[k.slice(PROP_PREFIX.length)] = decodeValue(v)
    }
    return { id: atom.name ?? atom.handle, labels, properties, createdAt: atom.createdAt }
  }

  private projectEdge(evalAtom: Atom): GraphEdge | null {
    const [predH, listH] = evalAtom.outgoing ?? []
    const pred = predH ? this.as.getAtom(predH) : undefined
    const list = listH ? this.as.getAtom(listH) : undefined
    const [fromH, toH] = list?.outgoing ?? []
    const from = fromH ? this.as.getAtom(fromH) : undefined
    const to = toH ? this.as.getAtom(toH) : undefined
    if (!pred?.name || !from?.name || !to?.name) return null
    const properties: Record<string, PropertyValue> = {}
    for (const [k, v] of Object.entries(evalAtom.values)) {
      if (k.startsWith(PROP_PREFIX)) properties[k.slice(PROP_PREFIX.length)] = decodeValue(v)
    }
    return { id: evalAtom.handle, label: pred.name, from: from.name, to: to.name, properties, createdAt: evalAtom.createdAt }
  }

  // ─── Write path ───────────────────────────────────────────────────────────

  addNode(id: string, labels: string[], properties: Record<string, PropertyValue> = {}): GraphNode {
    const atom = this.as.addNode(ENTITY, id)
    const existing = atom.values[LABELS_KEY]
    const existingLabels = existing?.kind === 'string' ? existing.value : []
    const merged = Array.from(new Set([...existingLabels, ...labels]))
    this.as.setValue(atom.handle, LABELS_KEY, { kind: 'string', value: merged })
    for (const [k, v] of Object.entries(properties)) {
      const enc = encodeValue(v)
      if (enc) this.as.setValue(atom.handle, PROP_PREFIX + k, enc)
    }
    return this.projectNode(this.as.getAtom(atom.handle)!)
  }

  addEdge(label: string, from: string, to: string, properties: Record<string, PropertyValue> = {}): GraphEdge {
    const fromA = this.as.addNode(ENTITY, from)
    const toA = this.as.addNode(ENTITY, to)
    const predA = this.as.addNode(PRED, label)
    const listA = this.as.addLink('ListLink', [fromA.handle, toA.handle])
    const evalA = this.as.addLink('EvaluationLink', [predA.handle, listA.handle])
    for (const [k, v] of Object.entries(properties)) {
      const enc = encodeValue(v)
      if (enc) this.as.setValue(evalA.handle, PROP_PREFIX + k, enc)
    }
    return this.projectEdge(this.as.getAtom(evalA.handle)!)!
  }

  setNodeProperty(id: string, key: string, value: PropertyValue): void {
    const enc = encodeValue(value)
    if (enc) this.as.setValue(nodeHandle(ENTITY, id), PROP_PREFIX + key, enc)
  }

  // ─── Read path ────────────────────────────────────────────────────────────

  getNode(id: string): GraphNode | undefined {
    const atom = this.as.getNode(ENTITY, id)
    return atom ? this.projectNode(atom) : undefined
  }

  allNodes(): GraphNode[] {
    return this.as.getByType(ENTITY, false).map((a) => this.projectNode(a))
  }

  allEdges(): GraphEdge[] {
    return this.as.getByType('EvaluationLink', false)
      .map((a) => this.projectEdge(a))
      .filter((e): e is GraphEdge => Boolean(e))
  }

  nodesByLabel(label: string): GraphNode[] {
    return this.allNodes().filter((n) => n.labels.includes(label))
  }

  outEdges(nodeId: string, label?: string): GraphEdge[] {
    const conceptH = nodeHandle(ENTITY, nodeId)
    return this.adjacentEdges(conceptH, 0, label)
  }

  inEdges(nodeId: string, label?: string): GraphEdge[] {
    const conceptH = nodeHandle(ENTITY, nodeId)
    return this.adjacentEdges(conceptH, 1, label)
  }

  out(nodeId: string, label?: string): GraphNode[] {
    return this.outEdges(nodeId, label)
      .map((e) => this.getNode(e.to))
      .filter((n): n is GraphNode => Boolean(n))
  }

  in(nodeId: string, label?: string): GraphNode[] {
    return this.inEdges(nodeId, label)
      .map((e) => this.getNode(e.from))
      .filter((n): n is GraphNode => Boolean(n))
  }

  /** Edges where conceptH sits at outgoing position `pos` (0 = subject, 1 = object) of the ListLink. */
  private adjacentEdges(conceptH: Handle, pos: 0 | 1, label?: string): GraphEdge[] {
    const out: GraphEdge[] = []
    for (const listLink of this.as.getIncoming(conceptH, 'ListLink')) {
      if (listLink.outgoing?.[pos] !== conceptH) continue
      for (const evalLink of this.as.getIncoming(listLink.handle, 'EvaluationLink')) {
        const edge = this.projectEdge(evalLink)
        if (edge && (!label || edge.label === label)) out.push(edge)
      }
    }
    return out
  }

  // ─── RDF triple projection ──────────────────────────────────────────────────

  triples(): Triple[] {
    const out: Triple[] = []
    for (const atom of this.as.getByType(ENTITY, false)) {
      const node = this.projectNode(atom)
      for (const label of node.labels) {
        out.push({ subject: node.id, predicate: 'rdf:type', object: label, isIri: false, assertedAt: atom.createdAt })
      }
      for (const [k, v] of Object.entries(node.properties)) {
        out.push({ subject: node.id, predicate: k, object: v, isIri: false, assertedAt: atom.createdAt })
      }
    }
    for (const edge of this.allEdges()) {
      out.push({ subject: edge.from, predicate: edge.label, object: edge.to, isIri: true, assertedAt: edge.createdAt })
    }
    return out
  }

  // ─── Stats / health ──────────────────────────────────────────────────────────

  get logicalClock(): number { return this.as.logicalClock }
  get id(): string { return this.as.id }
  nodeCount(): number { return this.as.getByType(ENTITY, false).length }
  edgeCount(): number { return this.as.getByType('EvaluationLink', false).length }

  orphanNodeCount(): number {
    let n = 0
    for (const atom of this.as.getByType(ENTITY, false)) {
      const inAnyList = this.as.getIncoming(atom.handle, 'ListLink').length > 0
      if (!inAnyList) n++
    }
    return n
  }

  danglingEdgeCount(): number { return this.as.danglingLinkCount() }

  logTail(n = 20): LogEntry[] {
    return this.as.logTail(n).map((e) => ({ seq: e.seq, ts: e.ts, op: e.op, payload: e.payload }))
  }

  earliestTs(): string | undefined { return this.as.earliestTs() }
  latestTs(): string | undefined { return this.as.latestTs() }

  /** Escape hatch to the underlying metagraph for hypergraph-native operations. */
  atomspace(): AtomSpace { return this.as }
}

// ─── Process-level singleton (façade over the shared AtomSpace) ────────────────

declare global {
  // eslint-disable-next-line no-var
  var __hellgraph_store__: HellGraphStore | undefined
}

export function getHellGraph(): HellGraphStore {
  if (!globalThis.__hellgraph_store__) {
    globalThis.__hellgraph_store__ = new HellGraphStore(getAtomSpace())
  }
  return globalThis.__hellgraph_store__
}

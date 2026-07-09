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

/** A node write in a transaction batch. */
export interface TxNode { id: string; labels: string[]; properties?: Record<string, PropertyValue> }
/** An edge write in a transaction batch. */
export interface TxEdge { label: string; from: string; to: string; properties?: Record<string, PropertyValue> }
/** An atomic (all-or-none) batch of graph writes. */
export interface TxBatch { nodes?: TxNode[]; edges?: TxEdge[] }

export class HellGraphStore {
  constructor(private as: AtomSpace) {}

  /** Registered uniqueness constraints: label → set of property keys that must be unique among
   *  nodes carrying that label. Opt-in (nothing enforced until addUniqueConstraint is called), so
   *  existing callers are unaffected. */
  private readonly uniqueConstraints = new Map<string, Set<string>>()

  /** Declare that `propKey` must be unique among nodes labelled `label` (Neo4j-style constraint).
   *  Enforced at write time by addNode/setNodeProperty via the secondary value index. */
  addUniqueConstraint(label: string, propKey: string): void {
    let keys = this.uniqueConstraints.get(label)
    if (!keys) { keys = new Set(); this.uniqueConstraints.set(label, keys) }
    keys.add(propKey)
  }

  /** Throw if writing `properties` onto node `id` (with effective `labels`) would break a
   *  uniqueness constraint. Runs BEFORE any write so a violation can't leave a partial node. */
  private assertUniqueOk(id: string, labels: string[], properties: Record<string, PropertyValue>): void {
    for (const label of labels) {
      const keys = this.uniqueConstraints.get(label)
      if (!keys) continue
      for (const k of keys) {
        const v = properties[k]
        if (v === undefined) continue
        const clash = this.nodesByProperty(k, v).find((n) => n.id !== id && n.labels.includes(label))
        if (clash) throw new Error(`uniqueness constraint (${label}.${k}) violated: value already held by node "${clash.id}"`)
      }
    }
  }

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
    // Compute effective labels from a READ-ONLY lookup and validate constraints BEFORE any write,
    // so a uniqueness violation throws without having created a partial node.
    const priorAtom = this.as.getNode(ENTITY, id)
    const prior = priorAtom?.values[LABELS_KEY]
    const existingLabels = prior?.kind === 'string' ? prior.value : []
    const merged = Array.from(new Set([...existingLabels, ...labels]))
    this.assertUniqueOk(id, merged, properties)
    const atom = this.as.addNode(ENTITY, id)
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
    this.assertUniqueOk(id, this.getNode(id)?.labels ?? [], { [key]: value })
    const enc = encodeValue(value)
    if (enc) this.as.setValue(nodeHandle(ENTITY, id), PROP_PREFIX + key, enc)
  }

  /**
   * Apply a batch of node/edge writes atomically (all-or-none). The WHOLE batch is validated first
   * — uniqueness constraints against the store AND intra-batch conflicts (two batch nodes claiming
   * the same unique value) — and only if every check passes are the writes applied. On any
   * violation nothing is written. Honest atomicity for an append-only store: validate-then-apply
   * (no post-commit rollback; the single-writer AtomSpace gives isolation within one writer).
   */
  transaction(batch: TxBatch): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = batch.nodes ?? []
    const edges = batch.edges ?? []
    // Phase 1 — validate everything, writing nothing.
    const claimed = new Map<string, string>() // `label\0key\0encoded` → nodeId
    for (const spec of nodes) {
      const prior = this.as.getNode(ENTITY, spec.id)?.values[LABELS_KEY]
      const priorLabels = prior?.kind === 'string' ? prior.value : []
      const merged = Array.from(new Set([...priorLabels, ...spec.labels]))
      this.assertUniqueOk(spec.id, merged, spec.properties ?? {})
      for (const label of merged) {
        const keys = this.uniqueConstraints.get(label)
        if (!keys) continue
        for (const k of keys) {
          const v = spec.properties?.[k]
          if (v === undefined) continue
          const enc = encodeValue(v)
          if (!enc) continue
          const ck = `${label} ${k} ${JSON.stringify(enc)}`
          const other = claimed.get(ck)
          if (other !== undefined && other !== spec.id) {
            throw new Error(`batch uniqueness conflict (${label}.${k}): "${spec.id}" and "${other}" claim the same value`)
          }
          claimed.set(ck, spec.id)
        }
      }
    }
    // Phase 2 — apply (validation guarantees these won't throw on constraints).
    return {
      nodes: nodes.map((s) => this.addNode(s.id, s.labels, s.properties ?? {})),
      edges: edges.map((s) => this.addEdge(s.label, s.from, s.to, s.properties ?? {})),
    }
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

  /** Nodes whose property `key` equals `value` — O(1) via the AtomSpace secondary value index,
   *  instead of the O(n) scan `nodesByLabel` does. Returns [] for unencodable values. */
  nodesByProperty(key: string, value: PropertyValue): GraphNode[] {
    const enc = encodeValue(value)
    if (!enc) return []
    return this.as.findByValue(PROP_PREFIX + key, enc)
      .filter((a) => a.type === ENTITY)
      .map((a) => this.projectNode(a))
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

import type { HellGraphStore } from './store'
import type { GraphNode, GraphEdge, GremlinResult, PropertyValue } from './types'

/**
 * A Gremlin/TinkerPop-style traversal engine over HellGraph's property graph.
 *
 * Provides a fluent traversal API (g.V().hasLabel().out().values()…) and a
 * textual parser so the same steps can be issued as a string through the query
 * endpoint, giving Neptune/TinkerPop parity on the property-graph surface.
 *
 * Supported steps: V, E, hasLabel, has(key,value), out, in, both, outE, inE,
 * values, valueMap, count, dedup, limit, order (asc/desc by property).
 */

type Traverser = GraphNode | GraphEdge | PropertyValue

export class GraphTraversal {
  private current: Traverser[]
  constructor(private store: HellGraphStore, initial: Traverser[]) {
    this.current = initial
  }

  static g(store: HellGraphStore): GraphSource { return new GraphSource(store) }

  // ─── Vertex/edge navigation ──────────────────────────────────────────────

  hasLabel(label: string): GraphTraversal {
    return this.derive(this.nodes().filter((n) => n.labels.includes(label)))
  }

  has(key: string, value: PropertyValue): GraphTraversal {
    return this.derive(this.nodes().filter((n) => looseEq(n.properties[key], value)))
  }

  out(label?: string): GraphTraversal {
    return this.derive(this.nodes().flatMap((n) => this.store.out(n.id, label)))
  }

  in(label?: string): GraphTraversal {
    return this.derive(this.nodes().flatMap((n) => this.store.in(n.id, label)))
  }

  both(label?: string): GraphTraversal {
    return this.derive(this.nodes().flatMap((n) => [...this.store.out(n.id, label), ...this.store.in(n.id, label)]))
  }

  outE(label?: string): GraphTraversal {
    return this.derive(this.nodes().flatMap((n) => this.store.outEdges(n.id, label)))
  }

  inE(label?: string): GraphTraversal {
    return this.derive(this.nodes().flatMap((n) => this.store.inEdges(n.id, label)))
  }

  // ─── Terminal-ish steps ──────────────────────────────────────────────────

  values(key: string): GraphTraversal {
    const out = this.current.map((t) => (isNode(t) || isEdge(t)) ? t.properties[key] : t).filter((v) => v !== undefined)
    return this.derive(out as Traverser[])
  }

  valueMap(): GraphTraversal {
    const out = this.current.filter((t): t is GraphNode | GraphEdge => isNode(t) || isEdge(t)).map((t) => t.properties)
    return this.derive(out as unknown as Traverser[])
  }

  dedup(): GraphTraversal {
    const seen = new Set<string>()
    const out = this.current.filter((t) => {
      const key = isNode(t) || isEdge(t) ? t.id : JSON.stringify(t)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return this.derive(out)
  }

  order(key: string, desc = false): GraphTraversal {
    const sorted = [...this.current].sort((a, b) => {
      const av = isNode(a) || isEdge(a) ? a.properties[key] : a
      const bv = isNode(b) || isEdge(b) ? b.properties[key] : b
      const an = Number(av), bn = Number(bv)
      const cmp = !Number.isNaN(an) && !Number.isNaN(bn) ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''))
      return desc ? -cmp : cmp
    })
    return this.derive(sorted)
  }

  limit(n: number): GraphTraversal { return this.derive(this.current.slice(0, n)) }

  count(): number { return this.current.length }

  toList(): Traverser[] { return this.current }

  result(): GremlinResult {
    return { values: this.current as GremlinResult['values'], count: this.current.length }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private nodes(): GraphNode[] { return this.current.filter(isNode) }
  private derive(next: Traverser[]): GraphTraversal { return new GraphTraversal(this.store, next) }
}

export class GraphSource {
  constructor(private store: HellGraphStore) {}
  V(): GraphTraversal { return new GraphTraversal(this.store, this.store.allNodes()) }
  E(): GraphTraversal { return new GraphTraversal(this.store, this.store.allEdges()) }
}

function isNode(t: Traverser): t is GraphNode {
  return typeof t === 'object' && t !== null && 'labels' in t
}
function isEdge(t: Traverser): t is GraphEdge {
  return typeof t === 'object' && t !== null && 'from' in t && 'to' in t
}
function looseEq(a: PropertyValue | undefined, b: PropertyValue): boolean {
  return a === b || String(a) === String(b)
}

// ─── Textual query parser ────────────────────────────────────────────────────

/**
 * Parse and run a textual Gremlin traversal such as:
 *   g.V().hasLabel('Interaction').out('PRODUCED').values('content').limit(5)
 */
export function runGremlin(store: HellGraphStore, query: string): GremlinResult {
  const steps = parseSteps(query)
  if (steps.length === 0 || (steps[0].name !== 'V' && steps[0].name !== 'E')) {
    throw new Error("Gremlin parse error: traversal must start with g.V() or g.E()")
  }

  const source = GraphTraversal.g(store)
  let t: GraphTraversal = steps[0].name === 'V' ? source.V() : source.E()
  let terminalCount: number | null = null

  for (const step of steps.slice(1)) {
    const [a, b] = step.args
    switch (step.name) {
      case 'hasLabel': t = t.hasLabel(str(a)); break
      case 'has': t = t.has(str(a), coerce(b)); break
      case 'out': t = t.out(a !== undefined ? str(a) : undefined); break
      case 'in': t = t.in(a !== undefined ? str(a) : undefined); break
      case 'both': t = t.both(a !== undefined ? str(a) : undefined); break
      case 'outE': t = t.outE(a !== undefined ? str(a) : undefined); break
      case 'inE': t = t.inE(a !== undefined ? str(a) : undefined); break
      case 'values': t = t.values(str(a)); break
      case 'valueMap': t = t.valueMap(); break
      case 'dedup': t = t.dedup(); break
      case 'order': t = t.order(str(a), b !== undefined && str(b).toLowerCase() === 'desc'); break
      case 'limit': t = t.limit(Number(a)); break
      case 'count': terminalCount = t.count(); break
      default: throw new Error(`Gremlin parse error: unknown step '${step.name}'`)
    }
  }

  if (terminalCount !== null) return { values: [terminalCount], count: 1 }
  return t.result()
}

interface Step { name: string; args: (string | number)[] }

function parseSteps(query: string): Step[] {
  const trimmed = query.trim().replace(/^g\./, '')
  const steps: Step[] = []
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) {
    const name = m[1]
    const argStr = m[2].trim()
    const args = argStr === '' ? [] : splitArgs(argStr).map(parseArg)
    steps.push({ name, args })
  }
  return steps
}

function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inStr: string | null = null
  for (const ch of s) {
    if (inStr) {
      if (ch === inStr) inStr = null
      else cur += ch
    } else if (ch === '"' || ch === "'") inStr = ch
    else if (ch === ',') { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parseArg(a: string): string | number {
  const num = Number(a)
  return !Number.isNaN(num) && a !== '' ? num : a
}

function str(v: string | number | undefined): string { return String(v ?? '') }
function coerce(v: string | number | undefined): PropertyValue {
  if (v === undefined) return null
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

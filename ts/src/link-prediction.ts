/**
 * link-prediction — classic neighbourhood link-prediction / node-similarity scores (Neo4j GDS
 * parity): common-neighbours, Jaccard, Adamic-Adar, resource-allocation, preferential-attachment,
 * plus predictLinks() to rank the most likely missing edges from a node. Undirected neighbourhoods;
 * deterministic. Pure over the store's node/edge projection.
 */
import type { HellGraphStore } from './store.js'
import type { Scored } from './retrieval.js'

/** Undirected neighbour set per node id. */
export function neighborhoods(store: HellGraphStore): Map<string, Set<string>> {
  const nb = new Map<string, Set<string>>()
  for (const n of store.allNodes()) nb.set(n.id, new Set())
  for (const e of store.allEdges()) {
    if (e.from === e.to) continue
    nb.get(e.from)?.add(e.to)
    nb.get(e.to)?.add(e.from)
  }
  return nb
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  const out: string[] = []
  for (const x of small) if (big.has(x)) out.push(x)
  return out
}

/** |Nₐ ∩ N_b| — number of shared neighbours. */
export function commonNeighbors(a: Set<string>, b: Set<string>): number {
  return intersect(a, b).length
}

/** |Nₐ ∩ N_b| / |Nₐ ∪ N_b| ∈ [0,1]. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const inter = intersect(a, b).length
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

/** Σ_{z ∈ Nₐ∩N_b} 1/log|N_z| — rare shared neighbours weigh more. */
export function adamicAdar(a: Set<string>, b: Set<string>, all: Map<string, Set<string>>): number {
  let s = 0
  for (const z of intersect(a, b)) {
    const dz = all.get(z)?.size ?? 0
    if (dz > 1) s += 1 / Math.log(dz)
  }
  return s
}

/** Σ_{z ∈ Nₐ∩N_b} 1/|N_z|. */
export function resourceAllocation(a: Set<string>, b: Set<string>, all: Map<string, Set<string>>): number {
  let s = 0
  for (const z of intersect(a, b)) {
    const dz = all.get(z)?.size ?? 0
    if (dz > 0) s += 1 / dz
  }
  return s
}

/** |Nₐ| · |N_b| — hubs pair up. */
export function preferentialAttachment(a: Set<string>, b: Set<string>): number {
  return a.size * b.size
}

export interface PredictLinksOptions {
  /** How many predictions to return (default 10). */
  topK?: number
  /** Scoring metric (default 'adamicAdar'). */
  metric?: 'adamicAdar' | 'commonNeighbors' | 'jaccard' | 'resourceAllocation' | 'preferentialAttachment'
}

/** Rank the most likely missing edges from `node`: score every non-neighbour candidate and return
 *  the top-K (descending; id tie-break). Excludes the node itself and its existing neighbours. */
export function predictLinks(store: HellGraphStore, node: string, opts: PredictLinksOptions = {}): Scored[] {
  const all = neighborhoods(store)
  const na = all.get(node)
  if (!na) return []
  const metric = opts.metric ?? 'adamicAdar'
  const score = (nb: Set<string>): number => {
    switch (metric) {
      case 'commonNeighbors': return commonNeighbors(na, nb)
      case 'jaccard': return jaccardSimilarity(na, nb)
      case 'resourceAllocation': return resourceAllocation(na, nb, all)
      case 'preferentialAttachment': return preferentialAttachment(na, nb)
      default: return adamicAdar(na, nb, all)
    }
  }
  const results: Scored[] = []
  for (const [id, nb] of all) {
    if (id === node || na.has(id)) continue
    const sc = score(nb)
    if (sc > 0) results.push({ id, score: sc })
  }
  return results
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, Math.max(0, opts.topK ?? 10))
}

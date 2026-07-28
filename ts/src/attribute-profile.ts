/**
 * Attribute profiling + new-attribute recommendation — the "Statistical Analysis & Indexing of
 * Attributes" and "Attribute Ranking" stages of corpus-driven KG enrichment, over the HellGraph store.
 *
 * `profileClass(store, label)` summarizes the schema actually in use by the instances carrying a label:
 * which property keys and which relation types appear, each with **coverage** (fraction of instances
 * that have it) and, for properties, **cardinality** (distinct value count). This is the label/content
 * statistical index the enrichment pipeline reasons over — net-new; nothing profiled attributes before.
 *
 * `recommendNewAttributes(store, label)` ranks attributes that are common on **peer** instances (nodes
 * that share ≥1 attribute with this class) but sparse on this class — the "useful new attributes for
 * this class" of the enrichment blueprint. v1 scores each candidate by `peerCoverage × (1 − ownCoverage)`
 * (common among peers, rare in-class). This is the coherence/consistency signal the heavier rankers
 * (PLN truth-values, link-prediction, PageRank-trust) layer on top of — kept deliberately transparent.
 *
 * Everything here is read-only over the property-graph façade (`nodesByLabel`, `outEdges`, `inEdges`,
 * `allNodes`), so it composes with SPARQL/Cypher, the graph kernels, and (once entities are KKO-typed)
 * KKO-grounded classification.
 */
import type { HellGraphStore } from './store'
import type { GraphNode } from './types'

export type AttributeKind = 'property' | 'relation-out' | 'relation-in'

export interface AttributeStat {
  /** Property key, or relation (edge) label. */
  key: string
  kind: AttributeKind
  /** Fraction of class instances that carry this attribute, in [0,1]. */
  coverage: number
  /** Number of instances that carry it. */
  count: number
  /** For properties: distinct value count (cardinality). Omitted for relations. */
  distinctValues?: number
}

export interface ClassProfile {
  label: string
  instances: number
  /** Attributes in use, sorted by coverage desc then key. */
  attributes: AttributeStat[]
}

export interface ScoredAttribute {
  key: string
  kind: AttributeKind
  /** Recommendation strength in [0,1]: peerCoverage × (1 − ownCoverage). */
  score: number
  /** Fraction of peers carrying it. */
  peerCoverage: number
  /** Fraction of this class's instances carrying it. */
  ownCoverage: number
}

export interface RecommendOptions {
  /** Max recommendations returned. Default 10. */
  topK?: number
  /** Ignore attributes present on fewer than this fraction of peers. Default 0.2. */
  minPeerCoverage?: number
}

/** Namespaced attribute key so a property and a relation of the same name never collide. */
const akey = (kind: AttributeKind, key: string): string => `${kind}:${key}`

/** The distinct attribute keys (as `kind:key`) present on a node. */
function nodeAttributeKeys(store: HellGraphStore, node: GraphNode): Set<string> {
  const keys = new Set<string>()
  for (const k of Object.keys(node.properties)) keys.add(akey('property', k))
  for (const e of store.outEdges(node.id)) keys.add(akey('relation-out', e.label))
  for (const e of store.inEdges(node.id)) keys.add(akey('relation-in', e.label))
  return keys
}

/** Profile the schema in use by the instances carrying `label`. */
export function profileClass(store: HellGraphStore, label: string): ClassProfile {
  const nodes = store.nodesByLabel(label)
  const n = nodes.length
  const count = new Map<string, number>()
  const values = new Map<string, Set<string>>()

  for (const node of nodes) {
    for (const [k, v] of Object.entries(node.properties)) {
      const kk = akey('property', k)
      count.set(kk, (count.get(kk) ?? 0) + 1)
      let vs = values.get(kk)
      if (!vs) { vs = new Set(); values.set(kk, vs) }
      vs.add(String(v))
    }
    // count each relation label once per node (coverage = how many instances have it, not edge count)
    for (const kk of new Set(store.outEdges(node.id).map((e) => akey('relation-out', e.label)))) count.set(kk, (count.get(kk) ?? 0) + 1)
    for (const kk of new Set(store.inEdges(node.id).map((e) => akey('relation-in', e.label)))) count.set(kk, (count.get(kk) ?? 0) + 1)
  }

  const attributes: AttributeStat[] = []
  for (const [kk, c] of count) {
    const [kind, ...rest] = kk.split(':')
    const key = rest.join(':')
    const stat: AttributeStat = { key, kind: kind as AttributeKind, coverage: n ? c / n : 0, count: c }
    if (kind === 'property') stat.distinctValues = values.get(kk)!.size
    attributes.push(stat)
  }
  attributes.sort((a, b) => b.coverage - a.coverage || a.key.localeCompare(b.key))
  return { label, instances: n, attributes }
}

/**
 * Rank attributes common on peers but sparse on this class — candidate useful new attributes.
 * Peers = nodes NOT in this class that share at least one attribute key with a class instance.
 */
export function recommendNewAttributes(store: HellGraphStore, label: string, opts: RecommendOptions = {}): ScoredAttribute[] {
  const topK = opts.topK ?? 10
  const minPeerCoverage = opts.minPeerCoverage ?? 0.2

  const own = profileClass(store, label)
  const ownCoverage = new Map(own.attributes.map((a) => [akey(a.kind, a.key), a.coverage]))
  const ownKeys = new Set(ownCoverage.keys())
  const classIds = new Set(store.nodesByLabel(label).map((node) => node.id))

  // Peers: share ≥1 attribute key with the class, and aren't in it. (O(N) façade scan.)
  const peerKeys: Set<string>[] = []
  for (const node of store.allNodes()) {
    if (classIds.has(node.id)) continue
    const keys = nodeAttributeKeys(store, node)
    let shares = false
    for (const k of keys) if (ownKeys.has(k)) { shares = true; break }
    if (shares) peerKeys.push(keys)
  }
  const nPeers = peerKeys.length
  if (nPeers === 0) return []

  const peerCount = new Map<string, number>()
  for (const keys of peerKeys) for (const k of keys) peerCount.set(k, (peerCount.get(k) ?? 0) + 1)

  const out: ScoredAttribute[] = []
  for (const [kk, c] of peerCount) {
    const peerCov = c / nPeers
    if (peerCov < minPeerCoverage) continue
    const ownCov = ownCoverage.get(kk) ?? 0
    if (ownCov >= peerCov) continue // already at least as common in-class → not a gap worth recommending
    const [kind, ...rest] = kk.split(':')
    out.push({ key: rest.join(':'), kind: kind as AttributeKind, score: peerCov * (1 - ownCov), peerCoverage: peerCov, ownCoverage: ownCov })
  }
  out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return out.slice(0, topK)
}

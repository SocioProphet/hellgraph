/**
 * Proof-carrying attribute-recommendation ranking — the "Attribute Ranking" stage of KG enrichment.
 *
 * Where `recommendNewAttributes` (attribute-profile.ts) produces a single coverage-gap score, this fuses
 * THREE independent, graph-grounded rankers over the same candidates and attaches a verifiable receipt:
 *
 *   • consistency  — coverage gap: peerCoverage × (1 − ownCoverage). How reliably peers carry it.
 *   • trust        — PageRank-weighted peer support × gap. Authoritative peers count for more.
 *   • probabilistic— PLN truth-value form: strength (peerCoverage) × confidence (n/(n+1)) × gap.
 *
 * The three orderings are fused with Reciprocal-Rank Fusion — the SAME fusion `hybridRetrieve` uses for
 * retrieval — so ranking is consistent across the platform. Every result carries a `hash` over the ranked
 * output + the graph snapshot it was computed against, so a recommendation is a proof, not an opinion.
 *
 * The 4th diagram ranker — *coherence* (semantic fit) — is deliberately deferred: it becomes meaningful
 * once entities are KKO-typed (the mapping stage), at which point "does this attribute fit the class's
 * KKO type?" can be answered against the loaded ontology. Documented, not silently dropped.
 */
import { createHash } from 'node:crypto'
import type { HellGraphStore } from './store'
import type { GraphNode } from './types'
import { pageRank } from './graph-analytics'
import { reciprocalRankFusion } from './retrieval'
import { profileClass, type AttributeKind } from './attribute-profile'

const akey = (kind: AttributeKind, key: string): string => `${kind}:${key}`

function nodeAttributeKeys(store: HellGraphStore, node: GraphNode): Set<string> {
  const keys = new Set<string>()
  for (const k of Object.keys(node.properties)) keys.add(akey('property', k))
  for (const e of store.outEdges(node.id)) keys.add(akey('relation-out', e.label))
  for (const e of store.inEdges(node.id)) keys.add(akey('relation-in', e.label))
  return keys
}

export interface RankerSignals {
  consistency: number
  trust: number
  probabilistic: number
  /** Ontological fit vs the class's KKO type — present only when a `kkoTypeOf` is supplied. */
  coherence?: number
}

export interface RankedAttribute {
  key: string
  kind: AttributeKind
  /** Fused RRF score across the three rankers. */
  fusedScore: number
  /** 1-based rank in the fused ordering. */
  rank: number
  peerCoverage: number
  ownCoverage: number
  signals: RankerSignals
}

export interface AttributeRecommendation {
  label: string
  /** The ranker fusion used, for auditability. */
  method: string
  /** Peer instances considered. */
  peers: number
  /** Graph state the ranking was computed against — binds the receipt to a snapshot. */
  snapshot: { nodes: number; edges: number }
  recommendations: RankedAttribute[]
  /** sha256 over the ranked output + snapshot (proof-carrying). */
  hash: string
}

export interface RankOptions {
  topK?: number
  minPeerCoverage?: number
  /**
   * Maps a node id → its KKO type IRIs (e.g. via `mapEntityToKko`/`kkoTypesOf` or a stored type edge).
   * When supplied AND the class's instances carry KKO types, a 4th **coherence** ranker is fused in:
   * an attribute scores higher when the peers carrying it share the class's ontological type. The ranker
   * provides the mechanism; the caller chooses how entities are typed.
   */
  kkoTypeOf?: (nodeId: string) => string[]
}

function sealed(rec: Omit<AttributeRecommendation, 'hash'>): AttributeRecommendation {
  const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(rec)).digest('hex')
  return { ...rec, hash }
}

/**
 * Rank candidate new attributes for `label` by fusing consistency + PageRank-trust + PLN-probabilistic
 * (+ an optional KKO **coherence** ranker when `kkoTypeOf` is supplied), returning a proof-carrying receipt.
 */
export function rankAttributeRecommendations(store: HellGraphStore, label: string, opts: RankOptions = {}): AttributeRecommendation {
  const topK = opts.topK ?? 10
  const minPeerCoverage = opts.minPeerCoverage ?? 0.2
  const kkoTypeOf = opts.kkoTypeOf
  const snapshot = { nodes: store.allNodes().length, edges: store.edgeCount() }

  const own = profileClass(store, label)
  const ownCoverage = new Map(own.attributes.map((a) => [akey(a.kind, a.key), a.coverage]))
  const ownKeys = new Set(ownCoverage.keys())
  const classIds = new Set(store.nodesByLabel(label).map((n) => n.id))
  const pr = pageRank(store)

  // The class's ontological type: the KKO types its instances carry. Empty ⇒ coherence is inert.
  const classTypes = new Set<string>()
  if (kkoTypeOf) for (const id of classIds) for (const t of kkoTypeOf(id)) classTypes.add(t)
  const coherenceActive = classTypes.size > 0
  const method = coherenceActive
    ? 'rrf(consistency,trust,probabilistic,coherence)'
    : 'rrf(consistency,trust,probabilistic)'

  // Peers: nodes outside the class that share ≥1 attribute key with it, carrying id + PageRank.
  const peers: { id: string; keys: Set<string>; pr: number }[] = []
  for (const node of store.allNodes()) {
    if (classIds.has(node.id)) continue
    const keys = nodeAttributeKeys(store, node)
    let shares = false
    for (const k of keys) if (ownKeys.has(k)) { shares = true; break }
    if (shares) peers.push({ id: node.id, keys, pr: pr.get(node.id) ?? 0 })
  }
  const nPeers = peers.length
  if (nPeers === 0) return sealed({ label, method, peers: 0, snapshot, recommendations: [] })
  const totalPeerPr = peers.reduce((s, p) => s + p.pr, 0) || 1

  interface Cand { kk: string; key: string; kind: AttributeKind; peerCoverage: number; ownCoverage: number; consistency: number; trust: number; probabilistic: number; coherence: number }
  const cands: Cand[] = []
  const seen = new Set<string>()
  for (const peer of peers) for (const kk of peer.keys) {
    if (seen.has(kk)) continue
    seen.add(kk)
    const withIt = peers.filter((p) => p.keys.has(kk))
    const nWith = withIt.length
    const peerCov = nWith / nPeers
    if (peerCov < minPeerCoverage) continue
    const ownCov = ownCoverage.get(kk) ?? 0
    if (ownCov >= peerCov) continue // already at least as common in-class → not a recommendation
    const gap = 1 - ownCov
    const consistency = peerCov * gap
    const trust = (withIt.reduce((s, p) => s + p.pr, 0) / totalPeerPr) * gap
    const probabilistic = peerCov * (nWith / (nWith + 1)) * gap // PLN strength × confidence × gap
    // coherence: of the peers carrying this attribute, the fraction whose KKO type overlaps the class's.
    let coherence = 0
    if (coherenceActive) {
      const fit = withIt.filter((p) => kkoTypeOf!(p.id).some((t) => classTypes.has(t))).length
      coherence = (fit / nWith) * gap
    }
    const [kind, ...rest] = kk.split(':')
    cands.push({ kk, key: rest.join(':'), kind: kind as AttributeKind, peerCoverage: peerCov, ownCoverage: ownCov, consistency, trust, probabilistic, coherence })
  }
  if (cands.length === 0) return sealed({ label, method, peers: nPeers, snapshot, recommendations: [] })

  const orderBy = (sig: (c: Cand) => number): string[] =>
    [...cands].sort((a, b) => sig(b) - sig(a) || a.kk.localeCompare(b.kk)).map((c) => c.kk)
  const orderings = [orderBy((c) => c.consistency), orderBy((c) => c.trust), orderBy((c) => c.probabilistic)]
  if (coherenceActive) orderings.push(orderBy((c) => c.coherence))
  const fused = reciprocalRankFusion(orderings)
  const byKk = new Map(cands.map((c) => [c.kk, c]))

  const recommendations: RankedAttribute[] = fused.slice(0, topK).map((f, i) => {
    const c = byKk.get(f.id)!
    const signals: RankerSignals = { consistency: c.consistency, trust: c.trust, probabilistic: c.probabilistic }
    if (coherenceActive) signals.coherence = c.coherence
    return {
      key: c.key, kind: c.kind, fusedScore: f.score, rank: i + 1,
      peerCoverage: c.peerCoverage, ownCoverage: c.ownCoverage, signals,
    }
  })
  return sealed({ label, method, peers: nPeers, snapshot, recommendations })
}

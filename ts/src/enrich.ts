/**
 * Enrichment orchestrator — one proof-carrying call that composes the whole enrichment pillar.
 *
 * `enrichClass(store, label)` runs `profileClass` (schema-in-use) + `rankAttributeRecommendations`
 * (the 4-ranker recommender) and, crucially, **auto-activates the KKO coherence ranker** when KBpedia
 * reference concepts are loaded in the graph: it builds the RC label index once and types each class
 * instance (by its `name` property, else its id) via `mapEntityToKko`, so recommendations are scored
 * against the class's actual ontological type — with zero wiring at the call site.
 *
 * This is where the deep KKO chain (upper TBox → 55k RC ABox → entity typing) flows into enrichment
 * automatically: load the reference concepts and coherence just turns on. When no RCs are present it
 * degrades cleanly to the 3-ranker fusion. The result is the same sealed, snapshot-bound receipt.
 */
import type { HellGraphStore } from './store'
import { profileClass, type ClassProfile } from './attribute-profile'
import { rankAttributeRecommendations, type AttributeRecommendation, type RankOptions } from './attribute-rank'
import { RC_LABEL, buildRcLabelIndex, mapEntityToKko } from './kko-rc'

export interface EnrichResult {
  profile: ClassProfile
  recommendation: AttributeRecommendation
  /** Whether the KKO coherence ranker was active (reference concepts loaded + a type resolved). */
  kkoCoherence: boolean
}

export interface EnrichOptions extends RankOptions {
  /** Set false to skip auto-wiring KKO coherence even when reference concepts are present. Default true. */
  autoKkoCoherence?: boolean
}

/** Profile a class and rank its useful new attributes, auto-activating KKO coherence when possible. */
export function enrichClass(store: HellGraphStore, label: string, opts: EnrichOptions = {}): EnrichResult {
  const profile = profileClass(store, label)

  let rankOpts: RankOptions = opts
  let kkoCoherence = false
  // Auto-wire coherence: only if the caller didn't supply their own typing and RCs are actually loaded.
  if (opts.autoKkoCoherence !== false && opts.kkoTypeOf === undefined && store.nodesByLabel(RC_LABEL).length > 0) {
    const index = buildRcLabelIndex(store)
    const kkoTypeOf = (id: string): string[] => {
      const node = store.getNode(id)
      const key = typeof node?.properties['name'] === 'string' ? (node.properties['name'] as string) : id
      return mapEntityToKko(store, key, index).kkoTypes
    }
    rankOpts = { ...opts, kkoTypeOf }
    kkoCoherence = true
  }

  const recommendation = rankAttributeRecommendations(store, label, rankOpts)
  // reflect what actually happened (method carries ",coherence" only if a class type resolved)
  return { profile, recommendation, kkoCoherence: kkoCoherence && recommendation.method.includes('coherence') }
}

import { getAtomSpace } from './atomspace'
import { dumpAtomese } from './atomese'
import { getHellGraph } from './store'
import type { SINDySeries, PlatformDynamicsCandidate } from './prometheus'

/**
 * Client for the OpenCog sidecar (opencog-sidecar/server.py).
 *
 * HellGraph is the system-of-record; the sidecar is the inference co-processor.
 * This client pushes our metagraph (as Atomese) into the sidecar's real
 * AtomSpace and delegates Pattern Matcher / PLN / ECAN work the pure-TS engine
 * does not perform. Every method degrades gracefully when the sidecar is absent.
 */

const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8137'

function sidecarUrl(): string {
  return process.env.HELLGRAPH_SIDECAR_URL?.replace(/\/$/, '') || DEFAULT_SIDECAR_URL
}

export interface SidecarHealth {
  available: boolean
  atom_count: number
  import_error: string | null
  capabilities: { pattern_matcher: boolean; pln: boolean; ure: boolean; ecan: boolean }
  version: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${sidecarUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`sidecar ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export async function sidecarHealth(): Promise<SidecarHealth | null> {
  try {
    return await call<SidecarHealth>('/health')
  } catch {
    return null
  }
}

/** Push the entire HellGraph metagraph into the sidecar's AtomSpace as Atomese. */
export async function syncToSidecar(): Promise<{ added: number; atom_count: number }> {
  const atomese = dumpAtomese(getAtomSpace())
  return call('/atomese/load', { method: 'POST', body: JSON.stringify({ atomese }) })
}

/** Run a BindLink/GetLink through the real OpenCog Pattern Matcher. */
export async function runBindLink(bindlink: string): Promise<{ result: string }> {
  return call('/pattern', { method: 'POST', body: JSON.stringify({ bindlink }) })
}

/** PLN forward chaining over the sidecar AtomSpace. */
export async function plnForwardChain(iterations = 10, focus?: string): Promise<{ result: string }> {
  return call('/pln/forward', { method: 'POST', body: JSON.stringify({ iterations, focus }) })
}

/** ECAN attention allocation — stimulate an atom's short-term importance. */
export async function ecanStimulate(atom: string, sti = 100): Promise<{ result: string }> {
  return call('/ecan/stimulate', { method: 'POST', body: JSON.stringify({ atom, sti }) })
}

/** Evaluate arbitrary Atomese/Scheme in the sidecar (advanced/escape hatch). */
export async function evalScheme(code: string): Promise<{ result: string }> {
  return call('/scheme', { method: 'POST', body: JSON.stringify({ code }) })
}

export interface SHACLValidateResult {
  conforms: boolean
  violations: { focusNode: string; path?: string; message: string; severity: string; constraint: string }[]
  rulesApplied: number
}

/** Validate HellGraph triples against shapes using pyshacl (full W3C compliance). */
export async function shaclValidate(shapesText: string): Promise<SHACLValidateResult | null> {
  try {
    const atomese = dumpAtomese(getAtomSpace())
    return await call<SHACLValidateResult>('/shacl/validate', {
      method: 'POST',
      body: JSON.stringify({ shapes: shapesText, atomese }),
    })
  } catch {
    return null
  }
}

interface DerivedEdge {
  from: string
  relation: string
  to: string
  strength: number
  confidence: number
  epistemicClass: string
}

/**
 * Pull PLN-derived edges from the sidecar's 2-hop derivation pass and write them
 * back into the TypeScript HellGraph. This closes the bidirectionality gap: the
 * Python side runs an independent PLN derivation on its AtomSpaceLite mirror and
 * returns any RELATED_TO edges it found that HellGraph doesn't have yet.
 */
export async function pullFromSidecar(): Promise<{ imported: number }> {
  try {
    const result = await call<{ edges: DerivedEdge[]; count: number }>('/pln/derived')
    if (result.count === 0) return { imported: 0 }
    const g = getHellGraph()
    const ts = new Date().toISOString()
    let imported = 0
    for (const edge of result.edges) {
      // Only import if both endpoint atoms already exist in HellGraph
      if (!g.getNode(edge.from) || !g.getNode(edge.to)) continue
      g.addEdge(edge.relation, edge.from, edge.to, {
        epistemicClass: edge.epistemicClass,
        confidence: edge.confidence,
        promotionState: 'inferred',
        createdAt: ts,
      })
      imported++
    }
    return { imported }
  } catch {
    return { imported: 0 }
  }
}

/** Apply SHACL SPARQL data-derivation rules via pyshacl and return count of new triples. */
export async function shaclApplyRules(shapesText: string): Promise<{ added: number } | null> {
  try {
    const atomese = dumpAtomese(getAtomSpace())
    return await call<{ added: number }>('/shacl/rules', {
      method: 'POST',
      body: JSON.stringify({ shapes: shapesText, atomese }),
    })
  } catch {
    return null
  }
}

// ─── CSKG normalization ───────────────────────────────────────────────────────

export interface RawRelationEdge {
  node1: string
  relation: string
  node2: string
  provenance_ref?: string
  source_evidence_ref?: string
}

export interface CSKGEdge {
  edge_id: string
  node1: string
  relation: string
  node2: string
  provenance_refs: string[]
  source_evidence_refs: string[]
}

/**
 * Normalize raw relation triples through the graphbrain-contract CSKG normalizer.
 * Returns the canonicalized edges, or null if the sidecar is unavailable.
 */
export async function normalizeThroughSidecar(edges: RawRelationEdge[]): Promise<CSKGEdge[] | null> {
  if (edges.length === 0) return []
  try {
    const result = await call<{ edges: CSKGEdge[]; count: number }>('/cskg/normalize', {
      method: 'POST',
      body: JSON.stringify({ relations: edges }),
    })
    return result.edges
  } catch {
    return null
  }
}

// ─── Prometheus SINDy ─────────────────────────────────────────────────────────

/**
 * Run the SINDy fast-path symbolic regression on a time series via the sidecar.
 * Returns a PlatformDynamicsCandidate, or null if the sidecar is unavailable.
 */
export async function runSINDy(
  series: SINDySeries[],
  stateVariable: string,
  datasetUri: string,
): Promise<PlatformDynamicsCandidate | null> {
  if (series.length < 3) return null
  try {
    return await call<PlatformDynamicsCandidate>('/prometheus/sindy', {
      method: 'POST',
      body: JSON.stringify({ series, stateVariable, datasetUri }),
    })
  } catch {
    return null
  }
}

// ─── Latent topic drift ───────────────────────────────────────────────────────

export interface EpisodeRef {
  episode_id: string
  working_memory_ref: string
  request_metadata: Record<string, unknown>
  retrieval_path?: unknown[]
  recommendation_object_refs?: string[]
}

export interface TopicDelta {
  topic_id: string
  delta_type: string
  weight: number
  evidence_refs: string[]
}

export interface DriftReport {
  report_id: string
  corpus_delta_ids: string[]
  episode_refs: string[]
  candidate_topic_deltas: TopicDelta[]
  notes: string
  created_at: string
}

/**
 * Consume EpisodeBundles through OnlineLDAMaintainer to produce a DriftReport.
 * Returns null if the sidecar is unavailable or the latent module isn't loaded.
 */
export async function consumeEpisodeDrift(
  episodes: EpisodeRef[],
  corpusDeltaIds: string[] = [],
): Promise<DriftReport | null> {
  if (episodes.length === 0) return null
  try {
    return await call<DriftReport>('/latent/consume', {
      method: 'POST',
      body: JSON.stringify({ episodes, corpusDeltaIds }),
    })
  } catch {
    return null
  }
}

/**
 * prometheus.ts — Prometheus symbolic regression integration for HellGraph.
 *
 * Wires the SINDy (Sparse Identification of Nonlinear Dynamics) fast path into
 * the ECAN attention subsystem. Every consolidation pass records a snapshot of
 * the graph's aggregate attention state. Once enough snapshots accumulate, SINDy
 * fits the governing decay equation: d(avg_sti)/dt = coeff * avg_sti + intercept.
 * The discovered coefficient is converted to a discrete per-tick decay factor and
 * fed back into decayAll() as an adaptive replacement for the hardcoded 0.85.
 *
 * This is genuinely novel: the knowledge graph's own attention dynamics discover
 * their decay law from first principles rather than using a hand-tuned constant.
 *
 * The PlatformDynamicsCandidate produced by SINDy is also written into HellGraph
 * as a node so the consolidation history is queryable and auditable.
 */

import { getHellGraph } from './store'

export interface SINDySeries {
  t: number
  y: number
}

export interface PlatformDynamicsCandidate {
  artifactType: 'PlatformDynamicsCandidate'
  applicationMode: string
  candidateId: string
  methodFamily: 'sindy'
  implementationMode: string
  datasetRef: { uri: string; contentHash: string; hashAlgorithm: string }
  timeColumn: string
  stateVariable: string
  equationLatex: string
  coefficient: number
  intercept: number
  fitMetric: { name: string; value: number }
  complexity: number
  unitsStatus: string
  promotionState: string
  controlAuthority: false
  nonAuthorityDeclaration: string
  issuedAt: string
  sampleCount: number
}

// ─── Attention snapshot store ─────────────────────────────────────────────────
// Attention snapshots are written into HellGraph as AttentionSnapshot nodes.
// We need at least 3 to run SINDy; 5+ gives a meaningful fit.

export function recordAttentionSnapshot(): void {
  const g = getHellGraph()
  const atoms = g.allNodes().filter(n => n.labels.includes('FeatureAtom'))
  if (atoms.length === 0) return

  const stiValues = atoms.map(a => Number(a.properties['ecan:sti'] ?? 0))
  const avgSTI = stiValues.reduce((s, v) => s + v, 0) / stiValues.length

  const ts = new Date().toISOString()
  const snapshotId = `urn:hellgraph:attention-snapshot:${Date.now()}`
  g.addNode(snapshotId, ['AttentionSnapshot'], {
    avgSTI,
    atomCount: atoms.length,
    snapshotAt: ts,
    epochMs: Date.now(),
  })
}

export function exportAttentionSeries(): SINDySeries[] {
  const g = getHellGraph()
  const snapshots = g.allNodes()
    .filter(n => n.labels.includes('AttentionSnapshot'))
    .map(n => ({
      t: Number(n.properties['epochMs'] ?? 0) / 1000,  // seconds
      y: Number(n.properties['avgSTI'] ?? 0),
    }))
    .filter(p => p.t > 0 && p.y > 0)
    .sort((a, b) => a.t - b.t)

  return snapshots
}

// ─── HellGraph ingest for PlatformDynamicsCandidate ──────────────────────────

export function ingestPrometheusCandidate(candidate: PlatformDynamicsCandidate): string {
  const g = getHellGraph()
  const nodeId = candidate.candidateId

  g.addNode(nodeId, ['PlatformDynamicsCandidate', 'PrometheusArtifact'], {
    methodFamily: candidate.methodFamily,
    implementationMode: candidate.implementationMode,
    stateVariable: candidate.stateVariable,
    equationLatex: candidate.equationLatex,
    coefficient: candidate.coefficient,
    intercept: candidate.intercept,
    nmse: candidate.fitMetric.value,
    complexity: candidate.complexity,
    promotionState: candidate.promotionState,
    controlAuthority: candidate.controlAuthority,
    sampleCount: candidate.sampleCount,
    issuedAt: candidate.issuedAt,
  })

  return nodeId
}

// ─── Discrete decay factor from SINDy linear coefficient ─────────────────────
// SINDy fits: d(y)/dt = coeff * y + intercept (continuous time)
// For our 30-min decay tick (dt = 1800s), the discrete form is:
//   y(t+dt) = y(t) * e^(coeff * dt)
// We clamp to [0.50, 0.99] — below 0.50 is too aggressive, above 0.99 is no-op.

export function discreteDecayFactor(coefficient: number, dtSeconds = 1800): number {
  const factor = Math.exp(coefficient * dtSeconds)
  return Math.max(0.50, Math.min(0.99, factor))
}

// ─── prometheusd client ───────────────────────────────────────────────────────
// prometheusd is the primary SR runtime — a persistent local daemon with its own
// SQLite history. The sidecar is a stateless fallback when prometheusd is absent.

const PROMETHEUSD_URL = (process.env['PROMETHEUSD_URL'] ?? 'http://127.0.0.1:8890').replace(/\/$/, '')
const TIMEOUT_MS = 5_000

async function _callPrometheusd<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PROMETHEUSD_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`prometheusd ${res.status}`)
  return res.json() as Promise<T>
}

/**
 * Push the current attention snapshot to prometheusd so it accumulates
 * collective history across sessions. Also writes the snapshot node to HellGraph.
 * Call this on every ECAN decay tick (every 30 min) not just on consolidation.
 */
export async function pushSnapshotToPrometheusd(
  epochMs: number,
  avgSTI: number,
  atomCount: number,
  sessionId?: string,
): Promise<void> {
  try {
    await _callPrometheusd('/attention/record', {
      method: 'POST',
      body: JSON.stringify({ epoch_ms: epochMs, avg_sti: avgSTI, atom_count: atomCount, session_id: sessionId ?? null }),
    })
  } catch {
    // prometheusd not running — snapshot only lives in HellGraph until daemon starts
  }
}

// ─── SINDy pass: prometheusd → sidecar fallback → update ECAN decay ──────────
// Imported lazily to avoid circular dep with sidecar.ts which imports from store.ts

const SINDY_MIN_SAMPLES = 3

export async function runSINDyPass(): Promise<PlatformDynamicsCandidate | null> {
  // Primary: ask prometheusd to run /sindy/auto — it uses its full cross-session history
  try {
    const candidate = await _callPrometheusd<PlatformDynamicsCandidate & { ok?: boolean; reason?: string }>('/sindy/auto', { method: 'POST' })
    if ((candidate as { ok?: boolean }).ok === false) return null  // insufficient data

    ingestPrometheusCandidate(candidate)
    if (candidate.fitMetric.value <= 0.1 && candidate.coefficient < 0) {
      const { setAdaptiveDecayFactor } = await import('./ecan.js')
      setAdaptiveDecayFactor(discreteDecayFactor(candidate.coefficient))
    }
    return candidate
  } catch { /* prometheusd offline — fall through to sidecar */ }

  // Fallback: local series → sidecar (stateless, single-session)
  const series = exportAttentionSeries()
  if (series.length < SINDY_MIN_SAMPLES) return null

  try {
    const { runSINDy } = await import('./sidecar.js')
    const candidate = await runSINDy(series, 'avg_sti', 'urn:hellgraph:ecan-attention-series')
    if (!candidate) return null

    ingestPrometheusCandidate(candidate)
    if (candidate.fitMetric.value <= 0.1 && candidate.coefficient < 0) {
      const { setAdaptiveDecayFactor } = await import('./ecan.js')
      setAdaptiveDecayFactor(discreteDecayFactor(candidate.coefficient))
    }
    return candidate
  } catch {
    return null
  }
}

/**
 * SuperPeer — the deployable "managed HellGraph" service (docs/specs/08).
 *
 * A super-peer is NOT a central authority. It is just a peer with more uptime and an
 * index: it joins a federation, replicates the participants' sovereign logs, keeps an
 * always-on Autobase materialization of the shared view, and serves reads + governance
 * over HTTP. Every atom it serves traces to a participant signature; it cannot forge or
 * rewrite, and the whole view is rebuildable from the participant logs alone.
 *
 * Responsibilities (spec 08 §"Super-peer"):
 *   - discovery/relay      → Hyperswarm on the federation topic (optional; joinSwarm)
 *   - always-on indexer    → FederatedAtomSpace materialization, cached on view growth
 *   - query endpoint       → SPARQL / Gremlin over the materialized view
 *   - sovereign admission  → signed addWriter control ops (POST /admit)
 *
 * Networking is deliberately separable: the indexer + query + admit logic works over any
 * replication transport (direct streams in tests; Hyperswarm in production), so the
 * service is fully testable without a live DHT.
 */

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { FederatedAtomSpace, type FederatedOptions } from './autobase-view.js'
import { HellGraphStore } from './store.js'
import { runSparql } from './sparql.js'
import { runGremlin } from './gremlin.js'
import { runMetta } from './metta.js'
import { runCypher } from './cypher.js'
import { getEdge, scanEdges, getSubgraphStream, resolveSameAs, commitSnapshot } from './cskg-surface.js'

export type CskgReadOp = 'GetEdge' | 'ScanEdges' | 'GetSubgraphStream' | 'ResolveSameAs' | 'CommitSnapshot'
import type { AtomSpace } from './atomspace.js'
import type { CausalCut } from './causal-proof.js'
import { bearer, hasScope, type Scope, type TokenVerifier } from './auth.js'
import type { AuditSink } from './policy.js'
import { Metrics } from './metrics.js'
import { RateLimiter } from './rate-limit.js'

/** Per-route scope requirement (enforced only when an auth verifier is configured). */
const ROUTE_SCOPE: Record<string, Scope> = {
  'GET /health': 'read',
  'GET /cut': 'read',
  'POST /query': 'query',
  'POST /admit': 'admit',
}

export interface SuperPeerOptions extends FederatedOptions {
  /** Bearer-token verifier. If omitted, endpoints run OPEN (dev mode); production MUST set it. */
  auth?: TokenVerifier
  /** Append-only audit sink for auth denials (binds to the evidence spine in prod). */
  audit?: AuditSink
  /** Prometheus metrics registry; if set, a public GET /metrics endpoint is exposed. */
  metrics?: Metrics
  /** Per-principal rate limiter for /query and /admit (429 on refusal). */
  rateLimit?: RateLimiter
}

async function loadDep<T>(name: string): Promise<T | null> {
  try {
    const mod = (await import(name)) as unknown as T | { default: T }
    return typeof mod === 'function' ? (mod as T) : (mod as { default: T }).default
  } catch {
    return null
  }
}

interface SwarmConnection { /* Duplex stream */ }
interface SwarmDiscovery { flushed(): Promise<void> }
interface SwarmInstance {
  on(event: 'connection', cb: (conn: SwarmConnection) => void): void
  join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): SwarmDiscovery
  destroy(): Promise<void>
}
type SwarmCtor = new () => SwarmInstance

export type QueryLang = 'sparql' | 'gremlin' | 'metta' | 'cypher'

export interface SuperPeerHealth {
  ok: true
  baseKey: string
  nodes: number
  edges: number
  writers: number
  cut: CausalCut
}

export class SuperPeer {
  private server: http.Server | null = null
  private swarm: SwarmInstance | null = null
  // Materialization cache: re-materialize only when the linearization grows.
  private cachedSpace: AtomSpace | null = null
  private cachedLen = -1

  private constructor(
    private readonly fed: FederatedAtomSpace,
    private readonly auth: TokenVerifier | null = null,
    private readonly audit: AuditSink | null = null,
    private readonly metrics: Metrics | null = null,
    private readonly rateLimit: RateLimiter | null = null,
  ) {}

  /** Open (or join) a federation as a super-peer index. */
  static async create(storageDir: string, opts: SuperPeerOptions = {}): Promise<SuperPeer> {
    const fed = await FederatedAtomSpace.create(storageDir, opts)
    return new SuperPeer(fed, opts.auth ?? null, opts.audit ?? null, opts.metrics ?? null, opts.rateLimit ?? null)
  }

  /** True if this super-peer enforces authentication. */
  get authEnforced(): boolean { return this.auth !== null }

  /** The federation identity participants bootstrap from. */
  baseKey(): string { return this.fed.baseKey() }
  /** This super-peer's own writer key (for admission by another indexer, if federated). */
  writerKey(): string { return this.fed.localWriterKey() }

  // ─── Indexing ────────────────────────────────────────────────────────────────

  /** The current materialized AtomSpace, re-derived only when new ops have linearized. */
  async atomSpace(): Promise<AtomSpace> {
    const len = (await this.fed.linearization()).length
    if (!this.cachedSpace || len !== this.cachedLen) {
      this.cachedSpace = await this.fed.materialize()
      this.cachedLen = len
    }
    return this.cachedSpace
  }

  /** The current materialized view as a property-graph store. */
  async store(): Promise<HellGraphStore> { return new HellGraphStore(await this.atomSpace()) }

  async currentCut(): Promise<CausalCut> { return this.fed.currentCut() }

  /** Run a read query over the materialized view (SPARQL/Gremlin over the store, MeTTa/DAS over
   *  the AtomSpace). */
  async query(lang: QueryLang, q: string): Promise<unknown> {
    if (lang === 'metta') return runMetta(await this.atomSpace(), q)
    if (lang === 'cypher') return runCypher(await this.atomSpace(), q)
    const store = await this.store()
    return lang === 'sparql' ? runSparql(store, q) : runGremlin(store, q)
  }

  /** Read-only CSKG root-surface ops over the materialized view. Mutating routes
   *  (PutEdge/PutAux/DeleteEdge/BulkPutEdges) run on a participant's local write
   *  path, not here — the super-peer is never a data owner. */
  async cskg(op: CskgReadOp, payload: Record<string, unknown>): Promise<unknown> {
    const as = await this.atomSpace()
    switch (op) {
      case 'GetEdge': return getEdge(as, payload as Parameters<typeof getEdge>[1])
      case 'ScanEdges': return scanEdges(as, payload as Parameters<typeof scanEdges>[1])
      case 'GetSubgraphStream': return getSubgraphStream(as, payload as Parameters<typeof getSubgraphStream>[1], Number(payload['hops'] ?? 1))
      case 'ResolveSameAs': return resolveSameAs(as, payload as unknown as Parameters<typeof resolveSameAs>[1])
      case 'CommitSnapshot': return commitSnapshot(as, payload as unknown as Parameters<typeof commitSnapshot>[1])
    }
  }

  /** Admit a sovereign participant (signed addWriter control op). */
  async admit(writerKeyHex: string): Promise<void> { await this.fed.admitWriter(writerKeyHex) }

  async health(): Promise<SuperPeerHealth> {
    const store = await this.store()
    const cut = await this.fed.currentCut()
    return {
      ok: true,
      baseKey: this.baseKey(),
      nodes: store.allNodes().length,
      edges: store.allEdges().length,
      writers: Object.keys(cut).length,
      cut,
    }
  }

  // ─── Replication transports ────────────────────────────────────────────────────

  /** Direct replication (tests / manual peering). Pass true on the initiating side. */
  replicate(isInitiator: boolean): unknown { return this.fed.replicate(isInitiator) }

  /**
   * Join the federation swarm for discovery-driven peering (production). The topic is the
   * 32-byte base key, so anyone with the base key discovers this super-peer and replicates
   * their sovereign log to it. Optional dependency — throws if hyperswarm is unavailable.
   */
  async joinSwarm(): Promise<void> {
    const Hyperswarm = await loadDep<SwarmCtor>('hyperswarm')
    if (!Hyperswarm) throw new Error('hyperswarm not available (optional dependency not installed)')
    const swarm = new Hyperswarm()
    swarm.on('connection', (conn) => { this.fed.replicateThrough(conn) })
    const topic = Buffer.from(this.baseKey(), 'hex') // 32-byte federation topic
    const discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    this.swarm = swarm
  }

  // ─── HTTP endpoint ─────────────────────────────────────────────────────────────

  /**
   * Start the HTTP query/governance endpoint. Routes:
   *   GET  /health          → SuperPeerHealth
   *   GET  /cut             → current causal cut
   *   POST /query {lang,query} → SPARQL/Gremlin results over the materialized view
   *   POST /admit {writerKey}  → admit a sovereign participant
   * Returns the bound port (pass 0 for an ephemeral port).
   */
  async listen(port = 0): Promise<number> {
    const server = http.createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve) => server.listen(port, resolve))
    this.server = server
    return (server.address() as AddressInfo).port
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      // Public liveness — unauthenticated so k8s/LB probes work even when auth is enforced.
      if (req.method === 'GET' && url.pathname === '/livez') return send(200, { ok: true })

      // Public Prometheus metrics (network-restrict in prod).
      if (req.method === 'GET' && url.pathname === '/metrics' && this.metrics) {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        res.end(this.metrics.render())
        return
      }
      this.metrics?.inc('hellgraph_requests_total', { route: url.pathname })

      // Per-principal rate limiting on the expensive/governance routes (before work).
      if (this.rateLimit && req.method === 'POST' && (url.pathname === '/query' || url.pathname === '/admit')) {
        const key = req.headers.authorization ?? req.socket.remoteAddress ?? 'anon'
        if (!this.rateLimit.allow(key)) {
          this.metrics?.inc('hellgraph_ratelimited_total', { route: url.pathname })
          return send(429, { error: 'rate limited' })
        }
      }

      // AuthN/Z gate — enforced only when a verifier is configured (production).
      const scope = ROUTE_SCOPE[`${req.method} ${url.pathname}`]
      if (scope && this.auth) {
        const principal = ((): ReturnType<TokenVerifier['verify']> => {
          const token = bearer(req.headers.authorization)
          return token ? this.auth!.verify(token) : null
        })()
        if (!principal) {
          this.audit?.append({ ts: Date.now(), kind: 'blocked', objectId: url.pathname, reason: 'unauthenticated' })
          return send(401, { error: 'unauthenticated' })
        }
        if (!hasScope(principal, scope)) {
          this.audit?.append({ ts: Date.now(), kind: 'blocked', objectId: url.pathname, reason: `forbidden:${scope}` })
          return send(403, { error: `missing scope: ${scope}` })
        }
      }

      if (req.method === 'GET' && url.pathname === '/health') return send(200, await this.health())
      if (req.method === 'GET' && url.pathname === '/cut') return send(200, await this.currentCut())

      if (req.method === 'POST' && url.pathname === '/query') {
        const body = await readJson(req)
        const lang = body['lang']
        const q = body['query']
        if ((lang !== 'sparql' && lang !== 'gremlin' && lang !== 'metta' && lang !== 'cypher') || typeof q !== 'string') {
          return send(400, { error: "body must be { lang: 'sparql'|'gremlin'|'metta'|'cypher', query: string }" })
        }
        const results = await this.query(lang, q)
        this.metrics?.inc('hellgraph_queries_total', { lang })
        // P5 (spec 09): results are frame-relative — return the causal cut they were answered
        // against, so a client can bind them to (or re-check them under) that frame.
        return send(200, { results, cut: await this.currentCut() })
      }

      if (req.method === 'POST' && url.pathname === '/cskg') {
        const body = await readJson(req)
        const op = body['op']
        const READ_OPS = ['GetEdge', 'ScanEdges', 'GetSubgraphStream', 'ResolveSameAs', 'CommitSnapshot']
        if (typeof op !== 'string' || !READ_OPS.includes(op)) {
          return send(400, { error: `body must be { op: ${READ_OPS.map((o) => `'${o}'`).join('|')}, ...payload }. Mutating routes (PutEdge/PutAux/DeleteEdge/BulkPutEdges) run on the participant's local write path.` })
        }
        return send(200, { result: await this.cskg(op as CskgReadOp, body) })
      }

      if (req.method === 'POST' && url.pathname === '/admit') {
        const body = await readJson(req)
        const writerKey = body['writerKey']
        if (typeof writerKey !== 'string' || !/^[0-9a-f]{64}$/.test(writerKey)) {
          return send(400, { error: 'body must be { writerKey: <64-hex> }' })
        }
        await this.admit(writerKey)
        return send(200, { admitted: writerKey })
      }
      send(404, { error: 'not found' })
    } catch (err) {
      this.metrics?.inc('hellgraph_errors_total')
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      const server = this.server
      // close() alone leaves keep-alive sockets open (the event loop never drains);
      // drop live connections too.
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (this.swarm) await this.swarm.destroy()
    await this.fed.close()
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) reject(new Error('body too large')) })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('invalid JSON')) } })
    req.on('error', reject)
  })
}

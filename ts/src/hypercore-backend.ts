/**
 * HypercoreBackend — the AtomSpace journal as a signed, replicable append-only log.
 *
 * This is the first code seam of the federated-sovereign model
 * (docs/specs/08_Federated_Sovereign_HellGraph_v0_1.md). HellGraph's write log is
 * already an append-only journal; a Hypercore IS a secure append-only log, so the
 * journal maps onto it directly:
 *
 *   AtomLogEntry (add_atom / set_tv / set_av / set_value)  →  one Hypercore block
 *
 * Each participant owns one Hypercore. Its keypair (persisted in the storage dir) is
 * the participant's identity and write authority: only the holder of the secret key
 * can append, and every block is signed, so peers verify — not trust — what they
 * replicate. This is what lets the "managed service" be a super-peer index over
 * sovereign logs rather than a central authority, and it retires the client→server
 * `StorageNodeClient` federation (spec 08) in favour of symmetric, signed replication.
 *
 * Impedance match (same shape as RocksDBBackend): the engine's AtomSpaceBackend is
 * synchronous but the Hypercore binding is async. We bridge by pre-loading every block
 * during the async open() so the sync restore() replays from memory, and by serialising
 * writes through an ordered promise chain (Hypercore's own on-disk log gives durability).
 *
 * The `hypercore` binding is an OPTIONAL dependency — if it isn't installed, open()
 * throws and the caller falls back to the default JSONL/RocksDB backend. Nothing breaks.
 *
 * NOTE (spec 09): a Hypercore gives per-writer linear order (local time). The causal
 * merge ACROSS writers (Autobase) and proof-binding to causal cuts live one layer up;
 * this backend is only the sovereign single-writer log those layers compose.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import type { AtomSpaceBackend, AtomLogEntry } from './atomspace.js'

// Minimal structural type for the `hypercore` binding (avoid a hard type dep on an
// optional package). Covers only what this backend uses.
interface HypercoreLog {
  ready(): Promise<void>
  append(block: unknown): Promise<number>
  get(index: number): Promise<AtomLogEntry>
  close(): Promise<void>
  replicate(isInitiator: boolean): unknown
  readonly length: number
  readonly writable: boolean
  readonly key: Uint8Array | null
}
type HypercoreCtor = new (storage: string, opts?: Record<string, unknown>) => HypercoreLog

// Dynamic import works in both the ESM and CJS builds (a bare require() throws in the
// ESM bundle, which is why the binding must be loaded this way).
async function loadHypercore(): Promise<HypercoreCtor | null> {
  try {
    const mod = (await import('hypercore')) as unknown as HypercoreCtor | { default: HypercoreCtor }
    return typeof mod === 'function' ? mod : mod.default
  } catch {
    return null
  }
}

export class HypercoreBackend implements AtomSpaceBackend {
  private readonly corePath: string
  private core: HypercoreLog | null = null
  private preloaded: AtomLogEntry[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false

  private constructor(corePath: string) {
    this.corePath = corePath
  }

  /**
   * Open the log and preload every block so the synchronous restore() can replay
   * without async. Reopening the same dir reuses the persisted keypair, so the
   * participant identity (public key) is stable across restarts. Throws if the
   * hypercore binding is unavailable — the caller should catch and fall back.
   */
  static async open(baseDir: string, spaceId = 'sociosphere-primary'): Promise<HypercoreBackend> {
    const Ctor = await loadHypercore()
    if (!Ctor) throw new Error('hypercore binding not available (optional dependency not installed)')
    fs.mkdirSync(baseDir, { recursive: true })
    const corePath = path.join(baseDir, `${spaceId}.hypercore`)
    const backend = new HypercoreBackend(corePath)
    const core = new Ctor(corePath, { valueEncoding: 'json' })
    await core.ready()
    backend.core = core
    backend.preloaded = await backend.readAll()
    return backend
  }

  private async readAll(): Promise<AtomLogEntry[]> {
    const core = this.core
    if (!core) return []
    const out: AtomLogEntry[] = []
    for (let i = 0; i < core.length; i++) {
      try { out.push(await core.get(i)) } catch { /* skip corrupt block */ }
    }
    return out
  }

  /** Sync replay from the blocks preloaded during open(). */
  restore(apply: (entry: AtomLogEntry) => void): void {
    for (const entry of this.preloaded) apply(entry)
  }

  /** Enqueue an ordered, signed append. Returns immediately; Hypercore persists it. */
  write(entry: AtomLogEntry): void {
    if (this.closed || !this.core) return
    const core = this.core
    this.writeChain = this.writeChain.then(async () => {
      try { await core.append(entry) } catch { /* best-effort; on-disk log is source of truth */ }
    })
  }

  storagePath(): string { return this.corePath }

  // ─── Federation primitives (spec 08) ─────────────────────────────────────────

  /**
   * The participant's write-authority identity: the Hypercore public key (hex).
   * This is the stable key other peers reference this log by, and the key that
   * scopes a causal cut for proof-binding (spec 09). Null until ready.
   */
  publicKey(): string | null {
    const k = this.core?.key
    return k ? Buffer.from(k).toString('hex') : null
  }

  /** True if this process holds the secret key and may append (it is the writer). */
  isWritable(): boolean { return this.core?.writable ?? false }

  /**
   * A symmetric, signed replication stream for peer-to-peer sync — the replacement
   * for the client→server `StorageNodeClient` change-feed. Pipe two peers' streams
   * together (`s1.pipe(s2).pipe(s1)`); replication is verified by signature, so a
   * peer can serve blocks it cannot forge. Pass true on the initiating side.
   */
  replicate(isInitiator: boolean): unknown {
    if (!this.core) throw new Error('HypercoreBackend.replicate: core not open')
    return this.core.replicate(isInitiator)
  }

  /** Drain pending appends and close the log. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.writeChain
    const core = this.core
    this.core = null
    if (core) await core.close()
  }
}

/**
 * Convenience: open a Hypercore backend and attach it to a space (sync setBackend
 * replays the preloaded blocks). Returns the backend, or null if hypercore is
 * unavailable — caller keeps the default backend.
 */
export async function attachHypercore(
  space: { setBackend(b: AtomSpaceBackend): void; id: string },
  baseDir: string,
): Promise<HypercoreBackend | null> {
  try {
    const backend = await HypercoreBackend.open(baseDir, space.id)
    space.setBackend(backend)
    return backend
  } catch {
    return null
  }
}

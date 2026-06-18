/**
 * RocksDBBackend — durable AtomSpace persistence on RocksDB.
 *
 * This is the convergence backend: OpenCog AtomSpace proper persists through
 * `atomspace-rocks` (a RocksDB StorageNode), so backing the TS engine with RocksDB
 * keeps every consumer (Noetica, the prophet-platform hellgraph-service, any future
 * Go/Python service) aligned to the same on-disk model instead of inventing parallel
 * SQLite/JSONL schemas. Point two processes at their own HELLGRAPH_STORE_DIR and they
 * are local RocksDB instances speaking the same engine.
 *
 * On-disk model: an ordered write-ahead log keyed by zero-padded seq, so RocksDB's
 * lexicographic key order == insertion order == the exact replay order the engine's
 * applyLogEntry expects. This makes restore provably equivalent to the JSONL backend
 * (same entries, same order) while gaining RocksDB durability + compaction.
 *
 * Impedance match: the engine's AtomSpaceBackend interface is synchronous
 * (write/restore return void) but the RocksDB binding is async. We bridge by
 * pre-loading all entries during the async open() so the sync restore() can replay
 * from memory, and by serialising writes through an ordered promise chain (RocksDB's
 * own WAL provides crash durability for completed puts; close() drains the queue).
 *
 * The `rocksdb` binding is an OPTIONAL dependency — if it isn't installed/built, open()
 * throws and the caller falls back to the default JSONL backend. Nothing breaks.
 */

import * as path from 'node:path'
import type { AtomSpaceBackend, AtomLogEntry } from './atomspace.js'

const SEQ_WIDTH = 16 // zero-pad so lexical order == numeric order up to 1e16 entries
const keyOf = (seq: number): string => 'e:' + String(seq).padStart(SEQ_WIDTH, '0')

// Minimal structural type for the abstract-leveldown `rocksdb` binding (avoid a
// hard type dep on an optional package).
interface RocksIterator {
  next(cb: (err: Error | undefined, key?: string, value?: string) => void): void
  end(cb: (err?: Error) => void): void
}
interface RocksDb {
  open(opts: Record<string, unknown>, cb: (err?: Error) => void): void
  put(key: string, value: string, cb: (err?: Error) => void): void
  iterator(opts: Record<string, unknown>): RocksIterator
  close(cb: (err?: Error) => void): void
}
type RocksCtor = (location: string) => RocksDb

function loadRocks(): RocksCtor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('rocksdb') as RocksCtor | { default: RocksCtor }
    return typeof mod === 'function' ? mod : mod.default
  } catch {
    return null
  }
}

export class RocksDBBackend implements AtomSpaceBackend {
  private readonly dbPath: string
  private db: RocksDb | null = null
  private preloaded: AtomLogEntry[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false

  private constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  /**
   * Open the store and preload every persisted entry so the synchronous restore()
   * can replay without async. Throws if the rocksdb binding is unavailable — the
   * caller should catch and fall back to JSONL.
   */
  static async open(baseDir: string, spaceId = 'sociosphere-primary'): Promise<RocksDBBackend> {
    const ctor = loadRocks()
    if (!ctor) throw new Error('rocksdb binding not available (optional dependency not installed)')
    const dbPath = path.join(baseDir, `${spaceId}.rocks`)
    const backend = new RocksDBBackend(dbPath)
    const db = ctor(dbPath)
    await new Promise<void>((resolve, reject) =>
      db.open({ createIfMissing: true }, (err) => (err ? reject(err) : resolve())))
    backend.db = db
    backend.preloaded = await backend.readAll()
    return backend
  }

  private readAll(): Promise<AtomLogEntry[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([])
      const it = this.db.iterator({ keyAsBuffer: false, valueAsBuffer: false })
      const out: AtomLogEntry[] = []
      const step = (): void =>
        it.next((err, _key, value) => {
          if (err) { it.end(() => reject(err)); return }
          if (value === undefined) { it.end(() => resolve(out)); return }
          try { out.push(JSON.parse(value) as AtomLogEntry) } catch { /* skip corrupt */ }
          step()
        })
      step()
    })
  }

  /** Sync replay from the entries preloaded during open(). */
  restore(apply: (entry: AtomLogEntry) => void): void {
    for (const entry of this.preloaded) apply(entry)
  }

  /** Enqueue an ordered, durable put. Returns immediately; RocksDB's WAL persists it. */
  write(entry: AtomLogEntry): void {
    if (this.closed || !this.db) return
    const db = this.db
    this.writeChain = this.writeChain.then(
      () => new Promise<void>((resolve) => {
        db.put(keyOf(entry.seq), JSON.stringify(entry), () => resolve())
      }),
    )
  }

  storagePath(): string { return this.dbPath }

  /** Drain pending writes and close the store. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.writeChain
    const db = this.db
    this.db = null
    if (db) await new Promise<void>((resolve) => db.close(() => resolve()))
  }
}

/**
 * Convenience: open a RocksDB backend and attach it to a space (sync setBackend
 * replays the preloaded entries). Returns the backend, or null if RocksDB is
 * unavailable — caller keeps the default JSONL backend.
 */
export async function attachRocksDB(
  space: { setBackend(b: AtomSpaceBackend): void; id: string },
  baseDir: string,
): Promise<RocksDBBackend | null> {
  try {
    const backend = await RocksDBBackend.open(baseDir, space.id)
    space.setBackend(backend)
    return backend
  } catch {
    return null
  }
}

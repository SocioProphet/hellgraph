/**
 * FederatedAtomSpace — the causal-merge layer over sovereign Hypercore logs.
 *
 * Second seam of the federated-sovereign model (docs/specs/08). A single
 * HypercoreBackend is one participant's linear log (local time). This layer uses
 * Autobase to merge N such logs into one causally-linearized operation log, then
 * projects that log into an AtomSpace — the shared "central" view that is a derived,
 * rebuildable index over sovereign logs, never a source of truth.
 *
 * Model (matches Autobase exactly):
 *   - Each writer appends operations to its own core. Writers reference their
 *     predecessors, forming a causal DAG.
 *   - Autobase linearizes the DAG into an ordered view log. Ordering is eventually
 *     consistent; causal forks may reorder as new information arrives (spec 08).
 *   - Operations are AtomLogEntry values (add_atom / set_tv / set_av / set_value),
 *     plus one control op — `{ addWriter: <hexkey> }` — by which an existing writer
 *     admits a new sovereign participant. Admission is itself a signed log entry.
 *
 * Projection: the linearized view is replayed into an AtomSpace via importEntry, so
 * cross-writer TruthValue conflicts resolve by the PLN revision rule (Bayesian merge)
 * rather than last-write-wins. The existing HellGraphStore / SPARQL / Gremlin surfaces
 * then work unchanged over the merged view.
 *
 * NOTE (spec 09): the linear order here is the causal order proofs bind to. A proof's
 * causal cut is a version vector over these writers' cores; proof re-check against a cut
 * lives one layer up and is out of scope for this seam.
 *
 * `autobase` + `corestore` are OPTIONAL dependencies loaded via dynamic import; if
 * absent, create() throws and the caller keeps a single-node AtomSpace. Both are kept
 * external from the bundle (their P2P dep tree must not be inlined).
 */

import { AtomSpace, type AtomLogEntry } from './atomspace.js'
import { HellGraphStore } from './store.js'

// ─── Structural types for the optional bindings (no hard type dep) ───────────────

interface ViewLog {
  readonly length: number
  get(index: number): Promise<AtomLogEntry>
  append(value: unknown): Promise<unknown>
}
interface AutobaseHost {
  addWriter(key: Uint8Array, opts?: { indexer?: boolean }): Promise<unknown>
}
interface AutobaseInstance {
  ready(): Promise<void>
  update(): Promise<void>
  append(value: unknown): Promise<unknown>
  close(): Promise<void>
  readonly view: ViewLog
  readonly key: Uint8Array
  readonly local: { key: Uint8Array }
  readonly writable: boolean
}
type AutobaseHandlers = {
  valueEncoding: string
  open(store: { get(name: string, opts?: unknown): ViewLog }): ViewLog
  apply(nodes: Array<{ value: unknown }>, view: ViewLog, host: AutobaseHost): Promise<void>
}
type AutobaseCtor = new (store: unknown, bootstrap: Uint8Array | null, handlers: AutobaseHandlers) => AutobaseInstance
interface CorestoreInstance { replicate(isInitiator: boolean): unknown; close(): Promise<void> }
type CorestoreCtor = new (storage: string) => CorestoreInstance

async function loadDep<T>(name: string): Promise<T | null> {
  try {
    const mod = (await import(name)) as unknown as T | { default: T }
    return typeof mod === 'function' ? (mod as T) : (mod as { default: T }).default
  } catch {
    return null
  }
}

const toHex = (k: Uint8Array): string => Buffer.from(k).toString('hex')

// A data op is an AtomLogEntry; a control op admits a sovereign writer.
type ControlOp = { addWriter: string }
function isControlOp(v: unknown): v is ControlOp {
  return typeof v === 'object' && v !== null && typeof (v as ControlOp).addWriter === 'string'
}

export interface FederatedOptions {
  /** Hex base key to join an existing federation. Omit to create a new one. */
  bootstrap?: string
  /** AtomSpace id for the materialized view. */
  spaceId?: string
}

export class FederatedAtomSpace {
  private constructor(
    private readonly base: AutobaseInstance,
    private readonly corestore: CorestoreInstance,
    private readonly spaceId: string,
  ) {}

  /**
   * Open (or join) a federation. With no `bootstrap` this core is the creator and its
   * `baseKey()` is the federation identity others join by. With a `bootstrap` hex key
   * this core joins that federation but cannot write until an existing writer admits its
   * `localWriterKey()`. Throws if autobase/corestore are unavailable.
   */
  static async create(storageDir: string, opts: FederatedOptions = {}): Promise<FederatedAtomSpace> {
    const Autobase = await loadDep<AutobaseCtor>('autobase')
    const Corestore = await loadDep<CorestoreCtor>('corestore')
    if (!Autobase || !Corestore) throw new Error('autobase/corestore not available (optional dependencies not installed)')

    const store = new Corestore(storageDir)
    const handlers: AutobaseHandlers = {
      valueEncoding: 'json',
      open(s) { return s.get('view', { valueEncoding: 'json' }) },
      async apply(nodes, view, host) {
        for (const { value } of nodes) {
          if (isControlOp(value)) {
            // Admit a sovereign participant as an indexing writer. This IS a signed
            // log entry — admission is auditable, not an out-of-band grant.
            await host.addWriter(Buffer.from(value.addWriter, 'hex'), { indexer: true })
            continue
          }
          await view.append(value)
        }
      },
    }
    const bootstrap = opts.bootstrap ? Buffer.from(opts.bootstrap, 'hex') : null
    const base = new Autobase(store, bootstrap, handlers)
    await base.ready()
    return new FederatedAtomSpace(base, store, opts.spaceId ?? 'sociosphere-federated')
  }

  /** The federation identity — the key other participants bootstrap from. */
  baseKey(): string { return toHex(this.base.key) }

  /** This participant's writer key — the key an existing writer must admit. */
  localWriterKey(): string { return toHex(this.base.local.key) }

  /** True once this participant has been admitted and may append. */
  isWritable(): boolean { return this.base.writable }

  /**
   * Admit a sovereign participant as a writer (called by an existing writer). Appends a
   * signed `addWriter` control op; the new writer becomes writable after it syncs.
   */
  async admitWriter(localWriterKeyHex: string): Promise<void> {
    await this.base.append({ addWriter: localWriterKeyHex })
    await this.base.update()
  }

  /** Append one AtomSpace mutation to this participant's log. */
  async appendEntry(entry: AtomLogEntry): Promise<void> {
    if (!this.base.writable) throw new Error('FederatedAtomSpace: not an admitted writer yet')
    await this.base.append(entry)
  }

  /** Pull the latest linearization from peers. */
  async update(): Promise<void> { await this.base.update() }

  /**
   * A replication stream for peer-to-peer sync at the corestore level. Pipe two peers'
   * streams together (`s1.pipe(s2).pipe(s1)`). Pass true on the initiating side.
   */
  replicate(isInitiator: boolean): unknown { return this.corestore.replicate(isInitiator) }

  /**
   * Materialize the merged view into a fresh AtomSpace by replaying the causally-ordered
   * op log through importEntry (PLN revision on cross-writer TruthValue conflicts). The
   * result is a derived, rebuildable projection — never the source of truth.
   */
  async materialize(): Promise<AtomSpace> {
    await this.base.update()
    const space = new AtomSpace(this.spaceId, false)
    const view = this.base.view
    for (let i = 0; i < view.length; i++) {
      let entry: AtomLogEntry
      try { entry = await view.get(i) } catch { continue }
      if (entry && typeof entry.op === 'string' && entry.payload) space.importEntry(entry)
    }
    return space
  }

  /** Materialize and wrap in a HellGraphStore (property-graph / query surface). */
  async materializeStore(): Promise<HellGraphStore> {
    return new HellGraphStore(await this.materialize())
  }

  async close(): Promise<void> {
    await this.base.close()
    await this.corestore.close()
  }
}

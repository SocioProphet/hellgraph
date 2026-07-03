/**
 * object-store — the canonical object store + metadata catalog (data-plane spec 10, L1).
 *
 * The source of truth for content blobs, beneath the derived knowledge stores (L2 =
 * semantic.ts + AtomSpace). Content-addressed (sha256), codex-sealed at ingest (the
 * "hash + MIME + encrypt + label" edge), with a catalog holding versions, ACLs, residency,
 * and the content-integrity manifest. Provenance (codex seal + causal cut) travels from a
 * canonical object to any derived artifact, so served results can cite integrity + frame.
 *
 * BYOS: the byte backend is an interface. The default is in-memory; S3-compatible / edge
 * adapters plug in behind ObjectBackend without touching the catalog or seal logic.
 */

import { createHash } from 'node:crypto'
import { manifest, syndrome, type Manifest, type Syndrome } from './codex.js'
import type { ContentState, ContentObject } from './lifecycle.js'
import type { CausalCut } from './causal-proof.js'

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export interface Acl { read: string[]; egress: string[] }

export interface CatalogEntry {
  id: string
  version: number
  contentHash: string
  mime: string
  residency: string
  acl: Acl
  sensitiveFields: string[]
  state: ContentState
  /** Content-integrity seal (codex) at this version. */
  codex: Manifest
  createdAt: string
}

/** What a derived L2 artifact carries so provenance travels from canonical → derived → served. */
export interface ObjectProvenance {
  canonicalId: string
  version: number
  contentHash: string
  codexSha: string
  /** The causal frame (spec 09) this derivation observed, if produced under federation. */
  cut?: CausalCut
}

// ─── Byte backend (BYOS-pluggable) ───────────────────────────────────────────────────
export interface ObjectBackend {
  put(hash: string, bytes: Buffer): void
  get(hash: string): Buffer | undefined
}
export class InMemoryObjectBackend implements ObjectBackend {
  private readonly blobs = new Map<string, Buffer>()
  put(hash: string, bytes: Buffer): void { this.blobs.set(hash, bytes) }
  get(hash: string): Buffer | undefined { return this.blobs.get(hash) }
}

export interface IngestMeta {
  mime: string
  residency: string
  acl?: Acl
  sensitiveFields?: string[]
  division?: number
}

export class CanonicalObjectStore {
  private readonly catalog = new Map<string, CatalogEntry>()
  constructor(private readonly backend: ObjectBackend = new InMemoryObjectBackend()) {}

  /** Ingest content: store bytes content-addressed, codex-seal, catalog at state Normalized. */
  ingest(id: string, content: string, meta: IngestMeta): CatalogEntry {
    const bytes = Buffer.from(content, 'utf8')
    const contentHash = sha256(bytes)
    this.backend.put(contentHash, bytes)
    const entry: CatalogEntry = {
      id,
      version: 1,
      contentHash,
      mime: meta.mime,
      residency: meta.residency,
      acl: meta.acl ?? { read: [], egress: [] },
      sensitiveFields: meta.sensitiveFields ?? [],
      state: 'Normalized', // past the hash + MIME + encrypt + label ingest edge
      codex: manifest(content, meta.division),
      createdAt: new Date().toISOString(),
    }
    this.catalog.set(id, entry)
    return entry
  }

  entry(id: string): CatalogEntry | undefined { return this.catalog.get(id) }

  get(id: string): { content: string; entry: CatalogEntry } | undefined {
    const entry = this.catalog.get(id)
    if (!entry) return undefined
    const bytes = this.backend.get(entry.contentHash)
    if (!bytes) return undefined
    return { content: bytes.toString('utf8'), entry }
  }

  /** Integrity check: recompute the codex manifest and diff against the sealed one. Defaults
   *  to the stored bytes (should be INTACT); pass `currentContent` to check external drift. */
  verify(id: string, currentContent?: string): Syndrome {
    const entry = this.catalog.get(id)
    if (!entry) throw new Error(`object ${id} not in catalog`)
    const content = currentContent ?? this.backend.get(entry.contentHash)?.toString('utf8')
    if (content === undefined) throw new Error(`object ${id} bytes missing`)
    return syndrome(entry.codex, content)
  }

  /** Append a new immutable version: new bytes, new hash, new codex seal; version bumps. */
  newVersion(id: string, content: string): CatalogEntry {
    const prev = this.catalog.get(id)
    if (!prev) throw new Error(`object ${id} not in catalog`)
    const bytes = Buffer.from(content, 'utf8')
    const contentHash = sha256(bytes)
    this.backend.put(contentHash, bytes)
    const entry: CatalogEntry = {
      ...prev,
      version: prev.version + 1,
      contentHash,
      codex: manifest(content, prev.codex._division),
      createdAt: new Date().toISOString(),
    }
    this.catalog.set(id, entry)
    return entry
  }

  setState(id: string, state: ContentState): void {
    const entry = this.catalog.get(id)
    if (entry) entry.state = state
  }

  /** The provenance a derived L2 artifact should carry (integrity + optional causal frame). */
  provenanceOf(id: string, cut?: CausalCut): ObjectProvenance {
    const entry = this.catalog.get(id)
    if (!entry) throw new Error(`object ${id} not in catalog`)
    return { canonicalId: id, version: entry.version, contentHash: entry.contentHash, codexSha: entry.codex._sha256, cut }
  }

  /** Bridge a catalog entry to a policy-engine object (L1 → L5). */
  toPolicyObject(id: string): ContentObject {
    const entry = this.catalog.get(id)
    if (!entry) throw new Error(`object ${id} not in catalog`)
    return { id, state: entry.state, residency: entry.residency, sensitiveFields: entry.sensitiveFields }
  }
}

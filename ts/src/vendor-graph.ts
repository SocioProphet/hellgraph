/**
 * Vendor graph — the estate's dependency-staleness plane, as a GRAPH the engine can reason over.
 *
 * A vendored artifact is a copy of one repo's build output living inside another repo, invisible to
 * that repo's dependency tooling. **Merging an upstream PR does not ship it**; only a re-vendor does.
 * `prophet-platform` ran engine 0.4.40 while `main` was 0.4.45 — five releases invisible in
 * production, one of them a silent-wrong Cypher defect — and a *second*, byte-identical copy in
 * `apps/lifecycle-warden` went unnoticed the whole time, because nothing enumerated the copies.
 *
 * The fix is not a better spreadsheet. It is to make freshness a **derived query**: state the pins
 * as typed nodes and edges, and recompute the verdict from the graph every time it is asked.
 *
 * ## The model — `vfp:`, implemented as declared
 *
 * Nodes and edges are the vocabulary of `sociosphere` PR #492
 * (`registry/vendor-freshness/vendor-freshness.ttl`, namespace
 * `https://socioprophet.org/ns/vendor-freshness#`), implemented under those names rather than
 * re-invented: `vfp:Repository`, `vfp:Artifact`, `vfp:ConsumerApp`, `vfp:VendorPin`, `vfp:Release`,
 * `vfp:Contract`; edges `vfp:vendors`, `vfp:producedBy`, `vfp:supersededBy`, `vfp:pinnedAt`,
 * `vfp:pinFor`, `vfp:hostedIn`, `vfp:releasedAs`, `vfp:changesContract`, `vfp:guardedBy`.
 *
 * Every class is **KKO-typed** in the AtomSpace `TypeLattice` (`VFP_KKO_TYPES`), so
 * `as.types.isA(VFP.Artifact, KKO_PRODUCTS)` answers by subsumption and the plane composes with
 * `loadKkoIntoAtomSpace` instead of sitting beside it. An `Artifact` is a `kko:Products` — the made,
 * released thing; a `VendorPin` is a `kko:RelationTypes` — a *reified* relation, because a pin
 * carries its own policy, owner, disposition and dates and is therefore a governed object, not an
 * edge label.
 *
 * `vfp:Finding` is deliberately **not** materialized. The vocabulary says findings are "emitted by
 * the reasoner, never hand-authored" — and writing one would mutate the store, which is exactly what
 * the three queries below may not do. Findings are returned as values.
 *
 * ## The three derived questions
 *
 *   1. `stalenessOf` — not a boolean. The `vfp:supersededBy` path from the pin to the newest
 *      artifact, returning the **release distance** and the **intervening artifacts** in order.
 *   2. `blastRadiusOf` — *what breaks if I cut 0.4.46?*, answered BEFORE cutting it. Counted over
 *      `vfp:ConsumerApp`, never over `vfp:Repository`: modelling at repo granularity is precisely
 *      what hid the `lifecycle-warden` copy.
 *   3. `contractCrossingRiskOf` — a gap of five patch releases is not inherently dangerous; a gap
 *      that spans a release which moved a load-bearing contract is. Contract changes are a
 *      **declared** property of the release (`changesContract`), never inferred from version
 *      numbers — 0.4.43 and 0.4.45 are both patch bumps and both moved contracts.
 *
 * All three are PURE: they read `store` and return. `store.version()` — the AtomSpace's monotonic
 * logical clock — is identical before and after, which the tests assert directly.
 *
 * ## The governed trigger
 *
 * `proposeRevendor` emits a **`EffectRequest`-shaped proposal** against the sourceos-spec contract
 * vendored at `ontology/effect-request/EffectRequest.json`, sha-asserted at import. It is a
 * PROPOSAL and nothing else: the engine never re-vendors, never opens a PR, never writes. This is
 * the same rule `nlq.ts`'s restricted search obeys — effects are proposed, never taken — and the
 * contract's own words for it are "a requested effect is a proposal only: it is not permission, not
 * execution, and not evidence that anything happened". A membrane gate returns the `EffectDecision`
 * that may authorize action, and it lives outside this engine.
 *
 * ## Sealing
 *
 * `analyzeVendorFreshness` seals exactly like `enrich` / `explore` / `nlq`: sha256 over the derived
 * output plus the `{seq,nodes,edges}` snapshot, where `seq` is the store's logical clock — the real
 * receipt binding (counts alone collide; the clock does not). Same inputs against the same graph
 * state ⇒ byte-identical seal, so a staleness verdict is provable and replayable rather than a
 * screenshot of somebody's terminal.
 */
import { createHash } from 'node:crypto'
import type { HellGraphStore } from './store'
import type { PropertyValue } from './types'
import { validateAgainst, assertSupportedKeywords, matchesFormat, type SchemaObj } from './nlq'
import {
  EFFECT_REQUEST_SCHEMA_TEXT,
  EFFECT_REQUEST_SCHEMA_SHA256,
  EFFECT_REQUEST_SPEC_VERSION,
} from './effect-request-data'

// ─── Vendored contract: sha-asserted at import ──────────────────────────────────

function loadEffectRequestContract(): SchemaObj {
  const bytes = Buffer.from(EFFECT_REQUEST_SCHEMA_TEXT, 'utf8')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== EFFECT_REQUEST_SCHEMA_SHA256) {
    throw new Error(
      `vendor-graph: vendored EffectRequest.json drifted: sha256 ${actual} != pinned ${EFFECT_REQUEST_SCHEMA_SHA256}; ` +
      're-vendor byte-identical from sourceos-spec and re-run scripts/gen-effect-request.mjs')
  }
  const schema = JSON.parse(bytes.toString('utf8')) as SchemaObj
  // Same bar the SemanticAction contract clears: a keyword the shared validator does not implement
  // fails LOUDLY here rather than silently validating less than the contract says.
  assertSupportedKeywords(schema, 'EffectRequest')
  return schema
}

/** The vendored EffectRequest JSON Schema, sha-verified at import. */
export const EFFECT_REQUEST_SCHEMA: Readonly<SchemaObj> = Object.freeze(loadEffectRequestContract())

/** Identity of the effect contract every proposal is validated against — sealed into receipts. */
export interface EffectContractRef {
  schema: string
  specVersion: string
  sha256: string
}

export const EFFECT_REQUEST_CONTRACT: Readonly<EffectContractRef> = Object.freeze({
  schema: String(EFFECT_REQUEST_SCHEMA['$id'] ?? 'EffectRequest.json'),
  specVersion: EFFECT_REQUEST_SPEC_VERSION,
  sha256: EFFECT_REQUEST_SCHEMA_SHA256,
})

// ─── The vfp: vocabulary, as implemented ────────────────────────────────────────

/** `vfp:` — the vendor-freshness vocabulary namespace (sociosphere PR #492). */
export const VFP_NS = 'https://socioprophet.org/ns/vendor-freshness#'
/** The instance namespace the worked lift (`lift.engine-pins.ttl`) uses for `ex:` ids. */
export const VFP_ID_NS = 'https://socioprophet.org/id/vendor-freshness/'

const KKO_NS_ = 'http://kbpedia.org/ontologies/kko#'

/** Node labels — the `vfp:` classes, verbatim. Used as graph labels and as `TypeLattice` types. */
export const VFP = {
  Repository: 'vfp:Repository',
  Artifact: 'vfp:Artifact',
  ConsumerApp: 'vfp:ConsumerApp',
  VendorPin: 'vfp:VendorPin',
  Release: 'vfp:Release',
  Contract: 'vfp:Contract',
} as const

/** Edge labels — the `vfp:` properties, verbatim (four spine edges, then the supporting ones). */
export const VFP_EDGE = {
  vendors: 'vfp:vendors',
  producedBy: 'vfp:producedBy',
  supersededBy: 'vfp:supersededBy',
  pinnedAt: 'vfp:pinnedAt',
  pinFor: 'vfp:pinFor',
  hostedIn: 'vfp:hostedIn',
  releasedAs: 'vfp:releasedAs',
  changesContract: 'vfp:changesContract',
  guardedBy: 'vfp:guardedBy',
} as const

/**
 * KKO anchors for the `vfp:` classes — this is what "KKO-typed" means here, not a bare `declare`.
 * Each is declared under a real KBpedia Knowledge Ontology class, so subsumption answers against
 * the loaded upper ontology (`Products ⊑ Artifacts ⊑ Symbolic ⊑ Manifestations ⊑ SuperTypes`).
 *
 *   Repository  ⊑ kko:Systems        — an organized symbolic system that produces and hosts.
 *   Artifact    ⊑ kko:Products       — one immutable released thing; a product of a repository.
 *   ConsumerApp ⊑ kko:Artifacts      — a made symbolic thing that carries a copy of another.
 *   VendorPin   ⊑ kko:RelationTypes  — a REIFIED relation, i.e. a Predication, not an entity.
 *   Release     ⊑ kko:Action         — an act performed at a time (Action ⊑ Events ⊑ Particulars).
 *   Contract    ⊑ kko:Concepts       — a load-bearing interface is an abstraction, not a file.
 */
export const VFP_KKO_TYPES: Readonly<Record<string, string>> = Object.freeze({
  [VFP.Repository]: KKO_NS_ + 'Systems',
  [VFP.Artifact]: KKO_NS_ + 'Products',
  [VFP.ConsumerApp]: KKO_NS_ + 'Artifacts',
  [VFP.VendorPin]: KKO_NS_ + 'RelationTypes',
  [VFP.Release]: KKO_NS_ + 'Action',
  [VFP.Contract]: KKO_NS_ + 'Concepts',
})

/** `receipt-shape | schema | fsm` — the contract kinds whose movement breaks consumers silently. */
export type ContractKind = 'receipt-shape' | 'schema' | 'fsm'
/** `pin-exact | track-minor | track-latest` — how a pin wants to follow its upstream. */
export type FreshnessPolicy = 'pin-exact' | 'track-minor' | 'track-latest'
/** `current | remediation-open | remediation-required | waived | observation-required` — DECLARED. */
export type Disposition =
  'current' | 'remediation-open' | 'remediation-required' | 'waived' | 'observation-required'
/** `current | stale | unknown` — DERIVED. Recomputed by the reasoner, never declared. */
export type FreshnessState = 'current' | 'stale' | 'unknown'

// ─── Manifest shape (the register, parsed) ──────────────────────────────────────

/**
 * A contract a release moved. `kind` is the load-bearing classification; the rest is evidence.
 */
export interface ManifestContractChange {
  kind: ContractKind
  /** Stable id within the source; defaults to `<version>/<kind>`. */
  id?: string
  note?: string
  /** A golden fixture whose bytes must be re-verified across this release. */
  receiptFixture?: string
  digest?: string
}

/** One upstream release of a source, in release order. */
export interface ManifestRelease {
  version: string
  /**
   * Contracts this release moved — **declared**, never inferred from the version number. Accepts
   * the bare kind (`'receipt-shape'`) or the full object. Empty/absent means "declared to move
   * nothing", which is a claim the register's author makes and this module simply carries.
   */
  changesContract?: (ContractKind | ManifestContractChange)[]
  digest?: string
  versionMarker?: string
  observedAt?: string
}

/** A source repository that produces vendored artifacts. */
export interface ManifestSource {
  sourceId: string
  repo: string
  url?: string
  artifactKind?: string
  versionScheme?: string
  packageName?: string
  upstreamLatestVersion?: string
  /** When upstream was last actually LOOKED AT. Absent ⇒ the pin's state is `unknown`, not `current`. */
  observedAt?: string
  observationMethod?: string
  workspaceBinding?: string
  /**
   * The release history, oldest → newest. This is what `vfp:supersededBy` is built from: each entry
   * is superseded by the next. Absent ⇒ only the versions the pins name are known, and the plane
   * can say "unknown" but not "five behind".
   */
  releases?: ManifestRelease[]
}

/** One declared vendored artifact — which the graph reifies as a `vfp:VendorPin`. */
export interface ManifestArtifact {
  /**
   * The register's `artifact_id`. Note it identifies a *pin* (source × consumer app), not an
   * artifact: `hellgraph-engine@hellgraph-service` and `hellgraph-engine@lifecycle-warden` name the
   * same 0.4.40 tarball. The graph separates the two, and this becomes the `vfp:VendorPin` id.
   */
  artifactId: string
  sourceId: string
  consumerRepo: string
  consumerUrl?: string
  consumerApp: string
  artifactPath?: string
  vendoredVersion?: string
  vendoredDigest?: string
  vendoredCommit?: string
  freshnessPolicy?: FreshnessPolicy
  owner?: string
  disposition?: Disposition
  guard?: { path?: string | null; floorConstant?: string; floorValue?: string; invokedByCi?: boolean }
  /** Trust zone / policy labels of the consuming app, carried onto an emitted proposal. */
  policyLabels?: string[]
  remediation?: { targetVersion?: string; due?: string; pullRequest?: string; findingId?: string }
}

/** The parsed `registry/vendor-freshness.yaml`. Parsed OBJECT only — the engine has no YAML dep. */
export interface VendorFreshnessManifest {
  manifestId?: string
  policy?: { observationMaxAgeDays?: number; defaultFreshnessPolicy?: FreshnessPolicy }
  sources: ManifestSource[]
  artifacts: ManifestArtifact[]
}

// ─── snake_case ⇄ camelCase tolerance ───────────────────────────────────────────

/**
 * The register is snake_case YAML; TypeScript callers write camelCase. One accessor reads both, so
 * `JSON.parse(yamlToJson(register))` and a hand-built object are the same input. Nothing is guessed:
 * only the two spellings of the SAME declared key are accepted.
 */
function field<T>(obj: Record<string, unknown> | undefined, camel: string): T | undefined {
  if (!obj) return undefined
  if (camel in obj) return obj[camel] as T
  const snake = camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
  return snake in obj ? (obj[snake] as T) : undefined
}

const asRec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

// ─── Ingest ─────────────────────────────────────────────────────────────────────

export interface VendorGraphIngestStats {
  repositories: number
  artifacts: number
  consumerApps: number
  pins: number
  releases: number
  contracts: number
  /** `vfp:supersededBy` edges written — the supersession chains the staleness query walks. */
  supersededByEdges: number
}

/**
 * Reduce a register-supplied string to the `[A-Za-z0-9._~-]` alphabet the EffectRequest `id` and
 * `requestedByEventRef` patterns allow, with leading/trailing separators trimmed.
 *
 * The trim is an index walk, NOT `/^-+|-+$/`. That regex is a polynomial-ReDoS (CodeQL
 * `js/polynomial-redos`): on `x` + n dashes + `y` the `-+$` alternative is retried from every
 * dash, each attempt scanning to the end — measured 48 ms at n=10k rising to 11.4 s at n=160k on
 * the pre-fix implementation. `pinKey` and `version` reach here from a caller-supplied register,
 * and this is a published library, so the input is not ours to trust. The walk below is linear
 * and allocation-free.
 */
const slug = (s: string): string => {
  const collapsed = s.replace(/[^A-Za-z0-9._~-]+/g, '-')
  const DASH = 45 // '-'
  let start = 0
  let end = collapsed.length
  while (start < end && collapsed.charCodeAt(start) === DASH) start++
  while (end > start && collapsed.charCodeAt(end - 1) === DASH) end--
  return collapsed.slice(start, end)
}

/** Deterministic node ids in the lift's `ex:` instance namespace. */
export const vfpId = {
  repository: (repo: string): string => `${VFP_ID_NS}repo/${repo}`,
  artifact: (sourceId: string, version: string): string => `${VFP_ID_NS}artifact/${sourceId}@${version}`,
  consumerApp: (repo: string, appPath: string): string => `${VFP_ID_NS}app/${repo}/${appPath}`,
  pin: (artifactId: string): string => `${VFP_ID_NS}pin/${artifactId}`,
  release: (sourceId: string, version: string): string => `${VFP_ID_NS}release/${sourceId}@${version}`,
  contract: (sourceId: string, id: string): string => `${VFP_ID_NS}contract/${sourceId}/${id}`,
}

function put(props: Record<string, PropertyValue>, k: string, v: unknown): void {
  if (v === undefined || v === null) return
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') props[k] = v
}

function normalizeContractChange(c: ContractKind | ManifestContractChange, version: string): ManifestContractChange {
  if (typeof c === 'string') return { kind: c, id: `${version}/${c}` }
  const rec = c as unknown as Record<string, unknown>
  const kind = (field<ContractKind>(rec, 'kind') ?? 'schema')
  return {
    kind,
    id: field<string>(rec, 'id') ?? `${version}/${kind}`,
    note: field<string>(rec, 'note'),
    receiptFixture: field<string>(rec, 'receiptFixture'),
    digest: field<string>(rec, 'digest'),
  }
}

/**
 * Build the `vfp:` subgraph from a parsed vendor-freshness manifest.
 *
 * Accepts the parsed OBJECT — the engine takes no YAML dependency, exactly as it takes no RDF
 * dependency to load KKO.
 *
 * Also declares each `vfp:` class in the AtomSpace `TypeLattice` under its KKO anchor, so the
 * classes are typed rather than merely labelled.
 *
 * **Idempotent in content, not in clock.** Re-ingesting the same manifest adds no nodes and no
 * edges — atoms are content-addressed — but `store.addNode` re-writes every label and property
 * value, and each write ticks the logical clock. (`store.addEdge` does not; it only interns
 * atoms.) This is measured behaviour shared with `loadKkoIntoAtomSpace`, and it is stated because
 * `seq` is what `analyzeVendorFreshness` seals against: a redundant re-ingest reseals the same
 * graph under a new hash. Ingest once per store, then analyze.
 */
export function ingestVendorFreshness(
  store: HellGraphStore,
  manifest: VendorFreshnessManifest | Record<string, unknown>,
): VendorGraphIngestStats {
  const m = manifest as Record<string, unknown>
  const sources = (field<unknown[]>(m, 'sources') ?? []).map((s) => asRec(s)).filter(Boolean) as Record<string, unknown>[]
  const artifacts = (field<unknown[]>(m, 'artifacts') ?? []).map((a) => asRec(a)).filter(Boolean) as Record<string, unknown>[]
  const defaultPolicy = field<FreshnessPolicy>(asRec(field(m, 'policy')), 'defaultFreshnessPolicy') ?? 'track-minor'

  // Type the vocabulary before instantiating it.
  const lattice = store.atomspace().types
  for (const [cls, kkoParent] of Object.entries(VFP_KKO_TYPES)) lattice.declare(cls, [kkoParent])

  const stats: VendorGraphIngestStats = {
    repositories: 0, artifacts: 0, consumerApps: 0, pins: 0, releases: 0, contracts: 0, supersededByEdges: 0,
  }
  const seenRepo = new Set<string>()
  const seenArtifact = new Set<string>()
  const seenApp = new Set<string>()
  const seenContract = new Set<string>()

  const ensureRepo = (repo: string, url?: string, workspaceBinding?: string): string => {
    const id = vfpId.repository(repo)
    if (seenRepo.has(id)) return id
    seenRepo.add(id)
    const props: Record<string, PropertyValue> = { repoName: repo }
    put(props, 'repoUrl', url)
    // `workspace_binding: unbound` is the register's way of declaring a repo the workspace manifest
    // does not know exists. Absent ⇒ bound. Silence is not the same as a declared exception.
    props['workspaceBound'] = workspaceBinding !== 'unbound'
    store.addNode(id, [VFP.Repository], props)
    stats.repositories++
    return id
  }

  // ── Sources: repositories, their release history, and the supersession chain ──
  for (const s of sources) {
    const sourceId = field<string>(s, 'sourceId') ?? ''
    const repo = field<string>(s, 'repo') ?? ''
    if (!sourceId || !repo) continue
    const repoId = ensureRepo(repo, field<string>(s, 'url'), field<string>(s, 'workspaceBinding'))

    const releases = (field<unknown[]>(s, 'releases') ?? []).map((r) => asRec(r)).filter(Boolean) as Record<string, unknown>[]
    let prevArtifactId: string | undefined
    for (const r of releases) {
      const version = field<string>(r, 'version')
      if (!version) continue

      const artifactId = vfpId.artifact(sourceId, version)
      if (!seenArtifact.has(artifactId)) {
        seenArtifact.add(artifactId)
        const aProps: Record<string, PropertyValue> = {
          artifactId: `${sourceId}@${version}`, version, sourceId,
        }
        put(aProps, 'artifactKind', field<string>(s, 'artifactKind'))
        put(aProps, 'versionScheme', field<string>(s, 'versionScheme'))
        put(aProps, 'digest', field<string>(r, 'digest'))
        put(aProps, 'versionMarker', field<string>(r, 'versionMarker'))
        store.addNode(artifactId, [VFP.Artifact], aProps)
        store.addEdge(VFP_EDGE.producedBy, artifactId, repoId)
        stats.artifacts++
      }

      const releaseId = vfpId.release(sourceId, version)
      const rProps: Record<string, PropertyValue> = { version, sourceId }
      put(rProps, 'observedAt', field<string>(r, 'observedAt'))
      store.addNode(releaseId, [VFP.Release], rProps)
      store.addEdge(VFP_EDGE.releasedAs, artifactId, releaseId)
      stats.releases++

      // Contract changes: DECLARED on the release, and mirrored onto the artifact as a
      // `changesContract` property so the risk question never has to guess from version numbers.
      const raw = (field<(ContractKind | ManifestContractChange)[]>(r, 'changesContract') ?? [])
      const changes = raw.map((c) => normalizeContractChange(c, version))
      if (changes.length > 0) {
        store.setNodeProperty(artifactId, 'changesContract', changes.map((c) => c.kind).join(','))
      }
      for (const c of changes) {
        const contractId = vfpId.contract(sourceId, c.id ?? `${version}/${c.kind}`)
        if (!seenContract.has(contractId)) {
          seenContract.add(contractId)
          const cProps: Record<string, PropertyValue> = { contractKind: c.kind }
          put(cProps, 'note', c.note)
          put(cProps, 'receiptFixture', c.receiptFixture)
          put(cProps, 'digest', c.digest)
          store.addNode(contractId, [VFP.Contract], cProps)
          stats.contracts++
        }
        store.addEdge(VFP_EDGE.changesContract, releaseId, contractId)
      }

      if (prevArtifactId) {
        store.addEdge(VFP_EDGE.supersededBy, prevArtifactId, artifactId)
        stats.supersededByEdges++
      }
      prevArtifactId = artifactId
    }
  }

  // ── Artifacts (register entries): consumer apps and the reified pins ──
  for (const a of artifacts) {
    const pinKey = field<string>(a, 'artifactId') ?? ''
    const sourceId = field<string>(a, 'sourceId') ?? ''
    const consumerRepo = field<string>(a, 'consumerRepo') ?? ''
    const consumerApp = field<string>(a, 'consumerApp') ?? ''
    if (!pinKey || !sourceId || !consumerRepo || !consumerApp) continue

    const consumerRepoId = ensureRepo(consumerRepo, field<string>(a, 'consumerUrl'))
    const appId = vfpId.consumerApp(consumerRepo, consumerApp)
    if (!seenApp.has(appId)) {
      seenApp.add(appId)
      store.addNode(appId, [VFP.ConsumerApp], { appPath: consumerApp, repoName: consumerRepo })
      store.addEdge(VFP_EDGE.hostedIn, appId, consumerRepoId)
      stats.consumerApps++
    }

    // The pinned artifact. A pin may name a version the source's release history does not list
    // (an unobserved upstream); the artifact node is still created, with no supersession chain —
    // which is precisely how the staleness query arrives at `unknown` rather than `current`.
    const version = field<string>(a, 'vendoredVersion') ?? field<string>(a, 'vendoredCommit') ?? 'unknown'
    const pinnedArtifactId = vfpId.artifact(sourceId, version)
    if (!seenArtifact.has(pinnedArtifactId)) {
      seenArtifact.add(pinnedArtifactId)
      const aProps: Record<string, PropertyValue> = { artifactId: `${sourceId}@${version}`, version, sourceId }
      put(aProps, 'digest', field<string>(a, 'vendoredDigest'))
      store.addNode(pinnedArtifactId, [VFP.Artifact], aProps)
      const src = sources.find((s) => field<string>(s, 'sourceId') === sourceId)
      if (src) store.addEdge(VFP_EDGE.producedBy, pinnedArtifactId, vfpId.repository(field<string>(src, 'repo') ?? ''))
      stats.artifacts++
    } else if (field<string>(a, 'vendoredDigest')) {
      store.setNodeProperty(pinnedArtifactId, 'digest', field<string>(a, 'vendoredDigest')!)
    }
    store.addEdge(VFP_EDGE.vendors, appId, pinnedArtifactId)

    const guard = asRec(field(a, 'guard'))
    const pinId = vfpId.pin(pinKey)
    const pProps: Record<string, PropertyValue> = {
      pinKey,
      sourceId,
      freshnessPolicy: field<FreshnessPolicy>(a, 'freshnessPolicy') ?? defaultPolicy,
      // DECLARED disposition. The derived `freshnessState` is never written here — that is the
      // whole point: the enforcement is that the declaration must agree with the computation.
      disposition: field<Disposition>(a, 'disposition') ?? 'current',
    }
    put(pProps, 'artifactPath', field<string>(a, 'artifactPath'))
    put(pProps, 'owner', field<string>(a, 'owner'))
    put(pProps, 'guardPath', field<string | null>(guard, 'path') ?? undefined)
    if (guard) pProps['guardInvokedByCi'] = field<boolean>(guard, 'invokedByCi') === true
    const remediation = asRec(field(a, 'remediation'))
    put(pProps, 'dueAt', field<string>(remediation, 'due'))
    put(pProps, 'targetVersion', field<string>(remediation, 'targetVersion'))
    const policyLabels = field<string[]>(a, 'policyLabels')
    if (Array.isArray(policyLabels) && policyLabels.length > 0) pProps['policyLabels'] = policyLabels.join(',')
    store.addNode(pinId, [VFP.VendorPin], pProps)
    store.addEdge(VFP_EDGE.pinnedAt, pinId, pinnedArtifactId)
    store.addEdge(VFP_EDGE.pinFor, pinId, appId)
    stats.pins++
  }

  return stats
}

// ─── Graph readers (pure) ───────────────────────────────────────────────────────

const str = (v: PropertyValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

/** Walk `vfp:supersededBy` forward from `artifactNodeId`, longest path, cycle-safe. */
function supersessionChain(store: HellGraphStore, artifactNodeId: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>([artifactNodeId])
  let cur = artifactNodeId
  for (;;) {
    // Deterministic when a release history forks: lowest node id wins, so the receipt is replayable.
    const next = store.out(cur, VFP_EDGE.supersededBy)
      .map((n) => n.id)
      .filter((id) => !seen.has(id))
      .sort()[0]
    if (next === undefined) return chain
    chain.push(next)
    seen.add(next)
    cur = next
  }
}

function artifactView(store: HellGraphStore, id: string): { artifactId: string; version: string; changesContract: ContractKind[] } {
  const n = store.getNode(id)
  const cc = str(n?.properties['changesContract'])
  return {
    artifactId: str(n?.properties['artifactId']) ?? id,
    version: str(n?.properties['version']) ?? 'unknown',
    changesContract: cc ? (cc.split(',') as ContractKind[]) : [],
  }
}

/** Every `vfp:VendorPin` node id in the store, in deterministic order. */
export function vendorPinIds(store: HellGraphStore): string[] {
  return store.nodesByLabel(VFP.VendorPin).map((n) => n.id).sort()
}

// ─── 1 ─ Staleness ──────────────────────────────────────────────────────────────

/** One artifact between the pin and the newest release — the path, not just its length. */
export interface InterveningArtifact {
  artifactId: string
  version: string
  /** Contracts this release declared it moved. Empty is a declaration, not an absence of data. */
  changesContract: ContractKind[]
}

export interface StalenessVerdict {
  pinId: string
  pinKey: string
  consumerApp: string
  consumerRepo: string
  artifactPath?: string
  pinnedVersion: string
  latestVersion: string
  /**
   * Number of `vfp:supersededBy` hops from the pinned artifact to the newest one. NOT a boolean:
   * "five behind" and "one behind" are different facts and the caller gets both.
   */
  releaseDistance: number
  /** The artifacts crossed, in release order. `releaseDistance === intervening.length`. */
  intervening: InterveningArtifact[]
  freshnessPolicy: FreshnessPolicy
  /** DERIVED, per the policy. */
  freshnessState: FreshnessState
  /** DECLARED in the register. */
  disposition: Disposition
  /**
   * Whether the declared disposition agrees with the derived state. Stale is a legitimate state to
   * be in; **stale-and-undeclared is not**, and that is the only thing this flag polices.
   */
  dispositionAgrees: boolean
  /** Why the state came out as it did, in words, for the receipt. */
  rationale: string
  owner?: string
  guardPath?: string
  guardInvokedByCi?: boolean
}

const majorOf = (v: string): string => v.split('.')[0] ?? v

/**
 * Derive the staleness of one pin from the graph.
 *
 * PURE — reads only. Returns the release distance and the intervening artifacts, because the
 * actionable question is never "is it stale" but "how far, across what".
 *
 * Policy semantics are the register's, implemented verbatim:
 *   • `pin-exact`    — never stale, but ONLY if upstream has actually been OBSERVED. A pin to
 *                      something nobody has looked at is `unknown`, not `current` — it is an
 *                      unknown wearing a pin's clothes.
 *   • `track-minor`  — stale if a newer artifact shares the pinned major, or if the newest
 *                      artifact's major differs at all.
 *   • `track-latest` — stale if the distance is greater than zero.
 */
export function stalenessOf(store: HellGraphStore, pinId: string): StalenessVerdict {
  const pin = store.getNode(pinId)
  if (!pin || !pin.labels.includes(VFP.VendorPin)) {
    throw new Error(`vendor-graph: ${pinId} is not a ${VFP.VendorPin} node`)
  }
  const pinnedArtifact = store.out(pinId, VFP_EDGE.pinnedAt)[0]
  if (!pinnedArtifact) throw new Error(`vendor-graph: pin ${pinId} has no ${VFP_EDGE.pinnedAt} edge`)

  const app = store.out(pinId, VFP_EDGE.pinFor)[0]
  const chain = supersessionChain(store, pinnedArtifact.id)
  const intervening = chain.map((id) => artifactView(store, id))
  const releaseDistance = intervening.length
  const pinnedVersion = str(pinnedArtifact.properties['version']) ?? 'unknown'
  const latestVersion = intervening.length > 0 ? intervening[intervening.length - 1]!.version : pinnedVersion

  const freshnessPolicy = (str(pin.properties['freshnessPolicy']) ?? 'track-minor') as FreshnessPolicy
  const disposition = (str(pin.properties['disposition']) ?? 'current') as Disposition

  // "Observed" means the source's release history is in the graph at all: an upstream nobody has
  // enumerated cannot be compared against, and saying `current` about it would be a guess.
  const observed = releaseDistance > 0 || store.in(pinnedArtifact.id, VFP_EDGE.supersededBy).length > 0
  let freshnessState: FreshnessState
  let rationale: string
  if (!observed) {
    freshnessState = 'unknown'
    rationale = `no upstream release history for ${pinnedVersion} in the graph — unobserved, not current`
  } else if (freshnessPolicy === 'pin-exact') {
    freshnessState = 'current'
    rationale = `pin-exact against an observed upstream: ${releaseDistance} newer release(s) exist and are deliberately not taken`
  } else if (freshnessPolicy === 'track-latest') {
    freshnessState = releaseDistance > 0 ? 'stale' : 'current'
    rationale = releaseDistance > 0
      ? `track-latest: ${releaseDistance} release(s) behind ${latestVersion}`
      : `track-latest: pinned at the newest release ${pinnedVersion}`
  } else {
    const sameMajorNewer = intervening.some((a) => majorOf(a.version) === majorOf(pinnedVersion))
    const majorMoved = releaseDistance > 0 && majorOf(latestVersion) !== majorOf(pinnedVersion)
    freshnessState = sameMajorNewer || majorMoved ? 'stale' : 'current'
    rationale = freshnessState === 'stale'
      ? (sameMajorNewer
        ? `track-minor: ${releaseDistance} newer release(s) share major ${majorOf(pinnedVersion)}, newest ${latestVersion}`
        : `track-minor: newest release ${latestVersion} changes major from ${majorOf(pinnedVersion)}`)
      : `track-minor: nothing newer within major ${majorOf(pinnedVersion)}`
  }

  // Agreement, not enforcement of freshness. A `current` declaration over a `stale` derivation is
  // the violation; every other declaration is an owner filing a finding, which is allowed.
  const dispositionAgrees = freshnessState === 'current'
    ? disposition === 'current' || disposition === 'waived'
    : freshnessState === 'unknown'
      ? disposition === 'observation-required'
      : disposition !== 'current'

  const verdict: StalenessVerdict = {
    pinId,
    pinKey: str(pin.properties['pinKey']) ?? pinId,
    consumerApp: str(app?.properties['appPath']) ?? 'unknown',
    consumerRepo: str(app?.properties['repoName']) ?? 'unknown',
    pinnedVersion,
    latestVersion,
    releaseDistance,
    intervening,
    freshnessPolicy,
    freshnessState,
    disposition,
    dispositionAgrees,
    rationale,
  }
  const artifactPath = str(pin.properties['artifactPath'])
  if (artifactPath !== undefined) verdict.artifactPath = artifactPath
  const owner = str(pin.properties['owner'])
  if (owner !== undefined) verdict.owner = owner
  const guardPath = str(pin.properties['guardPath'])
  if (guardPath !== undefined) verdict.guardPath = guardPath
  const gi = pin.properties['guardInvokedByCi']
  if (typeof gi === 'boolean') verdict.guardInvokedByCi = gi
  return verdict
}

// ─── 2 ─ Blast radius ───────────────────────────────────────────────────────────

export interface BlastRadiusConsumer {
  appId: string
  appPath: string
  consumerRepo: string
  pinId?: string
  pinKey?: string
  pinnedVersion: string
  /** Hops from what this consumer holds to the newest artifact already in the graph. */
  releaseDistance: number
  /** Would the bump cross a release that declared a contract change? */
  crossesContract: boolean
  contractKinds: ContractKind[]
}

export interface BlastRadiusReport {
  repository: string
  /** The release being contemplated. It need not exist — that is the point. */
  proposedVersion: string
  /** `| { c : ConsumerApp | ∃ a . c vendors a ∧ a producedBy R } |`. */
  count: number
  consumers: BlastRadiusConsumer[]
}

/**
 * Answer *what breaks if I cut `proposedVersion` of `repository`?* — **before** cutting it.
 *
 * PURE, and deliberately does NOT create a node for the proposed release: a query that has to
 * write the thing it is asking about is not a forecast. Counted over `vfp:ConsumerApp`, never over
 * `vfp:Repository` — one repository held two independent copies of the same tarball, and counting
 * repositories is what let the second one hide.
 */
export function blastRadiusOf(
  store: HellGraphStore,
  target: { repository: string; proposedVersion: string },
): BlastRadiusReport {
  const repoNodeId = vfpId.repository(target.repository)
  const produced = new Set(store.in(repoNodeId, VFP_EDGE.producedBy).map((n) => n.id))

  const consumers: BlastRadiusConsumer[] = []
  for (const app of store.nodesByLabel(VFP.ConsumerApp)) {
    const vendored = store.out(app.id, VFP_EDGE.vendors).filter((a) => produced.has(a.id))
    for (const artifact of vendored) {
      // The pin governing this app's copy of this artifact, if the register declared one.
      const pin = store.in(artifact.id, VFP_EDGE.pinnedAt)
        .find((p) => store.out(p.id, VFP_EDGE.pinFor).some((a) => a.id === app.id))
      const chain = supersessionChain(store, artifact.id).map((id) => artifactView(store, id))
      const kinds = new Set<ContractKind>()
      for (const a of chain) for (const k of a.changesContract) kinds.add(k)
      const row: BlastRadiusConsumer = {
        appId: app.id,
        appPath: str(app.properties['appPath']) ?? app.id,
        consumerRepo: str(app.properties['repoName']) ?? 'unknown',
        pinnedVersion: str(artifact.properties['version']) ?? 'unknown',
        releaseDistance: chain.length,
        crossesContract: kinds.size > 0,
        contractKinds: [...kinds].sort(),
      }
      if (pin) {
        row.pinId = pin.id
        const pk = str(pin.properties['pinKey'])
        if (pk !== undefined) row.pinKey = pk
      }
      consumers.push(row)
    }
  }
  consumers.sort((a, b) => a.appPath.localeCompare(b.appPath) || a.pinnedVersion.localeCompare(b.pinnedVersion))

  // The count is over DISTINCT consumer apps: an app vendoring two artifacts from the same
  // upstream is one thing that breaks, not two.
  const count = new Set(consumers.map((c) => c.appId)).size
  return { repository: target.repository, proposedVersion: target.proposedVersion, count, consumers }
}

// ─── 3 ─ Contract-crossing risk ─────────────────────────────────────────────────

export interface ContractCrossing {
  artifactId: string
  version: string
  kinds: ContractKind[]
  /** The `vfp:Contract` nodes the release moved, with whatever evidence was declared. */
  contracts: { id: string; kind: ContractKind; receiptFixture?: string; digest?: string; note?: string }[]
}

export interface ContractCrossingRisk {
  pinId: string
  pinnedVersion: string
  latestVersion: string
  /** `∃ a', r : a (supersededBy)+ a' ∧ a' releasedAs r ∧ r changesContract _`. */
  crossesContract: boolean
  /** Distinct kinds across the gap, sorted. */
  contractKinds: ContractKind[]
  /** Each contract-moving release in the gap, in release order. */
  crossings: ContractCrossing[]
}

/**
 * Does the gap span a release that moved a load-bearing contract?
 *
 * PURE. Contract changes are read from the DECLARED `vfp:changesContract` edges — never inferred
 * from the version numbers, which is why 0.4.43 (receipt shape) and 0.4.45 (Cypher projection) are
 * visible here at all: both are patch bumps and look identical to any semver heuristic.
 */
export function contractCrossingRiskOf(store: HellGraphStore, pinId: string): ContractCrossingRisk {
  const pin = store.getNode(pinId)
  if (!pin || !pin.labels.includes(VFP.VendorPin)) {
    throw new Error(`vendor-graph: ${pinId} is not a ${VFP.VendorPin} node`)
  }
  const pinnedArtifact = store.out(pinId, VFP_EDGE.pinnedAt)[0]
  if (!pinnedArtifact) throw new Error(`vendor-graph: pin ${pinId} has no ${VFP_EDGE.pinnedAt} edge`)

  const chain = supersessionChain(store, pinnedArtifact.id)
  const crossings: ContractCrossing[] = []
  const kinds = new Set<ContractKind>()
  for (const artifactNodeId of chain) {
    const contracts: ContractCrossing['contracts'] = []
    for (const release of store.out(artifactNodeId, VFP_EDGE.releasedAs)) {
      for (const c of store.out(release.id, VFP_EDGE.changesContract)) {
        const kind = (str(c.properties['contractKind']) ?? 'schema') as ContractKind
        kinds.add(kind)
        const entry: ContractCrossing['contracts'][number] = { id: c.id, kind }
        const rf = str(c.properties['receiptFixture']); if (rf !== undefined) entry.receiptFixture = rf
        const dg = str(c.properties['digest']); if (dg !== undefined) entry.digest = dg
        const nt = str(c.properties['note']); if (nt !== undefined) entry.note = nt
        contracts.push(entry)
      }
    }
    if (contracts.length === 0) continue
    contracts.sort((a, b) => a.id.localeCompare(b.id))
    const view = artifactView(store, artifactNodeId)
    crossings.push({
      artifactId: view.artifactId,
      version: view.version,
      kinds: [...new Set(contracts.map((c) => c.kind))].sort(),
      contracts,
    })
  }

  const latest = chain.length > 0 ? artifactView(store, chain[chain.length - 1]!).version : (str(pinnedArtifact.properties['version']) ?? 'unknown')
  return {
    pinId,
    pinnedVersion: str(pinnedArtifact.properties['version']) ?? 'unknown',
    latestVersion: latest,
    crossesContract: crossings.length > 0,
    contractKinds: [...kinds].sort(),
    crossings,
  }
}

// ─── The governed trigger: an EffectRequest PROPOSAL ────────────────────────────

/** A sourceos-spec `EffectRequest`, exactly as the vendored schema declares it. */
export interface EffectRequest {
  id: string
  type: 'EffectRequest'
  specVersion: string
  requestedByEventRef: string
  effectKind: 'update'
  capability: 'vendor.revendor'
  target: { kind: 'vendor-pin'; identifier: string; location?: string }
  parameters: {
    fromVersion: string
    toVersion: string
    gapSize: number
    blastRadius: number
    crossesContract: boolean
    contractKinds: ContractKind[]
  }
  idempotencyKey: string
  requiresHumanApproval: boolean
  policyLabels: string[]
  riskLabels: string[]
  requestedAt: string
  notes?: string
}

/**
 * A re-vendor proposal. `status` is `'proposed'` and there is no other value: the engine emits the
 * request and stops. Whether anything happens is an `EffectDecision`, taken by a membrane gate
 * outside this engine.
 */
export interface RevendorProposal {
  pinId: string
  /** Always `proposed`. An EffectDecision must precede any world change. */
  status: 'proposed'
  effectRequest: EffectRequest
  /** Violations of the vendored contract. Non-empty means the proposal is NOT emitted. */
  contractViolations: string[]
}

export interface ProposeOptions {
  /**
   * ISO-8601 date-time for `requestedAt`. Required by the contract, and taken from the CALLER (or
   * from the declared observation) rather than from the clock — a wall-clock read would make the
   * analysis seal differ on every run, and an unreplayable receipt is not a receipt.
   */
  requestedAt: string
  /** URN of the observation event that produced the finding. */
  requestedByEventRef?: string
  /** Blast radius to carry; computed by the caller so one graph walk serves every proposal. */
  blastRadius?: number
}

/**
 * Emit a re-vendor **proposal** for one pin as an `EffectRequest`-shaped object, validated against
 * the sha-asserted vendored contract.
 *
 * This is the whole governed trigger, and it is a proposal only. Nothing here re-vendors, opens a
 * PR, writes to the store, or touches the network — the same restriction `nlq.ts`'s restricted
 * search obeys, for the same reason: the MPCC lifecycle (EffectRequest → EffectDecision →
 * EffectRecord; decision before action) must never be bypassed by the thing that noticed the
 * problem. `requiresHumanApproval` is forced true whenever the gap crosses a contract.
 *
 * PURE with respect to the graph.
 */
export function proposeRevendor(store: HellGraphStore, pinId: string, opts: ProposeOptions): RevendorProposal {
  // `requestedAt` carries the contract's `format: "date-time"`, which the shared validator now
  // implements — so this asks that ONE implementation (`matchesFormat`) rather than keeping a second
  // copy of the rule here. It stays a THROW rather than a `contractViolations` entry because
  // `analyzeVendorFreshness` seals whatever proposals this returns without reading that array: a bad
  // `requestedAt` reaching the seal must stop the run, not ride along inside it.
  if (!matchesFormat('date-time', opts.requestedAt)) {
    throw new Error(`vendor-graph: requestedAt '${opts.requestedAt}' is not an ISO-8601 date-time`)
  }
  const verdict = stalenessOf(store, pinId)
  const risk = contractCrossingRiskOf(store, pinId)
  const pin = store.getNode(pinId)!

  const toVersion = str(pin.properties['targetVersion']) ?? verdict.latestVersion
  const location = verdict.artifactPath !== undefined
    ? `${verdict.consumerRepo}/${verdict.artifactPath}`
    : undefined

  const riskLabels = risk.crossesContract ? ['contract-crossing', ...risk.contractKinds] : []
  const declaredLabels = str(pin.properties['policyLabels'])

  const effectRequest: EffectRequest = {
    id: `urn:srcos:effect:vendor-revendor.${slug(verdict.pinKey)}.${slug(verdict.pinnedVersion)}-${slug(toVersion)}`,
    type: 'EffectRequest',
    specVersion: EFFECT_REQUEST_SPEC_VERSION,
    requestedByEventRef: opts.requestedByEventRef ?? `urn:srcos:vendor-freshness:${slug(verdict.pinKey)}`,
    effectKind: 'update',
    capability: 'vendor.revendor',
    target: {
      kind: 'vendor-pin',
      identifier: verdict.pinKey,
      ...(location !== undefined ? { location } : {}),
    },
    parameters: {
      fromVersion: verdict.pinnedVersion,
      toVersion,
      gapSize: verdict.releaseDistance,
      blastRadius: opts.blastRadius ?? 0,
      crossesContract: risk.crossesContract,
      contractKinds: risk.contractKinds,
    },
    // A re-emitted finding must not open a second PR.
    idempotencyKey: `${verdict.pinKey}@${verdict.pinnedVersion}->${toVersion}`,
    requiresHumanApproval: risk.crossesContract,
    policyLabels: declaredLabels ? declaredLabels.split(',') : [],
    riskLabels,
    requestedAt: opts.requestedAt,
  }

  const contractViolations: string[] = []
  validateAgainst(EFFECT_REQUEST_SCHEMA as SchemaObj, effectRequest, 'EffectRequest', contractViolations)
  return { pinId, status: 'proposed', effectRequest, contractViolations }
}

// ─── Sealed analysis ────────────────────────────────────────────────────────────

export interface VendorFreshnessAnalysis {
  method: string
  /** The effect contract proposals were validated against — sealed in, so a receipt names it. */
  contract: EffectContractRef
  /** `seq` = the store's monotonic logical clock — the receipt's real binding to graph state. */
  snapshot: { seq: number; nodes: number; edges: number }
  /** One verdict per `vfp:VendorPin`, in deterministic pin order. */
  pins: StalenessVerdict[]
  /** Contract-crossing risk per pin, same order. */
  risks: ContractCrossingRisk[]
  /** Blast radius per producing repository, sorted by repo name. */
  blastRadius: BlastRadiusReport[]
  /** Pins whose DECLARED disposition contradicts the DERIVED state — the only hard violation. */
  dispositionViolations: string[]
  /** Re-vendor proposals. Emitted, never executed; empty unless `requestedAt` is supplied. */
  proposals: RevendorProposal[]
  /** sha256 over everything above (proof-carrying). */
  hash: string
}

export interface AnalyzeOptions {
  /**
   * ISO-8601 date-time stamped onto emitted proposals. Omit and NO proposals are emitted — the
   * analysis will not invent a clock reading, because that would break the seal's determinism.
   */
  requestedAt?: string
  /** Restrict the analysis to these pin node ids. Default: every pin in the graph. */
  pinIds?: string[]
}

const METHOD = 'vendor-graph(staleness,blast-radius,contract-crossing)'

function sealed(rec: Omit<VendorFreshnessAnalysis, 'hash'>): VendorFreshnessAnalysis {
  return { ...rec, hash: 'sha256:' + createHash('sha256').update(JSON.stringify(rec)).digest('hex') }
}

/**
 * Run all three derived questions over every pin in the graph and seal the result.
 *
 * PURE — `store.version()` is identical before and after; the analysis writes nothing, and in
 * particular does not materialize the `vfp:Finding` nodes the vocabulary describes, because a
 * reasoner that mutates the graph it reasons over cannot be replayed against it.
 *
 * Deterministic: same graph state + same options ⇒ byte-identical `hash`.
 */
export function analyzeVendorFreshness(store: HellGraphStore, opts: AnalyzeOptions = {}): VendorFreshnessAnalysis {
  const snapshot = { seq: store.version(), nodes: store.allNodes().length, edges: store.edgeCount() }
  const pinIds = (opts.pinIds ?? vendorPinIds(store)).slice().sort()

  const pins = pinIds.map((id) => stalenessOf(store, id))
  const risks = pinIds.map((id) => contractCrossingRiskOf(store, id))

  // One blast-radius report per repository that produces something somebody vendors.
  const producing = new Set<string>()
  for (const app of store.nodesByLabel(VFP.ConsumerApp)) {
    for (const artifact of store.out(app.id, VFP_EDGE.vendors)) {
      for (const repo of store.out(artifact.id, VFP_EDGE.producedBy)) {
        const name = str(repo.properties['repoName'])
        if (name) producing.add(name)
      }
    }
  }
  // "What breaks if I cut the next one?" — the proposed version is the newest release the graph
  // knows about, which is exactly what a consumer would be moved to. No node is created for it.
  const blastRadius = [...producing].sort().map((repository) =>
    blastRadiusOf(store, { repository, proposedVersion: newestReleasedVersion(store, repository) }))

  const dispositionViolations = pins.filter((p) => !p.dispositionAgrees)
    .map((p) => `${p.pinKey}: declared '${p.disposition}' but derived '${p.freshnessState}' (${p.rationale})`)

  const proposals = opts.requestedAt === undefined ? [] : pins
    .filter((p) => p.freshnessState === 'stale')
    .map((p) => {
      const repo = store.out(store.out(p.pinId, VFP_EDGE.pinnedAt)[0]?.id ?? '', VFP_EDGE.producedBy)[0]
      const repoName = str(repo?.properties['repoName'])
      const br = blastRadius.find((b) => b.repository === repoName)
      return proposeRevendor(store, p.pinId, {
        requestedAt: opts.requestedAt!,
        ...(br ? { blastRadius: br.count } : {}),
      })
    })

  return sealed({
    method: METHOD,
    contract: { ...EFFECT_REQUEST_CONTRACT },
    snapshot,
    pins,
    risks,
    blastRadius,
    dispositionViolations,
    proposals,
  })
}

/** The newest version this repository has released, per the graph. Read-only. */
function newestReleasedVersion(store: HellGraphStore, repository: string): string {
  const repoNodeId = vfpId.repository(repository)
  const produced = store.in(repoNodeId, VFP_EDGE.producedBy)
  // The newest artifact is the one nothing supersedes.
  const heads = produced.filter((a) => store.out(a.id, VFP_EDGE.supersededBy).length === 0)
  const versions = heads.map((a) => str(a.properties['version']) ?? '').filter(Boolean).sort()
  return versions[versions.length - 1] ?? 'unknown'
}

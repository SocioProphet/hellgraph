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
  const seenRelease = new Set<string>()

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

      // Gated like every other counter. `stats.releases++` was unguarded, so it counted manifest
      // LINES while `artifacts`, `contracts`, `repositories` and `consumerApps` counted NODES
      // CREATED — and a register that declares the same release twice (two entries for one
      // `source_id`, the ordinary way a fork is written) made the two disagree with no way for a
      // caller to tell which question it had asked. First declaration wins, as it already does for
      // artifacts; the `releasedAs` edge is still drawn either way.
      const releaseId = vfpId.release(sourceId, version)
      if (!seenRelease.has(releaseId)) {
        seenRelease.add(releaseId)
        const rProps: Record<string, PropertyValue> = { version, sourceId }
        put(rProps, 'observedAt', field<string>(r, 'observedAt'))
        store.addNode(releaseId, [VFP.Release], rProps)
        stats.releases++
      }
      store.addEdge(VFP_EDGE.releasedAs, artifactId, releaseId)

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
      // Only if the source actually declares a repo. `?? ''` built `vfp:repo/` — an edge to the
      // empty repository id, whose target node the source loop never created because it skips
      // sources with no `repo`. A dangling edge is worse here than a missing one: `store.in()` on
      // that id is a query anyone can run, and the graph's claim is that receipts derive from it.
      // Routed through `ensureRepo` so the target is guaranteed to exist rather than assumed to.
      const src = sources.find((s) => field<string>(s, 'sourceId') === sourceId)
      const srcRepo = src ? field<string>(src, 'repo') ?? '' : ''
      if (src && srcRepo) {
        const producerId = ensureRepo(srcRepo, field<string>(src, 'url'), field<string>(src, 'workspaceBinding'))
        store.addEdge(VFP_EDGE.producedBy, pinnedArtifactId, producerId)
      }
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

// ─── Version precedence ─────────────────────────────────────────────────────────

/**
 * Compare two version strings by RELEASE PRECEDENCE. Returns <0, 0, >0 for `a` before, equal to,
 * or after `b`, so it drops straight into `Array.prototype.sort`.
 *
 * The default `.sort()` is ASCII, and ASCII ranks `0.4.9` above `0.4.46` — not a hypothetical, this
 * engine is at 0.4.46. It also ranks the literal `unknown` and any commit sha above every real
 * release, because letters sort above digits, and this graph holds both: a pin may name a version
 * the release history does not list, and that artifact is a head like any other.
 *
 * **The ordering is TOTAL and documented, because an undocumented tie-break is how this class of
 * bug comes back.** In order of application:
 *
 *  1. **Shape.** A version is *release-shaped* if it is an optional `v`, then dot-separated runs of
 *     digits, then an optional `-prerelease`, then an optional `+build`. Everything else — commit
 *     shas, dates, `unknown`, the empty string — is **not a release** and sorts BELOW every
 *     release-shaped version. Two non-release strings compare by ASCII between themselves. This is
 *     the rule that stops `unknown` from being proposed as the next release to cut.
 *  2. **Release components, numerically**, left to right. A missing component is `0`, so `0.4` and
 *     `0.4.0` name the same release (and `0.4` precedes `0.4.1`). Compared as digit strings rather
 *     than via `Number`, so precision does not silently collapse two distinct versions into a tie.
 *  3. **Prerelease loses to the release** (semver §11): `1.0.0-rc.1` precedes `1.0.0`.
 *  4. **Between two prereleases**, semver §11 identifier precedence: dot-separated identifiers
 *     left to right; all-digit identifiers compare numerically and rank BELOW alphanumeric ones;
 *     alphanumeric identifiers compare by ASCII; a prefix ranks below a longer identifier list, so
 *     `rc.1` precedes `rc.1.1`. Deliberately NOT ASCII on the whole suffix, which would put
 *     `rc.10` below `rc.2` and reintroduce the very defect this function exists to remove.
 *  5. **Build metadata is ignored** for precedence (semver §10).
 *  6. **Final tie-break: ASCII on the raw string**, so **`compareVersions` returns `0` only for
 *     two identical strings.** Versions that name the same release but are written differently —
 *     `0.4` and `0.4.0`, `1.0.0` and `v1.0.0`, `1.0.0+a` and `1.0.0+b` — tie under rules 1–5 and
 *     are then ordered by their raw text. That is the deliberate choice: an unresolved tie makes a
 *     sort's output depend on the input order, and the result of this sort is sealed into a
 *     receipt that has to be re-derivable from the graph alone. Equal precedence, ordered anyway.
 */
export function compareVersions(a: string, b: string): number {
  const ascii = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0)
  const pa = parseVersion(a)
  const pb = parseVersion(b)

  // (1) Non-releases sort below every release.
  if (pa === undefined || pb === undefined) {
    if (pa === undefined && pb === undefined) return ascii(a, b)
    return pa === undefined ? -1 : 1
  }

  // (2) Release components, numerically, missing ⇒ 0.
  const components = Math.max(pa.release.length, pb.release.length)
  for (let i = 0; i < components; i++) {
    const d = compareNumericIds(pa.release[i] ?? '0', pb.release[i] ?? '0')
    if (d !== 0) return d
  }

  // (3) Same release: a prerelease ranks below the release it leads to.
  if (pa.prerelease === undefined || pb.prerelease === undefined) {
    if (pa.prerelease === undefined && pb.prerelease === undefined) return ascii(a, b) // (5)(6)
    return pa.prerelease === undefined ? 1 : -1
  }

  // (4) Both prereleases: semver §11 identifier precedence.
  const ids = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < ids; i++) {
    const x = pa.prerelease[i]
    const y = pb.prerelease[i]
    if (x === undefined) return -1 // a shorter identifier list ranks below a longer one
    if (y === undefined) return 1
    const xNum = isDigits(x)
    const yNum = isDigits(y)
    if (xNum !== yNum) return xNum ? -1 : 1 // numeric identifiers rank below alphanumeric
    const d = xNum ? compareNumericIds(x, y) : ascii(x, y)
    if (d !== 0) return d
  }
  return ascii(a, b) // (6)
}

/** A version split into the parts that decide precedence. `prerelease` absent ⇒ a plain release. */
interface ParsedVersion {
  /** Dot-separated numeric components, kept as digit strings so comparison stays exact. */
  release: string[]
  prerelease: string[] | undefined
}

const isDigits = (s: string): boolean => {
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 48 || c > 57) return false
  }
  return true
}

/** Compare two all-digit identifiers exactly: leading zeros dropped, then length, then ASCII. */
function compareNumericIds(x: string, y: string): number {
  let i = 0
  let j = 0
  while (i < x.length - 1 && x.charCodeAt(i) === 48) i++
  while (j < y.length - 1 && y.charCodeAt(j) === 48) j++
  const sx = x.slice(i)
  const sy = y.slice(j)
  if (sx.length !== sy.length) return sx.length < sy.length ? -1 : 1
  return sx < sy ? -1 : sx > sy ? 1 : 0
}

/**
 * Parse a version into release components and prerelease identifiers, or `undefined` if it is not
 * release-shaped.
 *
 * Hand-scanned rather than matched with a regex, deliberately: these strings come from the vendor
 * register, `slug()` in this same file already had a CodeQL `js/polynomial-redos` finding on a
 * register-supplied value, and a nested-quantifier version pattern is the textbook way to earn a
 * second one. This scan is linear and cannot backtrack.
 */
function parseVersion(raw: string): ParsedVersion | undefined {
  let s = raw
  if (s.charCodeAt(0) === 118 /* v */) s = s.slice(1)
  const plus = s.indexOf('+')
  if (plus !== -1) s = s.slice(0, plus) // build metadata is not part of precedence
  const dash = s.indexOf('-')
  const core = dash === -1 ? s : s.slice(0, dash)
  const pre = dash === -1 ? undefined : s.slice(dash + 1)
  if (core.length === 0) return undefined

  const release = core.split('.')
  for (const component of release) if (!isDigits(component)) return undefined

  if (pre === undefined) return { release, prerelease: undefined }
  const prerelease = pre.split('.')
  // An empty identifier (`1.0.0-`, `1.0.0-a..b`) is not a legal prerelease, so the string is not
  // release-shaped at all — better a documented non-release than a silent partial parse.
  for (const id of prerelease) if (id.length === 0) return undefined
  return { release, prerelease }
}

// ─── Graph readers (pure) ───────────────────────────────────────────────────────

const str = (v: PropertyValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Walk `vfp:supersededBy` forward from `artifactNodeId`, cycle-safe.
 *
 * On a fork this takes the LOWEST NEXT NODE ID — not the longest path, which is what this
 * docstring used to claim while the code two lines below did, and said it did, something else.
 * Lowest-id is the correct rule and the deliberate one: the walk has to be replayable from the
 * graph alone or the receipt it feeds cannot be re-derived, and "longest" is not decidable in one
 * forward pass anyway. The consequence is that the chain is the deterministic branch, not
 * necessarily the deepest one, and `releaseDistance` counts hops along it.
 */
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
  /**
   * The newest release the POLICY is willing to take — which is not always `latestVersion`.
   *
   * `track-latest` takes the newest release; `pin-exact` takes nothing, so it is the pinned
   * version; `track-minor` takes the newest release **on the pinned `x.y` line**, which is
   * `0.4.47` even when `0.5.0` exists. This is the version `proposeRevendor` proposes: without
   * it a policy that correctly REFUSES a cross-minor bump would still emit a proposal to make
   * it, and the refusal would be a verdict nobody acts on.
   *
   * Required, not optional. Like every other field on this verdict it is DERIVED and always
   * produced — `stalenessOf` seeds it with `pinnedVersion` and only ever narrows it — and
   * `StalenessVerdict` is an OUTPUT type: produced here, read by consumers, not constructed by
   * them. Adding a field a reader will simply receive is not a break; making it optional would
   * instead push an `undefined` that never occurs onto every read site (`proposeRevendor` reads it
   * unconditionally). If a downstream ever does construct this verdict, that call site wanting the
   * new field set is the correct signal, not a reason to weaken the type.
   */
  policyTargetVersion: string
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

/**
 * The `x.y` line a version belongs to — the lane a `track-minor` pin follows — or `undefined`
 * if the version is not release-shaped and therefore has no lane.
 *
 * Derived through `parseVersion`, not `split('.')`: `v0.4.46`, `0.4.46+build.7` and `0.4` all
 * name a point on the `0.4` line, and a commit sha or the literal `unknown` names no line at
 * all. A missing minor is `0` (`1` and `1.0` are the same lane), matching `compareVersions`,
 * which already treats a missing component as `0`.
 */
function minorLineOf(v: string): string | undefined {
  const p = parseVersion(v)
  if (!p) return undefined
  return `${p.release[0] ?? '0'}.${p.release[1] ?? '0'}`
}

/** Is `v` a prerelease (`1.0.0-rc.1`)? Non-release-shaped strings are not. */
const isPrerelease = (v: string): boolean => parseVersion(v)?.prerelease !== undefined

/**
 * Derive the staleness of one pin from the graph.
 *
 * PURE — reads only. Returns the release distance and the intervening artifacts, because the
 * actionable question is never "is it stale" but "how far, across what".
 *
 * Policy semantics are the register's:
 *   • `pin-exact`    — never stale, but ONLY if upstream has actually been OBSERVED. A pin to
 *                      something nobody has looked at is `unknown`, not `current` — it is an
 *                      unknown wearing a pin's clothes.
 *   • `track-minor`  — the pin follows ONE MINOR LINE, `x.y.*`. Stale when a newer release lands
 *                      ON that line; NOT stale when the only newer releases have left it.
 *   • `track-latest` — stale if the distance is greater than zero.
 *
 * ── `track-minor` used to mean `track-latest` ───────────────────────────────────────────
 * The previous implementation was
 *
 *     const sameMajorNewer = intervening.some((a) => majorOf(a.version) === majorOf(pinnedVersion))
 *     const majorMoved     = releaseDistance > 0 && majorOf(latestVersion) !== majorOf(pinnedVersion)
 *     freshnessState = sameMajorNewer || majorMoved ? 'stale' : 'current'
 *
 * — MAJOR, not minor, and the two arms between them are exhaustive: if nothing newer shares the
 * pinned major then the newest cannot either, so `majorMoved` fires. `releaseDistance > 0` was
 * therefore ALWAYS stale, and `track-minor` was `track-latest` with a major-shaped rationale
 * string attached. Three declared policies, two distinct behaviours. A register author writing
 * `freshness_policy: track-minor` — the DEFAULT, and what every pin in the live vendor register
 * declares — was silently opted in to cross-minor bumps: a pin at `0.4.46` was reported stale
 * against `0.5.0` and a re-vendor proposal to `0.5.0` was emitted and sealed for it.
 *
 * Now: a `track-minor` pin at `0.4.46` is stale against `0.4.47` and CURRENT against `0.5.0`.
 * Leaving the line is a deliberate act — an owner editing the pin, or declaring `track-latest` —
 * not something the freshness plane proposes on the owner's behalf. The rationale names the
 * off-line releases anyway, so `current` here never means "nothing happened upstream".
 *
 * Two boundary rules, both stated so they are not rediscovered as bugs:
 *   · A pin whose version is NOT release-shaped (a sha, `unknown`) has no minor line to follow,
 *     so its state is `unknown`, not a guess in either direction — the same answer this function
 *     already gives an unobserved pin, for the same reason.
 *   · A PRERELEASE does not make a stable pin stale (`0.4.47-rc.1` leaves `0.4.46` current),
 *     matching how semver ranges treat prereleases: opt-in, never inherited. A pin that is
 *     itself a prerelease does follow them.
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
  // Defaults to the pinned version: a policy that takes nothing proposes nothing.
  let policyTargetVersion = pinnedVersion
  if (!observed) {
    freshnessState = 'unknown'
    rationale = `no upstream release history for ${pinnedVersion} in the graph — unobserved, not current`
  } else if (freshnessPolicy === 'pin-exact') {
    freshnessState = 'current'
    rationale = `pin-exact against an observed upstream: ${releaseDistance} newer release(s) exist and are deliberately not taken`
  } else if (freshnessPolicy === 'track-latest') {
    freshnessState = releaseDistance > 0 ? 'stale' : 'current'
    policyTargetVersion = latestVersion
    rationale = releaseDistance > 0
      ? `track-latest: ${releaseDistance} release(s) behind ${latestVersion}`
      : `track-latest: pinned at the newest release ${pinnedVersion}`
  } else {
    const line = minorLineOf(pinnedVersion)
    if (line === undefined) {
      // No lane can be derived, so neither `stale` nor `current` is a fact. Saying either would
      // be inventing one; `unknown` is the state this function already has for exactly that.
      freshnessState = 'unknown'
      rationale = `track-minor: pinned version '${pinnedVersion}' is not release-shaped, so it names no ` +
        `x.y line to follow — undecidable, not current (declare pin-exact or track-latest, or pin a release)`
    } else {
      // In-lane: same x.y line, strictly newer by PRECEDENCE (not by chain position — a register
      // may declare its releases out of order), and not a prerelease unless the pin is one.
      const followsPre = isPrerelease(pinnedVersion)
      const onLine = intervening.filter((a) =>
        minorLineOf(a.version) === line &&
        compareVersions(a.version, pinnedVersion) > 0 &&
        (followsPre || !isPrerelease(a.version)))
      const offLine = intervening.filter((a) => minorLineOf(a.version) !== line)
      freshnessState = onLine.length > 0 ? 'stale' : 'current'
      // The newest in-lane release by PRECEDENCE, not by chain position. `onLine` preserves the
      // supersession-chain order, which is the register's declared order and — as the filter above
      // says — may be out of order; `onLine[last]` would therefore reintroduce the exact chain-vs-
      // precedence defect this stack removes, one level down (an out-of-order `[0.4.46, 0.4.9]`
      // would propose `0.4.9` and seal a receipt whose rationale calls it "newest"). Reduce by
      // `compareVersions` — the same ranking `newestReleasedVersion` uses for the same reason.
      const newestOnLine = onLine.length > 0
        ? onLine.reduce((m, a) => (compareVersions(a.version, m.version) > 0 ? a : m)).version
        : undefined
      // The proposal target is the newest IN-LANE release, never `latestVersion`. `0.5.0` being
      // newer is not a reason to propose it to a pin that follows `0.4.*`.
      if (newestOnLine !== undefined) policyTargetVersion = newestOnLine
      const offLineNote = offLine.length > 0
        ? ` (${offLine.length} newer release(s) have left the ${line} line — ${offLine.map((a) => a.version).join(', ')} — ` +
          `not followed under track-minor)`
        : ''
      rationale = freshnessState === 'stale'
        ? `track-minor: ${onLine.length} newer release(s) on the pinned ${line} line, newest ${newestOnLine}${offLineNote}`
        : `track-minor: nothing newer on the pinned ${line} line${offLineNote || ` (newest overall ${latestVersion})`}`
    }
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
    policyTargetVersion,
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

  // `policyTargetVersion`, not `latestVersion`. They differ exactly when the policy declines the
  // newest release — a `track-minor` pin at 0.4.46 with 0.4.47 and 0.5.0 upstream is stale, and
  // the proposal it earns is `→ 0.4.47`. Proposing `→ 0.5.0` there would hand a human the very
  // cross-minor bump the policy exists to withhold, over a rationale that says it was withheld.
  const toVersion = str(pin.properties['targetVersion']) ?? verdict.policyTargetVersion
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
  /** Pins whose DECLARED disposition contradicts the DERIVED state. */
  dispositionViolations: string[]
  /**
   * Proposals WITHHELD because they did not validate against the vendored contract, as
   * `${pinKey}: ${violation}`. `RevendorProposal.contractViolations` says a violating proposal is
   * not emitted; this is where the ones that were not emitted are named, so the withholding is
   * visible in the seal instead of being a silent omission.
   */
  contractViolations: string[]
  /**
   * Re-vendor proposals. Emitted, never executed; empty unless `requestedAt` is supplied.
   * Contains only proposals that validated — see `contractViolations` for the rest.
   */
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

  const candidates = opts.requestedAt === undefined ? [] : pins
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

  // `RevendorProposal.contractViolations` has always said "non-empty means the proposal is NOT
  // emitted". Nothing implemented that sentence: every candidate was sealed regardless, and the
  // array had no reader anywhere in the repo — no branch, no `.length`, no throw. A violation
  // sealed into a receipt nobody reads is worse than no check, because the receipt then carries
  // evidence that the system looked.
  //
  // So the declared rule is now the actual rule: a violating proposal is WITHHELD, and its
  // violations are named at the top level the way `dispositionViolations` already is. Withholding
  // alone would be a silent drop, and naming alone would leave a consumer free to act on a
  // proposal the contract says was never emitted; it takes both.
  //
  // Reported, not thrown. `analyzeVendorFreshness` is documented PURE and deterministic, and one
  // malformed pin must not destroy the verdicts for every other pin in the run — the same reason
  // `dispositionViolations` is a list and not an exception. The engine proposes; a membrane gate
  // outside it decides.
  const proposals = candidates.filter((p) => p.contractViolations.length === 0)
  const contractViolations = candidates
    .filter((p) => p.contractViolations.length > 0)
    .flatMap((p) => p.contractViolations.map((v) => `${p.effectRequest.target.identifier}: ${v}`))

  return sealed({
    method: METHOD,
    contract: { ...EFFECT_REQUEST_CONTRACT },
    snapshot,
    pins,
    risks,
    blastRadius,
    dispositionViolations,
    contractViolations,
    proposals,
  })
}

/**
 * The newest version this repository has released, per the graph. Read-only.
 *
 * A repository can produce several artifacts — this one produces an npm package and a Rust crate —
 * so the head set routinely holds more than one candidate and they have to be RANKED. Ranked by
 * `compareVersions`, never by `.sort()`: ASCII put `0.4.9` ahead of `0.4.46`, and put a pin's
 * commit sha or the literal `unknown` ahead of every real release. This value is handed to
 * `blastRadiusOf` as `proposedVersion`, so getting it wrong misnames the release in every
 * blast-radius report the analysis seals.
 */
function newestReleasedVersion(store: HellGraphStore, repository: string): string {
  const repoNodeId = vfpId.repository(repository)
  const produced = store.in(repoNodeId, VFP_EDGE.producedBy)
  // The newest artifact is the one nothing supersedes.
  const heads = produced.filter((a) => store.out(a.id, VFP_EDGE.supersededBy).length === 0)
  const versions = heads.map((a) => str(a.properties['version']) ?? '').filter(Boolean).sort(compareVersions)
  return versions[versions.length - 1] ?? 'unknown'
}

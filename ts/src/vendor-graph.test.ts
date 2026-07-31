import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { loadKkoIntoAtomSpace } from './kko'
import {
  ingestVendorFreshness, stalenessOf, blastRadiusOf, contractCrossingRiskOf,
  proposeRevendor, analyzeVendorFreshness, vendorPinIds, vfpId, compareVersions,
  VFP, VFP_EDGE, VFP_KKO_TYPES, VFP_NS, EFFECT_REQUEST_CONTRACT, EFFECT_REQUEST_SCHEMA,
} from './vendor-graph'
import { validateAgainst } from './nlq'

/**
 * The REAL situation, as declared in sociosphere `registry/vendor-freshness.yaml` and lifted in
 * `registry/vendor-freshness/lift.engine-pins.ttl` on 2026-07-29:
 *
 *   • engine 0.4.40 vendored by TWO consumer apps in one repo — `apps/hellgraph-service` (a PR is
 *     open) and `apps/lifecycle-warden` (no PR, no guard at all, the copy nobody noticed).
 *   • upstream `main` is at 0.4.45 — five releases invisible in production.
 *   • 0.4.43 declared receipt-shape-relevant: it re-implemented `attribute-rank` peer discovery as
 *     an inverted index, and `apps/compute-gateway` pins golden sealed receipts to the 0.4.40 dist.
 *   • 0.4.45 declared schema-relevant: the silent-wrong Cypher property-projection fix.
 *
 * Written in the register's own snake_case, because that is what `JSON.parse` of the parsed YAML
 * hands over — the ingest is exercised against the shape it will really be fed.
 */
const REGISTER = {
  manifest_id: 'vendor-freshness-plane-v0',
  policy: { observation_max_age_days: 90, default_freshness_policy: 'track-minor' },
  sources: [
    {
      source_id: 'hellgraph-engine',
      repo: 'SocioProphet/hellgraph',
      url: 'https://github.com/SocioProphet/hellgraph',
      artifact_kind: 'npm-tarball',
      version_scheme: 'semver',
      package_name: '@socioprophet/hellgraph',
      upstream_latest_version: '0.4.45',
      observed_at: '2026-07-29',
      releases: [
        { version: '0.4.40', digest: 'sha256:a1f477969c8f335f95d806baeee349c8d1bbfc9e288665f20caa8a2a016aa6e0' },
        { version: '0.4.41' },
        { version: '0.4.42' },
        {
          version: '0.4.43',
          changes_contract: [{
            kind: 'receipt-shape',
            id: 'enrich-receipt',
            note: 'attribute-rank peer discovery re-implemented as an inverted index',
            receipt_fixture: 'apps/compute-gateway/tests/test_engine_seal.py',
            digest: 'sha256:018f2febf0c76f91752ba9726c9a32a4a8d3ca03895a5d877b780c312d34cc71',
          }],
        },
        { version: '0.4.44' },
        {
          version: '0.4.45',
          version_marker: 'PROP_NS = "prop:"',
          changes_contract: [{ kind: 'schema', id: 'cypher-projection', note: 'Cypher property projection' }],
        },
      ],
    },
  ],
  artifacts: [
    {
      artifact_id: 'hellgraph-engine@hellgraph-service',
      source_id: 'hellgraph-engine',
      consumer_repo: 'SocioProphet/prophet-platform',
      consumer_app: 'apps/hellgraph-service',
      artifact_path: 'apps/hellgraph-service/vendor/socioprophet-hellgraph-0.4.40.tgz',
      vendored_version: '0.4.40',
      vendored_digest: 'sha256:a1f477969c8f335f95d806baeee349c8d1bbfc9e288665f20caa8a2a016aa6e0',
      freshness_policy: 'track-minor',
      owner: '@mdheller',
      disposition: 'remediation-open',
      guard: {
        path: 'apps/hellgraph-service/scripts/check-engine-version.mjs',
        floor_constant: 'MIN_ENGINE',
        floor_value: '0.4.40',
        invoked_by_ci: false,
      },
      remediation: { target_version: '0.4.45', pull_request: 'https://github.com/SocioProphet/prophet-platform/pull/1030' },
    },
    {
      artifact_id: 'hellgraph-engine@lifecycle-warden',
      source_id: 'hellgraph-engine',
      consumer_repo: 'SocioProphet/prophet-platform',
      consumer_app: 'apps/lifecycle-warden',
      artifact_path: 'apps/lifecycle-warden/vendor/socioprophet-hellgraph-0.4.40.tgz',
      vendored_version: '0.4.40',
      vendored_digest: 'sha256:a1f477969c8f335f95d806baeee349c8d1bbfc9e288665f20caa8a2a016aa6e0',
      freshness_policy: 'track-minor',
      owner: '@mdheller',
      disposition: 'remediation-required',
      guard: { path: null, invoked_by_ci: false },
      remediation: { finding_id: 'VFP-0001', target_version: '0.4.45', due: '2026-09-30' },
    },
  ],
}

function fixture(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace('vendor-graph', false))
  ingestVendorFreshness(store, REGISTER)
  return store
}

const SERVICE_PIN = vfpId.pin('hellgraph-engine@hellgraph-service')
const WARDEN_PIN = vfpId.pin('hellgraph-engine@lifecycle-warden')

// ─── The model ─────────────────────────────────────────────────────────────────

test('ingest builds the vfp: subgraph under the declared names', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-ingest', false))
  const stats = ingestVendorFreshness(store, REGISTER)

  // Six released artifacts (0.4.40..0.4.45); the pins reuse 0.4.40 rather than duplicating it.
  assert.equal(stats.artifacts, 6)
  assert.equal(stats.repositories, 2, 'hellgraph (producer) + prophet-platform (host)')
  assert.equal(stats.consumerApps, 2)
  assert.equal(stats.pins, 2)
  assert.equal(stats.supersededByEdges, 5, 'five hops from 0.4.40 to 0.4.45')
  assert.equal(stats.contracts, 2, 'enrich-receipt + cypher-projection')

  assert.equal(store.nodesByLabel(VFP.Artifact).length, 6)
  assert.equal(store.nodesByLabel(VFP.VendorPin).length, 2)
  assert.equal(store.nodesByLabel(VFP.ConsumerApp).length, 2)
  assert.deepEqual(vendorPinIds(store), [SERVICE_PIN, WARDEN_PIN].sort())

  // The four spine edges exist under their declared vfp: names.
  const pinned = store.out(SERVICE_PIN, VFP_EDGE.pinnedAt)
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0]!.properties['version'], '0.4.40')
  const app = store.out(SERVICE_PIN, VFP_EDGE.pinFor)[0]!
  assert.equal(app.properties['appPath'], 'apps/hellgraph-service')
  assert.deepEqual(store.out(app.id, VFP_EDGE.vendors).map((a) => a.properties['version']), ['0.4.40'])
  assert.equal(store.out(pinned[0]!.id, VFP_EDGE.producedBy)[0]!.properties['repoName'], 'SocioProphet/hellgraph')

  // BOTH consumers vendor the SAME artifact node — one tarball, two pins. Modelling the pin as a
  // reified node (not an edge label) is what keeps the second copy visible.
  assert.equal(store.in(pinned[0]!.id, VFP_EDGE.vendors).length, 2)
  assert.equal(store.in(pinned[0]!.id, VFP_EDGE.pinnedAt).length, 2)
})

test('vfp: classes are KKO-typed, and subsume through the loaded upper ontology', () => {
  const store = fixture()
  const types = store.atomspace().types
  const kko = (n: string): string => 'http://kbpedia.org/ontologies/kko#' + n

  // Declared under real KKO classes — an Artifact is a made, released Product; a VendorPin is a
  // reified relation, i.e. a Predication, not an entity.
  assert.equal(VFP_KKO_TYPES[VFP.Artifact], kko('Products'))
  assert.equal(VFP_KKO_TYPES[VFP.VendorPin], kko('RelationTypes'))
  assert.ok(types.isA(VFP.Artifact, kko('Products')))
  assert.ok(types.isA(VFP.VendorPin, kko('RelationTypes')))
  assert.ok(!types.isA(VFP.Artifact, kko('RelationTypes')), 'typing discriminates')

  // With KKO loaded the full subsumption chain resolves — the plane composes with the ontology
  // rather than sitting beside it.
  loadKkoIntoAtomSpace(store.atomspace())
  assert.ok(types.isA(VFP.Artifact, kko('Artifacts')), 'Products ⊑ Artifacts')
  assert.ok(types.isA(VFP.Artifact, kko('SuperTypes')), 'and up to the KKO root')
  assert.ok(types.isA(VFP.VendorPin, kko('Predications')), 'RelationTypes ⊑ Predications')
  assert.equal(VFP_NS, 'https://socioprophet.org/ns/vendor-freshness#')
})

// ─── 1 ─ Staleness ─────────────────────────────────────────────────────────────

test('staleness is DERIVED: five hops, with the intervening artifacts named', () => {
  const store = fixture()
  const v = stalenessOf(store, SERVICE_PIN)

  assert.equal(v.pinnedVersion, '0.4.40')
  assert.equal(v.latestVersion, '0.4.45')
  assert.equal(v.releaseDistance, 5, 'the measured gap: 0.4.41, 0.4.42, 0.4.43, 0.4.44, 0.4.45')
  assert.equal(v.freshnessState, 'stale')
  assert.equal(v.freshnessPolicy, 'track-minor')

  // Not a boolean — the path itself, in release order.
  assert.deepEqual(v.intervening.map((a) => a.version), ['0.4.41', '0.4.42', '0.4.43', '0.4.44', '0.4.45'])
  assert.equal(v.releaseDistance, v.intervening.length)
  assert.deepEqual(v.intervening.find((a) => a.version === '0.4.43')!.changesContract, ['receipt-shape'])
  assert.deepEqual(v.intervening.find((a) => a.version === '0.4.45')!.changesContract, ['schema'])
  assert.deepEqual(v.intervening.find((a) => a.version === '0.4.41')!.changesContract, [])

  // Carried governance, straight off the reified pin.
  assert.equal(v.consumerApp, 'apps/hellgraph-service')
  assert.equal(v.owner, '@mdheller')
  assert.equal(v.guardInvokedByCi, false, 'a guard nobody calls is not a guard')
  assert.equal(v.disposition, 'remediation-open')
  assert.ok(v.dispositionAgrees, 'stale-and-declared is a legitimate state')

  // The second copy is equally stale and has no guard declared at all.
  const w = stalenessOf(store, WARDEN_PIN)
  assert.equal(w.releaseDistance, 5)
  assert.equal(w.consumerApp, 'apps/lifecycle-warden')
  assert.equal(w.guardPath, undefined)
  assert.equal(w.disposition, 'remediation-required')
})

test('the violation is stale-and-UNDECLARED, not stale', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-lying', false))
  ingestVendorFreshness(store, {
    ...REGISTER,
    artifacts: [{ ...REGISTER.artifacts[0]!, disposition: 'current' }],
  })
  const v = stalenessOf(store, SERVICE_PIN)
  assert.equal(v.freshnessState, 'stale')
  assert.equal(v.dispositionAgrees, false, 'you may not declare current while five releases behind')

  const analysis = analyzeVendorFreshness(store)
  assert.equal(analysis.dispositionViolations.length, 1)
  assert.match(analysis.dispositionViolations[0]!, /declared 'current' but derived 'stale'/)
})

test('an unobserved upstream is UNKNOWN, not current — even under pin-exact', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-unobserved', false))
  ingestVendorFreshness(store, {
    // A source with NO release history: nobody has enumerated upstream.
    sources: [{ source_id: 'sourceos-spec-schemas', repo: 'SourceOS-Linux/sourceos-spec' }],
    artifacts: [{
      artifact_id: 'sourceos-spec-schemas@hellgraph-service',
      source_id: 'sourceos-spec-schemas',
      consumer_repo: 'SocioProphet/prophet-platform',
      consumer_app: 'apps/hellgraph-service',
      vendored_commit: '7d74db818a943f2070285c2fc16e22f975d1b8d0',
      freshness_policy: 'pin-exact',
      disposition: 'observation-required',
    }],
  })
  const v = stalenessOf(store, vfpId.pin('sourceos-spec-schemas@hellgraph-service'))
  assert.equal(v.freshnessState, 'unknown', 'a pin to something nobody observed is an unknown wearing a pin')
  assert.equal(v.releaseDistance, 0)
  assert.ok(v.dispositionAgrees, 'declared observation-required, which is honest')
})

// ─── 2 ─ Blast radius ──────────────────────────────────────────────────────────

test('blast radius answers "what breaks if I cut 0.4.46?" BEFORE 0.4.46 exists', () => {
  const store = fixture()
  const before = store.version()
  const br = blastRadiusOf(store, { repository: 'SocioProphet/hellgraph', proposedVersion: '0.4.46' })

  assert.equal(br.count, 2, 'hellgraph-service AND lifecycle-warden — the fact unavailable when 0.4.45 was cut')
  assert.deepEqual(br.consumers.map((c) => c.appPath), ['apps/hellgraph-service', 'apps/lifecycle-warden'])
  for (const c of br.consumers) {
    assert.equal(c.pinnedVersion, '0.4.40')
    assert.equal(c.releaseDistance, 5)
    assert.equal(c.crossesContract, true)
    assert.deepEqual(c.contractKinds, ['receipt-shape', 'schema'])
    assert.equal(c.consumerRepo, 'SocioProphet/prophet-platform')
  }
  // Counted over ConsumerApp, never Repository: at repo granularity the answer is 1, and that
  // undercount is exactly what hid the lifecycle-warden copy.
  assert.equal(new Set(br.consumers.map((c) => c.consumerRepo)).size, 1)
  assert.equal(store.version(), before, 'no node was created for the unreleased 0.4.46')
})

test('a repository nobody vendors has an empty blast radius', () => {
  const br = blastRadiusOf(fixture(), { repository: 'SocioProphet/prophet-platform', proposedVersion: '1.0.0' })
  assert.equal(br.count, 0)
  assert.deepEqual(br.consumers, [])
})

// ─── 3 ─ Contract-crossing risk ────────────────────────────────────────────────

test('contract crossing is read from DECLARED edges, never guessed from version numbers', () => {
  const risk = contractCrossingRiskOf(fixture(), SERVICE_PIN)

  assert.equal(risk.crossesContract, true)
  assert.deepEqual(risk.contractKinds, ['receipt-shape', 'schema'])
  // 0.4.43 and 0.4.45 are both PATCH bumps: no semver heuristic could tell them from 0.4.41.
  assert.deepEqual(risk.crossings.map((c) => c.version), ['0.4.43', '0.4.45'])
  assert.deepEqual(risk.crossings[0]!.kinds, ['receipt-shape'])
  assert.equal(
    risk.crossings[0]!.contracts[0]!.receiptFixture,
    'apps/compute-gateway/tests/test_engine_seal.py',
    'the golden receipts that must be re-verified byte-for-byte across the bump')
  assert.equal(
    risk.crossings[0]!.contracts[0]!.digest,
    'sha256:018f2febf0c76f91752ba9726c9a32a4a8d3ca03895a5d877b780c312d34cc71')
  assert.deepEqual(risk.crossings[1]!.kinds, ['schema'])
})

test('a gap that spans no contract change is large but not risky', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-safe', false))
  const src = REGISTER.sources[0]!
  ingestVendorFreshness(store, {
    ...REGISTER,
    // Same five-release gap, with every contract declaration removed.
    sources: [{ ...src, releases: src.releases.map((r) => ({ version: r.version })) }],
  })
  assert.equal(stalenessOf(store, SERVICE_PIN).releaseDistance, 5, 'still five behind')
  const risk = contractCrossingRiskOf(store, SERVICE_PIN)
  assert.equal(risk.crossesContract, false, 'distance and danger are different questions')
  assert.deepEqual(risk.crossings, [])
})

// ─── Purity ────────────────────────────────────────────────────────────────────

test('every derived query is PURE — the logical clock does not move', () => {
  const store = fixture()
  const seq = store.version()
  const nodes = store.allNodes().length
  const edges = store.edgeCount()

  stalenessOf(store, SERVICE_PIN)
  stalenessOf(store, WARDEN_PIN)
  blastRadiusOf(store, { repository: 'SocioProphet/hellgraph', proposedVersion: '0.4.46' })
  contractCrossingRiskOf(store, SERVICE_PIN)
  proposeRevendor(store, SERVICE_PIN, { requestedAt: '2026-07-29T00:00:00Z' })
  analyzeVendorFreshness(store, { requestedAt: '2026-07-29T00:00:00Z' })

  assert.equal(store.version(), seq, 'store.version() is identical before and after')
  assert.equal(store.allNodes().length, nodes)
  assert.equal(store.edgeCount(), edges)
})

// ─── The governed trigger ──────────────────────────────────────────────────────

test('an EffectRequest is PROPOSED — and the engine never executes it', () => {
  const store = fixture()
  const p = proposeRevendor(store, WARDEN_PIN, {
    requestedAt: '2026-07-29T00:00:00Z',
    blastRadius: 2,
  })

  assert.equal(p.status, 'proposed', 'the only value there is')
  assert.deepEqual(p.contractViolations, [], 'conforms to the vendored EffectRequest contract')

  const er = p.effectRequest
  assert.equal(er.type, 'EffectRequest')
  assert.equal(er.specVersion, '0.1.0')
  assert.equal(er.effectKind, 'update')
  assert.equal(er.capability, 'vendor.revendor')
  assert.deepEqual(er.target, {
    kind: 'vendor-pin',
    identifier: 'hellgraph-engine@lifecycle-warden',
    location: 'SocioProphet/prophet-platform/apps/lifecycle-warden/vendor/socioprophet-hellgraph-0.4.40.tgz',
  })
  assert.deepEqual(er.parameters, {
    fromVersion: '0.4.40', toVersion: '0.4.45',
    gapSize: 5, blastRadius: 2,
    crossesContract: true, contractKinds: ['receipt-shape', 'schema'],
  })
  // A re-emitted finding must not open a second PR.
  assert.equal(er.idempotencyKey, 'hellgraph-engine@lifecycle-warden@0.4.40->0.4.45')
  assert.equal(er.requiresHumanApproval, true, 'forced true whenever the gap crosses a contract')
  assert.deepEqual(er.riskLabels, ['contract-crossing', 'receipt-shape', 'schema'])
  assert.match(er.id, /^urn:srcos:effect:[A-Za-z0-9._~-]+$/)
  assert.match(er.requestedByEventRef, /^urn:srcos:[a-z0-9-]+:[A-Za-z0-9._~-]+$/)

  // NOTHING is executed. The proposal is a value; the graph is untouched; the pin still holds
  // 0.4.40; and the only surface the module exposes is one that returns a proposal.
  assert.equal(stalenessOf(store, WARDEN_PIN).pinnedVersion, '0.4.40', 'still pinned at 0.4.40')
  assert.equal(store.out(WARDEN_PIN, VFP_EDGE.pinnedAt)[0]!.properties['version'], '0.4.40')
  const surface = Object.keys(p)
  assert.deepEqual(surface.sort(), ['contractViolations', 'effectRequest', 'pinId', 'status'])
  assert.ok(!surface.some((k) => /exec|apply|commit|run/i.test(k)), 'no execution surface exists')
})

test('the proposal is validated against the sha-asserted vendored contract', () => {
  assert.equal(EFFECT_REQUEST_CONTRACT.sha256, '99829aa50b0ebb7d663072028c37e3a29cf4cb6d2fbbbe5d6af0dda979264084')
  assert.equal(EFFECT_REQUEST_CONTRACT.specVersion, '0.1.0')
  assert.equal(EFFECT_REQUEST_CONTRACT.schema, 'https://schemas.srcos.ai/v2/EffectRequest.json')
  assert.equal((EFFECT_REQUEST_SCHEMA as Record<string, unknown>)['title'], 'EffectRequest')
})

/** Every `format` the schema declares, at any depth — walked here, not asked of the validator. */
function declaredFormats(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) { for (const v of node) declaredFormats(v, into); return into }
  if (node === null || typeof node !== 'object') return into
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'format' && typeof v === 'string') into.add(v)
    else declaredFormats(v, into)
  }
  return into
}

/**
 * `requestedAt` carries the contract's `format: "date-time"`. That format used to be declared here
 * and enforced nowhere but a private regex in `vendor-graph.ts`; the shared validator now implements
 * it, so this asserts BOTH ends: the contract-shaped check has teeth on its own, and the call site
 * still refuses to build a proposal — loudly — from a value that fails it.
 */
test('requestedAt must be a real date-time — enforced by the SHARED validator, from the contract', () => {
  const store = fixture()

  // 1. Every format this contract declares is one the validator implements (the whole bar).
  const declared = declaredFormats(EFFECT_REQUEST_SCHEMA)
  assert.deepEqual([...declared].sort(), ['date-time'], 'the contract declares format: date-time')

  // 2. The shared validator itself rejects it — no call-site workaround involved. Before the fix
  //    this produced [] : the format was declared by the contract and checked by nobody.
  const good = proposeRevendor(store, SERVICE_PIN, { requestedAt: '2026-07-29T00:00:00Z' })
  assert.deepEqual(good.contractViolations, [], 'baseline: a real instant conforms')

  const errs: string[] = []
  validateAgainst(EFFECT_REQUEST_SCHEMA as Record<string, unknown>,
    { ...good.effectRequest, requestedAt: '2026-07-29' }, 'EffectRequest', errs)
  assert.ok(errs.some((e) => /requestedAt.*not an ISO-8601 date-time/.test(e)), errs.join('; '))

  // 3. And the call site still fails loudly rather than sealing a proposal that carries a violation.
  assert.throws(
    () => proposeRevendor(store, SERVICE_PIN, { requestedAt: '2026-07-29' }),
    /not an ISO-8601 date-time/)
  assert.throws(
    () => analyzeVendorFreshness(store, { requestedAt: '2026-07-29' }),
    /not an ISO-8601 date-time/, 'a bad instant must stop the run, not ride inside the seal')
})

// ─── Sealing ───────────────────────────────────────────────────────────────────

test('the analysis seals like enrich/explore, and is deterministic', () => {
  const a = analyzeVendorFreshness(fixture(), { requestedAt: '2026-07-29T00:00:00Z' })
  const b = analyzeVendorFreshness(fixture(), { requestedAt: '2026-07-29T00:00:00Z' })

  assert.match(a.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(a.hash, b.hash, 'same inputs ⇒ byte-identical seal')
  assert.equal(a.method, 'vendor-graph(staleness,blast-radius,contract-crossing)')
  assert.ok(a.snapshot.seq > 0, 'bound to the store logical clock, not just to counts')
  // 2 repos + 6 artifacts + 6 releases + 2 contracts + 2 consumer apps + 2 pins.
  assert.equal(a.snapshot.nodes, 20)
  assert.equal(a.contract.sha256, EFFECT_REQUEST_CONTRACT.sha256, 'the receipt names the contract it used')

  // Both pins, both stale, both crossing; one blast-radius report for the producing repo.
  assert.equal(a.pins.length, 2)
  assert.deepEqual(a.pins.map((p) => p.releaseDistance), [5, 5])
  assert.deepEqual(a.risks.map((r) => r.crossesContract), [true, true])
  assert.equal(a.blastRadius.length, 1)
  assert.equal(a.blastRadius[0]!.repository, 'SocioProphet/hellgraph')
  assert.equal(a.blastRadius[0]!.count, 2)
  assert.equal(a.blastRadius[0]!.proposedVersion, '0.4.45', 'the newest release the graph knows')
  assert.deepEqual(a.dispositionViolations, [], 'both pins declare their staleness honestly')
  assert.equal(a.proposals.length, 2, 'one proposal per stale pin — re-vendor EVERY copy')
  assert.ok(a.proposals.every((p) => p.status === 'proposed' && p.contractViolations.length === 0))
  assert.deepEqual(a.proposals.map((p) => p.effectRequest.parameters.blastRadius), [2, 2])
})

test('a different graph state seals differently', () => {
  const store = fixture()
  const before = analyzeVendorFreshness(store, { requestedAt: '2026-07-29T00:00:00Z' }).hash
  store.addNode('unrelated', ['Other'], {})
  assert.notEqual(analyzeVendorFreshness(store, { requestedAt: '2026-07-29T00:00:00Z' }).hash, before)
})

test('without a requestedAt the analysis emits no proposals rather than reading the clock', () => {
  const a = analyzeVendorFreshness(fixture())
  assert.deepEqual(a.proposals, [])
  // Still deterministic, and still a full verdict.
  assert.equal(a.hash, analyzeVendorFreshness(fixture()).hash)
  assert.equal(a.pins.length, 2)
})

test('an empty graph yields an empty, still-sealed analysis', () => {
  const a = analyzeVendorFreshness(new HellGraphStore(new AtomSpace('vendor-graph-empty', false)))
  assert.deepEqual(a.pins, [])
  assert.deepEqual(a.blastRadius, [])
  assert.match(a.hash, /^sha256:/)
})

// ─── Ingest robustness ─────────────────────────────────────────────────────────

test('ingest reads camelCase and snake_case identically, and is idempotent', () => {
  const camel = new HellGraphStore(new AtomSpace('vendor-graph-camel', false))
  ingestVendorFreshness(camel, {
    sources: [{
      sourceId: 'hellgraph-engine',
      repo: 'SocioProphet/hellgraph',
      releases: [
        { version: '0.4.40' }, { version: '0.4.41' }, { version: '0.4.42' },
        { version: '0.4.43', changesContract: ['receipt-shape'] },
        { version: '0.4.44' }, { version: '0.4.45', changesContract: ['schema'] },
      ],
    }],
    artifacts: [{
      artifactId: 'hellgraph-engine@hellgraph-service',
      sourceId: 'hellgraph-engine',
      consumerRepo: 'SocioProphet/prophet-platform',
      consumerApp: 'apps/hellgraph-service',
      vendoredVersion: '0.4.40',
      freshnessPolicy: 'track-minor',
      disposition: 'remediation-open',
    }],
  })
  const v = stalenessOf(camel, SERVICE_PIN)
  assert.equal(v.releaseDistance, 5)
  assert.deepEqual(contractCrossingRiskOf(camel, SERVICE_PIN).contractKinds, ['receipt-shape', 'schema'])

  // Re-ingesting the same manifest adds no nodes and no edges — atoms are content-addressed.
  const store = fixture()
  const seq = store.version()
  const edges = store.edgeCount()
  ingestVendorFreshness(store, REGISTER)
  assert.equal(store.allNodes().length, 20, 're-ingest is not a duplicate subgraph')
  assert.equal(store.edgeCount(), edges)
  // But it DOES advance the logical clock: `store.addNode` re-writes every label and property
  // value, and each write ticks the clock (`store.addEdge` does not — it only interns atoms).
  // Measured, not assumed, and identical to the KKO loader's behaviour on reload. It matters
  // because `seq` is what the seal binds to: a redundant re-ingest reseals the same graph.
  assert.ok(store.version() > seq, 'content-idempotent, but not clock-idempotent')
  const before = analyzeVendorFreshness(fixture()).hash
  assert.notEqual(analyzeVendorFreshness(store).hash, before, 'so the reseal differs — by design')
})

test('a pin id that is not a VendorPin fails loudly', () => {
  const store = fixture()
  assert.throws(() => stalenessOf(store, vfpId.repository('SocioProphet/hellgraph')), /is not a vfp:VendorPin/)
  assert.throws(() => contractCrossingRiskOf(store, 'nope'), /is not a vfp:VendorPin/)
})

// ─── The checks that must be able to FAIL ──────────────────────────────────────

/**
 * `contractViolations: []` is asserted in two tests above. An empty array is also what a validator
 * that does nothing returns, so on its own that assertion proves the proposal is well-formed only
 * if the validator can, in fact, report. This test breaks a proposal against the SAME
 * sha-asserted schema object and requires violations — so the green above means something.
 */
test('the vendored-contract validator has TEETH — a malformed EffectRequest is rejected', () => {
  const store = fixture()
  const good = proposeRevendor(store, WARDEN_PIN, { requestedAt: '2026-07-29T00:00:00Z' })
  assert.deepEqual(good.contractViolations, [], 'baseline: the real proposal conforms')

  const schema = EFFECT_REQUEST_SCHEMA as Record<string, unknown>
  const check = (mutate: (er: Record<string, unknown>) => void): string[] => {
    const er = JSON.parse(JSON.stringify(good.effectRequest)) as Record<string, unknown>
    mutate(er)
    const errs: string[] = []
    validateAgainst(schema, er, 'EffectRequest', errs)
    return errs
  }

  // Each of these is a distinct keyword in the vendored contract. If any returns [], that keyword
  // is declared by the schema and enforced by nothing.
  assert.ok(check((er) => { delete er['idempotencyKey'] }).length > 0, 'required')
  assert.ok(check((er) => { er['type'] = 'EffectDecision' }).length > 0, 'const')
  assert.ok(check((er) => { er['effectKind'] = 'detonate' }).length > 0, 'enum')
  assert.ok(check((er) => { er['requiresHumanApproval'] = 'yes' }).length > 0, 'type')
  assert.ok(check((er) => { er['id'] = 'not-a-urn' }).length > 0, 'pattern')
  assert.ok(check((er) => { er['capability'] = '' }).length > 0, 'minLength')
  assert.ok(check((er) => { er['policyLabels'] = ['dup', 'dup'] }).length > 0, 'uniqueItems')
  assert.ok(check((er) => { er['smuggled'] = true }).length > 0, 'additionalProperties: false')
  assert.ok(check((er) => {
    (er['target'] as Record<string, unknown>)['identifier'] = 42
  }).length > 0, 'nested object properties')
})

/**
 * …and the verdict that validator produces must be READ.
 *
 * `RevendorProposal.contractViolations` has always documented "non-empty means the proposal is NOT
 * emitted", and nothing implemented it: `analyzeVendorFreshness` sealed every candidate regardless,
 * and across the whole repo the field had no production reader — no branch, no `.length`, no throw,
 * only its own definition and these tests. A violation computed, sealed, and never read is worse
 * than no check at all, because the receipt then carries evidence that the system looked.
 *
 * The violation here is driven from the GRAPH, not by mutating a finished request: `policyLabels`
 * on the pin is declared `['ops','ops']`, `proposeRevendor` joins and re-splits it, and the
 * vendored contract's `uniqueItems` rejects it. Exactly the shape a bad register entry would take.
 */
test('a contract-violating proposal is WITHHELD from the seal and NAMED in it', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-violation', false))
  ingestVendorFreshness(store, {
    ...REGISTER,
    artifacts: [
      REGISTER.artifacts[0],
      { ...REGISTER.artifacts[1], policy_labels: ['ops', 'ops'] },
    ],
  })

  // The input really does violate the contract — otherwise the rest of this test proves nothing.
  const direct = proposeRevendor(store, WARDEN_PIN, { requestedAt: '2026-07-29T00:00:00Z' })
  assert.ok(direct.contractViolations.length > 0, 'the duplicate policy label is a real violation')

  const a = analyzeVendorFreshness(store, { requestedAt: '2026-07-29T00:00:00Z' })

  // WITHHELD: both pins are stale, so two candidates were built, but only the conforming one is
  // emitted. Sealing the bad one alongside the good one is the defect.
  assert.equal(a.pins.filter((p) => p.freshnessState === 'stale').length, 2, 'two stale pins')
  assert.equal(a.proposals.length, 1, 'only the conforming proposal is emitted')
  assert.equal(a.proposals[0]!.effectRequest.target.identifier, 'hellgraph-engine@hellgraph-service')
  assert.ok(a.proposals.every((p) => p.contractViolations.length === 0),
    'nothing carrying a violation rides inside the seal')

  // NAMED: withholding on its own would be a silent drop.
  assert.ok(a.contractViolations.length > 0, 'the withheld proposal is reported, not dropped')
  assert.ok(a.contractViolations.every((v) => v.startsWith('hellgraph-engine@lifecycle-warden: ')),
    'each violation names the pin it came from, like dispositionViolations does')
  assert.ok(a.contractViolations.some((v) => /policyLabels/.test(v)), 'and says what was wrong')

  // Sealed, not merely returned: the field is inside the hashed record.
  const clean = analyzeVendorFreshness(fixture(), { requestedAt: '2026-07-29T00:00:00Z' })
  assert.deepEqual(clean.contractViolations, [], 'a conforming graph reports none')
  assert.equal(clean.proposals.length, 2, 'and withholds nothing')
  assert.notEqual(a.hash, clean.hash, 'the withheld violation changes the seal')
})

test('contractViolations participates in the seal rather than sitting beside it', () => {
  // Two analyses whose ONLY difference is the violation must not seal identically. If the field
  // were dropped from the sealed record, these hashes would collide.
  const violating = () => {
    const s = new HellGraphStore(new AtomSpace('vendor-graph-seal', false))
    ingestVendorFreshness(s, {
      ...REGISTER,
      artifacts: [REGISTER.artifacts[0], { ...REGISTER.artifacts[1], policy_labels: ['ops', 'ops'] }],
    })
    return analyzeVendorFreshness(s, { requestedAt: '2026-07-29T00:00:00Z' })
  }
  const x = violating()
  const y = violating()
  assert.equal(x.hash, y.hash, 'still deterministic')
  assert.ok(x.contractViolations.length > 0)
  assert.ok(JSON.stringify(x).includes(x.contractViolations[0]!), 'the violation text is in the record')
})

/**
 * CodeQL `js/polynomial-redos` on the pre-fix `slug()` trim (`/^-+|-+$/`). `artifact_id` becomes
 * `pinKey`, which `slug()` puts into the EffectRequest `id` — so a register value walks straight
 * into the regex. Measured on the pre-fix implementation: 48 ms at 10k dashes, 2.8 s at 80k,
 * 11.4 s at 160k (clean quadratic). The linear index walk does 400k in about a millisecond, so the
 * 5 s bound below cannot be met by the old code on any runner and is not tight for the new one.
 */
test('slug() is linear — the EffectRequest id builder is not a ReDoS', () => {
  const pathological = 'x' + '-'.repeat(400_000) + 'y'
  const store = new HellGraphStore(new AtomSpace('vendor-graph-redos', false))
  ingestVendorFreshness(store, {
    ...REGISTER,
    artifacts: [{ ...REGISTER.artifacts[1], artifact_id: pathological }],
  })

  const t0 = process.hrtime.bigint()
  const p = proposeRevendor(store, vfpId.pin(pathological), { requestedAt: '2026-07-29T00:00:00Z' })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6

  assert.ok(ms < 5_000, `slug() went quadratic: ${ms.toFixed(0)} ms for 400k separators`)
  // ...and it still produces a contract-legal id: the dashes are trimmed at both ends.
  assert.match(p.effectRequest.id, /^urn:srcos:effect:[A-Za-z0-9._~-]+$/)
  assert.ok(!p.effectRequest.id.endsWith('-'), 'trailing separators trimmed')
})

// ─── Version precedence ────────────────────────────────────────────────────────

/**
 * A repository can produce more than one vendored artifact — this one demonstrably does: the
 * package description calls the npm engine the "polyglot sibling of the Rust hellgraph crate", and
 * the register keys release history by `source_id` while blast radius is keyed by `repo`. So the
 * head set `newestReleasedVersion` picks from is a set of *several* artifacts, one per source, and
 * something has to rank them.
 *
 * Ranking them with `.sort()` is ASCII ranking, and ASCII puts `0.4.9` above `0.4.46`. That is not
 * a latent edge case at the time of writing: this engine is at 0.4.46, so every repository past a
 * two-digit patch resolves to the wrong "newest", and the wrong version is then handed to
 * `blastRadiusOf` as `proposedVersion` — the blast-radius report names a release that is not the
 * one anybody would cut.
 *
 * The four versions below are chosen so a single-digit-patch fixture cannot pass in place of this
 * one: ASCII order is 0.4.10, 0.4.46, 0.4.5, 0.4.9 (picking 0.4.9), release order is 0.4.5, 0.4.9,
 * 0.4.10, 0.4.46 (picking 0.4.46). They disagree on both the maximum and the whole ordering.
 */
const POLYGLOT = {
  manifest_id: 'vendor-freshness-polyglot',
  policy: { default_freshness_policy: 'track-latest' },
  sources: [
    { source_id: 'hellgraph-npm', repo: 'SocioProphet/hellgraph', artifact_kind: 'npm-tarball', releases: [{ version: '0.4.5' }] },
    { source_id: 'hellgraph-crate', repo: 'SocioProphet/hellgraph', artifact_kind: 'cargo-crate', releases: [{ version: '0.4.9' }] },
    { source_id: 'hellgraph-wheel', repo: 'SocioProphet/hellgraph', artifact_kind: 'python-wheel', releases: [{ version: '0.4.10' }] },
    { source_id: 'hellgraph-oci', repo: 'SocioProphet/hellgraph', artifact_kind: 'oci-image', releases: [{ version: '0.4.46' }] },
  ],
  artifacts: [
    {
      artifact_id: 'hellgraph-npm@service',
      source_id: 'hellgraph-npm',
      consumer_repo: 'SocioProphet/prophet-platform',
      consumer_app: 'apps/hellgraph-service',
      vendored_version: '0.4.5',
      freshness_policy: 'track-latest',
      disposition: 'observation-required',
    },
  ],
}

/**
 * The comparator's documented rules, pinned one at a time.
 *
 * `newestReleasedVersion` only ever asks for the maximum, so almost none of this is exercised by
 * the graph tests — and an ordering rule that nothing asserts is an ordering rule that the next
 * edit is free to change. The docstring on `compareVersions` is the specification; this is the
 * enforcement of it. In particular the prerelease case is here because ASCII on the whole suffix
 * would rank `rc.10` below `rc.2` and quietly reintroduce the defect one level down.
 */
test('compareVersions implements the documented total order', () => {
  const lt = (a: string, b: string): void => {
    assert.ok(compareVersions(a, b) < 0, `${a} should precede ${b}`)
    assert.ok(compareVersions(b, a) > 0, `${b} should follow ${a}`)
  }
  const eq = (a: string, b: string): void => {
    assert.equal(compareVersions(a, b), 0, `${a} and ${b} should be equal in precedence`)
  }

  // (2) numeric components, not ASCII — the bug this comparator exists for.
  lt('0.4.5', '0.4.9')
  lt('0.4.9', '0.4.10')
  lt('0.4.10', '0.4.46')
  lt('0.9.0', '0.10.0')
  lt('2.0.0', '10.0.0')

  // (2) a missing component is 0.
  lt('0.4', '0.4.1')
  // ...so these name the same release — but (6) the order is TOTAL, so they are still ordered,
  // by raw text, rather than tying. A tie would let the sort's output depend on input order, and
  // this sort's result is sealed.
  lt('0.4', '0.4.0')
  lt('1', '1.0.0')
  assert.notEqual(compareVersions('0.4', '0.4.0'), 0, 'same release, still not a tie')

  // (1) non-releases sort below every release, and by ASCII between themselves.
  lt('unknown', '0.0.0')
  lt('f3a9c21', '0.0.0')
  lt('', '0.0.0')
  lt('a1b2c3d', 'f3a9c21')

  // (3) a prerelease precedes the release it leads to.
  lt('1.0.0-rc.1', '1.0.0')
  lt('0.4.46-alpha', '0.4.46')

  // (4) semver §11 between prereleases: numeric identifiers numerically, and BELOW alphanumeric.
  lt('1.0.0-rc.2', '1.0.0-rc.10')
  lt('1.0.0-alpha', '1.0.0-beta')
  lt('1.0.0-1', '1.0.0-alpha')
  lt('1.0.0-rc.1', '1.0.0-rc.1.1')

  // (5) build metadata is not part of precedence: it does not make 1.0.0+a newer than 1.0.0.
  lt('1.0.0-rc.1', '1.0.0+a')
  // ...but (6) the order stays TOTAL: differing only in build metadata still ranks deterministically.
  assert.notEqual(compareVersions('1.0.0+a', '1.0.0+b'), 0, 'total order — no unresolved ties')
  assert.equal(
    compareVersions('1.0.0+a', '1.0.0+b') + compareVersions('1.0.0+b', '1.0.0+a'), 0,
    'and it is antisymmetric',
  )

  // (6) zero is returned for identical strings, and — the contract — for nothing else.
  eq('1.0.0', '1.0.0')
  eq('unknown', 'unknown')
  eq('v1.2.3', 'v1.2.3')

  // A `v` prefix is accepted and does not change the release.
  lt('v1.2.3', 'v1.2.4')
  lt('v1.2.3', '1.2.4')

  // The whole point, as a sort: the four-version case orders correctly end to end.
  assert.deepEqual(
    ['0.4.10', '0.4.46', '0.4.5', '0.4.9'].sort(compareVersions),
    ['0.4.5', '0.4.9', '0.4.10', '0.4.46'],
  )
  // ...which is exactly what the default sort does NOT do.
  assert.deepEqual(['0.4.10', '0.4.46', '0.4.5', '0.4.9'].sort(), ['0.4.10', '0.4.46', '0.4.5', '0.4.9'])
})

/**
 * The register is attacker-influenced text and `slug()` in this same file already earned a CodeQL
 * `js/polynomial-redos` finding on it, so the version parser is a hand-written linear scan rather
 * than a nested-quantifier regex. This is the assertion that keeps it that way.
 */
test('compareVersions is linear — the version parser is not a ReDoS', () => {
  const pathological = '9'.repeat(200_000) + 'x'
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 50; i++) compareVersions(pathological, '0.4.46')
  const ms = Number(process.hrtime.bigint() - t0) / 1e6

  assert.ok(ms < 5_000, `version parsing went superlinear: ${ms.toFixed(0)} ms`)
  // ...and it still gets the answer right: a 200k-digit non-release is not newer than 0.4.46.
  assert.ok(compareVersions(pathological, '0.4.46') < 0)
})

test('the newest release is the newest by VERSION, not by ASCII — 0.4.46 outranks 0.4.9', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-semver', false))
  ingestVendorFreshness(store, POLYGLOT)

  const a = analyzeVendorFreshness(store)
  const report = a.blastRadius.find((b) => b.repository === 'SocioProphet/hellgraph')
  assert.ok(report, 'the producing repository has a blast-radius report')

  // The whole point of the report: "what breaks if I cut the next one?" answered about the release
  // that would actually be cut. `.sort()` answers it about 0.4.9, a release five patches behind.
  assert.equal(report.proposedVersion, '0.4.46')
})

/**
 * The same defect, one step worse, and reachable from the register as it is written today.
 *
 * A pin may name a version the source's release history does not list — the ingest says so in
 * as many words and builds the artifact anyway, with no supersession chain. Such an artifact is a
 * HEAD (nothing supersedes it), so it lands in the same candidate set. A `vendored_commit` pin
 * therefore puts a commit sha in there, and an entry with neither version nor commit puts the
 * literal string `unknown` in there.
 *
 * Under ASCII both outrank every real release, because letters sort above digits. The blast-radius
 * report then proposes cutting `f3a9c21` — or `unknown`. Non-numeric versions are not releases and
 * must not be ranked as though they were.
 */
test('a commit sha and the literal unknown are not "newer" than every release', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-nonnumeric', false))
  ingestVendorFreshness(store, {
    ...POLYGLOT,
    artifacts: [
      ...POLYGLOT.artifacts,
      {
        artifact_id: 'hellgraph-crate@gateway',
        source_id: 'hellgraph-crate',
        consumer_repo: 'SocioProphet/prophet-platform',
        consumer_app: 'apps/compute-gateway',
        vendored_commit: 'f3a9c21',
        disposition: 'observation-required',
      },
      {
        artifact_id: 'hellgraph-wheel@warden',
        source_id: 'hellgraph-wheel',
        consumer_repo: 'SocioProphet/prophet-platform',
        consumer_app: 'apps/lifecycle-warden',
        disposition: 'observation-required',
      },
    ],
  })

  // Both non-numeric heads really are in the graph — otherwise this test proves nothing.
  const heads = store.nodesByLabel(VFP.Artifact)
    .filter((n) => store.out(n.id, VFP_EDGE.supersededBy).length === 0)
    .map((n) => n.properties['version'])
  assert.ok(heads.includes('f3a9c21'), 'the commit-sha artifact is a head')
  assert.ok(heads.includes('unknown'), 'the version-less artifact is a head')

  const a = analyzeVendorFreshness(store)
  const report = a.blastRadius.find((b) => b.repository === 'SocioProphet/hellgraph')
  assert.equal(report?.proposedVersion, '0.4.46')
})

// ─── Forked supersession ───────────────────────────────────────────────────────

/**
 * The register can fork a release history, and does it the ordinary way: two entries for the same
 * `source_id` — a re-observation, or a backport branch enumerated separately — whose release lists
 * share an ancestor. `0.4.40` then has TWO outgoing `vfp:supersededBy` edges.
 *
 * `supersessionChain` resolves that fork by taking the LOWEST NEXT NODE ID, which is a deliberate
 * choice: it is replayable, so the sealed receipt is reproducible from the graph alone. It is not
 * the longest path, and the docstring that claimed it was has been corrected.
 *
 * The branches below are built so the two rules give different answers and the difference is
 * visible in the verdict: the low-id branch (0.4.41) is a dead end at distance 1, the high-id
 * branch (0.4.42 → 0.4.43) runs to distance 2. A future "improvement" to longest-path would change
 * `releaseDistance`, `latestVersion` and therefore the seal — so it breaks here rather than
 * silently rewriting receipts.
 */
const FORKED = {
  manifest_id: 'vendor-freshness-forked',
  policy: { default_freshness_policy: 'track-latest' },
  sources: [
    {
      source_id: 'hellgraph-engine',
      repo: 'SocioProphet/hellgraph',
      releases: [{ version: '0.4.40' }, { version: '0.4.41' }],
    },
    {
      source_id: 'hellgraph-engine',
      repo: 'SocioProphet/hellgraph',
      releases: [{ version: '0.4.40' }, { version: '0.4.42' }, { version: '0.4.43' }],
    },
  ],
  artifacts: [
    {
      artifact_id: 'hellgraph-engine@service',
      source_id: 'hellgraph-engine',
      consumer_repo: 'SocioProphet/prophet-platform',
      consumer_app: 'apps/hellgraph-service',
      vendored_version: '0.4.40',
      freshness_policy: 'track-latest',
      disposition: 'remediation-required',
    },
  ],
}

test('a forked release history follows the LOWEST NEXT NODE ID, not the longest path', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-fork', false))
  ingestVendorFreshness(store, FORKED)

  // The fork is real: 0.4.40 is superseded by two different artifacts.
  const forkPoint = vfpId.artifact('hellgraph-engine', '0.4.40')
  assert.deepEqual(
    store.out(forkPoint, VFP_EDGE.supersededBy).map((n) => n.id).sort(),
    [vfpId.artifact('hellgraph-engine', '0.4.41'), vfpId.artifact('hellgraph-engine', '0.4.42')],
  )

  const v = stalenessOf(store, vfpId.pin('hellgraph-engine@service'))

  // Lowest id wins, so the chain is the SHORT branch. Longest-path would give ['0.4.42','0.4.43'].
  assert.deepEqual(v.intervening.map((i) => i.version), ['0.4.41'])
  assert.equal(v.releaseDistance, 1)
  assert.equal(v.latestVersion, '0.4.41')

  // Deterministic: the same graph replays to the same chain, which is why the receipt is sealable.
  const again = stalenessOf(store, vfpId.pin('hellgraph-engine@service'))
  assert.deepEqual(again.intervening, v.intervening)
})

/**
 * `stats.releases` was the one counter not gated by a `seen*` set, so the fork fixture above — five
 * release lines naming four distinct versions, because `0.4.40` is declared by both source
 * entries — reported five releases where the graph holds four `vfp:Release` nodes. Every other
 * counter reports nodes created; this one reported manifest lines read. Two different questions
 * under one name, and the caller cannot tell which answer it got.
 */
test('ingest stats count NODES, not manifest lines — a repeated release is counted once', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-stats', false))
  const stats = ingestVendorFreshness(store, FORKED)

  // Content-addressed: both `0.4.40` lines intern to the same vfp:Release atom.
  assert.equal(store.nodesByLabel(VFP.Release).length, 4, '0.4.40, 0.4.41, 0.4.42, 0.4.43')
  assert.equal(stats.releases, 4, 'the repeated 0.4.40 is counted once, as the artifact would be')
  assert.equal(stats.releases, store.nodesByLabel(VFP.Release).length, 'stats.releases matches the graph')

  // The guard must not suppress genuinely distinct releases: same version, different source.
  assert.equal(stats.artifacts, 4, 'artifacts were already gated this way — the two agree now')
})

/**
 * The pinned-artifact branch of the ingest built its `vfp:producedBy` edge straight from the
 * matched source's `repo` field, with no check that the field was there. A source entry missing
 * `repo` is skipped by the source loop — no repository node is ever created for it — but the
 * artifact loop still found it with `sources.find`, so the edge was built to `vfp:repo/`: an edge
 * to an empty id, pointing at a node that does not exist.
 *
 * That is a dangling edge in a graph whose whole claim is that its receipts are derivable from it,
 * and `store.in(vfpId.repository(''), ...)` is a live query someone can run.
 */
test('a source with no repo produces no edge to an empty repository id', () => {
  const store = new HellGraphStore(new AtomSpace('vendor-graph-emptyrepo', false))
  ingestVendorFreshness(store, {
    manifest_id: 'vendor-freshness-norepo',
    sources: [{ source_id: 'orphan', releases: [{ version: '0.1.0' }] }],
    artifacts: [
      {
        artifact_id: 'orphan@service',
        source_id: 'orphan',
        consumer_repo: 'SocioProphet/prophet-platform',
        consumer_app: 'apps/hellgraph-service',
        vendored_version: '0.1.0',
        disposition: 'observation-required',
      },
    ],
  })

  const emptyRepo = vfpId.repository('')
  assert.equal(store.getNode(emptyRepo), undefined, 'no node was created for the empty repository id')
  assert.deepEqual(store.in(emptyRepo, VFP_EDGE.producedBy), [], 'and nothing points at it')
})

// ─── 9 ─ `track-minor` means the MINOR line ────────────────────────────────────

/**
 * `track-minor` was implemented with `majorOf`:
 *
 *     const sameMajorNewer = intervening.some((a) => majorOf(a.version) === majorOf(pinnedVersion))
 *     const majorMoved     = releaseDistance > 0 && majorOf(latestVersion) !== majorOf(pinnedVersion)
 *     freshnessState = sameMajorNewer || majorMoved ? 'stale' : 'current'
 *
 * A policy whose NAME states one contract and whose CODE honoured another. Worse than
 * "track-minor is really track-major": the two arms are exhaustive — if nothing newer shares the
 * pinned major then the newest release cannot either, so `majorMoved` fires — which made
 * `releaseDistance > 0` always stale. `track-minor` was `track-latest`, wearing a major-shaped
 * rationale string. Three declared policies, two distinct behaviours, and the collapsed one is
 * the DEFAULT that every pin in the live register declares.
 *
 * These tests fix the contract the name states: a pin on `x.y.*` follows its own minor line.
 */
const minorLineFixture = (releases: string[], pinned: string, policy = 'track-minor'): HellGraphStore => {
  const store = new HellGraphStore(new AtomSpace(`vendor-graph-line-${pinned}-${releases.join('_')}-${policy}`, false))
  ingestVendorFreshness(store, {
    manifest_id: 'vendor-freshness-minor-line',
    sources: [{
      source_id: 'engine',
      repo: 'SocioProphet/hellgraph',
      artifact_kind: 'npm-tarball',
      version_scheme: 'semver',
      releases: releases.map((version) => ({ version })),
    }],
    artifacts: [{
      artifact_id: 'engine@probe',
      source_id: 'engine',
      consumer_repo: 'SocioProphet/prophet-platform',
      consumer_app: 'apps/probe',
      vendored_version: pinned,
      freshness_policy: policy,
      disposition: 'current',
    }],
  })
  return store
}
const LINE_PIN = vfpId.pin('engine@probe')

test('track-minor ACCEPTS a patch bump inside the pinned minor: 0.4.46 → 0.4.47', () => {
  const v = stalenessOf(minorLineFixture(['0.4.46', '0.4.47'], '0.4.46'), LINE_PIN)
  assert.equal(v.freshnessState, 'stale', '0.4.47 is on the 0.4 line the pin follows — take it')
  assert.equal(v.policyTargetVersion, '0.4.47')
  assert.match(v.rationale, /on the pinned 0\.4 line, newest 0\.4\.47/)
})

test('track-minor REFUSES a minor bump inside the pinned major: 0.4.46 → 0.5.0', () => {
  const v = stalenessOf(minorLineFixture(['0.4.46', '0.5.0'], '0.4.46'), LINE_PIN)
  assert.equal(v.freshnessState, 'current', '0.5.0 left the 0.4 line — not this pin\'s to take')
  assert.equal(v.releaseDistance, 1, 'and the distance is still REPORTED: current ≠ nothing happened')
  assert.equal(v.policyTargetVersion, '0.4.46', 'so no cross-minor target is proposed')
  assert.match(v.rationale, /0\.5\.0.*not followed under track-minor/)
})

test('track-minor is no longer track-latest — the two now disagree', () => {
  // The differential the old implementation could not produce: identical graph, both policies.
  const cases: [string[], string, string, string][] = [
    [['0.4.46', '0.4.47'], '0.4.46', 'stale', 'stale'],
    [['0.4.46', '0.5.0'], '0.4.46', 'current', 'stale'],
    [['0.4.46', '1.0.0'], '0.4.46', 'current', 'stale'],
    [['0.4.46', '0.4.47', '0.5.0'], '0.4.46', 'stale', 'stale'],
  ]
  for (const [releases, pinned, wantMinor, wantLatest] of cases) {
    assert.equal(stalenessOf(minorLineFixture(releases, pinned), LINE_PIN).freshnessState, wantMinor,
      `track-minor over ${releases.join('→')}`)
    assert.equal(stalenessOf(minorLineFixture(releases, pinned, 'track-latest'), LINE_PIN).freshnessState, wantLatest,
      `track-latest over ${releases.join('→')}`)
  }
})

test('a stale track-minor pin proposes the newest IN-LANE release, not the newest release', () => {
  // 0.4.47 and 0.5.0 both exist. The pin IS stale — 0.4.47 is on its line — and the proposal it
  // earns is `→ 0.4.47`. Proposing `→ 0.5.0` would hand a human the cross-minor bump the policy
  // exists to withhold, under a rationale that says it was withheld.
  const store = minorLineFixture(['0.4.46', '0.4.47', '0.5.0'], '0.4.46')
  const v = stalenessOf(store, LINE_PIN)
  assert.equal(v.freshnessState, 'stale')
  assert.equal(v.latestVersion, '0.5.0', 'the newest release is still reported as such')
  assert.equal(v.policyTargetVersion, '0.4.47', 'but the policy will only take the 0.4 line')

  const p = proposeRevendor(store, LINE_PIN, { requestedAt: '2026-07-30T00:00:00Z' })
  assert.equal(p.effectRequest.parameters['toVersion'], '0.4.47')
  assert.equal(p.effectRequest.idempotencyKey, 'engine@probe@0.4.46->0.4.47')
  assert.deepEqual(p.contractViolations, [])
})

test('the in-lane target is the newest by PRECEDENCE, not the last release in the declared chain', () => {
  // The filter above ranks with `compareVersions` precisely because "a register may declare its
  // releases out of order" — the supersession chain is declared order, not precedence order. The
  // proposal target has to honour the same rule. Picking `onLine[last]` (the chain tail) here would
  // reintroduce the exact chain-vs-precedence defect this stack removes, one level down: an
  // out-of-order 0.4 line `[0.4.46, 0.4.9]` would propose `→ 0.4.9`, seal a re-vendor receipt for
  // it, and print a rationale calling 0.4.9 the "newest". 0.4.46 is newer and also on the line.
  const store = minorLineFixture(['0.4.5', '0.4.46', '0.4.9'], '0.4.5')
  const v = stalenessOf(store, LINE_PIN)
  assert.equal(v.freshnessState, 'stale')
  assert.equal(v.policyTargetVersion, '0.4.46',
    'newest IN-LANE by version, not 0.4.9 (the last release in the declared chain)')
  assert.ok(v.rationale.includes('newest 0.4.46'), `rationale must name the real newest: ${v.rationale}`)
  assert.ok(!v.rationale.includes('newest 0.4.9'), `rationale must not call 0.4.9 newest: ${v.rationale}`)

  const p = proposeRevendor(store, LINE_PIN, { requestedAt: '2026-07-30T00:00:00Z' })
  assert.equal(p.effectRequest.parameters['toVersion'], '0.4.46',
    'the sealed proposal targets the real newest in-lane release')
})

test('track-latest still proposes the newest release — the split is per-policy, not global', () => {
  const store = minorLineFixture(['0.4.46', '0.4.47', '0.5.0'], '0.4.46', 'track-latest')
  const v = stalenessOf(store, LINE_PIN)
  assert.equal(v.policyTargetVersion, '0.5.0')
  assert.equal(proposeRevendor(store, LINE_PIN, { requestedAt: '2026-07-30T00:00:00Z' })
    .effectRequest.parameters['toVersion'], '0.5.0')
})

test('the minor line is parsed, not string-split: v-prefix, build metadata, missing patch', () => {
  // `split('.')[0]` on `v0.4.46` yields `v0`; on `0.4.46+build.7` the LINE is still 0.4. These all
  // name a point on the 0.4 line, and `parseVersion` is what knows that.
  for (const [pinned, newer] of [['v0.4.46', '0.4.47'], ['0.4.46+build.7', 'v0.4.47+build.8'], ['0.4', '0.4.1']]) {
    const v = stalenessOf(minorLineFixture([pinned!, newer!], pinned!), LINE_PIN)
    assert.equal(v.freshnessState, 'stale', `${pinned} → ${newer} is an in-lane bump`)
  }
  // …and 1 / 1.0 / 1.0.0 are one lane, so 1.1.0 leaves it.
  assert.equal(stalenessOf(minorLineFixture(['1', '1.1.0'], '1'), LINE_PIN).freshnessState, 'current')
  assert.equal(stalenessOf(minorLineFixture(['1', '1.0.1'], '1'), LINE_PIN).freshnessState, 'stale')
})

test('a prerelease does not make a stable track-minor pin stale — but does for a prerelease pin', () => {
  assert.equal(stalenessOf(minorLineFixture(['0.4.46', '0.4.47-rc.1'], '0.4.46'), LINE_PIN).freshnessState,
    'current', 'prereleases are opt-in, as in every semver range')
  assert.equal(stalenessOf(minorLineFixture(['0.4.47-rc.1', '0.4.47-rc.2'], '0.4.47-rc.1'), LINE_PIN).freshnessState,
    'stale', 'a pin that is itself a prerelease follows them')
  assert.equal(stalenessOf(minorLineFixture(['0.4.47-rc.1', '0.4.47'], '0.4.47-rc.1'), LINE_PIN).freshnessState,
    'stale', 'and the release the prerelease led to is in-lane')
})

test('a track-minor pin that is not release-shaped is UNKNOWN, not a guess', () => {
  // A sha names no x.y line. Deriving `current` would be the same silent guess the unobserved
  // branch already refuses to make.
  const store = new HellGraphStore(new AtomSpace('vendor-graph-shapeless', false))
  ingestVendorFreshness(store, {
    manifest_id: 'vendor-freshness-shapeless',
    sources: [{ source_id: 'engine', repo: 'SocioProphet/hellgraph', releases: [{ version: '7d74db8' }, { version: '0.4.47' }] }],
    artifacts: [{
      artifact_id: 'engine@probe', source_id: 'engine',
      consumer_repo: 'SocioProphet/prophet-platform', consumer_app: 'apps/probe',
      vendored_version: '7d74db8', freshness_policy: 'track-minor', disposition: 'current',
    }],
  })
  const v = stalenessOf(store, LINE_PIN)
  assert.equal(v.freshnessState, 'unknown')
  assert.equal(v.dispositionAgrees, false, 'declaring `current` over an undecidable state is a violation')
  assert.match(v.rationale, /not release-shaped/)
})

test('the live register is unaffected: 0.4.40 → 0.4.45 is all one 0.4 line', () => {
  // The fix must not quietly un-stale the real finding it was built to keep reporting.
  const v = stalenessOf(fixture(), SERVICE_PIN)
  assert.equal(v.freshnessState, 'stale')
  assert.equal(v.policyTargetVersion, '0.4.45', 'every intervening release is on the 0.4 line')
  assert.equal(v.latestVersion, '0.4.45')
})

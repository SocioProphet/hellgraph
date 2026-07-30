import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { loadKkoIntoAtomSpace } from './kko'
import {
  ingestVendorFreshness, stalenessOf, blastRadiusOf, contractCrossingRiskOf,
  proposeRevendor, analyzeVendorFreshness, vendorPinIds, vfpId,
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

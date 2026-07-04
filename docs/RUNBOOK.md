# Super-peer Operator Runbook

Operating the deployable HellGraph super-peer (see `deploy/README.md` for build/deploy).

## Roles
- **Super-peer** — a peer with uptime + an index. It replicates participants' sovereign logs
  and serves the causally-merged view. It is **never an authority**: it cannot forge or rewrite,
  and the whole view is rebuildable from the participant logs.
- **Participant** — a sovereign node that owns its Hypercore (its keypair = its write authority).

## Mint an access token
Tokens are stateless HMAC bearer tokens carrying `{id, tenant?, scopes[]}`. Scopes:
`read` (health/cut), `query`, `admit`.
```js
import { HmacTokenVerifier } from '@socioprophet/hellgraph'
const v = HmacTokenVerifier.fromSecret(process.env.HELLGRAPH_AUTH_SECRET)
const token = v.mint({ id: 'analyst-1', tenant: 'acme', scopes: ['read', 'query'] })
```
Use it: `Authorization: Bearer <token>`.

## Bring up a federation
1. Deploy a super-peer with **no** `HELLGRAPH_BOOTSTRAP_KEY` → it is the **creator**. Read its
   base key: `GET /health` → `baseKey` (or the pod log line `role=creator base=<hex>`).
2. Each participant bootstraps from that base key (`FederatedAtomSpace.create(dir, { bootstrap })`).
3. Admit the participant's writer key (governance action, scope `admit`):
   ```bash
   curl -sX POST $BASE/admit -H "authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{"writerKey":"<participant localWriterKey hex>"}'
   ```
   After the participant syncs, `isWritable()` is true and its ops merge into the view.

## Query
```bash
curl -sX POST $BASE/query -H "authorization: Bearer $QUERY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"lang":"metta","query":"(match &self (InheritanceLink $x (ConceptNode Mammal)) $x)"}'
```
`lang` ∈ `sparql | gremlin | metta`.

## Health, liveness, metrics
- `GET /livez` — public liveness (k8s probe).
- `GET /health` — scope `read`: `{nodes, edges, writers, cut}`.
- `GET /cut` — scope `read`: the current causal cut (version vector over writer cores).
- `GET /metrics` — public Prometheus (network-restrict): `hellgraph_requests_total`,
  `hellgraph_queries_total{lang}`, `hellgraph_ratelimited_total`, `hellgraph_errors_total`.

## Key custody (masking)
- **Standard tier** — `KmsKeyProvider.load(kmsClient, wrappedDataKey)` (KMS envelope).
- **Sovereign tier** — split the key with `splitSecret(key, n, t)`, distribute shares; reconstruct
  with `new ThresholdKeyProvider(shares, t)`. No single party (operator included) can unmask alone.

## Backup / DR
- The corestore PVC is the local durability. Snapshot it (VolumeSnapshot) for fast restore.
- **True DR**: the merged view is a *derived* store — if a super-peer is lost, a new one
  re-materializes the entire view by replaying the participants' sovereign logs. No data lives
  only on the super-peer.

## Troubleshooting
- **401** — missing/invalid token. **403** — token lacks the route's scope. **429** — rate-limited.
- **Participant not writable after admit** — it hasn't synced; ensure replication (swarm reachable
  or a direct transport) and re-`update()`.
- **`joinSwarm` fails / no peers** — Hyperswarm needs UDP egress + hole-punching; set
  `HELLGRAPH_JOIN_SWARM=0` and wire a direct transport if the cluster blocks it.
- **Endpoints OPEN warning** — `HELLGRAPH_AUTH_SECRET` unset. Set it in production.

# Deploying the HellGraph super-peer

The super-peer is the deployable managed-HellGraph service (`super-peer.ts` +
`superpeer-service.ts`): it joins a federation, replicates participants' sovereign Hypercore
logs, keeps an always-on Autobase materialization, and serves the causally-merged view over
HTTP (SPARQL / Gremlin / MeTTa) with bearer auth. It is an **index, never an authority** — it
cannot forge or rewrite (every atom traces to a participant signature).

## Artifacts
- `superpeer.mjs` — container entrypoint (boots from env, drains on SIGTERM).
- `Dockerfile` — multi-stage build (native optional deps included).
- `k8s/superpeer.yaml` — Namespace, Secret, PVC, Deployment, Service (GKE).
- `argocd-application.yaml` — GitOps sync.

## Configuration (env)
| var | default | meaning |
|---|---|---|
| `HELLGRAPH_HTTP_PORT` | `8850` | HTTP port |
| `HELLGRAPH_STORAGE_DIR` | `/var/lib/hellgraph-superpeer` | corestore dir (mount a PVC) |
| `HELLGRAPH_BOOTSTRAP_KEY` | — | edge federation base key (hex). Omit → this node is the creator |
| `HELLGRAPH_JOIN_SWARM` | `1` | `0` to skip Hyperswarm discovery (HTTP-only) |
| `HELLGRAPH_AUTH_SECRET` | — | HMAC secret for bearer auth. **Unset → endpoints are OPEN (dev only)** |

## Endpoints
- `GET /livez` — **public** liveness (used by k8s probes).
- `GET /health`, `GET /cut` — scope `read`
- `POST /query {lang: sparql|gremlin|metta, query}` — scope `query`
- `POST /admit {writerKey}` — scope `admit` (governance: admit a sovereign participant)

Mint a token with `HmacTokenVerifier.fromSecret(secret).mint({ id, scopes: ['query'] })`.

## Build & deploy
```bash
docker build -f deploy/Dockerfile -t $REGISTRY/hellgraph-superpeer:$TAG .
docker push $REGISTRY/hellgraph-superpeer:$TAG

# real auth secret (do NOT commit it)
kubectl -n hellgraph create secret generic hellgraph-superpeer-auth \
  --from-literal=HELLGRAPH_AUTH_SECRET="$(openssl rand -hex 32)"

# then edit image REGISTRY/TAG in k8s/superpeer.yaml and:
kubectl apply -f deploy/k8s/superpeer.yaml         # or via ArgoCD
kubectl apply -f deploy/argocd-application.yaml
```

## Notes / not-yet-validated
- The image is **not built in CI** in this repo; the entrypoint is smoke-tested locally
  (`node deploy/superpeer.mjs` boots, serves `/livez` + `/health`, drains on SIGTERM).
- **Hyperswarm** needs UDP egress + hole-punching for DHT discovery; if the cluster blocks it,
  set `HELLGRAPH_JOIN_SWARM=0` and wire replication over a direct transport/sidecar.
- Single replica on one RWO PVC (`Recreate` strategy) — the super-peer is a single-writer
  index. Scale-out is a read-replica concern, not a second writer on the same store.
- Manage the auth secret with sealed-secrets / external-secrets in real environments.

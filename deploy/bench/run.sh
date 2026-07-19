#!/usr/bin/env bash
# run.sh — one-command boundary-halo PageRank benchmark on an existing k8s cluster.
# Spin up → deploy → verify → TEAR DOWN. Assumes kubectl is pointed at the target cluster and you can
# push to $REGISTRY. Does NOT create or delete the cluster itself (that stays an explicit, separate step
# so nobody leaves a cluster running by accident).
#
# Usage:
#   REGISTRY=us-docker.pkg.dev/PROJECT/hellgraph deploy/bench/run.sh [TAG]
#
# Env:
#   REGISTRY   (required) container registry prefix
#   TAG        image tag (default: git short sha)
#   KEEP=1     skip teardown (leave pods for inspection) — you then MUST clean up manually
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
K8S="$HERE/k8s"
: "${REGISTRY:?set REGISTRY=your.registry/path}"
TAG="${1:-$(git -C "$ROOT" rev-parse --short HEAD)}"
IMAGE="$REGISTRY/hellgraph-bench:$TAG"
# Project id (for the Cloud Build SA resource path) — field 2 of the AR registry host/PROJECT/repo.
PROJECT_ID="${PROJECT_ID:-$(echo "$REGISTRY" | cut -d/ -f2)}"

# HG_SHARDS is the single source of truth for the worker fan-out.
SHARDS="$(grep -E '^\s*HG_SHARDS:' "$K8S/configmap.yaml" | grep -oE '[0-9]+' | head -1)"
echo "▸ image=$IMAGE  shards=$SHARDS"

teardown() {
  [ "${KEEP:-0}" = "1" ] && { echo "▸ KEEP=1 — leaving resources up. Clean up with: kubectl delete -k $K8S (or by label app=hg-bench)"; return; }
  echo "▸ tearing down (spin up → work → TEAR DOWN)"
  kubectl delete job hg-workers hg-coordinator --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete svc hg-coordinator --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete configmap hg-bench-params --ignore-not-found >/dev/null 2>&1 || true
}
trap teardown EXIT

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "▸ SKIP_BUILD=1 — using pre-built image $IMAGE"
else
  echo "▸ build + push (BUILDER=${BUILDER:-docker})"
  case "${BUILDER:-docker}" in
    cloudbuild)
      # Server-side build — no local docker daemon needed. Uses cloudbuild.yaml so the non-root Dockerfile
      # is honoured. CLOUDBUILD_SA lets hardened projects (deleted default compute SA) name a build SA.
      SA_ARG=()
      [ -n "${CLOUDBUILD_SA:-}" ] && SA_ARG=(--service-account "projects/$PROJECT_ID/serviceAccounts/$CLOUDBUILD_SA")
      gcloud builds submit "$ROOT" --config="$HERE/cloudbuild.yaml" \
        --substitutions=_IMAGE="$IMAGE" "${SA_ARG[@]}"
      ;;
    docker)
      docker build -f "$HERE/Dockerfile" -t "$IMAGE" "$ROOT"
      docker push "$IMAGE"
      ;;
    *) echo "unknown BUILDER=$BUILDER (want docker|cloudbuild)"; exit 2 ;;
  esac
fi

echo "▸ apply configmap + coordinator + workers"
kubectl apply -f "$K8S/configmap.yaml"
# Substitute the image and keep worker completions/parallelism == HG_SHARDS.
sed "s#IMAGE_PLACEHOLDER#$IMAGE#g" "$K8S/coordinator.yaml" | kubectl apply -f -
# NOTE: use [[:space:]] not \s — BSD/macOS sed does not understand \s, so \s* silently matches nothing and
# the fan-out stays at the file's default (an 8-vs-16 shard mismatch hangs the coordinator). POSIX class works
# on both GNU and BSD sed.
sed -e "s#IMAGE_PLACEHOLDER#$IMAGE#g" \
    -e "s/^\([[:space:]]*completions:\).*/\1 $SHARDS/" \
    -e "s/^\([[:space:]]*parallelism:\).*/\1 $SHARDS/" \
    "$K8S/workers.yaml" | kubectl apply -f -

echo "▸ waiting for the run to finish (coordinator prints the verified result) ..."
# Stream coordinator logs once its pod is scheduled.
kubectl wait --for=condition=ready pod -l role=coordinator --timeout=180s || true
kubectl logs -f job/hg-coordinator || true

echo "▸ result (coordinator job):"
kubectl wait --for=condition=complete job/hg-coordinator --timeout=1800s && echo "✔ COMPLETE" || echo "✗ coordinator did not complete — see logs above"

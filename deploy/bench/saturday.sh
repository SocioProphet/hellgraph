#!/usr/bin/env bash
# saturday.sh — the whole money run in one command: create GKE cluster → build image (Cloud Build, no
# local docker) → run the boundary-halo benchmark → TEAR DOWN the cluster. Ephemeral by construction
# (spin up → work → tear down); the cluster delete runs on EXIT no matter what.
#
# Usage:
#   PROJECT=my-proj REGION=us-central1 deploy/bench/saturday.sh            # full run
#   PROJECT=my-proj deploy/bench/saturday.sh --preflight                   # checks only, spends nothing
#
# Env:
#   PROJECT   (required) GCP project id
#   REGION    default us-central1
#   NODES     cluster node count (default = HG_SHARDS + 1 for the coordinator)
#   MACHINE   node machine type (default e2-standard-4 = 4 vCPU / 16 GB, matches the sizing table)
#   CLUSTER   cluster name (default hg-bench)
#   REPO      Artifact Registry repo (default hellgraph); AR host derived from REGION
#   KEEP=1    skip cluster teardown (you MUST delete it yourself afterwards)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S="$HERE/k8s"
PREFLIGHT=0; [ "${1:-}" = "--preflight" ] && PREFLIGHT=1

: "${PROJECT:?set PROJECT=your-gcp-project}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-hg-bench}"
REPO="${REPO:-hellgraph}"
MACHINE="${MACHINE:-e2-standard-4}"
SHARDS="$(grep -E '^\s*HG_SHARDS:' "$K8S/configmap.yaml" | grep -oE '[0-9]+' | head -1)"
NODES="${NODES:-$((SHARDS + 1))}"
AR_HOST="${REGION}-docker.pkg.dev"
export REGISTRY="${AR_HOST}/${PROJECT}/${REPO}"

echo "── plan ─────────────────────────────────────────────"
echo "  project=$PROJECT region=$REGION cluster=$CLUSTER"
echo "  nodes=$NODES × $MACHINE (spot)   shards=$SHARDS"
echo "  registry=$REGISTRY   builder=cloudbuild (no local docker)"
echo "  scale=$(grep -E '^\s*HG_SCALE:' "$K8S/configmap.yaml" | grep -oE '[0-9]+' | head -1) (≈edges = 2^scale × edgefactor)"
echo "─────────────────────────────────────────────────────"

# ── preflight: verify everything WITHOUT spending a cent ──────────────────────────────────────────────
echo "▸ preflight"
command -v gcloud >/dev/null || { echo "✗ gcloud not found"; exit 1; }
command -v kubectl >/dev/null || { echo "✗ kubectl not found"; exit 1; }
gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q . \
  || { echo "✗ gcloud not authenticated — run: gcloud auth login"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null
echo "  ✓ gcloud authenticated, project set"
# APIs needed: container (GKE), cloudbuild, artifactregistry.
for api in container.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com; do
  if gcloud services list --enabled --format="value(config.name)" 2>/dev/null | grep -q "$api"; then
    echo "  ✓ API enabled: $api"
  else
    echo "  ! API NOT enabled: $api  (enable: gcloud services enable $api)"
    [ "$PREFLIGHT" = 0 ] && { echo "    enabling…"; gcloud services enable "$api"; }
  fi
done
# Artifact Registry repo present?
if gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1; then
  echo "  ✓ Artifact Registry repo $REPO exists"
else
  echo "  ! AR repo $REPO missing in $REGION"
  [ "$PREFLIGHT" = 0 ] && gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" --description="hellgraph bench images"
fi
python3 - "$K8S" <<'PY'
import glob, sys, yaml
for f in sorted(glob.glob(sys.argv[1] + "/*.yaml")):
    list(yaml.safe_load_all(open(f)))
    print(f"  ✓ manifest parses: {f}")
PY

if [ "$PREFLIGHT" = 1 ]; then
  echo "▸ preflight OK — nothing was created, no spend. Drop --preflight to run for real."
  exit 0
fi

# ── cluster lifecycle (ephemeral) ─────────────────────────────────────────────────────────────────────
teardown() {
  [ "${KEEP:-0}" = "1" ] && { echo "▸ KEEP=1 — cluster $CLUSTER left UP. Delete it: gcloud container clusters delete $CLUSTER --region $REGION --quiet"; return; }
  echo "▸ TEAR DOWN cluster $CLUSTER (spin up → work → tear down)"
  gcloud container clusters delete "$CLUSTER" --region "$REGION" --quiet || true
}
trap teardown EXIT

echo "▸ create GKE cluster (spot, ephemeral)"
gcloud container clusters create "$CLUSTER" \
  --region "$REGION" --num-nodes "$NODES" --machine-type "$MACHINE" --spot \
  --no-enable-autoupgrade --enable-ip-alias
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION"

echo "▸ run the benchmark (Cloud Build image → deploy → stream verified result)"
BUILDER=cloudbuild "$HERE/run.sh"

echo "▸ done — result streamed above; cluster teardown on exit"

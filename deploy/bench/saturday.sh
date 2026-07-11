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
# ZONAL cluster: --num-nodes is then the EXACT node count (a regional cluster multiplies it by 3 zones,
# which both triples the bill and spreads nodes across zones — worse for the BSP halo latency). Single-zone
# also gives the tightest node-to-node network for the halo exchange.
ZONE="${ZONE:-${REGION}-a}"
CLUSTER="${CLUSTER:-hg-bench}"
REPO="${REPO:-hellgraph}"
MACHINE="${MACHINE:-e2-standard-4}"
SHARDS="$(grep -E '^\s*HG_SHARDS:' "$K8S/configmap.yaml" | grep -oE '[0-9]+' | head -1)"
NODES="${NODES:-$((SHARDS + 1))}"
AR_HOST="${REGION}-docker.pkg.dev"
export REGISTRY="${AR_HOST}/${PROJECT}/${REPO}"
# Spot is OPT-IN (SPOT=1). Default = on-demand: a spot preemption of any node fails the whole non-idempotent
# run, and we ate exactly that. Spot is fine for throwaway/short runs where you accept the risk.
SPOT_FLAG=""; [ "${SPOT:-0}" = "1" ] && SPOT_FLAG="--spot"
CAP=$([ -n "$SPOT_FLAG" ] && echo spot || echo on-demand)

echo "── plan ─────────────────────────────────────────────"
echo "  project=$PROJECT region=$REGION zone=$ZONE cluster=$CLUSTER"
echo "  nodes=$NODES × $MACHINE ($CAP)   shards=$SHARDS"
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
# Quota check: a ZONAL cluster uses NODES × vCPU-per-node CPUs of the machine's family. Catch it BEFORE
# creating (we once blew the T2A regional quota with a regional cluster × 3 zones).
VCPU_PER=$(echo "$MACHINE" | grep -oE '[0-9]+$'); : "${VCPU_PER:=4}"
NEED_CPUS=$((NODES * VCPU_PER))
FAMILY=$(echo "$MACHINE" | cut -d- -f1 | tr '[:lower:]' '[:upper:]')   # t2a → T2A
QUOTA_METRIC="${FAMILY}_CPUS"; [ "$FAMILY" = "E2" ] && QUOTA_METRIC="CPUS"
LIMIT=$(gcloud compute regions describe "$REGION" --format="value(quotas)" 2>/dev/null \
  | tr ';' '\n' | grep -A2 "'$QUOTA_METRIC'" | grep -oE "limit[^,]*" | grep -oE '[0-9]+' | head -1)
if [ -n "$LIMIT" ] && [ "$NEED_CPUS" -gt "$LIMIT" ]; then
  echo "  ✗ QUOTA: need $NEED_CPUS $QUOTA_METRIC ($NODES × $VCPU_PER) but limit is $LIMIT in $REGION — reduce NODES or request quota"
  [ "$PREFLIGHT" = 1 ] && exit 1
else
  echo "  ✓ quota: $NEED_CPUS $QUOTA_METRIC needed, limit ${LIMIT:-unknown}"
fi

if [ "$PREFLIGHT" = 1 ]; then
  echo "▸ preflight OK — nothing was created, no spend. Drop --preflight to run for real."
  exit 0
fi

# ── cluster lifecycle (ephemeral) ─────────────────────────────────────────────────────────────────────
teardown() {
  [ "${KEEP:-0}" = "1" ] && { echo "▸ KEEP=1 — cluster $CLUSTER left UP. Delete it: gcloud container clusters delete $CLUSTER --zone $ZONE --quiet"; return; }
  echo "▸ TEAR DOWN cluster $CLUSTER (spin up → work → tear down)"
  gcloud container clusters delete "$CLUSTER" --zone "$ZONE" --quiet || true
}
trap teardown EXIT

echo "▸ create GKE cluster (zonal $ZONE, spot, ephemeral) — $NODES × $MACHINE"
# Node identity: many hardened projects delete the default Compute Engine SA, so allow an explicit node
# service account via NODE_SA (e.g. gke-prophet-nodes@PROJECT.iam.gserviceaccount.com). If unset, GKE uses
# the project default (which must exist).
SA_FLAG=()
[ -n "${NODE_SA:-}" ] && SA_FLAG=(--service-account "$NODE_SA")
gcloud container clusters create "$CLUSTER" \
  --zone "$ZONE" --num-nodes "$NODES" --machine-type "$MACHINE" $SPOT_FLAG \
  --no-enable-autoupgrade --enable-ip-alias "${SA_FLAG[@]}"
gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE"

echo "▸ run the benchmark (Cloud Build image → deploy → stream verified result)"
BUILDER=cloudbuild "$HERE/run.sh"

echo "▸ done — result streamed above; cluster teardown on exit"

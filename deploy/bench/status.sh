#!/usr/bin/env bash
# status.sh — one-command view of a running bench: nodes, pods (with placement), the coordinator's phase
# log, and the reason for anything that's Pending/Failed. This is the "why is it stuck" dashboard.
#   deploy/bench/status.sh          # snapshot
#   watch -n5 deploy/bench/status.sh  # live
set -uo pipefail

echo "── nodes ───────────────────────────────────────────────"
kubectl get nodes -o custom-columns=NODE:.metadata.name,POOL:'.metadata.labels.cloud\.google\.com/gke-nodepool',STATUS:.status.conditions[-1].type 2>/dev/null

echo "── pods (placement) ────────────────────────────────────"
kubectl get pods -l app=hg-bench -o custom-columns=POD:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName 2>/dev/null

# Surface WHY anything isn't Running (the thing we had to dig for last time).
STUCK=$(kubectl get pods -l app=hg-bench --field-selector=status.phase=Pending -o name 2>/dev/null)
if [ -n "$STUCK" ]; then
  echo "── ⚠ pending pods — scheduler reason ───────────────────"
  for p in $STUCK; do
    echo "  $p:"
    kubectl describe "$p" 2>/dev/null | grep -A2 "Events:" | grep -iE "FailedScheduling|Insufficient|untolerated|didn't" | head -2 | sed 's/^/    /'
  done
fi

echo "── coordinator memory / cpu ────────────────────────────"
kubectl top pod -l role=coordinator --no-headers 2>/dev/null | awk '{print "  cpu="$2" mem="$3}' || echo "  (metrics not ready)"

echo "── coordinator phase log (tail) ────────────────────────"
kubectl logs job/hg-coordinator --tail=12 2>/dev/null | sed 's/^/  /' || echo "  (no coordinator log yet)"

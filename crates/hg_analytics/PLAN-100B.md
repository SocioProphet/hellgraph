# The 100B mark (ready-to-run)

## PHASE PLAN 2026-07-12 (post-68B) — NETWORK is the bottleneck, not compute

**68B BURIED** (RECEIPT-68B.txt): 68.7B edges verified, Σrank=1.0, torn down. 2.1× past Neptune's 32B ceiling.
BUT ~25 min: **network-bound at ~26 MB/s/node** in BOTH gen+shuffle (1030s) and PageRank-halo (498s). The 5
compute annealing passes (opt8: parallel gen/receive/pack/sort/ghost) sped up compute — which was NOT the
dominant cost. Lesson: measure before optimizing.

### NEXT SESSION — ONE spend that fixes AND measures (candidates pre-attacked):
`opt10` source staged (`hg-src-opt10.tar.gz`) already contains BOTH: the top fix + the instrument, so the
next run confirms the fix and names any remainder in a single spend (no measure-then-fix double-spend).
1. **Build opt10x86** (kaniko flow below) → run a cheap **10B (scale-29) with HG_TIMING=1** on a small cluster.
2. Read the two splits: `[setup shard N] gen/shuffle/csr/route` + `[shard N] compute/halo/sync`.
   - If gen+shuffle collapsed → the socket-buffer fix WAS the 26MB/s wall → re-run 68B fast, then 100B.
   - If shuffle still slow → the split says whether it's send, round-2 `all_to_all`, or halo → fix that next.
- **DONE (opt10, bit-exact):** (a) **16MiB SO_SNDBUF/SO_RCVBUF** on the mesh sockets (socket2) — top suspect;
  64KB default / 2.5ms RTT = 26 MB/s, matches the wall exactly. Round-2 + halo use the same sockets → fixed
  for free. (b) setup-phase instrumentation.
- **HELD (attack only if the split says so):** `write_robust` chunk bump (unlikely — blocking sockets + big
  buffers make 1MiB fine; risks loopback stability); round-2 `all_to_all` windowing; **LZ4 compression** (only
  if byte-bound, not window-bound); higher HG_RECV_WINDOW (config knob, try 32 on the cluster).
3. Then re-run 68B fast, then push 100B.

### NODE-SCALING BLOCKER (needed for fast shuffle AND 100B):
- **IN_USE_ADDRESSES quota = 69** caps on-demand nodes (1 external IP each) → forces few-big-nodes
  (n2d-standard-16 ×62) = slow shuffle. Fix EITHER: (a) request IN_USE_ADDRESSES bump to ~256, OR (b) **private
  cluster** `--enable-private-nodes --enable-ip-alias --master-ipv4-cidr=172.16.0.0/28` (no external IPs;
  Private Google Access pulls AR; internal pod mesh) → then 250× n2d-standard-4 = fast many-small shuffle.
- N2D_CPUS = 1000 granted (2048 requested, manual-review pending).



## UPDATE 2026-07-12 — 10B DONE, straggler diagnosis, build-via-Kaniko

- **10B PROVEN**: 8,589,934,592-edge PageRank (scale-29), 47 workers on x86/EPYC spot, balanced partition,
  NO node held O(m)/O(n), Σrank=1.0. gen+shuffle+route 462s, PageRank 110s. (8.6B is still UNDER Neptune
  ~16-32B / Neo4j ~18B ceilings — the architectural burial needs >32B = the 100B run.)
- **Build path is now KANIKO, not Cloud Build**: `gcloud builds submit` is walled by an org/deny policy on
  `serviceusage.services.use` for michael@ (role is granted but still denied — can't fix from CLI). Instead:
  tar repo → `gsutil cp` to `gs://socioprophet-platform_cloudbuild/hg-src-<tag>.tar.gz` → run
  `deploy/bench/k8s/kaniko-build.yaml` (edit the gs:// name + destination tag) on the cluster. Needs node SA
  `gke-prophet-nodes@` to have `artifactregistry.writer` + `storage.objectViewer` (GRANTED 2026-07-12).
  Local podman is DEAD (VM crashes). Kaniko is the build. Images: opt3x86 (comm opts), opt4x86 (+ prefetch).
- **Straggler tax is the #1 wall-clock limiter on SPOT**: every run draws a slow node (compute 2.6–3× the
  others = memory-bandwidth starvation on a shared spot host). The synchronous Anderson/dangling all-reduce
  makes all workers wait for the slowest each superstep. NOT a cheap code fix — true fix = async PageRank
  (versioned halos, drops bit-exact) = task #14. Reliable fix = UNIFORM ON-DEMAND nodes (below). Note: at
  100B the all-to-all SHUFFLE dominates wall-clock, so the straggler tax (~2× on PageRank) is secondary.
- **Shipped `opt4`: bit-exact software prefetch** in the pull gather (x86 `_mm_prefetch`, no-op on arm) —
  hides random contrib[] cache-miss latency. Verified bit-exact (max|Δ| 4.79e-15). Measure its effect at 10B.

### On-demand / uniform node config (kills stragglers)
```bash
# Tear the spot cluster, create ON-DEMAND n2d-standard-16 (64GB, full memory domain per worker, no noisy
# neighbors). Within the 200-vCPU quota: 12 nodes = 192 vCPU = 11 workers + coordinator (good for a 10B
# validation). For 100B: needs the quota bump → ~108 × n2d-standard-16.
gcloud container clusters delete hg-bench-x86 --zone us-central1-a --quiet   # frees N2D quota
gcloud container clusters create hg-bench-od --zone us-central1-a \
  --machine-type n2d-standard-16 --num-nodes 12 \
  --disk-size 100 --disk-type pd-balanced --no-enable-autoupgrade \
  --service-account gke-prophet-nodes@socioprophet-platform.iam.gserviceaccount.com   # NO --spot = on-demand
```
Worker resources: bump limit to ~48Gi (n2d-standard-16 = 64GB) for the bigger per-worker shard at 10B/100B.

---

# (original) plan — the 100B mark (ready-to-run)

## Where we ended tonight (2026-07-11)

**Proven on GKE (real receipts):**
- 1B PageRank, balanced partition + parallel compute (`opt2` image): **92s total** (gen+shuffle 75s, PageRank
  17s), **1.57 GTEPS**, Σrank=1.0, bit-exact, 16 t2a spot nodes. That's **3.6× faster** than the first 1B (335s).
- Real-cluster superstep breakdown (the key diagnostic): **compute 63% · halo-send 18% · sync 13% · halo-recv 7%**.
  → We are COMPUTE-bound (memory-bandwidth-bound), not comm-bound, at 1B/16-node.

**Written + locally verified bit-exact, NOT yet imaged (`opt3` code):**
- Concurrent halo sends (writer thread per peer — attacks the 18% serial send).
- Overlapped coordinator sync (fire dangling reduce before halo, read reply after — hides the ~7%).
- Balanced partition (`mix(v)%k`, invertible bit-permutation): imbalance 5.34×→1.09×, bijection + 2 lib tests.
- Parallel pull/contrib/Anderson-apply (rayon), ~2× per-node (memory-bandwidth wall past that).
- `HG_TIMING=1` → per-shard `compute/halo/sync` breakdown to stdout.
- `examples/skew_check.rs` — range-vs-balanced partition imbalance tool.

**Environment lessons (IMPORTANT for tomorrow):**
- **Local podman is UNRELIABLE this machine** — the VM (krunkit AND applehv) crashed ~4× mid-build tonight,
  triggered by a full host disk. **Build via CLOUD BUILD, not local podman.**
- **Cloud Build now works** — `michael@` was granted `roles/serviceusage.serviceUsageConsumer` tonight (was the
  blocker). Build SA = `cloudbuild-runner@`. IAM propagation is done by morning.
- Host disk had filled (from 119 stale podman images) — keep an eye on it; `rm -rf target` + prune if needed.
- All clusters TORN DOWN. No infra billing overnight.

## Quotas (us-central1)
- T2A (arm): 96 vCPU · N2 / N2D (x86): 200 vCPU each · general CPUS: 200 · **16× A100 spot GPUs** available.
- 100B needs ~2048 vCPU → **FILE A QUOTA BUMP FIRST THING** (it approves during the day).

## Step-by-step (copy/paste order)

```bash
# 0. Re-auth (fresh in AM)
gcloud auth login
gcloud config set project socioprophet-platform

# 1. FILE THE 100B QUOTA BUMP IMMEDIATELY (so it approves while we do 1B/10B)
#    Console → IAM & Admin → Quotas → filter "N2D_CPUS" (or T2A_CPUS) us-central1 → request ~2048.

# 2. Build opt3 via CLOUD BUILD (x86 — NOT local podman)
cd ~/dev/hellgraph-rust
gcloud builds submit . --config=deploy/bench/cloudbuild.yaml \
  --substitutions=_IMAGE=us-central1-docker.pkg.dev/socioprophet-platform/hellgraph/hellgraph-bench:opt3x86 \
  --service-account projects/socioprophet-platform/serviceAccounts/cloudbuild-runner@socioprophet-platform.iam.gserviceaccount.com

# 3. Create x86/N2D cluster (EPYC = high mem bandwidth = our bottleneck; 192/200 vCPU)
gcloud container clusters create hg-bench-x86 --zone us-central1-a \
  --machine-type n2d-standard-4 --num-nodes 48 --spot --disk-size 50 --disk-type pd-balanced \
  --no-enable-autoupgrade \
  --service-account gke-prophet-nodes@socioprophet-platform.iam.gserviceaccount.com
gcloud container clusters get-credentials hg-bench-x86 --zone us-central1-a
```

Then deploy (via `deploy/bench/run.sh` or manual `kubectl apply` with the configmap):
- **1B A/B** first: scale-26, 16 shards, `HG_TIMING=1` → confirm halo-send dropped from 18% (validates opt3).
- **10B**: scale-29 (~8.6B), 47 shards on the 48-node cluster (47 workers + 1 coord). ~183M edges/worker fits 16GB.
- **100B**: only after the quota bump lands. ~128 × n2d-standard-16 (or T2A). scale-33 (~137B) or ef-tuned ~100B.
  Balanced partition + u64 ids make it memory-safe; watch per-shard `HG_TIMING` for the comm fraction at 128 nodes.

### Deploy gotchas (learned the hard way)
- k8s sed MUST use `[[:space:]]` not `\s` (BSD/macOS sed) to sync `completions`/`parallelism` to HG_SHARDS —
  else workers come up at the file default (8) against a 16+ coordinator and the run HANGS. (Fixed in run.sh.)
- configmap flags: `HG_RUNTIME=dist_gen HG_VERIFY=0 HG_ACCEL=5 HG_F32_HALO=1 HG_TIMING=1`.
- x86 image → x86 (n2d) cluster. Don't mix arch. (workers.yaml arm64 toleration is harmless on x86.)
- Node SA `gke-prophet-nodes@` is REQUIRED (hardened project — default compute SA deleted).
- **TEAR DOWN after each stage** (`gcloud container clusters delete hg-bench-x86 --zone us-central1-a --quiet`).
  If a delete collides with a still-running CREATE op, `gcloud container operations wait <op>` then delete.

## Optimization roadmap (after 10B, ranked)
1. **Cache-block the gather** (~1.5× on the 63% compute) — free SW, not yet done. Biggest remaining free lever.
2. **GPU nodes (HBM)** — the only real per-node throughput lever vs cuGraph; needs Metal→CUDA port. 16 A100
   spot already quota'd. Only pays off on 100B+ graphs a DGX can't hold.
3. **RDMA/EFA** — comm grows with node count; at 128 nodes the comm fraction rises, so revisit then.

## The scoreboard we're chasing
cuGraph 38 GTEPS (DGX-2, 16 GPUs). Us: 1.57 GTEPS on cheap CPU spot after tonight's 6× — ~1/24th, for ~$0.
Burial thesis holds: Neptune/Neo4j wall at ~16-32B (can't hold 100B at any price); we hold it on spot + teardown.

# hg_analytics — distributed graph analytics benchmarks

Every number here is reproducible from this crate on a commodity machine (measured on an 8-core laptop,
`--release`). Determinism is a hard invariant: every distributed result is checked **bit-for-bit** against
the single-graph reference, so "distributed" never means "approximate". The synthetic graph is Graph500
Kronecker/RMAT (`Kronecker`), so there is nothing to download.

## The thesis, in one line

Rust + a boundary-only halo + an edge-cut partition beats the usual distributed-BSP graph engine on the
axis that actually caps scale — **the bytes that cross the network each superstep** — while staying exact,
and it is competitive-to-faster than optimized single-node sparse linear algebra.

## 1. Single-node vs off-the-shelf (same graph, same machine, matched damping/tol)

```
cargo run -p hg_analytics --release --example vs_baseline   # emits the shared graph + our result
python3 scripts/bench/vs_baseline.py                        # runs networkx + scipy on it
```

| graph (RMAT ef=16) | hg_analytics | scipy sparse (C/BLAS) | networkx (pure Py) | agreement |
|--------------------|-------------:|----------------------:|-------------------:|:---------:|
| scale 15, 524K edges | **9.4 ms** | 32 ms (3.4× slower) | 271 ms (29× slower) | top-100 100% |
| scale 17, 2.1M edges | **44 ms** | 122 ms (2.8× slower) | 1.28 s (29× slower) | top-100 100% |

PageRank is memory-bound, so parallel-vs-serial is ~1.6× (honest) and scipy's spmv is also well-optimized —
~3× is a real single-node win, not a strawman, and the ranking is identical.

## 2. Boundary-only halo — the scaling unlock

```
cargo run -p hg_analytics --release --example halo_bench
```

The naive distributed BSP broadcasts the full O(n) rank vector to every shard each superstep (k·n). The
boundary-only halo sends each shard only the ghost ranks its edges reference. Same fixed point (max|Δ|
< 1e-16), far less wire. On RMAT scale-16, k=16:

| partition | edge cut | per-step halo vs full broadcast | balance |
|-----------|---------:|--------------------------------:|--------:|
| range (naive) | 85% | 5.9× less | 1.0× |
| **Fennel (edge-cut)** | **20%** | **13.1× less** | 3.0× |
| LDG | 76% | 7.2× less | 1.1× |

Fennel = 4× fewer crossing edges. The advantage **grows with scale**: edge cut falls 23% → 15% from
scale 14 → 20 (`dress_rehearsal`), the opposite of how a full-broadcast BSP degrades.

## 3. Real multi-process, over TCP (not shared memory)

```
cargo run -p hg_analytics --release --example dist_boundary   # coordinator-relay
cargo run -p hg_analytics --release --example dist_p2p        # pure peer-to-peer mesh
```

N worker **processes**, Fennel-partitioned, boundary halo over real sockets. Edges never leave a worker.

| runtime | scale-18, 4.2M edges, 8 procs | correctness |
|---------|-------------------------------|:-----------:|
| relay (`dist_boundary`) | 122 ms, 6.5× less wire than full-broadcast BSP | max\|Δ\| 8.6e-16 |
| **P2P mesh (`dist_p2p`)** | **99.99% of bytes peer-to-peer, coordinator 128 B/step (O(k))** | max\|Δ\| 8.6e-16 |

The P2P mesh removes the coordinator from the hot path: its traffic is O(k), independent of graph size —
the difference between an 8-node demo and a 64-node run.

## 4. The distributed suite — four LDBC kernels, all exact

```
HG_SCALE=20 HG_SHARDS=16 cargo run -p hg_analytics --release --example ldbc_suite
```

One Fennel partition, four computational shapes, self-verifying scorecard. Scale-20 (1M nodes / 16.8M
edges, 16 shards):

| kernel | shape | time | halo/step | vs single-graph |
|--------|-------|-----:|----------:|:---------------:|
| PageRank | fixpoint | 1.01 s | 7.6 MB | max\|Δ\| 6e-17 ✓ |
| WCC | label-prop | 0.22 s | 5.4 MB | exact ✓ |
| BFS | unit traversal | 0.20 s | 5.4 MB | exact ✓ |
| SSSP | weighted traversal | 0.49 s | 10.8 MB | max\|Δ\| 0 ✓ |

Four of the six LDBC Graphalytics kernels (BFS, PR, WCC, SSSP), boundary-halo distributed, all bit-exact
against their single-graph reference (SSSP vs serial Dijkstra).

## 5. Out-of-core (single machine, > RAM)

```
cargo run -p hg_analytics --release --example billions
```

Bucketed CSR on disk (mmap'd), O(n) heap: **500M edges** built + PageRanked on a laptop (159 s build,
11.9 s / 3 iters, ~1.2 GB resident, Σrank = 1.0). Streaming builder thrashes past ~100M; the bucketed
(sequential-I/O) builder is the one that holds.

## Cluster sizing (measured, not guessed)

~126 bytes/edge resident (`dress_rehearsal`):

| edges | nodes @ 16 GB | nodes @ 32 GB |
|------:|--------------:|--------------:|
| 1B | 8 | 4 |
| 10B | ~79 | ~40 |
| ~17B | ~135 | ~68 |

Run it on GKE: `deploy/bench/` (`saturday.sh` = create → Cloud Build → run → teardown).

## Honest limits

- No Neptune/TigerGraph **server** head-to-head on identical hardware yet — the library baselines
  (networkx/scipy) are what's reproducible here; the server comparison is the next artifact.
- `dist_p2p` uses a full mesh (only among peers with real boundary overlap); >100 nodes wants a sparser
  mesh and pod-IP wiring.
- Laptop out-of-core ceiling ~500M edges; beyond that is the cluster.
- LDBC coverage is 4/6 kernels (BFS, PR, WCC, SSSP); CDLP (community detection) and LCC (local clustering
  coefficient) are not yet distributed (Louvain exists single-graph).

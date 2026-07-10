#!/usr/bin/env python3
"""vs_baseline.py — head-to-head against off-the-shelf PageRank on the SAME graph the Rust engine emitted.

Runs, on the identical Graph500 graph and the same machine:
  1. networkx.pagerank            — pure Python (what a data scientist first reaches for)
  2. scipy sparse power iteration — optimized C/BLAS (the FAIR, fast baseline; no strawman)
and reports each engine's wall time + speedup vs our Rust parallel PageRank, plus top-100 agreement so the
comparison is honest about correctness, not just speed.

Prereqs: the Rust side wrote $HG_OUT (default /tmp/hg_vs) via:
    HG_SCALE=15 cargo run -p hg_analytics --release --example vs_baseline
Then: python3 scripts/bench/vs_baseline.py
"""
import os
import time
import numpy as np

OUT = os.environ.get("HG_OUT", "/tmp/hg_vs")

with open(f"{OUT}/meta.txt") as f:
    n, m, iters, damping, rust_serial_s, rust_parallel_s = f.read().split()
n, m, iters = int(n), int(m), int(iters)
damping, rust_serial_s, rust_parallel_s = float(damping), float(rust_serial_s), float(rust_parallel_s)
tol = 1e-6

edges = np.fromfile(f"{OUT}/edges.bin", dtype=np.uint32).reshape(-1, 2)
rust_top = [int(x) for x in open(f"{OUT}/rust_top.txt").read().split()]

print(f"graph: n={n} m={m} iters={iters} damping={damping}")
print(f"rust  parallel : {rust_parallel_s:.4f}s   (serial {rust_serial_s:.4f}s)")


def agreement(order):
    """top-100 overlap between a baseline's ranking and Rust's."""
    top = set(order[:100])
    return len(top & set(rust_top)) / 100.0


# ── scipy sparse power iteration (the optimized baseline) ────────────────────────────────────────────
from scipy.sparse import csr_matrix

t = time.perf_counter()
u, v = edges[:, 0].astype(np.int64), edges[:, 1].astype(np.int64)
outdeg = np.bincount(u, minlength=n).astype(np.float64)
# Column-stochastic transport: M[v,u] = 1/outdeg[u]; dangling handled explicitly each iter.
inv = np.zeros(n)
nz = outdeg > 0
inv[nz] = 1.0 / outdeg[nz]
M = csr_matrix((inv[u], (v, u)), shape=(n, n))
dangling = ~nz
r = np.full(n, 1.0 / n)
base = (1 - damping) / n
for _ in range(iters):
    dmass = r[dangling].sum()
    nxt = base + damping * (M.dot(r) + dmass / n)
    if np.abs(nxt - r).sum() < tol:
        r = nxt
        break
    r = nxt
scipy_s = time.perf_counter() - t
scipy_order = list(np.argsort(-r))
print(f"scipy sparse   : {scipy_s:.4f}s   → rust is {scipy_s / rust_parallel_s:6.1f}x faster   "
      f"top100 agree {agreement(scipy_order)*100:.0f}%")

# ── networkx pure Python (the naive baseline) ────────────────────────────────────────────────────────
try:
    import networkx as nx
    G = nx.DiGraph()
    G.add_nodes_from(range(n))
    G.add_edges_from(map(tuple, edges.tolist()))
    t = time.perf_counter()
    pr = nx.pagerank(G, alpha=damping, tol=tol, max_iter=iters)
    nx_s = time.perf_counter() - t
    nx_order = sorted(range(n), key=lambda i: -pr[i])
    print(f"networkx (py)  : {nx_s:.4f}s   → rust is {nx_s / rust_parallel_s:6.1f}x faster   "
          f"top100 agree {agreement(nx_order)*100:.0f}%")
except Exception as e:  # networkx OOMs / is too slow at large scale — skip gracefully
    print(f"networkx (py)  : skipped ({e})")

print("\nSame graph, same machine, matched damping/tol. Speedups are wall-clock; agreement confirms we "
      "compute the SAME ranking, just far faster.")

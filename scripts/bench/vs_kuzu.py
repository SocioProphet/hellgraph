#!/usr/bin/env python3
"""vs_kuzu.py — head-to-head against a REAL embedded graph database (KuzuDB, Cypher + native PageRank).

This is the comparison that usually "needs a cluster": an actual graph DB, not a linear-algebra library.
Kuzu runs in-process (no server, no docker), so we can put it head-to-head with hg_analytics on the SAME
Graph500 graph, on the SAME machine. We report Kuzu's bulk-load time and its PageRank compute time
separately (the fair algo-vs-algo comparison is compute-to-compute), plus top-100 ranking agreement.

Prereqs:
    pip install kuzu
    HG_SCALE=17 cargo run -p hg_analytics --release --example vs_baseline   # emits the shared graph
    HG_OUT=/tmp/hg_vs17 python3 scripts/bench/vs_kuzu.py
"""
import os
import time
import tempfile
import numpy as np
import kuzu

OUT = os.environ.get("HG_OUT", "/tmp/hg_vs17")
meta = open(f"{OUT}/meta.txt").read().split()
n, m = int(meta[0]), int(meta[1])
rust_parallel_s = float(meta[5])
edges = np.fromfile(f"{OUT}/edges.bin", dtype=np.uint32).reshape(-1, 2)
rust_top = [int(x) for x in open(f"{OUT}/rust_top.txt").read().split()]

print(f"graph: n={n} m={m}   (same RMAT graph hg_analytics used)")
print(f"hg_analytics parallel PageRank: {rust_parallel_s*1000:.1f} ms  (in-memory, no load step)")

# ── write the graph as CSVs for Kuzu's bulk COPY ─────────────────────────────────────────────────────
d = tempfile.mkdtemp()
nodes_csv, rels_csv = f"{d}/nodes.csv", f"{d}/rels.csv"
t = time.perf_counter()
np.savetxt(nodes_csv, np.arange(n), fmt="%d")
np.savetxt(rels_csv, edges, fmt="%d,%d")
csv_s = time.perf_counter() - t

# ── load into Kuzu (bulk COPY) ───────────────────────────────────────────────────────────────────────
db = kuzu.Database(f"{d}/db")
con = kuzu.Connection(db)
con.execute("CREATE NODE TABLE V(id INT64, PRIMARY KEY(id))")
con.execute("CREATE REL TABLE E(FROM V TO V)")
t = time.perf_counter()
con.execute(f'COPY V FROM "{nodes_csv}"')
con.execute(f'COPY E FROM "{rels_csv}"')
load_s = time.perf_counter() - t

# ── Kuzu native PageRank (algo extension) ────────────────────────────────────────────────────────────
con.execute("INSTALL algo")
con.execute("LOAD algo")
con.execute("CALL project_graph('G', ['V'], ['E'])")
t = time.perf_counter()
res = con.execute("CALL page_rank('G') RETURN node.id AS id, rank ORDER BY rank DESC")
kuzu_s = time.perf_counter() - t
kuzu_order = []
while res.has_next():
    kuzu_order.append(int(res.get_next()[0]))

agree = len(set(kuzu_order[:100]) & set(rust_top)) / 100.0

print(f"\nKuzu (embedded graph DB, native PageRank):")
print(f"  bulk load (COPY)   : {load_s*1000:8.1f} ms   (+ {csv_s*1000:.0f} ms to write CSV)")
print(f"  PageRank compute   : {kuzu_s*1000:8.1f} ms")
print(f"\nhead-to-head (compute-to-compute, same graph, same machine):")
print(f"  hg_analytics : {rust_parallel_s*1000:7.1f} ms")
print(f"  Kuzu         : {kuzu_s*1000:7.1f} ms   → hg_analytics is {kuzu_s/rust_parallel_s:.1f}x faster")
print(f"  top-100 ranking agreement: {agree*100:.0f}%")
print("\nNote: exact PageRank values differ (Kuzu's default damping/iterations vs ours); the ranking is "
      "what agrees. Kuzu also pays a load step we don't (in-memory). Compute-to-compute is the fair line.")

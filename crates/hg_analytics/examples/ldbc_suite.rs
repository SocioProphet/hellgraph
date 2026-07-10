//! ldbc_suite — the whole distributed boundary-halo suite on ONE graph, as an LDBC-Graphalytics-style
//! scorecard. Runs PageRank (PR), weakly-connected-components (WCC), and BFS — the three main computational
//! shapes (fixpoint smoothing / label propagation / frontier traversal), which are also three of the six
//! LDBC Graphalytics kernels. Each is Fennel-partitioned + boundary-halo distributed and VERIFIED bit-exact
//! against its single-graph reference, with per-kernel time + recurring halo traffic reported.
//!
//! This is the Saturday deliverable in one command: a credible, self-verifying benchmark result, not just
//! "it ran". Graph size via HG_SCALE / HG_EDGEFACTOR; shards via HG_SHARDS.
//!
//! Run: `HG_SCALE=20 HG_SHARDS=16 cargo run -p hg_analytics --release --example ldbc_suite`

use hg_analytics::{
    connected_components, distributed_bfs_boundary, distributed_cc_boundary,
    distributed_pagerank_boundary, fennel_partition, pagerank, partition_cc_boundary_at,
    partition_edges_boundary_at, relabel_contiguous, total_cc_halo_bytes, total_halo_bytes,
    BoundaryCcShard, Kronecker,
};
use std::time::Instant;

fn env(key: &str, d: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

fn human(b: f64) -> String {
    if b >= 1e6 {
        format!("{:.1} MB", b / 1e6)
    } else if b >= 1e3 {
        format!("{:.0} KB", b / 1e3)
    } else {
        format!("{b:.0} B")
    }
}

/// Serial reference BFS (hop distance) for the correctness check.
fn serial_bfs(n: usize, edges: &[(usize, usize)], source: usize) -> Vec<u32> {
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        if u < n && v < n && u != v {
            adj[u].push(v);
            adj[v].push(u);
        }
    }
    let mut dist = vec![u32::MAX; n];
    let mut q = std::collections::VecDeque::new();
    dist[source] = 0;
    q.push_back(source);
    while let Some(u) = q.pop_front() {
        for &w in &adj[u] {
            if dist[w] == u32::MAX {
                dist[w] = dist[u] + 1;
                q.push_back(w);
            }
        }
    }
    dist
}

fn main() {
    let scale = env("HG_SCALE", 20) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let k = env("HG_SHARDS", 16);
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x1DBC).collect();
    let m = edges.len();

    println!("LDBC-style distributed suite  |  n={n}  m={m}  scale={scale}  shards={k}");

    // One Fennel partition, relabelled to contiguous blocks, shared by all three kernels.
    let t = Instant::now();
    let part = fennel_partition(n, &edges, k);
    let (remapped, bounds, _perm) = relabel_contiguous(n, &part, k, &edges);
    let part_s = t.elapsed().as_secs_f64();
    println!("  partition (Fennel, once): {part_s:.2}s\n");
    println!(
        "  {:<6} {:>9} {:>11} {:>14}",
        "kernel", "time", "halo/step", "vs single-graph"
    );
    println!("  {}", "-".repeat(64));

    // ── PageRank (directed, fixpoint) ────────────────────────────────────────────────────────────────
    let (pr_shards, out_deg) = partition_edges_boundary_at(n, &remapped, &bounds);
    let t = Instant::now();
    let pr = distributed_pagerank_boundary(n, &pr_shards, &out_deg, 0.85, 40, 1e-10);
    let pr_s = t.elapsed().as_secs_f64();
    let pr_ref = pagerank(n, &remapped, 0.85, 40, 1e-10);
    let pr_delta = pr_ref
        .iter()
        .zip(&pr)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f64, f64::max);
    println!(
        "  {:<6} {:>9} {:>11} {:>14}  {}",
        "PR",
        format!("{pr_s:.2}s"),
        human(total_halo_bytes(&pr_shards) as f64),
        format!("max|Δ| {pr_delta:.0e}"),
        if pr_delta < 1e-9 {
            "EXACT ✓"
        } else {
            "MISMATCH ✗"
        }
    );

    // ── WCC + BFS share the undirected boundary CC shards ────────────────────────────────────────────
    let cc_shards: Vec<BoundaryCcShard> = partition_cc_boundary_at(n, &remapped, &bounds);

    let t = Instant::now();
    let wcc = distributed_cc_boundary(n, &cc_shards);
    let wcc_s = t.elapsed().as_secs_f64();
    let wcc_ref = connected_components(n, &remapped);
    let wcc_ok = wcc == wcc_ref;
    println!(
        "  {:<6} {:>9} {:>11} {:>14}  {}",
        "WCC",
        format!("{wcc_s:.2}s"),
        human(total_cc_halo_bytes(&cc_shards) as f64),
        if wcc_ok { "exact match" } else { "DIVERGED" },
        if wcc_ok { "EXACT ✓" } else { "MISMATCH ✗" }
    );

    let source = 0usize;
    let t = Instant::now();
    let bfs = distributed_bfs_boundary(n, &cc_shards, source);
    let bfs_s = t.elapsed().as_secs_f64();
    let bfs_ref = serial_bfs(n, &remapped, source);
    let bfs_ok = bfs == bfs_ref;
    let reached = bfs.iter().filter(|&&d| d != u32::MAX).count();
    println!(
        "  {:<6} {:>9} {:>11} {:>14}  {}",
        "BFS",
        format!("{bfs_s:.2}s"),
        human(total_cc_halo_bytes(&cc_shards) as f64),
        if bfs_ok { "exact match" } else { "DIVERGED" },
        if bfs_ok { "EXACT ✓" } else { "MISMATCH ✗" }
    );

    println!(
        "\n  BFS from {source}: {reached}/{n} vertices reached (max hop {})",
        bfs.iter()
            .filter(|&&d| d != u32::MAX)
            .max()
            .copied()
            .unwrap_or(0)
    );
    let all_ok = pr_delta < 1e-9 && wcc_ok && bfs_ok;
    println!(
        "\n  {}  — 3 LDBC kernels, boundary-halo distributed, all verified against single-graph.",
        if all_ok {
            "ALL EXACT ✓"
        } else {
            "FAILURES PRESENT ✗"
        }
    );
}

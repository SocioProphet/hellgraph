//! slack_probe — challenge the "wrung out" verdict with measurements, not assertions.
//!   1. Load balance: max in-degree vs mean → is the parallel pull straggler-bound on RMAT hubs?
//!   2. Dangling fraction: is the per-iter O(n) dangling scan wasted vs a precomputed list?
//!   3. Anderson window sweep: is 2× the ceiling, or does a bigger window do better?
//!   4. Serial-reduction tax: how much of pagerank_parallel is the SERIAL diff+dangling O(n) scans?

use hg_analytics::{pagerank, pagerank_accel, Kronecker};
use std::time::Instant;

const D: f64 = 0.85;

fn env(k: &str, d: usize) -> usize {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

fn main() {
    let scale = env("HG_SCALE", 20) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x6907).collect();
    let m = edges.len();
    println!(
        "slack_probe: n={n} m={m} scale={scale} cores={}\n",
        rayon::current_num_threads()
    );

    // ── 1+2: degree structure ────────────────────────────────────────────────────────────────────────
    let mut indeg = vec![0u32; n];
    let mut outdeg = vec![0u32; n];
    for &(u, v) in &edges {
        indeg[v] += 1;
        outdeg[u] += 1;
    }
    let max_in = *indeg.iter().max().unwrap();
    let mean_in = m as f64 / n as f64;
    let dangling = outdeg.iter().filter(|&&d| d == 0).count();
    // How much of the total edge work sits in the single hottest vertex's in-list (indivisible task).
    let top_frac = max_in as f64 / m as f64;
    // Work in the top-8 hubs (would-be stragglers across 8 cores).
    let mut sorted_in = indeg.clone();
    sorted_in.sort_unstable_by(|a, b| b.cmp(a));
    let top8: u64 = sorted_in[..8].iter().map(|&d| d as u64).sum();
    println!("Load balance (parallel pull is per-vertex; a hub can't split across threads):");
    println!(
        "  mean in-deg {mean_in:.1}, MAX in-deg {max_in} = {:.1}% of all edges in ONE task",
        top_frac * 100.0
    );
    println!(
        "  top-8 hubs = {:.1}% of all edges (vs ideal 8-core share of any chunk)",
        top8 as f64 / m as f64 * 100.0
    );
    println!(
        "  ⇒ straggler risk: {}",
        if top_frac > 1.0 / rayon::current_num_threads() as f64 {
            "YES — one hub exceeds a fair core-share"
        } else {
            "low — hubs under a fair share"
        }
    );
    println!("Dangling: {dangling} nodes = {:.2}% → per-iter O(n) scan touches {n} to sum {dangling} values\n", dangling as f64 / n as f64 * 100.0);

    // ── 3: Anderson window sweep — is 2× the ceiling? ──────────────────────────────────────────────────
    println!("Anderson window sweep (sweeps to Σ|Δ|<1e-10):");
    let (_p, base_sweeps) = pagerank_accel(n, &edges, D, 3000, 1e-10, 0);
    let reference = pagerank(n, &edges, D, 3000, 1e-12);
    print!("  power={base_sweeps}");
    let mut best = (usize::MAX, 0);
    for w in [2usize, 3, 4, 5, 6, 8, 10, 12, 15, 20] {
        let (r, s) = pagerank_accel(n, &edges, D, 3000, 1e-10, w);
        let err = r
            .iter()
            .zip(&reference)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        // only report windows that actually converged to the right point
        if err < 1e-7 && s < best.0 {
            best = (s, w);
        }
        print!("  w{w}={s}");
    }
    println!(
        "\n  BEST: window {} → {} sweeps = {:.2}× vs power {base_sweeps}\n",
        best.1,
        best.0,
        base_sweeps as f64 / best.0 as f64
    );

    // ── 4: serial-reduction tax — fraction of pagerank_parallel spent in the SERIAL O(n) scans ─────────
    // Reproduce the kernel's two serial O(n) passes (dangling scan + diff reduction) and time them alone.
    let rank = vec![1.0 / n as f64; n];
    let next = vec![1.0 / n as f64; n];
    let iters = 20;
    let t = Instant::now();
    let mut sink = 0.0f64;
    for _ in 0..iters {
        let mut dang = 0.0;
        for u in 0..n {
            if outdeg[u] == 0 {
                dang += rank[u];
            }
        }
        let diff: f64 = (0..n).map(|i| (next[i] - rank[i]).abs()).sum();
        sink += dang + diff;
    }
    let serial_s = t.elapsed().as_secs_f64();
    std::hint::black_box(sink);
    println!(
        "Serial reductions (dangling scan + diff), {iters} iters: {serial_s:.3}s = {:.1}ms/iter",
        serial_s / iters as f64 * 1000.0
    );
    println!(
        "  at billion (n=67M) that's ~{:.0}ms/superstep of PURE SERIAL work × supersteps",
        serial_s / iters as f64 * 1000.0 * (67e6 / n as f64)
    );
}

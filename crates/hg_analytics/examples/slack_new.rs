//! slack_new — measure the two NEW levers this pass:
//!   1. f32 CPU contrib gather (half the random bandwidth) vs f64 — throughput + accuracy.
//!   2. Personalized forward-push: work (pushes) vs graph size — the SUBLINEAR local-query win.

use hg_analytics::{pagerank, Kronecker, PreparedGraph};
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
    println!("slack_new: n={n} m={m} scale={scale}\n");
    let g = PreparedGraph::build(n, &edges);

    // ── 1: f32 vs f64 contrib gather ─────────────────────────────────────────────────────────────────
    println!("f32 vs f64 CPU pull (contrib gather: 4B vs 8B random/edge):");
    let it = 40;
    let t = Instant::now();
    let r64 = g.pagerank(D, it, -1.0);
    let s64 = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let r32 = g.pagerank_f32(D, it, -1.0);
    let s32 = t.elapsed().as_secs_f64();
    let maxd = r64
        .iter()
        .zip(&r32)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    // ranking agreement on the top 100
    let mut idx64: Vec<usize> = (0..n).collect();
    idx64.sort_unstable_by(|&a, &b| r64[b].partial_cmp(&r64[a]).unwrap());
    let mut idx32: Vec<usize> = (0..n).collect();
    idx32.sort_unstable_by(|&a, &b| r32[b].partial_cmp(&r32[a]).unwrap());
    let top64: std::collections::HashSet<_> = idx64[..100].iter().collect();
    let agree = idx32[..100].iter().filter(|i| top64.contains(i)).count();
    println!(
        "  f64 {:.3}s ({:.2} GTEPS)  →  f32 {:.3}s ({:.2} GTEPS)  =  {:.2}× faster",
        s64,
        m as f64 * it as f64 / s64 / 1e9,
        s32,
        m as f64 * it as f64 / s32 / 1e9,
        s64 / s32
    );
    println!("  accuracy: max|Δ| {maxd:.1e}, top-100 ranking agreement {agree}/100\n");

    // ── 2: personalized push — work is ~independent of graph size (SUBLINEAR) ────────────────────────
    println!("Personalized push PPR: work vs graph size (seed = vertex 1, eps=1e-7):");
    println!(
        "  {:>5}  {:>12}  {:>14}  {:>12}",
        "scale", "edges", "global O(m·it)", "push work"
    );
    for s in [12u32, 14, 16, 18, 20] {
        let nn = Kronecker::vertices(s);
        let ee: Vec<(usize, usize)> = Kronecker::new(s, ef, 0x6907).collect();
        let mm = ee.len();
        let gg = PreparedGraph::build(nn, &ee);
        let (_p, pushes) = gg.pagerank_personalized(&[1], D, 1e-7);
        // global reference work = one converged run's iterations × m (what full PageRank would cost)
        let global = 20 * mm; // ~20 power-iteration sweeps
        println!(
            "  {s:>5}  {mm:>12}  {global:>14}  {pushes:>12}   ({:.0}× less work than global)",
            global as f64 / pushes.max(1) as f64
        );
    }
    std::hint::black_box(pagerank(4, &[(0, 1)], D, 1, 1e-9));
}

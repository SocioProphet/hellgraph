//! slack_bench — measure the two CPU-side slack levers (no cluster/GPU needed):
//!   1. Anderson acceleration: sweeps to a fixed tolerance vs plain power iteration (window=0).
//!   2. CPU contrib-fusion: pagerank_parallel wall time (the fused kernel).
//!
//!   cargo run -p hg_analytics --release --example slack_bench   # HG_SCALE (default 20)

use hg_analytics::{pagerank, pagerank_accel, pagerank_parallel, Kronecker};
use std::time::Instant;

const D: f64 = 0.85;

fn env(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() {
    let scale = env("HG_SCALE", 20) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x6907).collect();
    let m = edges.len();
    println!("slack_bench: n={n} m={m} scale={scale}\n");

    // ── Lever 2: Anderson acceleration — sweeps to convergence vs power iteration ────────────────────
    println!("Anderson acceleration (sweeps to Σ|Δ|<tol, same fixed point):");
    let reference = pagerank(n, &edges, D, 2000, 1e-12);
    for &tol in &[1e-6, 1e-8, 1e-10] {
        let (rp, sp) = pagerank_accel(n, &edges, D, 2000, tol, 0); // power iteration
        let mut best = (usize::MAX, 0usize, 0.0f64);
        for w in [3usize, 5, 8] {
            let (ra, sa) = pagerank_accel(n, &edges, D, 2000, tol, w);
            let err = ra.iter().zip(&reference).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
            if sa < best.0 {
                best = (sa, w, err);
            }
        }
        let errp = rp.iter().zip(&reference).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        let (sa, w, erra) = best;
        println!(
            "  tol={tol:>6.0e}: power {sp:>4} sweeps (max|Δ|{errp:.1e})  →  Anderson(w={w}) {sa:>3} sweeps (max|Δ|{erra:.1e})  =  {:.2}× fewer",
            sp as f64 / sa as f64
        );
    }

    // ── Lever 1: CPU contrib-fusion — wall time of the fused parallel kernel ─────────────────────────
    println!("\nCPU fused kernel (pagerank_parallel, 40 iters):");
    let t = Instant::now();
    let pr = pagerank_parallel(n, &edges, D, 40, -1.0);
    let dt = t.elapsed().as_secs_f64();
    let s: f64 = pr.iter().sum();
    println!(
        "  {dt:.3}s  →  {:.2} GTEPS  (Σrank={s:.4}, ≈1 ⇒ correct)",
        m as f64 * 40.0 / dt / 1e9
    );

    // ── Combined: Anderson sweep-count × fused kernel = the compounded CPU win ───────────────────────
    println!("\nCompounded (Anderson w=5 to 1e-8, fused kernel):");
    let t = Instant::now();
    let (_r, sw) = pagerank_accel(n, &edges, D, 2000, 1e-8, 5);
    let dt2 = t.elapsed().as_secs_f64();
    println!("  converged in {sw} accelerated sweeps, {dt2:.3}s total");
}

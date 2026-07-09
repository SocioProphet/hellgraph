//! warm_scale — incremental (warm-start) PageRank: the real-time differentiator. After a small graph
//! delta, recompute from the PRIOR fixed point instead of cold. Converges in a handful of iterations
//! to the same answer — so a live, mutating graph gets near-instant refreshed analytics, the thing a
//! batch engine (Neptune-style) makes you recompute from scratch. Run: `cargo run --release --example warm_scale`.

use hg_analytics::{pagerank, pagerank_warm};
use std::time::Instant;

fn main() {
    let (n, m) = (2_000_000usize, 20_000_000usize);
    let mut s = 0x9e3779b97f4a7c15u64;
    let mut r = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let mut edges: Vec<(usize, usize)> = (0..m)
        .map(|_| ((r() as usize) % n, (r() as usize) % n))
        .collect();
    let (d, tol) = (0.85, 1e-9);

    // Prior state: the current fixed point (what a live system already holds).
    let prior = pagerank(n, &edges, d, 500, tol);

    // A small delta: 50 new edges arrive (a live graph mutation).
    for _ in 0..50 {
        edges.push(((r() as usize) % n, (r() as usize) % n));
    }

    let t = Instant::now();
    let cold = pagerank(n, &edges, d, 500, tol); // recompute from scratch (uniform)
    let tc = t.elapsed();

    let t = Instant::now();
    let warm = pagerank_warm(n, &edges, d, 500, tol, &prior); // recompute from the prior fixpoint
    let tw = t.elapsed();

    let diff = cold
        .iter()
        .zip(&warm)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    println!(
        "Incremental warm-start PageRank — {}M edges, +50-edge delta",
        m / 1_000_000
    );
    println!("  cold recompute (from scratch): {:>8.3?}", tc);
    println!("  warm-start (from prior state): {:>8.3?}", tw);
    println!(
        "  speedup: {:.1}x   == cold result: max|Δ| {:.2e}   (same fixed point, near-instant refresh)",
        tc.as_secs_f64() / tw.as_secs_f64(),
        diff
    );
}

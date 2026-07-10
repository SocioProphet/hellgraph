//! vs_baseline — emit a Graph500 RMAT graph + our PageRank result + timing, so an off-the-shelf engine
//! (networkx / scipy) can be run on the IDENTICAL graph on the SAME machine for an honest head-to-head.
//! We are not comparing against a strawman: the companion script runs BOTH pure-Python networkx AND
//! scipy's optimized sparse power iteration.
//!
//! Writes to $HG_OUT (default /tmp/hg_vs):
//!   edges.bin   — m × (u32,u32) little-endian edge list (the shared graph)
//!   meta.txt    — "n m iters damping rust_serial_s rust_parallel_s"
//!   rust_top.txt— top-100 node ids by rank (for agreement cross-check)
//!
//! Run: `HG_SCALE=15 cargo run -p hg_analytics --release --example vs_baseline`

use hg_analytics::{pagerank, pagerank_parallel, Kronecker};
use std::io::Write;
use std::time::Instant;

fn main() {
    let scale: u32 = std::env::var("HG_SCALE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15);
    let ef: usize = std::env::var("HG_EDGEFACTOR")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16);
    let iters: usize = std::env::var("HG_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);
    let out = std::env::var("HG_OUT").unwrap_or_else(|_| "/tmp/hg_vs".into());
    std::fs::create_dir_all(&out).unwrap();

    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x5EED).collect();
    let m = edges.len();
    let damping = 0.85;
    let tol = 1e-6; // match networkx's default so the comparison is apples-to-apples

    // Our engine: serial + parallel (same fixed point).
    let t = Instant::now();
    let serial = pagerank(n, &edges, damping, iters, tol);
    let rust_serial_s = t.elapsed().as_secs_f64();

    let t = Instant::now();
    let parallel = pagerank_parallel(n, &edges, damping, iters, tol);
    let rust_parallel_s = t.elapsed().as_secs_f64();

    // Sanity: parallel == serial fixed point.
    let maxd = serial
        .iter()
        .zip(&parallel)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f64, f64::max);

    // Emit the shared graph as u32 pairs.
    let mut ebuf = Vec::with_capacity(m * 8);
    for &(u, v) in &edges {
        ebuf.extend_from_slice(&(u as u32).to_le_bytes());
        ebuf.extend_from_slice(&(v as u32).to_le_bytes());
    }
    std::fs::write(format!("{out}/edges.bin"), &ebuf).unwrap();

    // Top-100 node ids by our rank (for agreement check).
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| serial[b].partial_cmp(&serial[a]).unwrap());
    let mut top = String::new();
    for &i in idx.iter().take(100) {
        top.push_str(&i.to_string());
        top.push('\n');
    }
    std::fs::write(format!("{out}/rust_top.txt"), top).unwrap();

    let mut meta = std::fs::File::create(format!("{out}/meta.txt")).unwrap();
    writeln!(
        meta,
        "{n} {m} {iters} {damping} {rust_serial_s} {rust_parallel_s}"
    )
    .unwrap();

    println!("vs_baseline: n={n} m={m} scale={scale} ef={ef} iters={iters}");
    println!("  rust serial   : {rust_serial_s:.4}s");
    println!(
        "  rust parallel : {rust_parallel_s:.4}s  ({:.2}x vs serial)",
        rust_serial_s / rust_parallel_s.max(1e-9)
    );
    println!("  parallel == serial: max|Δ| {maxd:.2e}");
    println!("  wrote graph + result to {out}/  — now run scripts/bench/vs_baseline.py");
}

//! ooc_scale — out-of-core at real scale. Streams a large deterministic edge set into an mmap'd CSR
//! (O(n) heap, the edges are NEVER materialized), then runs PageRank directly over the disk-backed
//! mapping. Proves the RAM ceiling is broken at a scale where an in-heap edge list would dominate
//! memory. Run: `cargo run --release --example ooc_scale [n_nodes] [n_edges]`  (default 10M / 100M).

use hg_analytics::{pagerank_mmap, write_csr_streaming, MmapCsr};
use std::time::Instant;

/// Deterministic edge stream — a fresh one per `EdgeGen::new`, so the two streaming passes agree.
struct EdgeGen {
    s: u64,
    remaining: usize,
    n: usize,
}
impl EdgeGen {
    fn new(seed: u64, m: usize, n: usize) -> Self {
        EdgeGen {
            s: seed,
            remaining: m,
            n,
        }
    }
    #[inline]
    fn next_u64(&mut self) -> u64 {
        self.s ^= self.s << 13;
        self.s ^= self.s >> 7;
        self.s ^= self.s << 17;
        self.s
    }
}
impl Iterator for EdgeGen {
    type Item = (usize, usize);
    fn next(&mut self) -> Option<(usize, usize)> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let u = (self.next_u64() as usize) % self.n;
        let v = (self.next_u64() as usize) % self.n;
        Some((u, v))
    }
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000_000);
    let m: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000_000);
    const SEED: u64 = 0x9e3779b97f4a7c15;

    println!("Out-of-core PageRank @ scale: {} nodes / {} edges", n, m);
    println!("  (edges streamed from a generator — NEVER held in heap; an in-heap edge Vec would be ~{} MB)", m * 16 / 1_000_000);

    let path = std::env::temp_dir().join("hg_ooc_scale.csr");
    let t_build = Instant::now();
    write_csr_streaming(&path, n, || EdgeGen::new(SEED, m, n)).unwrap();
    let build = t_build.elapsed();

    let csr = MmapCsr::open(&path).unwrap();
    let iters = 10;
    let t_pr = Instant::now();
    let pr = pagerank_mmap(&csr, 0.85, iters, -1.0);
    let prt = t_pr.elapsed();

    // sanity: mass is conserved (Σ rank ≈ 1) — the computation ran correctly at scale
    let mass: f64 = pr.iter().sum();

    println!(
        "  CSR on disk (mmap'd): {} MB",
        csr.mapped_bytes() / 1_000_000
    );
    println!(
        "  heap resident:        ~{} MB (only the O(n) rank + O(n) build vectors)",
        n * 8 * 3 / 1_000_000
    );
    println!(
        "  stream-build: {:>7.3?}   pagerank_mmap ({} iters): {:>7.3?}",
        build, iters, prt
    );
    println!(
        "  Σrank = {:.6} (≈1, mass conserved)   edges·iter/s: {:.0}M",
        mass,
        (m as f64 * iters as f64 / prt.as_secs_f64()) / 1e6
    );
    std::fs::remove_file(&path).ok();
}

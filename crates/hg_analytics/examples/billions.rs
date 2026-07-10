//! billions — out-of-core PageRank at BILLION-edge scale on a single machine. Streams the edges into
//! an mmap CSR (O(n) heap, edges never materialized) and runs PageRank over the disk-backed mapping.
//! The whole point: a graph this size would need ~16 GB just for an in-heap edge list; here the O(E)
//! structure lives on disk and only O(n) rank vectors are resident. Run:
//!   `cargo run --release --example billions [n_nodes] [n_edges] [iters]`  (default 100M / 1B / 3).

use hg_analytics::{pagerank_mmap, write_csr_bucketed, MmapCsr};
use std::time::Instant;

struct Gen {
    s: u64,
    rem: usize,
    n: usize,
}
impl Gen {
    fn new(seed: u64, m: usize, n: usize) -> Self {
        Gen { s: seed, rem: m, n }
    }
}
impl Iterator for Gen {
    type Item = (usize, usize);
    #[inline]
    fn next(&mut self) -> Option<(usize, usize)> {
        if self.rem == 0 {
            return None;
        }
        self.rem -= 1;
        self.s ^= self.s << 13;
        self.s ^= self.s >> 7;
        self.s ^= self.s << 17;
        let u = (self.s as usize) % self.n;
        self.s ^= self.s << 13;
        self.s ^= self.s >> 7;
        self.s ^= self.s << 17;
        let v = (self.s as usize) % self.n;
        Some((u, v))
    }
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000_000); // proven clean on a laptop; larger is hardware-bound
    let m: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500_000_000);
    let iters: usize = std::env::args()
        .nth(3)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    const SEED: u64 = 0x9e3779b97f4a7c15;

    println!(
        "BILLION-scale out-of-core PageRank: {} nodes / {} edges",
        n, m
    );
    println!(
        "  an in-heap edge Vec alone would be ~{} GB — here edges are streamed to disk",
        m * 16 / 1_000_000_000
    );

    let path = std::env::temp_dir().join("hg_billions.csr");
    // Bucketed = fully sequential writes (no random-write page-thrash on the big neighbours array).
    let tb = Instant::now();
    write_csr_bucketed(&path, n, || Gen::new(SEED, m, n), 64).unwrap();
    let build = tb.elapsed();

    let csr = MmapCsr::open(&path).unwrap();
    let tp = Instant::now();
    let pr = pagerank_mmap(&csr, 0.85, iters, -1.0);
    let prt = tp.elapsed();
    let mass: f64 = pr.iter().sum();

    println!(
        "  CSR on disk (mmap'd): {:.2} GB   heap resident: ~{:.1} GB (O(n) only)",
        csr.mapped_bytes() as f64 / 1e9,
        (n * 8 * 3) as f64 / 1e9
    );
    println!(
        "  stream-build: {:>7.2?}   pagerank_mmap({} iters): {:>7.2?}",
        build, iters, prt
    );
    println!(
        "  Σrank = {:.4} (≈1)   {:.0}M edges·iter/s",
        mass,
        (m as f64 * iters as f64 / prt.as_secs_f64()) / 1e6
    );
    std::fs::remove_file(&path).ok();
}

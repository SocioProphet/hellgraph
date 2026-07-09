//! scale_bench — cashes the scale thesis with real wall-clock numbers, honestly. Measures the SAME
//! parallel code at 1 thread vs N threads (a true parallel-scaling number, no baseline confound):
//!   • PageRank  — memory-bandwidth-bound (random rank[] gather); scales modestly. Report throughput.
//!   • Betweenness — compute-bound (independent BFS per source); scales near-linearly.
//! Also checks the parallel results match the serial fixed point and are deterministic run-to-run.
//! Run: `cargo run --release --example scale_bench`.

use hg_analytics::{
    betweenness, betweenness_parallel, distributed_pagerank, pagerank, pagerank_parallel,
    partition_edges,
};
use std::time::{Duration, Instant};

fn with_threads<R: Send>(k: usize, f: impl FnOnce() -> R + Send) -> R {
    rayon::ThreadPoolBuilder::new()
        .num_threads(k)
        .build()
        .unwrap()
        .install(f)
}

fn xorshift() -> impl FnMut() -> u64 {
    let mut s: u64 = 0x9e3779b97f4a7c15;
    move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    }
}

fn gen_edges(n: usize, m: usize) -> Vec<(usize, usize)> {
    let mut rnd = xorshift();
    (0..m)
        .map(|_| ((rnd() as usize) % n, (rnd() as usize) % n))
        .collect()
}

fn timed<R>(f: impl FnOnce() -> R) -> (Duration, R) {
    let t = Instant::now();
    let r = f();
    (t.elapsed(), r)
}

fn main() {
    let cores = rayon::current_num_threads();
    println!("machine: {} logical cores\n", cores);

    // ── PageRank: big graph, throughput + (honest) parallel scaling ──────────────────────────
    let (n, m, iters) = (2_000_000usize, 20_000_000usize, 20usize);
    let edges = gen_edges(n, m);
    let (d, tol) = (0.85, -1.0); // tol<0 → run all iters (fair)
    let (t1, r1) = with_threads(1, || timed(|| pagerank_parallel(n, &edges, d, iters, tol)));
    let (tn, rn) = with_threads(cores, || {
        timed(|| pagerank_parallel(n, &edges, d, iters, tol))
    });
    println!("PageRank  {} nodes / {} edges / {} iters", n, m, iters);
    println!("  1 thread : {:>8.3?}", t1);
    println!("  {} threads: {:>8.3?}", cores, tn);
    println!(
        "  speedup  : {:.2}x   throughput {:.0}M edges·iter/s   (memory-bound: honest ceiling)",
        t1.as_secs_f64() / tn.as_secs_f64(),
        (m as f64 * iters as f64 / tn.as_secs_f64()) / 1e6
    );
    let pr_serial = pagerank(n, &edges, d, iters, tol);
    let pr_diff = r1
        .iter()
        .zip(&pr_serial)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    println!(
        "  deterministic (1==N threads): {}   max|Δ vs serial|: {:.2e}  (same fixed point)\n",
        r1 == rn,
        pr_diff
    );

    // ── Betweenness: compute-bound, near-linear scaling ──────────────────────────────────────
    let (bn, bm) = (6_000usize, 48_000usize);
    let bedges = gen_edges(bn, bm);
    let (b1, br1) = with_threads(1, || timed(|| betweenness_parallel(bn, &bedges)));
    let (bnp, brn) = with_threads(cores, || timed(|| betweenness_parallel(bn, &bedges)));
    let serial_bc = betweenness(bn, &bedges);
    let maxdiff = serial_bc
        .iter()
        .zip(&brn)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    println!("Betweenness (Brandes)  {} nodes / {} edges", bn, bm);
    println!("  1 thread : {:>8.3?}", b1);
    println!("  {} threads: {:>8.3?}", cores, bnp);
    println!(
        "  speedup  : {:.2}x   ({:.0}% of linear)",
        b1.as_secs_f64() / bnp.as_secs_f64(),
        100.0 * (b1.as_secs_f64() / bnp.as_secs_f64()) / cores as f64
    );
    println!(
        "  parallel == serial: max|Δ| {:.2e}   deterministic run==run: {}",
        maxdiff,
        br1 == brn
    );
    println!();

    // ── Distributed PageRank: partition = shard, only the halo is exchanged (the wedge) ──────────
    let shards_k = cores;
    let (shards, out_deg) = partition_edges(n, &edges, shards_k);
    let owned: Vec<usize> = shards
        .iter()
        .map(|s| s.in_adj.iter().map(|a| a.len()).sum())
        .collect();
    let (td, dist) = timed(|| distributed_pagerank(n, &shards, &out_deg, d, iters, tol));
    let dist_diff = pr_serial
        .iter()
        .zip(&dist)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    println!(
        "Distributed PageRank  {} shards (partition = participant)",
        shards_k
    );
    println!(
        "  time: {:>8.3?}   (edges stay sharded; each superstep exchanges only the O(n) halo)",
        td
    );
    println!(
        "  per-shard edges: ~{} each   |   halo/superstep: {} f64 ({} MB)  vs  edges kept local: {}",
        owned.iter().sum::<usize>() / shards_k,
        n,
        n * 8 / 1_000_000,
        m
    );
    println!(
        "  == single-graph PageRank: max|Δ| {:.2e}  (sharded answer is EXACT)",
        dist_diff
    );
    println!(
        "  deterministic run==run: {}",
        dist == distributed_pagerank(n, &shards, &out_deg, d, iters, tol)
    );
}

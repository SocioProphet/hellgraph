//! halo_bench — measure the boundary-only halo vs the full-broadcast baseline, and confirm the boundary
//! result is bit-identical to serial PageRank. RMAT + a naive RANGE partition is the WORST case for the
//! boundary halo (RMAT hubs have no locality, range ignores structure) — so this is the honest floor that
//! the edge-cut partitioner (step #3) improves on. Also runs a ring (perfect locality) for the ceiling.
//!
//! cargo run -p hg_analytics --example halo_bench --release

use hg_analytics::{
    balance, distributed_pagerank_boundary, edge_cut, fennel_partition, ldg_partition, pagerank,
    partition_edges_boundary, partition_edges_boundary_at, relabel_contiguous, total_halo_bytes,
    Kronecker,
};

fn human(bytes: usize) -> String {
    let b = bytes as f64;
    if b >= 1e9 {
        format!("{:.2} GB", b / 1e9)
    } else if b >= 1e6 {
        format!("{:.2} MB", b / 1e6)
    } else if b >= 1e3 {
        format!("{:.2} KB", b / 1e3)
    } else {
        format!("{bytes} B")
    }
}

fn run(name: &str, n: usize, edges: &[(usize, usize)], k: usize) {
    let (shards, out_deg) = partition_edges_boundary(n, edges, k);
    let halo = total_halo_bytes(&shards);
    let full = k * n * 8;

    // Correctness: boundary halo must equal serial PageRank to float precision.
    let serial = pagerank(n, edges, 0.85, 40, 1e-10);
    let dist = distributed_pagerank_boundary(n, &shards, &out_deg, 0.85, 40, 1e-10);
    let max_delta = serial
        .iter()
        .zip(&dist)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f64, f64::max);

    let total_ghosts: usize = shards.iter().map(|s| s.ghosts.len()).sum();
    println!("{name}: n={n} m={} k={k}", edges.len());
    println!(
        "  halo/superstep: {}  vs full broadcast {}  → {:.1}x less, {:.2}% of full",
        human(halo),
        human(full),
        full as f64 / halo.max(1) as f64,
        100.0 * halo as f64 / full as f64
    );
    println!(
        "  ghosts total {total_ghosts} (avg {:.0}/shard, {:.1}% of n)  |  max|Δ| vs serial = {max_delta:e}",
        total_ghosts as f64 / k as f64,
        100.0 * (total_ghosts as f64 / k as f64) / n as f64
    );
}

/// Compare range vs Fennel vs LDG on the SAME graph: edge cut, balance, halo bytes/superstep, and
/// (for the smart partitions) confirm the boundary-halo PageRank is still bit-identical to serial.
fn compare(name: &str, n: usize, edges: &[(usize, usize)], k: usize) {
    println!("{name}: n={n} m={} k={k}", edges.len());
    let full = k * n * 8;
    let serial = pagerank(n, edges, 0.85, 40, 1e-10);
    let size = n.div_ceil(k);
    let range: Vec<usize> = (0..n).map(|v| (v / size).min(k - 1)).collect();

    for (label, part) in [
        ("range ", range),
        ("fennel", fennel_partition(n, edges, k)),
        ("ldg   ", ldg_partition(n, edges, k)),
    ] {
        let cut = edge_cut(&part, edges);
        let (mn, mx) = balance(&part, k);
        let (remapped, bounds, perm) = relabel_contiguous(n, &part, k, edges);
        let (shards, out_deg) = partition_edges_boundary_at(n, &remapped, &bounds);
        let halo = total_halo_bytes(&shards);
        let dist = distributed_pagerank_boundary(n, &shards, &out_deg, 0.85, 40, 1e-10);
        let max_delta = (0..n)
            .map(|v| (serial[v] - dist[perm[v]]).abs())
            .fold(0.0f64, f64::max);
        println!(
            "  {label}  cut {:>6.2}%  balance {mn}/{mx} ({:.1}x)  halo {:>9}  ({:>5.1}x < full)  max|Δ| {:.0e}",
            100.0 * cut as f64 / edges.len() as f64,
            mx as f64 / mn.max(1) as f64,
            human(halo),
            full as f64 / halo.max(1) as f64,
            max_delta,
        );
    }
}

fn main() {
    // RMAT / Graph500: the honest worst case for a naive range partition.
    let scale = 16u32; // 65_536 vertices
    let n = Kronecker::vertices(scale);
    let rmat: Vec<(usize, usize)> = Kronecker::new(scale, 16, 0xD00D).collect();
    run("RMAT scale-16 (range partition, worst case)", n, &rmat, 16);

    println!();

    // Ring: perfect locality — the boundary-halo ceiling (≈1 ghost per shard boundary).
    let rn = 1_000_000usize;
    let ring: Vec<(usize, usize)> = (0..rn).map(|i| (i, (i + 1) % rn)).collect();
    run("Ring 1M (perfect locality, ceiling)", rn, &ring, 16);

    println!("\n── partitioner comparison (range vs edge-cut) ──");
    compare("RMAT scale-16", n, &rmat, 16);
}

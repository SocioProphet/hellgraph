//! dress_rehearsal — the Saturday cluster run, in miniature. Puts the three pieces together end to end:
//! Graph500 RMAT → Fennel edge-cut partition → boundary-only-halo distributed PageRank, across a scaling
//! curve of graph sizes. For each size it reports the numbers that actually size the cluster and de-risk
//! the $150 spend BEFORE we spend it:
//!
//!   • fattest shard's RAM       → the per-node memory budget (pick the machine)
//!   • max halo bytes / shard    → the per-node network RX each superstep (pick the network)
//!   • total network / superstep → aggregate bandwidth the cluster moves per step
//!   • edge cut %                → partition quality (lower = less coordination)
//!   • wall time                 → throughput (edges·iter/s)
//!
//! Then it extrapolates: at the measured bytes/edge, how many nodes does 1B / 10B / 100B edges need at a
//! given per-node RAM budget. This is the plan, backed by measurement, not a guess.
//!
//! cargo run -p hg_analytics --example dress_rehearsal --release

use hg_analytics::{
    distributed_pagerank_boundary, edge_cut, fennel_partition, partition_edges_boundary_at,
    relabel_contiguous, total_halo_bytes, BoundaryShard, Kronecker,
};
use std::time::Instant;

const K: usize = 16; // shards (= cluster nodes we're rehearsing)
const ITERS: usize = 20;

fn human(bytes: f64) -> String {
    if bytes >= 1e9 {
        format!("{:.2} GB", bytes / 1e9)
    } else if bytes >= 1e6 {
        format!("{:.1} MB", bytes / 1e6)
    } else if bytes >= 1e3 {
        format!("{:.0} KB", bytes / 1e3)
    } else {
        format!("{bytes:.0} B")
    }
}

/// Resident bytes a worker holds for one shard: the CSR of its owned in-edges (adjacency entries +
/// per-owned offset), the ghost id table, and the rank vectors (owned + ghost halo). This is what sets
/// the per-node RAM budget.
fn shard_bytes(sh: &BoundaryShard) -> usize {
    let entries: usize = sh.in_adj.iter().map(|a| a.len()).sum(); // in-edges owned
    let owned = sh.owned();
    let ghosts = sh.ghosts.len();
    entries * 8            // adjacency (local index per in-edge)
        + owned * 8        // offsets / owned rank
        + ghosts * 8       // ghost id table
        + (owned + ghosts) * 8 // local rank view (owned + halo)
}

fn run_scale(scale: u32, edgefactor: usize) {
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, edgefactor, 0xD1CE).collect();
    let m = edges.len();

    // Partition (setup, once) — Fennel edge-cut, then relabel to contiguous blocks.
    let t_part = Instant::now();
    let part = fennel_partition(n, &edges, K);
    let cut = edge_cut(&part, &edges);
    let (remapped, bounds, _perm) = relabel_contiguous(n, &part, K, &edges);
    let (shards, out_deg) = partition_edges_boundary_at(n, &remapped, &bounds);
    let part_ms = t_part.elapsed().as_secs_f64() * 1e3;

    // Per-node metrics (the fattest shard is the one that sizes the machine).
    let max_ram = shards.iter().map(shard_bytes).max().unwrap_or(0);
    let max_halo = shards
        .iter()
        .map(BoundaryShard::halo_bytes)
        .max()
        .unwrap_or(0);
    let total_halo = total_halo_bytes(&shards);
    let max_owned = shards.iter().map(BoundaryShard::owned).max().unwrap_or(0);

    // Run the boundary-halo distributed PageRank (rayon shards = the cluster in one box).
    let t_run = Instant::now();
    let rank = distributed_pagerank_boundary(n, &shards, &out_deg, 0.85, ITERS, 1e-12);
    let run_s = t_run.elapsed().as_secs_f64();
    let sum: f64 = rank.iter().sum();
    let throughput = m as f64 * ITERS as f64 / run_s;

    println!(
        "scale {scale:>2} | n {n:>10} m {m:>11} | cut {:>5.1}% | fattest shard: RAM {:>8} owned {:>8} | \
halo/node {:>8} total {:>9} | part {:>6.0}ms run {:>6.2}s ({:>4.0}M e·it/s) | Σrank {:.3}",
        100.0 * cut as f64 / m as f64,
        human(max_ram as f64),
        max_owned,
        human(max_halo as f64),
        human(total_halo as f64),
        part_ms,
        run_s,
        throughput / 1e6,
        sum,
    );

    // Bytes/edge (resident) at this scale — the extrapolation constant for cluster sizing.
    let bytes_per_edge = max_ram as f64 * K as f64 / m as f64; // whole-graph resident / m
    BYTES_PER_EDGE.with(|b| b.set(bytes_per_edge));
}

thread_local! {
    static BYTES_PER_EDGE: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

fn main() {
    println!("── dress rehearsal: Graph500 → Fennel → boundary-halo PageRank, k={K} shards, {ITERS} iters ──");
    // Scaling curve. Each doubling of scale doubles vertices; edgefactor 16 keeps it hub-heavy (RMAT).
    for scale in [14u32, 16, 18, 20] {
        run_scale(scale, 16);
    }

    // Extrapolate the cluster from the measured bytes/edge (from the largest local run above).
    let bpe = BYTES_PER_EDGE.with(|b| b.get());
    println!("\n── cluster sizing from measured {bpe:.1} bytes/edge resident ──");
    for (label, edges) in [("1B", 1e9), ("10B", 10e9), ("100B", 100e9)] {
        let total_ram = bpe * edges;
        for budget_gb in [16.0, 32.0, 64.0] {
            let nodes = (total_ram / (budget_gb * 1e9)).ceil();
            println!(
                "  {label:>4} edges → {} total → {:>4.0} nodes @ {:.0} GB/node",
                human(total_ram),
                nodes,
                budget_gb
            );
        }
    }
    println!(
        "\nNote: bytes/edge from RMAT (hub-heavy, worst case for balance). Real per-node RAM also carries \
the OS + runtime; budget headroom accordingly. Transport already proven separately (dist_socket)."
    );
}

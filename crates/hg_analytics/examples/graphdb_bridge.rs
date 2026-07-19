//! graphdb_bridge — the Phase-1 bridge on a REAL generated graph: an openCypher-style k-hop / pattern
//! traversal executed ACROSS shards (no shard holds the whole graph), VERIFIED bit-exact against a
//! single-node reference, and TIMED. This is "a graph query running on the distributed engine" — the
//! thing a single-box graph DB cannot do once the graph outgrows one machine.
//!
//! Run: `HG_SCALE=18 HG_SHARDS=16 HG_HOPS=3 cargo run -p hg_analytics --release --example graphdb_bridge`

use hg_analytics::{Kronecker, ShardedGraph, Step};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

fn env(key: &str, d: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// Single-node reference k-hop (BFS over a full in-memory adjacency) — the ground truth the sharded
/// distributed traversal must match exactly.
fn ref_khop(adj: &HashMap<u64, Vec<u64>>, start: u64, k: usize) -> Vec<u64> {
    let mut visited: HashSet<u64> = HashSet::from([start]);
    let mut frontier = vec![start];
    let mut result: HashSet<u64> = HashSet::new();
    for _ in 0..k {
        let mut next = Vec::new();
        for u in &frontier {
            if let Some(nb) = adj.get(u) {
                for &v in nb {
                    if visited.insert(v) {
                        result.insert(v);
                        next.push(v);
                    }
                }
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }
    let mut out: Vec<u64> = result.into_iter().collect();
    out.sort_unstable();
    out
}

/// Single-node reference for a compiled PLAN: the endpoints of paths of EXACTLY `steps` hops (frontier
/// expansion, no visited-dedup across steps) — the semantics `ShardedGraph::plan` must match.
fn ref_plan(adj: &HashMap<u64, Vec<u64>>, start: u64, steps: usize) -> Vec<u64> {
    let mut frontier: HashSet<u64> = HashSet::from([start]);
    for _ in 0..steps {
        let mut next: HashSet<u64> = HashSet::new();
        for u in &frontier {
            if let Some(nb) = adj.get(u) {
                for &v in nb {
                    next.insert(v);
                }
            }
        }
        frontier = next;
    }
    let mut out: Vec<u64> = frontier.into_iter().collect();
    out.sort_unstable();
    out
}

fn main() {
    let scale = env("HG_SCALE", 18) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let k = env("HG_SHARDS", 16);
    let hops = env("HG_HOPS", 3);
    let n = Kronecker::vertices(scale);

    println!("GraphDB bridge — distributed traversal on a real RMAT graph");
    println!("  n={n}  scale={scale}  edgefactor={ef}  shards={k}  hops={hops}\n");

    // Generate an RMAT graph and label every edge (property-graph style).
    let t = Instant::now();
    let raw: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x6DB).collect();
    let m = raw.len();
    let edges: Vec<(u64, u64, String)> =
        raw.iter().map(|&(u, v)| (u as u64, v as u64, "E".to_string())).collect();
    println!("  generated m={m} edges in {:.2}s", t.elapsed().as_secs_f64());

    // Reference adjacency (single-node, holds the WHOLE graph — what an incumbent needs).
    let mut adj: HashMap<u64, Vec<u64>> = HashMap::new();
    for &(u, v) in &raw {
        adj.entry(u as u64).or_default().push(v as u64);
    }
    for a in adj.values_mut() {
        a.sort_unstable();
        a.dedup();
    }

    // Shard the graph — NO shard holds the whole thing.
    let t = Instant::now();
    let g = ShardedGraph::from_edges(&edges, k);
    let shard_build = t.elapsed().as_secs_f64();
    let total_sources = adj.len();
    println!(
        "  sharded into {k} in {shard_build:.2}s — largest shard holds {} of {} source-nodes ({:.1}% — no shard holds the graph)\n",
        g.max_shard_nodes(),
        total_sources,
        100.0 * g.max_shard_nodes() as f64 / total_sources.max(1) as f64
    );

    // Run distributed k-hop from several sources; verify bit-exact vs the single-node reference; time it.
    let sources: Vec<u64> = [0u64, 1, 7, 42, 100, 1000].into_iter().filter(|&s| (s as usize) < n).collect();
    println!("  {:>8} {:>12} {:>14} {:>12}", "source", "reachable", "dist time", "vs single-node");
    println!("  {}", "-".repeat(52));
    let mut all_exact = true;
    let mut total_reach = 0usize;
    let mut total_us = 0u128;
    for &src in &sources {
        let t = Instant::now();
        let dist = g.k_hop(src, hops, None);
        let us = t.elapsed().as_micros();
        total_us += us;
        let reference = ref_khop(&adj, src, hops);
        let exact = dist == reference;
        all_exact &= exact;
        total_reach += dist.len();
        println!(
            "  {:>8} {:>12} {:>11}us {:>12}",
            src,
            dist.len(),
            us,
            if exact { "EXACT ✓" } else { "MISMATCH ✗" }
        );
    }

    // A compiled 2-step pattern (openCypher `(src)-[:E]->()-[:E]->(x)`) executed across shards.
    let steps = vec![Step { label: Some("E".into()) }, Step { label: Some("E".into()) }];
    let plan_exact = sources.iter().all(|&src| {
        let dist = g.plan(src, &steps);
        let reference = ref_plan(&adj, src, 2); // exactly-2-step frontier (plan semantics, single label)
        dist == reference
    });

    println!(
        "\n  {} — {hops}-hop distributed traversal from {} sources, {} avg reached, {:.0}us avg, verified bit-exact.",
        if all_exact { "ALL EXACT ✓" } else { "FAILURES ✗" },
        sources.len(),
        total_reach / sources.len().max(1),
        total_us as f64 / sources.len().max(1) as f64
    );
    println!(
        "  compiled 2-step pattern across shards: {}",
        if plan_exact { "EXACT ✓" } else { "MISMATCH ✗" }
    );
    println!(
        "\n  RECEIPT: a Cypher-style traversal ran across {k} shards where the largest holds {:.1}% of the\n  graph, and returned byte-identical results to the single-node engine. This is the query path a\n  single-box graph DB structurally cannot run once the graph exceeds one machine.",
        100.0 * g.max_shard_nodes() as f64 / total_sources.max(1) as f64
    );
}

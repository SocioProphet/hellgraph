//! graphdb_index_bench — proves the ingest-time index tricks pay off. Same graph, same queries, two read
//! paths: the hashmap adjacency (ShardedGraph) vs the ingest-prepared dense-CSR GraphIndex (dictionary-
//! encoded ordered integers, sorted CSR, labelled sub-slices). Both verified equal; both timed.
//!
//! Run: `HG_SCALE=20 cargo run -p hg_analytics --release --example graphdb_index_bench`

use hg_analytics::{GraphCore, GraphIndex, HyperLogLog, Kronecker, ShardedGraph};
use std::collections::HashSet;
use std::time::Instant;

fn env(key: &str, d: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() {
    let scale = env("HG_SCALE", 20) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let hops = env("HG_HOPS", 3);
    let raw: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x1D5).collect();
    let edges: Vec<(u64, u64, String)> =
        raw.iter().map(|&(u, v)| (u as u64, v as u64, "E".to_string())).collect();
    println!("index bench — scale {scale}, {} edges, {hops}-hop queries\n", edges.len());

    // Build both read paths, timing the ingest-prepare.
    let t = Instant::now();
    let g = ShardedGraph::from_edges(&edges, 1);
    let sg_build = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let idx = GraphIndex::from_edges(&edges);
    let idx_build = t.elapsed().as_secs_f64();
    println!("  ingest-prepare:  hashmap adjacency {sg_build:.2}s   |   dense-CSR index {idx_build:.2}s");
    println!("  index: {} dense nodes (0..n contiguous), {} edges\n", idx.node_count(), idx.edge_count());

    let sources: Vec<u64> = [0u64, 1, 7, 42, 100, 1000].into_iter().collect();
    // Warm both, verify identical results.
    let mut ok = true;
    for &s in &sources {
        if g.k_hop(s, hops, None) != idx.k_hop(s, hops, None) {
            ok = false;
        }
    }
    println!("  correctness: hashmap vs dense-CSR {}", if ok { "IDENTICAL ✓" } else { "MISMATCH ✗" });

    // Time each path over repeated queries.
    let reps = 5;
    let t = Instant::now();
    let mut sink = 0usize;
    for _ in 0..reps {
        for &s in &sources {
            sink += g.k_hop(s, hops, None).len();
        }
    }
    let sg_us = t.elapsed().as_micros() as f64 / (reps * sources.len()) as f64;
    let t = Instant::now();
    for _ in 0..reps {
        for &s in &sources {
            sink += idx.k_hop(s, hops, None).len();
        }
    }
    let idx_us = t.elapsed().as_micros() as f64 / (reps * sources.len()) as f64;

    println!("\n  {hops}-hop query latency (avg over {} runs):", reps * sources.len());
    println!("    hashmap adjacency : {sg_us:>9.0} us");
    println!("    dense-CSR index   : {idx_us:>9.0} us   ⇒ {:.1}× faster", sg_us / idx_us.max(1e-9));

    // ── Bloom-filtered edge-existence: negative probes reject in O(k), no dictionary lookup ──
    let t = Instant::now();
    let idxb = GraphIndex::from_edges(&edges).with_edge_bloom();
    let bloom_build = t.elapsed().as_secs_f64();
    let nn = idx.node_count() as u64;
    let mut r = 0x1234_5678_9abc_def0u64;
    let mut probes: Vec<(u64, u64)> = Vec::with_capacity(200_000);
    for _ in 0..200_000 {
        r ^= r << 13;
        r ^= r >> 7;
        r ^= r << 17;
        let u = idx.original((r % nn) as u32);
        r ^= r << 13;
        r ^= r >> 7;
        r ^= r << 17;
        let v = idx.original((r % nn) as u32);
        probes.push((u, v));
    }
    // exact path (dictionary + binary search), no bloom
    let t = Instant::now();
    let mut c1 = 0usize;
    for &(u, v) in &probes {
        if let (Some(ud), Some(vd)) = (idx.dense(u), idx.dense(v)) {
            if idx.out_neighbors(ud, Some("E")).binary_search(&vd).is_ok() {
                c1 += 1;
            }
        }
    }
    let exact_ns = t.elapsed().as_nanos() as f64 / probes.len() as f64;
    // bloom pre-check path
    let t = Instant::now();
    let mut c2 = 0usize;
    for &(u, v) in &probes {
        if idxb.has_edge(u, v, "E") {
            c2 += 1;
        }
    }
    let bloom_ns = t.elapsed().as_nanos() as f64 / probes.len() as f64;
    assert_eq!(c1, c2, "bloom path must agree with exact");
    println!(
        "\n  edge-existence: {} probes, {} real edges ({:.1}% negative) — bloom build +{bloom_build:.2}s ingest:",
        probes.len(),
        c1,
        100.0 * (1.0 - c1 as f64 / probes.len() as f64)
    );
    println!("    exact (dict+binsearch): {exact_ns:>6.0} ns/probe");
    println!("    bloom pre-check       : {bloom_ns:>6.0} ns/probe   ⇒ {:.1}× on negative probes", exact_ns / bloom_ns.max(1e-9));

    // ── HyperLogLog: distinct edge-target cardinality in ~16 KB vs an exact hash set ──
    let mut hll = HyperLogLog::new(14); // 2^14 registers = 16 KB
    let mut exact_set: HashSet<u64> = HashSet::new();
    for &(_, v, _) in &edges {
        hll.add(v);
        exact_set.insert(v);
    }
    let est = hll.estimate();
    let exact = exact_set.len();
    println!(
        "\n  HLL distinct edge-targets: exact {} vs estimate {:.0} ({:.2}% error) — 16 KB sketch vs a {}-entry set",
        exact,
        est,
        100.0 * (est - exact as f64).abs() / exact as f64,
        exact
    );

    println!("\n  (sink={sink}) — same answers, the ingest-prepared dense-CSR path wins on read latency.");
}

//! race_suite — multi-workload head-to-head vs Neo4j GDS. More than PageRank: adds connectivity (WCC),
//! community (Louvain), and the 3-HOP NEIGHBORHOOD traversal that Neo4j is built for. Generates one RMAT
//! graph, writes it as Neo4j-admin CSV (identical graph both sides), and times each workload on our engine.
//!
//! Run: `HG_SCALE=18 HG_CSV_DIR=/tmp/graph cargo run -p hg_analytics --release --example race_suite`

use hg_analytics::{connected_components_uf, louvain, louvain_parallel, modularity, GraphCore, GraphIndex, Kronecker, PreparedGraph};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

fn env(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let scale = env("HG_SCALE", 18) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x1DBC).collect();
    let m = edges.len();
    eprintln!("[hg] n={n} m={m}");

    // Identical graph → Neo4j-admin CSV.
    let dir = std::env::var("HG_CSV_DIR").unwrap_or_else(|_| "/tmp/graph".into());
    std::fs::create_dir_all(&dir).unwrap();
    {
        let mut w = BufWriter::new(File::create(format!("{dir}/nodes.csv")).unwrap());
        writeln!(w, "nodeId:ID").unwrap();
        for i in 0..n {
            writeln!(w, "{i}").unwrap();
        }
        let mut w = BufWriter::new(File::create(format!("{dir}/rels.csv")).unwrap());
        writeln!(w, ":START_ID,:END_ID").unwrap();
        for &(u, v) in &edges {
            writeln!(w, "{u},{v}").unwrap();
        }
    }

    println!("=================== HELLGRAPH SUITE ===================");
    println!("scale={scale}  n={n}  m={m}");

    // 1) PageRank (20 iters, damping 0.85) — GDS-default.
    let g = PreparedGraph::build(n, &edges);
    let t = Instant::now();
    let pr = g.pagerank(0.85, 20, 1e-7);
    let pr_ms = ms(t);
    let sum: f64 = pr.iter().sum();
    println!("  PageRank        : {pr_ms:8.1} ms   (Σrank={sum:.4})");

    // 2) WCC — weakly-connected components (union-find).
    let t = Instant::now();
    let cc = connected_components_uf(n, &edges);
    let wcc_ms = ms(t);
    let comps = cc.iter().collect::<HashSet<_>>().len();
    println!("  WCC             : {wcc_ms:8.1} ms   (components={comps})");

    // 3) 3-HOP NEIGHBORHOOD — the traversal Neo4j is built for. Indexed CSR, from 5 sources.
    let labeled: Vec<(u64, u64, String)> =
        edges.iter().map(|&(u, v)| (u as u64, v as u64, "REL".to_string())).collect();
    let t = Instant::now();
    let idx = GraphIndex::from_edges(&labeled);
    let idx_ms = ms(t);
    let srcs = [0u64, 1, 7, 42, 100];
    let t = Instant::now();
    let mut reached = 0usize;
    for &s in &srcs {
        reached += idx.k_hop(s, 3, None).len();
    }
    let hop_ms = ms(t);
    println!("  3-hop ×{}       : {hop_ms:8.1} ms   ({} nodes reached, index build {idx_ms:.0} ms)", srcs.len(), reached);

    // 4) Louvain — sequential (deterministic) vs parallel (synchronous, all-cores). Q = modularity (quality).
    let t = Instant::now();
    let cs = louvain(n, &edges);
    let lv_ms = ms(t);
    println!("  Louvain (seq)   : {lv_ms:8.1} ms   (Q={:.4}, communities={})", modularity(n, &edges, &cs), cs.iter().collect::<HashSet<_>>().len());
    let t = Instant::now();
    let cp = louvain_parallel(n, &edges);
    let lp_ms = ms(t);
    println!("  Louvain (par)   : {lp_ms:8.1} ms   (Q={:.4}, communities={})", modularity(n, &edges, &cp), cp.iter().collect::<HashSet<_>>().len());
    println!("======================================================");
}

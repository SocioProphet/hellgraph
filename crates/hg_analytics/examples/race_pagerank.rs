//! race_pagerank — the head-to-head harness. Generates an RMAT (Graph500) graph at HG_SCALE, writes it as
//! Neo4j-admin CSV (nodes.csv + rels.csv) so Neo4j runs the IDENTICAL graph, then builds our CSR and runs
//! PageRank with GDS-default parameters (damping 0.85, 20 iters), reporting load + compute time + GTEPS.
//!
//! Run: `HG_SCALE=20 HG_ITERS=20 HG_CSV_DIR=/tmp/graph cargo run -p hg_analytics --release --example race_pagerank`

use hg_analytics::{Kronecker, PreparedGraph};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

fn env(key: &str, d: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() {
    let scale = env("HG_SCALE", 20) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let iters = env("HG_ITERS", 20);
    let n = Kronecker::vertices(scale);

    let t = Instant::now();
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x1DBC).collect();
    let gen_s = t.elapsed().as_secs_f64();
    let m = edges.len();
    eprintln!("[hg] generated n={n} m={m} in {gen_s:.2}s");

    // Write the IDENTICAL graph as neo4j-admin CSV (headers for bulk import).
    let dir = std::env::var("HG_CSV_DIR").unwrap_or_else(|_| "/tmp/graph".into());
    std::fs::create_dir_all(&dir).unwrap();
    let t = Instant::now();
    {
        let mut w = BufWriter::new(File::create(format!("{dir}/nodes.csv")).unwrap());
        writeln!(w, "nodeId:ID").unwrap();
        for i in 0..n {
            writeln!(w, "{i}").unwrap();
        }
    }
    {
        let mut w = BufWriter::new(File::create(format!("{dir}/rels.csv")).unwrap());
        writeln!(w, ":START_ID,:END_ID").unwrap();
        for &(u, v) in &edges {
            writeln!(w, "{u},{v}").unwrap();
        }
    }
    eprintln!("[hg] wrote CSV ({}/nodes.csv, {}/rels.csv) in {:.2}s", dir, dir, t.elapsed().as_secs_f64());

    // Our engine: build the CSR (the "load") then PageRank (the "compute"), GDS-default params.
    let t = Instant::now();
    let g = PreparedGraph::build(n, &edges);
    let build_s = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let pr = g.pagerank(0.85, iters, 1e-7);
    let compute_s = t.elapsed().as_secs_f64();
    let gteps = (m as f64 * iters as f64) / compute_s / 1e9;
    let sum: f64 = pr.iter().sum();

    println!("=================== HELLGRAPH ===================");
    println!("scale={scale}  n={n}  m={m}  iters={iters}  damping=0.85");
    println!("  build (load)  : {build_s:.3} s");
    println!("  pagerank      : {compute_s:.3} s   ({gteps:.2} GTEPS)   Σrank={sum:.4}");
    println!("  load+compute  : {:.3} s", build_s + compute_s);
    println!("=================================================");
}

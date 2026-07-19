//! race_graphalytics — the full LDBC Graphalytics 6-kernel scorecard vs Neo4j GDS. Loads a real edge list
//! (SNAP format, or generates RMAT if HG_EDGES unset), dictionary-encodes to dense ids, writes the identical
//! graph as Neo4j-admin CSV, and times all six kernels on our engine: PageRank, WCC, BFS, SSSP, CDLP, LCC.
//!
//! Run: `HG_EDGES=/path/soc-LiveJournal1.txt HG_CSV_DIR=/tmp/graph cargo run -p hg_analytics --release --example race_graphalytics`
//! (no HG_EDGES → RMAT at HG_SCALE for local testing)

use hg_analytics::{
    bfs_csr, bfs_on_csr, cdlp_csr, cdlp_on_csr, connected_components_parallel, sssp_csr, sssp_on_csr,
    Kronecker, PreparedGraph,
};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::time::Instant;

fn env(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Load an edge list from HG_EDGES (SNAP: whitespace-separated src dst, '#' comments), or generate RMAT.
/// Returns (n, dense edges) — original ids dictionary-encoded to a dense 0..n space.
fn load_graph() -> (usize, Vec<(usize, usize)>) {
    if let Ok(path) = std::env::var("HG_EDGES") {
        let f = File::open(&path).expect("open HG_EDGES");
        let mut raw: Vec<(u64, u64)> = Vec::new();
        for line in BufReader::new(f).lines() {
            let line = line.unwrap();
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut it = line.split_whitespace();
            if let (Some(a), Some(b)) = (it.next(), it.next()) {
                if let (Ok(u), Ok(v)) = (a.parse::<u64>(), b.parse::<u64>()) {
                    raw.push((u, v));
                }
            }
        }
        // dictionary-encode to dense 0..n
        let mut ids: Vec<u64> = raw.iter().flat_map(|&(u, v)| [u, v]).collect();
        ids.sort_unstable();
        ids.dedup();
        let dense: HashMap<u64, usize> = ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
        let edges: Vec<(usize, usize)> = raw.iter().map(|&(u, v)| (dense[&u], dense[&v])).collect();
        (ids.len(), edges)
    } else {
        let scale = env("HG_SCALE", 18) as u32;
        let ef = env("HG_EDGEFACTOR", 16);
        let n = Kronecker::vertices(scale);
        let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x1DBC).collect();
        (n, edges)
    }
}

/// Flat CSR from dense edges. `undirected` adds both directions. Returns (offsets, neighbours).
fn build_csr(n: usize, edges: &[(usize, usize)], undirected: bool) -> (Vec<u32>, Vec<u32>) {
    let mut off = vec![0u32; n + 1];
    for &(u, v) in edges {
        off[u + 1] += 1;
        if undirected {
            off[v + 1] += 1;
        }
    }
    for i in 0..n {
        off[i + 1] += off[i];
    }
    let mut cur = off.clone();
    let mut nbr = vec![0u32; off[n] as usize];
    for &(u, v) in edges {
        nbr[cur[u] as usize] = v as u32;
        cur[u] += 1;
        if undirected {
            nbr[cur[v] as usize] = u as u32;
            cur[v] += 1;
        }
    }
    (off, nbr)
}

fn main() {
    let (n, edges) = load_graph();
    let m = edges.len();
    eprintln!("[hg] n={n} m={m}");

    // identical graph → Neo4j-admin CSV
    let dir = std::env::var("HG_CSV_DIR").unwrap_or_else(|_| "/tmp/graph".into());
    std::fs::create_dir_all(&dir).unwrap();
    {
        let mut w = BufWriter::new(File::create(format!("{dir}/nodes.csv")).unwrap());
        writeln!(w, "nodeId:ID").unwrap();
        for i in 0..n {
            writeln!(w, "{i}").unwrap();
        }
        let mut w = BufWriter::new(File::create(format!("{dir}/rels.csv")).unwrap());
        writeln!(w, ":START_ID,:END_ID,weight:double").unwrap();
        for &(u, v) in &edges {
            let wt = 1.0 + ((u.wrapping_mul(2654435761) ^ v) % 16) as f64; // same weights our SSSP uses
            writeln!(w, "{u},{v},{wt}").unwrap();
        }
    }

    // Source for BFS/SSSP = highest out-degree node (guaranteed traversable). Same source handed to GDS.
    let mut outdeg = vec![0u32; n];
    for &(u, _) in &edges {
        outdeg[u] += 1;
    }
    let src = (0..n).max_by_key(|&i| outdeg[i]).unwrap_or(0);
    println!("============ HELLGRAPH — LDBC GRAPHALYTICS 6 ============");
    println!("n={n}  m={m}  HG_SOURCE={src}  src_outdeg={}", outdeg[src]);

    // 1) PageRank (directed, 20 iters, damping 0.85). Time the COMPUTE only: build the CSR OUTSIDE the timer,
    // matching GDS computeMillis (which excludes gds.graph.project's projectMillis). Both engines' model is
    // "build the in-memory graph once, run the kernel" — so kernel-vs-kernel is the apples-to-apples race
    // (our build ~2.5s at 117M also beats GDS projectMillis ~16s, but that's a separate, end-to-end number).
    let pg = PreparedGraph::build(n, &edges);
    let t = Instant::now();
    let pr = pg.pagerank(0.85, 20, 1e-7);
    let pr_ms = ms(t);
    println!("  PageRank : {pr_ms:9.1} ms   (Σ={:.3})", pr.iter().sum::<f64>());

    // 2) WCC (undirected connectivity) — lock-free PARALLEL union-find (scales past the 69M crossover)
    let t = Instant::now();
    let cc = connected_components_parallel(n, &edges);
    let wcc_ms = ms(t);
    let comps = cc.iter().collect::<std::collections::HashSet<_>>().len();
    println!("  WCC      : {wcc_ms:9.1} ms   (components={comps})");

    // 3) BFS (directed, single source = src) — PARALLEL level-synchronous frontier expansion. Out-CSR built
    // OUTSIDE the timer (matches GDS computeMillis); the timed kernel is the parallel traversal, producing the
    // same BFS hop-distances as sequential BFS (proven in lib tests).
    let (doff, dnbr) = bfs_csr(n, &edges);
    let t = Instant::now();
    let dist = bfs_on_csr(n, &doff, &dnbr, src);
    let bfs_ms = ms(t);
    let reached = dist.iter().filter(|&&d| d != u32::MAX).count();
    println!("  BFS      : {bfs_ms:9.1} ms   (reached={reached})");

    // 4) SSSP (directed weighted, single source = src) — PARALLEL label-correcting relaxation (the WCC recipe
    // applied to Dijkstra). Weighted CSR built OUTSIDE the timer (matches GDS computeMillis, which excludes
    // projection); the timed kernel produces the LDBC SSSP output — the shortest DISTANCE to every vertex —
    // deterministically (== sequential Dijkstra, proven in lib tests).
    let wt: Vec<f64> =
        edges.iter().map(|&(u, v)| 1.0 + ((u.wrapping_mul(2654435761) ^ v) % 16) as f64).collect();
    let (woff, wnbr, wwgt) = sssp_csr(n, &edges, &wt);
    let t = Instant::now();
    let sd = sssp_on_csr(n, &woff, &wnbr, &wwgt, src);
    let sssp_ms = ms(t);
    let sreached = sd.iter().filter(|&&d| d.is_finite()).count();
    println!("  SSSP     : {sssp_ms:9.1} ms   (reached={sreached})");

    // Graph prep for the community/clustering kernels — UNTIMED (mirrors GDS projectMillis, which is excluded
    // from computeMillis). The two kernels are defined on DIFFERENT graphs, so we build two adjacencies:
    //  • CDLP wants the LDBC in∪out MULTISET — a reciprocal directed pair counts a neighbour's label TWICE
    //    (`cdlp_csr`, validated against the LDBC definition in the lib tests; GDS labelPropagation is a
    //    different algorithm, so its community count is not a conformance signal).
    //  • LCC wants the SIMPLE undirected graph — dedup parallel edges, drop self-loops, rows SORTED (below);
    //    GDS matches this with an `aggregation:'SINGLE'` UNDIRECTED projection.
    let (coff, cnbr) = cdlp_csr(n, &edges);
    let (uoff, unbr) = build_csr(n, &edges, true);
    let mut soff = vec![0u32; n + 1];
    let mut snbr: Vec<u32> = Vec::with_capacity(unbr.len());
    {
        let mut scratch: Vec<u32> = Vec::new();
        for i in 0..n {
            scratch.clear();
            scratch.extend_from_slice(&unbr[uoff[i] as usize..uoff[i + 1] as usize]);
            scratch.sort_unstable();
            scratch.dedup();
            for &x in &scratch {
                if x != i as u32 {
                    snbr.push(x); // drop self-loops → simple graph
                }
            }
            soff[i + 1] = snbr.len() as u32;
        }
    }

    // 5) CDLP — LDBC-conformant Community Detection by Label Propagation: the in∪out multiset CSR (built
    // untimed above), 10 synchronous sweeps, most-frequent neighbour label, ties → smallest. Parallel
    // per-thread scratch inside `cdlp_on_csr`; timing is the kernel only, matching GDS computeMillis.
    let t = Instant::now();
    let label = cdlp_on_csr(n, &coff, &cnbr, 10);
    let cdlp_ms = ms(t);
    let ncomm = label.iter().collect::<std::collections::HashSet<_>>().len();
    println!("  CDLP     : {cdlp_ms:9.1} ms   (labels={ncomm})");

    // 6) LCC (local clustering coefficient) on the SIMPLE graph. Per node: count triangles via sorted-
    // adjacency intersection over its neighbours, divide by d(d-1). Rows are already sorted+deduped+self-free.
    let t = Instant::now();
    let soff_ref = &soff;
    let snbr_ref = &snbr;
    let row = |k: usize| &snbr_ref[soff_ref[k] as usize..soff_ref[k + 1] as usize];
    let lcc_sum: f64 = (0..n)
        .into_par_iter()
        .map(|v| {
            let nb = row(v);
            let d = nb.len();
            if d < 2 {
                return 0.0;
            }
            let mut tri = 0usize;
            for &a in nb {
                let na = row(a as usize);
                let (mut i, mut j) = (0usize, 0usize);
                while i < nb.len() && j < na.len() {
                    match nb[i].cmp(&na[j]) {
                        std::cmp::Ordering::Less => i += 1,
                        std::cmp::Ordering::Greater => j += 1,
                        std::cmp::Ordering::Equal => {
                            tri += 1;
                            i += 1;
                            j += 1;
                        }
                    }
                }
            }
            tri as f64 / (d as f64 * (d as f64 - 1.0))
        })
        .sum();
    let lcc_ms = ms(t);
    println!("  LCC      : {lcc_ms:9.1} ms   (avg={:.5})", lcc_sum / n as f64);
    println!("========================================================");
}

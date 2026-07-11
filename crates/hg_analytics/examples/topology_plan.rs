//! topology_plan — show the deployment the planner picks across graph sizes, and WHERE the single→cluster
//! crossover falls. This is the axis the kernel/algorithm work missed: the fastest strategy is
//! topology-dependent.  cargo run -p hg_analytics --release --example topology_plan

use hg_analytics::{plan_pagerank, ClusterSpec, PlannerConfig, Topology, Workload};

fn main() {
    let spec = ClusterSpec {
        nodes: 16,
        mem_gb_per_node: 16.0,
    };
    let cfg = PlannerConfig::default();
    println!(
        "Cluster: {} nodes × {}GB (usable ~{:.0}GB/node). Graph = edgefactor-16 RMAT.\n",
        spec.nodes,
        spec.mem_gb_per_node,
        spec.mem_gb_per_node * cfg.usable_mem_fraction
    );
    println!(
        "{:>7}  {:>13}  {:>10}  {:>20}  {:>10}  {:>9}",
        "scale", "edges", "resident", "topology", "est wall", "est $"
    );
    for scale in 18u32..=32 {
        let n = 1usize << scale;
        let m = 16 * n;
        let plan = plan_pagerank(n, m, 25, spec, Workload::SingleQuery, cfg);
        let topo = match plan.topology {
            Topology::SingleInMemory => "SINGLE in-mem".to_string(),
            Topology::SingleOutOfCore => "SINGLE out-of-core".to_string(),
            Topology::Replicated { nodes } => format!("REPLICATED×{nodes}"),
            Topology::Distributed { shards } => format!("DISTRIBUTED k={shards}"),
        };
        println!(
            "{:>7}  {:>13}  {:>8.1}GB  {:>20}  {:>8.1}s  {:>8.4}",
            scale, m, plan.resident_gb, topo, plan.est_wall_s, plan.est_cost_usd
        );
    }
    // Show the reasoning + the workload-dependent flip (repeated queries replicate instead of single).
    println!("\nWhy each choice (scale-20, scale-26):");
    for scale in [20u32, 26] {
        let (n, m) = (1usize << scale, 16 * (1usize << scale));
        let p = plan_pagerank(n, m, 25, spec, Workload::SingleQuery, cfg);
        println!("  scale-{scale} single-query: {}", p.reason);
    }
    let (n, m) = (1usize << 20, 16 * (1usize << 20));
    let rep = plan_pagerank(n, m, 25, spec, Workload::RepeatedQueries, cfg);
    println!("  scale-20 REPEATED:    {}", rep.reason);
}

//! topology_plan — show the deployment the planner picks across graph sizes, and WHERE the single→cluster
//! crossover falls. This is the axis the kernel/algorithm work missed: the fastest strategy is
//! topology-dependent.  cargo run -p hg_analytics --release --example topology_plan

use hg_analytics::{
    plan_hetero, plan_pagerank, ClusterSpec, NodeKind, NodeType, Objective, PlannerConfig,
    Topology, Workload,
};

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

    // Topology → the ALGORITHM knobs it implies (single-node vs distributed differ).
    println!("\nAlgorithm config the topology implies:");
    for (label, plan) in [
        (
            "scale-20 single",
            plan_pagerank(1 << 20, 16 << 20, 25, spec, Workload::SingleQuery, cfg),
        ),
        (
            "scale-26 distrib",
            plan_pagerank(1 << 26, 16 << 26, 25, spec, Workload::SingleQuery, cfg),
        ),
    ] {
        let a = &plan.algo;
        println!(
            "  {label}: accelerate={} f32_gather={} delta_halo={} f32_halo={} build_once={}\n     {}",
            a.accelerate, a.f32_gather, a.delta_halo, a.f32_halo, a.build_once, a.note
        );
    }

    // Heterogeneous: 1 GPU node (fast, small VRAM, pricey) vs 8 CPU nodes (slow, big aggregate mem, cheap).
    println!("\nHeterogeneous pools (1×GPU 24GB/28 GTEPS/$2, 8×CPU 16GB/2.8 GTEPS/$0.05):");
    let gpu = NodeType {
        kind: NodeKind::Gpu,
        count: 1,
        mem_gb: 24.0,
        throughput_edges_per_s: 28e9,
        usd_per_hour: 2.0,
    };
    let cpu = NodeType {
        kind: NodeKind::Cpu,
        count: 8,
        mem_gb: 16.0,
        throughput_edges_per_s: 2.8e9,
        usd_per_hour: 0.05,
    };
    let pools = [gpu, cpu];
    for scale in [22u32, 24, 26] {
        let (nn, mm) = (1usize << scale, 16 * (1usize << scale));
        let wall = plan_hetero(
            nn,
            mm,
            25,
            &pools,
            Workload::SingleQuery,
            cfg,
            Objective::MinWall,
        )
        .unwrap();
        let costo = plan_hetero(
            nn,
            mm,
            25,
            &pools,
            Workload::SingleQuery,
            cfg,
            Objective::MinCost,
        )
        .unwrap();
        println!(
            "  scale-{scale}: min-wall → {:?} ({:.2}s), min-cost → {:?} (${:.4})",
            wall.kind, wall.plan.est_wall_s, costo.kind, costo.plan.est_cost_usd
        );
    }
}

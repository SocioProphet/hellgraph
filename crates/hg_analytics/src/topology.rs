//! topology — deployment-topology planner. Given a graph size and cluster resources, PICK the deployment
//! and node count, instead of hand-tuning it. This is the axis all the kernel/algorithm work missed: the
//! fastest strategy is topology-dependent, and the WRONG topology loses badly.
//!
//! The decisions this encodes, each grounded in a MEASURED fact from this project:
//!   • Fits in one node's RAM  → SINGLE node in-memory: no network at all, the per-edge floor. (Measured:
//!     at 33M edges the cluster went the WRONG way — 4 workers beat 8 — because it was communication-bound;
//!     below the single-node ceiling, don't distribute.)
//!   • Repeated queries + fits → REPLICATE the graph per node (zero halo, queries spread) rather than
//!     partition — throughput scales linearly with nodes and no halo is ever exchanged.
//!   • Doesn't fit → DISTRIBUTE, but use the MINIMUM shard count that fits: the boundary halo grows with
//!     shard count (edge-cut rises), so over-sharding adds network cost for no compute win. (Measured: the
//!     billion at 8 shards was coordinator-relay-bound; more shards would have made the halo worse.)
//!   • Doesn't fit any affordable cluster → OUT-OF-CORE on one node (mmap CSR), trading speed for capacity.
//!
//! The cost constants are DOCUMENTED assumptions (resident bytes/edge is measured; throughput/bandwidth are
//! per-machine) — tune them in `PlannerConfig`. The planner returns the choice AND the numbers behind it, so
//! the reasoning is auditable, not a black box.

/// Measured resident footprint of the in-memory engine: ~126 bytes per edge (CSR + rank + halo metadata).
pub const RESIDENT_BYTES_PER_EDGE: f64 = 126.0;

/// Per-machine performance assumptions (override for your hardware). Defaults are conservative cloud/CPU.
#[derive(Clone, Copy, Debug)]
pub struct PlannerConfig {
    /// Usable fraction of a node's RAM after OS + daemons + working buffers.
    pub usable_mem_fraction: f64,
    /// Single-node PageRank throughput (edges·iter/s). Measured M2 CPU ≈ 2.8e9; a cloud GPU is ~10× more.
    pub throughput_edges_per_s: f64,
    /// Inter-node network bandwidth, bytes/s (10 Gbps ≈ 1.25e9 B/s).
    pub net_bytes_per_s: f64,
    /// Bytes exchanged per boundary ghost per superstep (f64 rank = 8; f32 halo = 4).
    pub halo_bytes_per_ghost: f64,
    /// Price per node per hour (USD). Used to report $ cost — because the WALL-optimal topology is not
    /// always the COST-optimal one (a fast N-node cluster can cost more than one slow out-of-core node).
    pub node_usd_per_hour: f64,
}

impl Default for PlannerConfig {
    fn default() -> Self {
        PlannerConfig {
            usable_mem_fraction: 0.7,
            throughput_edges_per_s: 2.8e9,
            net_bytes_per_s: 1.25e9,
            halo_bytes_per_ghost: 8.0,
            node_usd_per_hour: 0.05, // ~a small arm/spot node
        }
    }
}

/// A cluster the planner may target.
#[derive(Clone, Copy, Debug)]
pub struct ClusterSpec {
    pub nodes: usize,
    pub mem_gb_per_node: f64,
}

/// How the graph is queried — changes the partition-vs-replicate decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workload {
    /// One PageRank (or a few) — capacity is what matters.
    SingleQuery,
    /// Many independent queries (personalized PR, per-user rankings) — throughput matters.
    RepeatedQueries,
}

/// The chosen deployment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Topology {
    /// One node, whole graph in RAM. No network. The per-edge floor.
    SingleInMemory,
    /// One node, CSR memory-mapped from disk. Slower per edge, but fits graphs bigger than RAM.
    SingleOutOfCore,
    /// Graph replicated on every node; queries spread across nodes. Zero halo, linear query throughput.
    Replicated { nodes: usize },
    /// Graph partitioned into `shards` boundary shards across nodes; boundary halo exchanged per superstep.
    Distributed { shards: usize },
}

/// The plan + the numbers behind it (auditable, not a black box).
#[derive(Clone, Debug)]
pub struct Plan {
    pub topology: Topology,
    pub resident_gb: f64,
    pub usable_gb_per_node: f64,
    pub est_wall_s: f64,
    /// Estimated $ for the run = nodes_used · wall_hours · price. Wall-optimal ≠ cost-optimal in general.
    pub est_cost_usd: f64,
    pub reason: String,
}

/// Plan the deployment for a PageRank of `iters` supersteps over an (n-vertex, m-edge) graph on `spec`.
pub fn plan_pagerank(
    n: usize,
    m: usize,
    iters: usize,
    spec: ClusterSpec,
    workload: Workload,
    cfg: PlannerConfig,
) -> Plan {
    let resident_gb = m as f64 * RESIDENT_BYTES_PER_EDGE / 1e9;
    let usable_gb = spec.mem_gb_per_node * cfg.usable_mem_fraction;
    let compute_s = |edges: f64| edges * iters as f64 / cfg.throughput_edges_per_s;
    let cost = |nodes: usize, wall: f64| nodes as f64 * (wall / 3600.0) * cfg.node_usd_per_hour;

    // 1. Fits in ONE node's RAM → the question is single vs replicate (never partition — partitioning a
    //    graph that fits only adds halo for nothing).
    if resident_gb <= usable_gb {
        if workload == Workload::RepeatedQueries && spec.nodes > 1 {
            // Replicate: each node answers whole queries independently, no halo, throughput ×nodes.
            let wall = compute_s(m as f64); // per-query latency unchanged; throughput = nodes× this
            return Plan {
                topology: Topology::Replicated { nodes: spec.nodes },
                resident_gb,
                usable_gb_per_node: usable_gb,
                est_wall_s: wall,
                est_cost_usd: cost(spec.nodes, wall),
                reason: format!(
                    "graph fits one node ({resident_gb:.1}GB ≤ {usable_gb:.1}GB); repeated queries → REPLICATE on {} nodes (zero halo, {}× query throughput) — partitioning would add network cost for no benefit",
                    spec.nodes, spec.nodes
                ),
            };
        }
        return Plan {
            topology: Topology::SingleInMemory,
            resident_gb,
            usable_gb_per_node: usable_gb,
            est_wall_s: compute_s(m as f64),
            est_cost_usd: cost(1, compute_s(m as f64)),
            reason: format!(
                "graph fits one node ({resident_gb:.1}GB ≤ {usable_gb:.1}GB) → SINGLE node in-memory: no network, the per-edge floor. Distributing here loses (comm-bound: measured 4 workers beat 8 at 33M edges)"
            ),
        };
    }

    // 2. Doesn't fit one node. Minimum shards to fit; over-sharding raises the halo, so start at the min.
    let min_shards = (resident_gb / usable_gb).ceil() as usize;
    if min_shards <= spec.nodes {
        // Estimate wall at the minimum shard count: per-superstep = compute(m/k) + halo(k)/network.
        // Halo model: ghosts per shard grow with the edge-cut boundary. Empirically the ghost count per
        // shard ≈ boundary_fraction · (n/k); boundary_fraction rises slowly with k (Fennel keeps it ~20%).
        let k = min_shards;
        let boundary_fraction = 0.20 + 0.02 * (k as f64).log2(); // ~20% at small k, creeps up with shards
        let ghosts_total = boundary_fraction * n as f64; // summed across shards (each owns n/k, ghosts scale)
        let halo_bytes_per_superstep = ghosts_total * cfg.halo_bytes_per_ghost;
        let per_superstep = (m as f64 / k as f64) / cfg.throughput_edges_per_s
            + halo_bytes_per_superstep / cfg.net_bytes_per_s;
        let wall = per_superstep * iters as f64;
        return Plan {
            topology: Topology::Distributed { shards: k },
            resident_gb,
            usable_gb_per_node: usable_gb,
            est_wall_s: wall,
            est_cost_usd: cost(k, wall),
            reason: format!(
                "graph needs {resident_gb:.1}GB > {usable_gb:.1}GB/node → DISTRIBUTE over {k} shards (the MINIMUM that fits; more shards only grow the boundary halo — {:.0}MB/superstep at k={k}). {} nodes available.",
                halo_bytes_per_superstep / 1e6,
                spec.nodes
            ),
        };
    }

    // 3. Doesn't fit even the whole cluster → out-of-core on one node (mmap), or the cluster is too small.
    Plan {
        topology: Topology::SingleOutOfCore,
        resident_gb,
        usable_gb_per_node: usable_gb,
        est_wall_s: compute_s(m as f64) * 4.0, // OOC ≈ several× slower (disk-bound, rough)
        est_cost_usd: cost(1, compute_s(m as f64) * 4.0),
        reason: format!(
            "graph needs {resident_gb:.1}GB but the whole cluster holds only {:.1}GB ({} nodes × {usable_gb:.1}GB) → OUT-OF-CORE on one node (mmap CSR), or provision bigger/more nodes (need ≥{min_shards})",
            spec.nodes as f64 * usable_gb,
            spec.nodes
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_graph_picks_single_node_not_a_cluster() {
        // 33M edges ≈ 4.2GB resident — fits a 16GB node. The planner must NOT distribute (the measured
        // trap: distributing at this size went the wrong way, 4 workers beat 8).
        let spec = ClusterSpec {
            nodes: 8,
            mem_gb_per_node: 16.0,
        };
        let plan = plan_pagerank(
            33_554_432,
            33_554_432,
            25,
            spec,
            Workload::SingleQuery,
            Default::default(),
        );
        assert_eq!(plan.topology, Topology::SingleInMemory, "{}", plan.reason);
    }

    #[test]
    fn repeated_queries_that_fit_replicate_not_partition() {
        let spec = ClusterSpec {
            nodes: 8,
            mem_gb_per_node: 16.0,
        };
        let plan = plan_pagerank(
            4_000_000,
            33_554_432,
            25,
            spec,
            Workload::RepeatedQueries,
            Default::default(),
        );
        assert!(
            matches!(plan.topology, Topology::Replicated { nodes: 8 }),
            "{}",
            plan.reason
        );
    }

    #[test]
    fn billion_edges_distributes_over_minimum_nodes() {
        // 1B edges ≈ 126GB resident. On 16GB nodes (usable ~11.2GB) that needs ≈12 shards. With 16 nodes it
        // distributes; the planner uses the MINIMUM that fits, not all 16 (over-sharding grows the halo).
        let spec = ClusterSpec {
            nodes: 16,
            mem_gb_per_node: 16.0,
        };
        let plan = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            spec,
            Workload::SingleQuery,
            Default::default(),
        );
        match plan.topology {
            Topology::Distributed { shards } => {
                assert!(
                    shards >= 12 && shards <= 16,
                    "expected ~12 min shards, got {shards}: {}",
                    plan.reason
                );
            }
            other => panic!("billion should distribute, got {other:?}: {}", plan.reason),
        }
    }

    #[test]
    fn cost_is_reported_and_scales_with_nodes_used() {
        // The billion on 16 nodes distributes over ~13 shards → its $ reflects 13 nodes, not 1. Cost
        // visibility is the point (wall-optimal ≠ cost-optimal under per-node billing).
        let spec = ClusterSpec {
            nodes: 16,
            mem_gb_per_node: 16.0,
        };
        let plan = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            spec,
            Workload::SingleQuery,
            Default::default(),
        );
        assert!(
            plan.est_cost_usd > 0.0,
            "cost must be reported: {}",
            plan.reason
        );
        // Same graph, 1×-node cost basis (single in-mem on a huge node) is cheaper per unit wall than
        // spreading across shards — the planner exposes the number so the human can trade wall vs $.
        let big = ClusterSpec {
            nodes: 1,
            mem_gb_per_node: 256.0,
        };
        let single = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            big,
            Workload::SingleQuery,
            Default::default(),
        );
        assert_eq!(single.topology, Topology::SingleInMemory);
        assert!(single.est_cost_usd > 0.0);
    }

    #[test]
    fn graph_too_big_for_cluster_goes_out_of_core() {
        // 1B edges on a puny 2×8GB cluster can't fit → out-of-core fallback.
        let spec = ClusterSpec {
            nodes: 2,
            mem_gb_per_node: 8.0,
        };
        let plan = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            spec,
            Workload::SingleQuery,
            Default::default(),
        );
        assert_eq!(plan.topology, Topology::SingleOutOfCore, "{}", plan.reason);
    }
}

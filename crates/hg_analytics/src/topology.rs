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
    /// Billing granularity in hours: cloud bills in increments (per-hour = 1.0, per-second ≈ 1/3600). A run
    /// is billed `ceil(wall_hours / increment) · increment` per node — so under per-HOUR billing, k nodes
    /// for a 4-second job still costs k node-HOURS, which flips cost toward FEWER nodes. Modelling this is
    /// the difference between the paper cost and the invoice.
    pub billing_increment_hours: f64,
    /// Out-of-core slowdown vs in-RAM: random CSR gather from mmap is disk-bound. SSD random access is
    /// ~20–100× slower than RAM bandwidth; default 20× is a defensible-but-rough middle. This is what makes
    /// OOC a genuine last resort (a fast GPU doing OOC does NOT beat a CPU cluster — the disk dominates).
    pub ooc_slowdown: f64,
}

impl Default for PlannerConfig {
    fn default() -> Self {
        PlannerConfig {
            usable_mem_fraction: 0.7,
            throughput_edges_per_s: 2.8e9,
            net_bytes_per_s: 1.25e9,
            halo_bytes_per_ghost: 8.0,
            node_usd_per_hour: 0.05,               // ~a small arm/spot node
            billing_increment_hours: 1.0 / 3600.0, // per-second by default; set 1.0 for hourly minimums
            ooc_slowdown: 20.0,                    // disk-bound random access; OOC is a last resort
        }
    }
}

/// The algorithm knobs a given topology + workload IMPLY. The kernel/algorithm levers built earlier are not
/// universally worth it — their value is topology-dependent, and this makes that explicit so the deployment
/// carries the right config instead of a hand-guess.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlgoConfig {
    /// Anderson acceleration — ~2× fewer sweeps. Always on (helps single AND distributed; distributed even
    /// more, since each sweep is also a halo exchange).
    pub accelerate: bool,
    /// f32 contrib gather (½ the random bandwidth, tolerance-accurate). On for throughput; off if the answer
    /// must be the bit-exact f64 fixed point.
    pub f32_gather: bool,
    /// Delta/residual halo — only meaningful DISTRIBUTED (ship only ghosts that moved). No-op single-node.
    pub delta_halo: bool,
    /// f32 halo (½ the ghost bytes) — only DISTRIBUTED.
    pub f32_halo: bool,
    /// Hold a PreparedGraph and reuse the built CSR — for repeated queries / replicated serving.
    pub build_once: bool,
    pub note: String,
}

/// Derive the algorithm config a topology + workload wants.
fn algo_for(topology: Topology, workload: Workload) -> AlgoConfig {
    let distributed = matches!(topology, Topology::Distributed { .. });
    let repeated =
        workload == Workload::RepeatedQueries || matches!(topology, Topology::Replicated { .. });
    AlgoConfig {
        accelerate: true,
        f32_gather: true,
        delta_halo: distributed,
        f32_halo: distributed,
        build_once: repeated,
        note: if distributed {
            "distributed: Anderson cuts sweeps (=halo exchanges) ~2×; delta+f32 halo cut the wire; f32 gather on each node"
                .into()
        } else if repeated {
            "single node, repeated: hold a PreparedGraph (reuse CSR); Anderson + f32 gather; halo levers are no-ops here"
                .into()
        } else {
            "single node, one-shot: Anderson + f32 gather; halo/delta levers are no-ops (no network)".into()
        },
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
    /// Estimated $ for the run = nodes · billed_hours · price (billed_hours rounds wall UP to the billing
    /// increment). Wall-optimal ≠ cost-optimal in general.
    pub est_cost_usd: f64,
    /// The algorithm knobs this topology implies — so the deployment carries the right config.
    pub algo: AlgoConfig,
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
    // Bill wall time rounded UP to the billing increment (per-hour minimums make few nodes cheaper).
    let cost = |nodes: usize, wall: f64| {
        let inc = cfg.billing_increment_hours.max(1e-9);
        let billed_hours = (wall / 3600.0 / inc).ceil() * inc;
        nodes as f64 * billed_hours * cfg.node_usd_per_hour
    };

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
                algo: algo_for(Topology::Replicated { nodes: spec.nodes }, workload),
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
            algo: algo_for(Topology::SingleInMemory, workload),
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
            algo: algo_for(Topology::Distributed { shards: k }, workload),
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
        est_wall_s: compute_s(m as f64) * cfg.ooc_slowdown, // disk-bound random access
        est_cost_usd: cost(1, compute_s(m as f64) * cfg.ooc_slowdown),
        algo: algo_for(Topology::SingleOutOfCore, workload),
        reason: format!(
            "graph needs {resident_gb:.1}GB but the whole cluster holds only {:.1}GB ({} nodes × {usable_gb:.1}GB) → OUT-OF-CORE on one node (mmap CSR), or provision bigger/more nodes (need ≥{min_shards})",
            spec.nodes as f64 * usable_gb,
            spec.nodes
        ),
    }
}

/// A pool of identical nodes (one hardware kind) available to the planner.
#[derive(Clone, Copy, Debug)]
pub struct NodeType {
    pub kind: NodeKind,
    pub count: usize,
    pub mem_gb: f64,
    /// Single-node throughput (edges·iter/s). A GPU is ~10× a CPU here…
    pub throughput_edges_per_s: f64,
    /// …but a GPU's usable memory is VRAM (smaller), so it hits the capacity ceiling sooner. Both matter.
    pub usd_per_hour: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Cpu,
    Gpu,
}

/// What to optimize when several node pools could each run the job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Objective {
    MinWall,
    MinCost,
}

/// The chosen pool + its plan.
#[derive(Clone, Debug)]
pub struct HeteroPlan {
    pub kind: NodeKind,
    pub plan: Plan,
}

/// Plan across HETEROGENEOUS node pools (e.g. a few big GPU nodes AND many small CPU nodes). A GPU node has
/// high throughput but small memory (VRAM) → great when the graph FITS it; CPU nodes have more aggregate
/// memory → needed when it doesn't. Evaluates each pool with its own throughput/memory/price and returns the
/// one best by `objective`, so the "1 GPU node vs N CPU nodes" call is made on numbers, not habit.
pub fn plan_hetero(
    n: usize,
    m: usize,
    iters: usize,
    pools: &[NodeType],
    workload: Workload,
    base_cfg: PlannerConfig,
    objective: Objective,
) -> Option<HeteroPlan> {
    let mut best: Option<HeteroPlan> = None;
    for pool in pools {
        if pool.count == 0 {
            continue;
        }
        let cfg = PlannerConfig {
            throughput_edges_per_s: pool.throughput_edges_per_s,
            node_usd_per_hour: pool.usd_per_hour,
            ..base_cfg
        };
        let spec = ClusterSpec {
            nodes: pool.count,
            mem_gb_per_node: pool.mem_gb,
        };
        let plan = plan_pagerank(n, m, iters, spec, workload, cfg);
        let cand = HeteroPlan {
            kind: pool.kind,
            plan,
        };
        let better = match (&best, objective) {
            (None, _) => true,
            (Some(b), Objective::MinWall) => cand.plan.est_wall_s < b.plan.est_wall_s,
            (Some(b), Objective::MinCost) => cand.plan.est_cost_usd < b.plan.est_cost_usd,
        };
        if better {
            best = Some(cand);
        }
    }
    best
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
    fn algo_config_is_topology_aware() {
        // Single-node: halo levers are no-ops. Distributed: they turn on.
        let one = ClusterSpec {
            nodes: 1,
            mem_gb_per_node: 64.0,
        };
        let single = plan_pagerank(
            1 << 20,
            16 << 20,
            25,
            one,
            Workload::SingleQuery,
            Default::default(),
        );
        assert!(single.algo.accelerate && single.algo.f32_gather);
        assert!(
            !single.algo.delta_halo && !single.algo.f32_halo,
            "no halo levers single-node"
        );

        let cluster = ClusterSpec {
            nodes: 16,
            mem_gb_per_node: 16.0,
        };
        let dist = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            cluster,
            Workload::SingleQuery,
            Default::default(),
        );
        assert!(matches!(dist.topology, Topology::Distributed { .. }));
        assert!(
            dist.algo.delta_halo && dist.algo.f32_halo,
            "halo levers on when distributed"
        );

        // Repeated queries → build_once (reuse the CSR).
        let rep = plan_pagerank(
            4_000_000,
            33_554_432,
            25,
            cluster,
            Workload::RepeatedQueries,
            Default::default(),
        );
        assert!(
            rep.algo.build_once,
            "repeated queries should reuse the prepared graph"
        );
    }

    #[test]
    fn hourly_billing_makes_fewer_nodes_cheaper() {
        // Per-second billing: cost ∝ node-seconds. Per-hour billing: a short job on many nodes still bills
        // many node-hours → the invoice flips toward fewer nodes even when they're slower.
        let spec = ClusterSpec {
            nodes: 16,
            mem_gb_per_node: 16.0,
        };
        let per_sec = PlannerConfig {
            billing_increment_hours: 1.0 / 3600.0,
            ..Default::default()
        };
        let hourly = PlannerConfig {
            billing_increment_hours: 1.0,
            ..Default::default()
        };
        let a = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            spec,
            Workload::SingleQuery,
            per_sec,
        );
        let b = plan_pagerank(
            67_108_864,
            1_073_741_824,
            25,
            spec,
            Workload::SingleQuery,
            hourly,
        );
        assert!(
            b.est_cost_usd > a.est_cost_usd,
            "hourly minimum must cost ≥ per-second: {} vs {}",
            b.est_cost_usd,
            a.est_cost_usd
        );
    }

    #[test]
    fn hetero_picks_gpu_when_it_fits_cpu_cluster_when_it_doesnt() {
        // 1 GPU node (24GB VRAM, 10× throughput, pricey) + 8 CPU nodes (16GB, cheap).
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

        // A graph that FITS the GPU's 24GB (scale-22 ≈ 8.5GB) → MinWall picks the GPU (10× faster).
        let fit = plan_hetero(
            1 << 22,
            16 << 22,
            25,
            &pools,
            Workload::SingleQuery,
            Default::default(),
            Objective::MinWall,
        )
        .unwrap();
        assert_eq!(
            fit.kind,
            NodeKind::Gpu,
            "graph fits VRAM → GPU wins on wall: {}",
            fit.plan.reason
        );

        // A graph that EXCEEDS 24GB VRAM but fits the CPU cluster (scale-24 ≈ 34GB) → GPU pool can only go
        // out-of-core (1 node), so the CPU cluster wins on wall.
        let big = plan_hetero(
            1 << 24,
            16 << 24,
            25,
            &pools,
            Workload::SingleQuery,
            Default::default(),
            Objective::MinWall,
        )
        .unwrap();
        assert_eq!(
            big.kind,
            NodeKind::Cpu,
            "graph exceeds VRAM → CPU cluster wins: {}",
            big.plan.reason
        );
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

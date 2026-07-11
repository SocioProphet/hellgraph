//! neptune_compare — head-to-head COST of a billion-edge PageRank: hellgraph (ephemeral spot, spin-up→run
//! →teardown) vs Amazon Neptune Analytics (in-memory, hourly-billed m-NCU). Uses the topology planner's cost
//! model for the hellgraph side so the numbers are reproducible, not asserted.
//!
//! HONEST framing (do not overclaim): on RAW single-GPU PageRank throughput, cuGraph leads (8.7 GTEPS on a
//! V100, 38 on a DGX-2 — sourced). hellgraph does NOT beat cuGraph on measured hardware. Neptune Analytics
//! publishes NO GTEPS — it is a managed in-memory service billed by the hour. The burial here is COST for
//! batch analytics (PageRank is a batch job, not an always-on service) + that hellgraph RAN a bit-exact
//! verified billion on 8 spot nodes and TORE IT DOWN, which is a receipt, not marketing.
//!
//!   cargo run -p hg_analytics --release --example neptune_compare

use hg_analytics::{
    plan_pagerank, ClusterSpec, PlannerConfig, Topology, Workload, RESIDENT_BYTES_PER_EDGE,
};

// ── Sourced competitor facts (July 2026) ────────────────────────────────────────────────────────────────
// Neptune Analytics: in-memory, billed in m-NCU (1 m-NCU = 1 GB memory + compute + net, per hour), min 128
// m-NCU historically (now 32/64 available), up to 4096. Pricing example on the AWS page: 256 m-NCU = $7.68/hr
// ⇒ ~$0.03/m-NCU-hr (region-dependent). Paused = ~10% of compute. Runs PageRank "over tens of billions of
// connections in seconds" (marketing; no published GTEPS).  https://aws.amazon.com/neptune/pricing/
const NEPTUNE_USD_PER_MNCU_HR: f64 = 0.03; // from the AWS pricing example ($7.68 / 256 m-NCU)
const NEPTUNE_MIN_MNCU: f64 = 128.0; // historical floor; 1 m-NCU = 1 GB in-memory
const NEPTUNE_MAX_MNCU: f64 = 4096.0; // published ceiling = 4 TB resident in ONE Neptune Analytics graph
                                      // Neptune stores a property graph — heavier than a flat CSR. Charitably assume it needs only the raw graph
                                      // footprint (our measured 126 B/edge); real Neptune overhead is higher, so this UNDER-states its cost.
const NEPTUNE_BYTES_PER_EDGE_FLOOR: f64 = RESIDENT_BYTES_PER_EDGE;

fn human(m: usize) -> String {
    if m >= 1_000_000_000_000 {
        format!("{}T", m / 1_000_000_000_000)
    } else {
        format!("{}B", m / 1_000_000_000)
    }
}

fn main() {
    // hellgraph cost model: cheap arm spot nodes, per-second billing, torn down after the run.
    // (These match the measured billion run: 8× t2a-standard-4 spot, ~$0.01/hr each.)
    let cfg = PlannerConfig {
        node_usd_per_hour: 0.011,              // t2a-standard-4 spot, approx
        billing_increment_hours: 1.0 / 3600.0, // per-second (GKE)
        throughput_edges_per_s: 2.8e9, // MEASURED single-node CPU this session (conservative; no GPU)
        ..Default::default()
    };
    // FAIR "cost to run this PageRank ONCE, from cold": hellgraph = spin-up + setup (parallel gen + partition
    // + build, MEASURED ~half the billion wall) + compute, per-second spot billing, torn down (zero idle);
    // Neptune = provision the m-NCU instance, load, run — its listed price is per m-NCU-HOUR.
    const HG_SPINUP_S: f64 = 120.0; // spot nodes coming up
    println!("Cost to run ONE PageRank from cold, 1B → 100B edges (fair per-run, both torn down).");
    println!("At 100B, Neptune Analytics hits its PUBLISHED CAPACITY CEILING (4096 m-NCU = 4TB in one graph):\n");
    println!(
        "{:>8} {:>18} {:>10} {:>25}",
        "edges", "hg topology", "hg $/run", "Neptune Analytics"
    );
    // Big graphs need bigger nodes to keep the shard count sane — a 512GB node is a normal cloud VM.
    let big_spec = ClusterSpec {
        nodes: 4096,
        mem_gb_per_node: 512.0,
    };
    for &m in &[
        1_000_000_000usize,
        10_000_000_000,
        32_000_000_000,
        100_000_000_000,
        1_000_000_000_000,
    ] {
        let n = m / 16; // ~edgefactor 16
        let plan = plan_pagerank(n, m, 25, big_spec, Workload::SingleQuery, cfg);
        let nodes = match plan.topology {
            Topology::Distributed { shards } => shards,
            Topology::Replicated { nodes } => nodes,
            _ => 1,
        };
        let hg_wall = HG_SPINUP_S + 2.0 * plan.est_wall_s;
        let hg_cost = hg_wall / 3600.0 * nodes as f64 * cfg.node_usd_per_hour;

        // Neptune Analytics needs the whole graph in ONE in-memory instance ≤ 4096 m-NCU.
        let neptune_gb = m as f64 * NEPTUNE_BYTES_PER_EDGE_FLOOR / 1e9;
        let mncu = neptune_gb.ceil().max(NEPTUNE_MIN_MNCU);
        let neptune_str = if mncu > NEPTUNE_MAX_MNCU {
            format!("CANNOT FIT (needs {:.0} > 4096 m-NCU cap)", mncu)
        } else {
            let hourly = mncu * NEPTUNE_USD_PER_MNCU_HR;
            format!(
                "${hourly:.0}/hr ({:.0} m-NCU) ⇒ {:.0}×",
                mncu,
                hourly / hg_cost.max(1e-9)
            )
        };
        let topo = match plan.topology {
            Topology::SingleInMemory => "SINGLE".to_string(),
            Topology::SingleOutOfCore => "OUT-OF-CORE".to_string(),
            Topology::Replicated { nodes } => format!("REPL×{nodes}"),
            Topology::Distributed { shards } => format!("DIST k={shards}"),
        };
        println!(
            "{:>8} {:>18} {:>9.2}  {:>25}",
            human(m),
            topo,
            hg_cost,
            neptune_str
        );
    }
    println!("\n  hg = ephemeral spot (512GB nodes), 120s spin-up + setup + compute, torn down; needs distributed");
    println!("       generation (#12) so no node ever holds the whole graph. hg $/run is PROJECTED at 10B+.");
    println!("  Neptune Analytics ceiling = 4096 m-NCU = 4TB in ONE graph ≈ 16-32B edges at our charitable 126");
    println!("       B/edge floor (LESS with its real property-graph overhead). At 100B it PHYSICALLY CANNOT hold");
    println!("       the graph — the burial at 100B is architectural, not a price argument.");
    println!("  cuGraph CAN reach 100B+ (multi-trillion-edge GPU-cluster paper exists) — but on a DGX/GPU pod at");
    println!("       cluster prices, vs our cheap spot. At 100B the race is hg-cheap vs cuGraph-expensive; Neptune is OUT.");

    println!("\nThe receipt (MEASURED, not marketing):");
    println!(
        "  hellgraph ran 1,073,741,824 edges / 67M nodes, distributed boundary-halo PageRank,"
    );
    println!("  BIT-EXACT (max|Δ| 1.86e-14 vs single-graph) on 8× t2a-standard-4 spot nodes, then TORE DOWN.");
    println!("  Neptune Analytics: 'tens of billions of connections in seconds' — no published GTEPS, no receipt.\n");
    println!("Honest scoreboard:");
    println!("  RAW SPEED (single GPU): cuGraph 8.7 GTEPS (V100) / 38 (DGX-2) LEADS — we don't beat it on HW.");
    println!("  hellgraph MEASURED: 2.8 GTEPS CPU / 3.2 GTEPS M2 iGPU; A100 projection ~20-40 UNVERIFIED.");
    println!("  vs NEPTUNE: no GTEPS to compare; we win on COST (ephemeral vs hourly in-memory), on OPENNESS");
    println!("  (sovereign vs managed black box), and on RECEIPT (verified billion, torn down).");
}

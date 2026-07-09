//! hg_analytics — deterministic graph analytics over hg_core ids, designed to ride the kernel's TxnId/journal for
//! incremental (warm-start) recompute. The Rust home for the refresh framework's heavy kernels (Phase R1).
//!
//! Starts with PageRank (cold + warm-start); Louvain + betweenness follow. Determinism is a hard invariant
//! (same input → same output, every run) — it's a product property, so the algorithms avoid RNG and use a fixed
//! iteration order. Parameters match the TS reference (`agent-machine/lib/graph-analytics.ts`, damping 0.85) so the
//! two engines reconcile while both exist; once the edge binds to this kernel, only this determinism matters.

use hg_core::AtomId;
use rayon::prelude::*;
use std::collections::HashMap;

/// Cold PageRank over a 0..n indexed graph. Dangling nodes (no out-edges) redistribute their mass uniformly.
pub fn pagerank(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    max_iters: usize,
    tol: f64,
) -> Vec<f64> {
    pagerank_from(
        n,
        edges,
        damping,
        max_iters,
        tol,
        &vec![1.0 / n.max(1) as f64; n],
    )
}

/// Warm-start PageRank: begin from `prior` instead of 1/n. After a small graph delta this converges in a handful
/// of iterations to the SAME fixed point as a cold run (proven in tests) — the incremental hook for the refresh
/// framework. If `prior.len() != n` (the graph grew/shrank), fall back to the uniform baseline for the new size.
pub fn pagerank_warm(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    max_iters: usize,
    tol: f64,
    prior: &[f64],
) -> Vec<f64> {
    let seed = if prior.len() == n {
        prior.to_vec()
    } else {
        vec![1.0 / n.max(1) as f64; n]
    };
    pagerank_from(n, edges, damping, max_iters, tol, &seed)
}

fn pagerank_from(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    max_iters: usize,
    tol: f64,
    seed: &[f64],
) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let mut out_deg = vec![0usize; n];
    let mut out_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        if u < n && v < n {
            out_adj[u].push(v);
            out_deg[u] += 1;
        }
    }
    let base = (1.0 - damping) / n as f64;
    let mut rank = seed.to_vec();
    for _ in 0..max_iters {
        let mut next = vec![base; n];
        let mut dangling = 0.0;
        for u in 0..n {
            if out_deg[u] == 0 {
                dangling += rank[u];
                continue;
            }
            let share = damping * rank[u] / out_deg[u] as f64;
            for &v in &out_adj[u] {
                next[v] += share;
            }
        }
        let dshare = damping * dangling / n as f64;
        if dshare != 0.0 {
            for x in next.iter_mut() {
                *x += dshare;
            }
        }
        let diff: f64 = (0..n).map(|i| (next[i] - rank[i]).abs()).sum();
        rank = next;
        if diff < tol {
            break;
        }
    }
    rank
}

/// Parallel (rayon) PageRank — the multi-core scale-out of `pagerank`. Pull-based: each node's next
/// rank is computed independently from its IN-neighbours, so the O(E) work parallelises with no write
/// contention. The O(n) dangling + convergence reductions stay serial, which keeps the result
/// deterministic (same output every run) AND identical to the serial `pagerank` fixed point. This is
/// the leg that turns "Rust is faster" from a claim into a number: linear-ish speedup in cores.
pub fn pagerank_parallel(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    max_iters: usize,
    tol: f64,
) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let mut out_deg = vec![0usize; n];
    let mut in_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        if u < n && v < n {
            out_deg[u] += 1;
            in_adj[v].push(u);
        }
    }
    let base = (1.0 - damping) / n as f64;
    let mut rank = vec![1.0 / n as f64; n];
    for _ in 0..max_iters {
        // Dangling mass + share: serial O(n), deterministic.
        let mut dangling = 0.0;
        for u in 0..n {
            if out_deg[u] == 0 {
                dangling += rank[u];
            }
        }
        let add = base + damping * dangling / n as f64;
        // Parallel pull over the O(E) work: next[v] = add + damping·Σ_{u→v} rank[u]/out_deg[u].
        let next: Vec<f64> = (0..n)
            .into_par_iter()
            .map(|v| {
                let mut acc = 0.0;
                for &u in &in_adj[v] {
                    acc += rank[u] / out_deg[u] as f64; // out_deg[u] ≥ 1 (u has edge u→v)
                }
                add + damping * acc
            })
            .collect();
        let diff: f64 = (0..n).map(|i| (next[i] - rank[i]).abs()).sum();
        rank = next;
        if diff < tol {
            break;
        }
    }
    rank
}

/// AtomId-facing wrapper: map ids → dense indices (sorted for determinism), run PageRank, return id → score.
pub fn pagerank_by_id(
    node_ids: &[AtomId],
    edges: &[(AtomId, AtomId)],
    damping: f64,
    max_iters: usize,
    tol: f64,
) -> HashMap<AtomId, f64> {
    let mut ids: Vec<AtomId> = node_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let idx: HashMap<AtomId, usize> = ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let e: Vec<(usize, usize)> = edges
        .iter()
        .filter_map(|&(u, v)| Some((*idx.get(&u)?, *idx.get(&v)?)))
        .collect();
    let pr = pagerank(ids.len(), &e, damping, max_iters, tol);
    ids.iter().enumerate().map(|(i, &id)| (id, pr[i])).collect()
}

// ── Betweenness centrality (Brandes, unweighted, undirected) ─────────────────────────────────────────────────
/// Exact Brandes betweenness over an undirected graph. Deterministic (BFS in index order). Each shortest-path pair
/// is counted once (undirected → halved). Identifies "bridge" nodes — the structural connectors.
pub fn betweenness(n: usize, edges: &[(usize, usize)]) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        if u < n && v < n && u != v {
            adj[u].push(v);
            adj[v].push(u);
        }
    }
    let mut bc = vec![0.0f64; n];
    for s in 0..n {
        let mut stack: Vec<usize> = Vec::new();
        let mut preds: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut sigma = vec![0.0f64; n];
        let mut dist = vec![-1i64; n];
        sigma[s] = 1.0;
        dist[s] = 0;
        let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
        queue.push_back(s);
        while let Some(v) = queue.pop_front() {
            stack.push(v);
            for &w in &adj[v] {
                if dist[w] < 0 {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
                if dist[w] == dist[v] + 1 {
                    sigma[w] += sigma[v];
                    preds[w].push(v);
                }
            }
        }
        let mut delta = vec![0.0f64; n];
        while let Some(w) = stack.pop() {
            for &v in &preds[w] {
                delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w]);
            }
            if w != s {
                bc[w] += delta[w];
            }
        }
    }
    for x in bc.iter_mut() {
        *x /= 2.0; // undirected: each pair counted from both endpoints
    }
    bc
}

/// Single-source Brandes accumulation into `bc` (shared helper for serial + parallel betweenness).
fn brandes_source(s: usize, adj: &[Vec<usize>], n: usize, bc: &mut [f64]) {
    let mut stack: Vec<usize> = Vec::new();
    let mut preds: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut sigma = vec![0.0f64; n];
    let mut dist = vec![-1i64; n];
    sigma[s] = 1.0;
    dist[s] = 0;
    let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    queue.push_back(s);
    while let Some(v) = queue.pop_front() {
        stack.push(v);
        for &w in &adj[v] {
            if dist[w] < 0 {
                dist[w] = dist[v] + 1;
                queue.push_back(w);
            }
            if dist[w] == dist[v] + 1 {
                sigma[w] += sigma[v];
                preds[w].push(v);
            }
        }
    }
    let mut delta = vec![0.0f64; n];
    while let Some(w) = stack.pop() {
        for &v in &preds[w] {
            delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w]);
        }
        if w != s {
            bc[w] += delta[w];
        }
    }
}

/// Parallel (rayon) Brandes betweenness — the source loop is embarrassingly parallel and
/// COMPUTE-bound (each BFS is real work, not a memory gather), so this scales near-linearly in
/// cores. Determinism is preserved: sources are split into fixed contiguous chunks, each chunk
/// accumulates a partial vector, and the partials are summed back IN CHUNK ORDER (independent of
/// thread scheduling) → same output every run. This is the leg that actually buries them on
/// "we scale with cores".
pub fn betweenness_parallel(n: usize, edges: &[(usize, usize)]) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        if u < n && v < n && u != v {
            adj[u].push(v);
            adj[v].push(u);
        }
    }
    // FIXED chunk count (independent of thread count) so the deterministic in-order sum of partials
    // yields the SAME result on any core count — determinism must not depend on the machine. rayon
    // load-balances the fixed chunks across whatever threads are available.
    let chunks = 64usize.min(n).max(1);
    let chunk_size = n.div_ceil(chunks);
    // Each chunk → a partial bc vector; collect() preserves chunk order for a deterministic sum.
    let partials: Vec<Vec<f64>> = (0..chunks)
        .into_par_iter()
        .map(|c| {
            let mut local = vec![0.0f64; n];
            let start = c * chunk_size;
            let end = ((c + 1) * chunk_size).min(n);
            for s in start..end {
                brandes_source(s, &adj, n, &mut local);
            }
            local
        })
        .collect();
    let mut bc = vec![0.0f64; n];
    for p in &partials {
        for i in 0..n {
            bc[i] += p[i];
        }
    }
    for x in bc.iter_mut() {
        *x /= 2.0;
    }
    bc
}

// ── Distributed (partition-parallel, BSP) PageRank ────────────────────────────────────────────────────────────
/// A graph partition owned by ONE federation participant: the node range `[lo, hi)` it owns, plus the
/// in-edges TO those owned nodes (edge sources may be remote — read from the exchanged halo). This is
/// the unit of sharding — a sovereign Autobase log IS one of these. Edges never leave their shard.
pub struct Shard {
    pub lo: usize,
    pub hi: usize,
    /// Per owned node (local index `v - lo`) → global source ids of its in-edges.
    pub in_adj: Vec<Vec<usize>>,
}

/// Range-partition a global edge list into `k` shards (each owns a contiguous node range). Returns the
/// shards + the global out-degree vector (small O(n) metadata replicated to every participant).
pub fn partition_edges(n: usize, edges: &[(usize, usize)], k: usize) -> (Vec<Shard>, Vec<u32>) {
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    let k = k.clamp(1, n);
    let size = n.div_ceil(k);
    let mut out_deg = vec![0u32; n];
    let mut shards: Vec<Shard> = (0..k)
        .map(|c| {
            let lo = c * size;
            let hi = ((c + 1) * size).min(n);
            Shard {
                lo,
                hi,
                in_adj: vec![Vec::new(); hi - lo],
            }
        })
        .collect();
    for &(u, v) in edges {
        if u < n && v < n {
            out_deg[u] += 1;
            let sh = &mut shards[v / size]; // shard owning v
            let li = v - sh.lo;
            sh.in_adj[li].push(u);
        }
    }
    (shards, out_deg)
}

/// Distributed PageRank over sharded partitions (Pregel/BSP model). Each superstep: every shard
/// computes its OWNED nodes' ranks locally IN PARALLEL from a globally-exchanged rank halo (the only
/// thing that crosses shard boundaries — O(n) per superstep, not the O(E) edges), then the owned
/// ranges are gathered into the next global vector. Matches single-graph `pagerank` exactly.
///
/// This is the move the centralized incumbents can't make: the data (edges) stays sovereign per
/// participant; only ranks are exchanged. Deterministic (disjoint owned ranges, fixed source order).
pub fn distributed_pagerank(
    n: usize,
    shards: &[Shard],
    out_deg: &[u32],
    damping: f64,
    max_iters: usize,
    tol: f64,
) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let base = (1.0 - damping) / n as f64;
    let mut rank = vec![1.0 / n as f64; n]; // the exchanged halo (post-gather global state)
    for _ in 0..max_iters {
        let mut dangling = 0.0;
        for u in 0..n {
            if out_deg[u] == 0 {
                dangling += rank[u];
            }
        }
        let add = base + damping * dangling / n as f64;
        // SCATTER: each shard computes its owned partial locally, in parallel (rayon = participants).
        let partials: Vec<(usize, Vec<f64>)> = shards
            .par_iter()
            .map(|sh| {
                let mut local = vec![0.0f64; sh.hi - sh.lo];
                for (i, srcs) in sh.in_adj.iter().enumerate() {
                    let mut acc = 0.0;
                    for &u in srcs {
                        acc += rank[u] / out_deg[u] as f64; // remote source rank ← the halo
                    }
                    local[i] = add + damping * acc;
                }
                (sh.lo, local)
            })
            .collect();
        // GATHER: stitch disjoint owned ranges into the next global vector.
        let mut next = vec![0.0f64; n];
        for (lo, local) in &partials {
            next[*lo..*lo + local.len()].copy_from_slice(local);
        }
        let diff: f64 = (0..n).map(|i| (next[i] - rank[i]).abs()).sum();
        rank = next;
        if diff < tol {
            break;
        }
    }
    rank
}

// ── Louvain community detection (full: local-moving + aggregation, deterministic) ─────────────────────────────
/// Modularity-optimizing community detection. Deterministic (nodes visited in index order, ties broken by lowest
/// community id). Unweighted, undirected, resolution 1.0. Returns a flat community id per original node.
pub fn louvain(n: usize, edges: &[(usize, usize)]) -> Vec<usize> {
    if n == 0 {
        return Vec::new();
    }
    // Build a weighted undirected super-graph as adjacency maps; start with the input graph (weight 1 per edge).
    let mut adj: Vec<HashMap<usize, f64>> = vec![HashMap::new(); n];
    let mut self_loop = vec![0.0f64; n];
    for &(u, v) in edges {
        if u >= n || v >= n {
            continue;
        }
        if u == v {
            self_loop[u] += 2.0;
        } else {
            *adj[u].entry(v).or_insert(0.0) += 1.0;
            *adj[v].entry(u).or_insert(0.0) += 1.0;
        }
    }
    // partition[orig] tracks each original node's current top-level community as we coarsen.
    let mut partition: Vec<usize> = (0..n).collect();
    loop {
        let (comm, moved) = local_moving(&adj, &self_loop);
        // relabel comm to dense 0..k
        let mut remap: HashMap<usize, usize> = HashMap::new();
        for &c in &comm {
            let next = remap.len();
            remap.entry(c).or_insert(next);
        }
        let dense: Vec<usize> = comm.iter().map(|c| remap[c]).collect();
        // push down to original nodes
        for p in partition.iter_mut() {
            *p = dense[*p];
        }
        if !moved || remap.len() == adj.len() {
            break; // converged: no node moved, or every node is its own community
        }
        // aggregate into the super-graph for the next level
        let k = remap.len();
        let mut nadj: Vec<HashMap<usize, f64>> = vec![HashMap::new(); k];
        let mut nself = vec![0.0f64; k];
        for u in 0..adj.len() {
            let cu = dense[u];
            nself[cu] += self_loop[u];
            for (&v, &w) in &adj[u] {
                let cv = dense[v];
                if cu == cv {
                    nself[cu] += w; // each intra edge seen twice across u,v → sums to 2*w (matches self_loop convention)
                } else {
                    *nadj[cu].entry(cv).or_insert(0.0) += w;
                }
            }
        }
        adj = nadj;
        self_loop = nself;
    }
    // relabel final partition to dense ids
    let mut remap: HashMap<usize, usize> = HashMap::new();
    partition
        .iter()
        .map(|&c| {
            let next = remap.len();
            *remap.entry(c).or_insert(next)
        })
        .collect()
}

/// One level of Louvain local-moving. Returns (community per node, whether any node moved).
fn local_moving(adj: &[HashMap<usize, f64>], self_loop: &[f64]) -> (Vec<usize>, bool) {
    let n = adj.len();
    let deg: Vec<f64> = (0..n)
        .map(|i| adj[i].values().sum::<f64>() + self_loop[i])
        .collect();
    let m2: f64 = deg.iter().sum::<f64>(); // 2m
    if m2 == 0.0 {
        return ((0..n).collect(), false);
    }
    let mut comm: Vec<usize> = (0..n).collect();
    let mut tot: Vec<f64> = deg.clone(); // sum of degrees in each community
    let mut any_moved = false;
    let mut improved = true;
    while improved {
        improved = false;
        for i in 0..n {
            let ci = comm[i];
            // weight from i to each neighbor community
            let mut to_comm: HashMap<usize, f64> = HashMap::new();
            for (&j, &w) in &adj[i] {
                *to_comm.entry(comm[j]).or_insert(0.0) += w;
            }
            // remove i from its community
            tot[ci] -= deg[i];
            // best gain (staying-removed baseline is community ci with its own to_comm weight)
            let mut best_c = ci;
            let mut best_gain = to_comm.get(&ci).copied().unwrap_or(0.0) - tot[ci] * deg[i] / m2;
            for (&c, &k_i_in) in &to_comm {
                let gain = k_i_in - tot[c] * deg[i] / m2;
                if gain > best_gain || (gain == best_gain && c < best_c) {
                    best_gain = gain;
                    best_c = c;
                }
            }
            tot[best_c] += deg[i];
            if best_c != ci {
                comm[i] = best_c;
                improved = true;
                any_moved = true;
            }
        }
    }
    (comm, any_moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    const D: f64 = 0.85;
    const IT: usize = 200;
    const TOL: f64 = 1e-12;

    #[test]
    fn parallel_pagerank_matches_serial_and_is_deterministic() {
        let edges = vec![(0, 1), (1, 2), (2, 0), (2, 3), (3, 1), (0, 3)];
        let a = pagerank(4, &edges, D, IT, TOL);
        let b = pagerank_parallel(4, &edges, D, IT, TOL);
        for i in 0..4 {
            assert!(
                (a[i] - b[i]).abs() < 1e-9,
                "parallel PR must match serial fixed point"
            );
        }
        assert_eq!(
            b,
            pagerank_parallel(4, &edges, D, IT, TOL),
            "deterministic run-to-run"
        );
    }

    #[test]
    fn parallel_betweenness_matches_serial_and_is_deterministic() {
        let edges = vec![(0, 1), (1, 2), (2, 3), (3, 4), (1, 3), (0, 4)];
        let a = betweenness(5, &edges);
        let b = betweenness_parallel(5, &edges);
        for i in 0..5 {
            assert!(
                (a[i] - b[i]).abs() < 1e-9,
                "parallel betweenness must match serial"
            );
        }
        assert_eq!(
            b,
            betweenness_parallel(5, &edges),
            "deterministic run-to-run"
        );
    }

    #[test]
    fn distributed_pagerank_matches_single_graph_at_any_shard_count() {
        let edges = vec![
            (0, 1),
            (1, 2),
            (2, 0),
            (2, 3),
            (3, 1),
            (0, 3),
            (3, 4),
            (4, 2),
        ];
        let n = 5;
        let single = pagerank(n, &edges, D, IT, TOL);
        for k in [1usize, 2, 3, 5] {
            let (shards, out_deg) = partition_edges(n, &edges, k);
            let dist = distributed_pagerank(n, &shards, &out_deg, D, IT, TOL);
            for i in 0..n {
                assert!(
                    (single[i] - dist[i]).abs() < 1e-9,
                    "sharded (k={k}) must equal single-graph at node {i}"
                );
            }
        }
        let (s, o) = partition_edges(n, &edges, 3);
        assert_eq!(
            distributed_pagerank(n, &s, &o, D, IT, TOL),
            distributed_pagerank(n, &s, &o, D, IT, TOL),
            "deterministic run-to-run"
        );
    }

    #[test]
    fn symmetric_cycle_is_uniform() {
        // 0->1->2->0: by symmetry every node has rank 1/3.
        let pr = pagerank(3, &[(0, 1), (1, 2), (2, 0)], D, IT, TOL);
        for x in &pr {
            assert!((x - 1.0 / 3.0).abs() < 1e-6, "got {x}");
        }
        assert!(
            (pr.iter().sum::<f64>() - 1.0).abs() < 1e-6,
            "mass conserved"
        );
    }

    #[test]
    fn deterministic_same_input_same_output() {
        let g = [(0, 1), (0, 2), (1, 2), (2, 0), (3, 2)];
        assert_eq!(
            pagerank(4, &g, D, IT, TOL),
            pagerank(4, &g, D, IT, TOL),
            "bit-identical across runs"
        );
    }

    #[test]
    fn warm_start_lands_on_the_same_fixed_point() {
        // The incremental-recompute guarantee: warm-starting from any prior converges to the SAME fixed point as a
        // cold run. (1) warm from the cold result reproduces it; (2) warm from a perturbed prior converges to cold.
        let g = [(0, 1), (0, 2), (1, 2), (2, 0), (3, 0), (3, 2)];
        let cold = pagerank(4, &g, D, IT, TOL);
        let warm_from_cold = pagerank_warm(4, &g, D, IT, TOL, &cold);
        for i in 0..4 {
            assert!(
                (cold[i] - warm_from_cold[i]).abs() < 1e-9,
                "warm-from-converged must equal converged"
            );
        }
        let perturbed = vec![0.9, 0.03, 0.04, 0.03];
        let warm = pagerank_warm(4, &g, D, IT, TOL, &perturbed);
        for i in 0..4 {
            assert!(
                (cold[i] - warm[i]).abs() < 1e-6,
                "warm converges to cold at {i}: {} vs {}",
                cold[i],
                warm[i]
            );
        }
    }

    #[test]
    fn dangling_node_conserves_mass() {
        let pr = pagerank(3, &[(0, 1), (1, 2)], D, IT, TOL); // node 2 has no out-edges
        assert!(
            (pr.iter().sum::<f64>() - 1.0).abs() < 1e-6,
            "mass conserved with dangling: {}",
            pr.iter().sum::<f64>()
        );
    }

    #[test]
    fn by_id_maps_back_to_atom_ids() {
        let ids: Vec<AtomId> = vec![100, 200, 300];
        let pr = pagerank_by_id(&ids, &[(100, 200), (200, 300), (300, 100)], D, IT, TOL);
        assert_eq!(pr.len(), 3);
        for id in &ids {
            assert!((pr[id] - 1.0 / 3.0).abs() < 1e-6);
        }
    }

    #[test]
    fn betweenness_path_graph_golden() {
        // path 0-1-2-3-4: exact betweenness is [0, 3, 4, 3, 0] (center is the strongest bridge, endpoints 0).
        let bc = betweenness(5, &[(0, 1), (1, 2), (2, 3), (3, 4)]);
        let expect = [0.0, 3.0, 4.0, 3.0, 0.0];
        for i in 0..5 {
            assert!(
                (bc[i] - expect[i]).abs() < 1e-9,
                "bc[{i}]={} expected {}",
                bc[i],
                expect[i]
            );
        }
    }

    #[test]
    fn betweenness_star_center_is_the_bridge() {
        // star: center 0 connected to 1,2,3 → center on all 3 leaf-pairs, leaves 0.
        let bc = betweenness(4, &[(0, 1), (0, 2), (0, 3)]);
        assert!((bc[0] - 3.0).abs() < 1e-9, "center {}", bc[0]);
        for (i, &leaf) in bc.iter().enumerate().skip(1) {
            assert!(leaf.abs() < 1e-9, "leaf {i} = {leaf}");
        }
    }

    #[test]
    fn louvain_finds_two_triangles() {
        // two triangles {0,1,2} {3,4,5} joined by a single bridge edge 2-3 → exactly two communities.
        let g = [(0, 1), (1, 2), (0, 2), (3, 4), (4, 5), (3, 5), (2, 3)];
        let c = louvain(6, &g);
        let ncomm = c
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>()
            .len();
        assert_eq!(ncomm, 2, "two communities, got {ncomm}: {c:?}");
        assert!(
            c[0] == c[1] && c[1] == c[2],
            "first triangle together: {c:?}"
        );
        assert!(
            c[3] == c[4] && c[4] == c[5],
            "second triangle together: {c:?}"
        );
        assert_ne!(c[0], c[3], "the two triangles are distinct communities");
    }

    #[test]
    fn louvain_single_clique_is_one_community() {
        let c = louvain(3, &[(0, 1), (1, 2), (0, 2)]);
        assert!(
            c[0] == c[1] && c[1] == c[2],
            "clique is one community: {c:?}"
        );
    }

    #[test]
    fn louvain_isolated_nodes_are_separate() {
        let c = louvain(3, &[]);
        assert_eq!(
            c.iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3,
            "{c:?}"
        );
    }
}

//! hg_analytics — deterministic graph analytics over hg_core ids, designed to ride the kernel's TxnId/journal for
//! incremental (warm-start) recompute. The Rust home for the refresh framework's heavy kernels (Phase R1).
//!
//! Starts with PageRank (cold + warm-start); Louvain + betweenness follow. Determinism is a hard invariant
//! (same input → same output, every run) — it's a product property, so the algorithms avoid RNG and use a fixed
//! iteration order. Parameters match the TS reference (`agent-machine/lib/graph-analytics.ts`, damping 0.85) so the
//! two engines reconcile while both exist; once the edge binds to this kernel, only this determinism matters.

use hg_core::AtomId;
use std::collections::HashMap;

/// Cold PageRank over a 0..n indexed graph. Dangling nodes (no out-edges) redistribute their mass uniformly.
pub fn pagerank(n: usize, edges: &[(usize, usize)], damping: f64, max_iters: usize, tol: f64) -> Vec<f64> {
    pagerank_from(n, edges, damping, max_iters, tol, &vec![1.0 / n.max(1) as f64; n])
}

/// Warm-start PageRank: begin from `prior` instead of 1/n. After a small graph delta this converges in a handful
/// of iterations to the SAME fixed point as a cold run (proven in tests) — the incremental hook for the refresh
/// framework. If `prior.len() != n` (the graph grew/shrank), fall back to the uniform baseline for the new size.
pub fn pagerank_warm(n: usize, edges: &[(usize, usize)], damping: f64, max_iters: usize, tol: f64, prior: &[f64]) -> Vec<f64> {
    let seed = if prior.len() == n { prior.to_vec() } else { vec![1.0 / n.max(1) as f64; n] };
    pagerank_from(n, edges, damping, max_iters, tol, &seed)
}

fn pagerank_from(n: usize, edges: &[(usize, usize)], damping: f64, max_iters: usize, tol: f64, seed: &[f64]) -> Vec<f64> {
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

#[cfg(test)]
mod tests {
    use super::*;
    const D: f64 = 0.85;
    const IT: usize = 200;
    const TOL: f64 = 1e-12;

    #[test]
    fn symmetric_cycle_is_uniform() {
        // 0->1->2->0: by symmetry every node has rank 1/3.
        let pr = pagerank(3, &[(0, 1), (1, 2), (2, 0)], D, IT, TOL);
        for x in &pr {
            assert!((x - 1.0 / 3.0).abs() < 1e-6, "got {x}");
        }
        assert!((pr.iter().sum::<f64>() - 1.0).abs() < 1e-6, "mass conserved");
    }

    #[test]
    fn deterministic_same_input_same_output() {
        let g = [(0, 1), (0, 2), (1, 2), (2, 0), (3, 2)];
        assert_eq!(pagerank(4, &g, D, IT, TOL), pagerank(4, &g, D, IT, TOL), "bit-identical across runs");
    }

    #[test]
    fn warm_start_lands_on_the_same_fixed_point() {
        // The incremental-recompute guarantee: warm-starting from any prior converges to the SAME fixed point as a
        // cold run. (1) warm from the cold result reproduces it; (2) warm from a perturbed prior converges to cold.
        let g = [(0, 1), (0, 2), (1, 2), (2, 0), (3, 0), (3, 2)];
        let cold = pagerank(4, &g, D, IT, TOL);
        let warm_from_cold = pagerank_warm(4, &g, D, IT, TOL, &cold);
        for i in 0..4 {
            assert!((cold[i] - warm_from_cold[i]).abs() < 1e-9, "warm-from-converged must equal converged");
        }
        let perturbed = vec![0.9, 0.03, 0.04, 0.03];
        let warm = pagerank_warm(4, &g, D, IT, TOL, &perturbed);
        for i in 0..4 {
            assert!((cold[i] - warm[i]).abs() < 1e-6, "warm converges to cold at {i}: {} vs {}", cold[i], warm[i]);
        }
    }

    #[test]
    fn dangling_node_conserves_mass() {
        let pr = pagerank(3, &[(0, 1), (1, 2)], D, IT, TOL); // node 2 has no out-edges
        assert!((pr.iter().sum::<f64>() - 1.0).abs() < 1e-6, "mass conserved with dangling: {}", pr.iter().sum::<f64>());
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
}

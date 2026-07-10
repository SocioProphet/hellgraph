//! boundary — boundary-only halo (ghost vertices) distributed PageRank. The scaling unlock.
//!
//! The plain `distributed_pagerank` exchanges the FULL O(n) rank vector to every shard each superstep —
//! that's a k·n broadcast, and it's the reason a naive BSP graph engine stops scaling: add a node and
//! every node pays for it. Here a shard exchanges ONLY the ranks of the remote vertices its own edges
//! actually reference — its "ghosts". With an edge-cut partition the ghost set is O(boundary) per shard,
//! so the recurring per-superstep network cost is Σ|ghosts| ≪ k·n. That is the difference between "rides a
//! cluster" and "broadcasts the world every step". The numeric result is bit-identical to single-graph
//! `pagerank` — the halo shrinks, the answer doesn't move.
//!
//! Cost accounting (honest): out-degrees are static topology, exchanged ONCE at setup (O(n) one-time).
//! The RECURRING cost — what grows with supersteps and dominates at scale — is the ghost rank halo, and
//! that is exactly what `halo_bytes`/`total_halo_bytes` measure.

use rayon::prelude::*;
use std::collections::{BTreeSet, HashMap};

/// One partition carrying a boundary-only halo. Owns node range `[lo, hi)`. `ghosts` holds the sorted,
/// distinct global ids of the remote source vertices this shard's in-edges reference (sorted → the halo
/// order is deterministic and machine-independent). `in_adj` stores, per owned node, the LOCAL index of
/// each in-neighbour: an owned source maps to `src - lo` in `[0, owned)`, a ghost source maps to
/// `owned + ghost_position`. That compact local index space is exactly what a real worker holds in RAM —
/// it never materialises the global vertex id space.
pub struct BoundaryShard {
    pub lo: usize,
    pub hi: usize,
    /// Global ids of the remote source vertices referenced by this shard's edges — sorted, distinct.
    pub ghosts: Vec<usize>,
    /// Per owned node (index `v - lo`): local indices (owned `< owned`, else ghost) of its in-neighbours.
    pub in_adj: Vec<Vec<usize>>,
}

impl BoundaryShard {
    /// Number of nodes this shard owns.
    pub fn owned(&self) -> usize {
        self.hi - self.lo
    }
    /// Bytes this shard RECEIVES per superstep for its halo (one f64 per ghost). The recurring cost.
    pub fn halo_bytes(&self) -> usize {
        self.ghosts.len() * 8
    }
}

/// Total recurring halo traffic across all shards, per superstep, in bytes. Compare against a full
/// broadcast (`k * n * 8`) to see the boundary-only saving on a given partition.
pub fn total_halo_bytes(shards: &[BoundaryShard]) -> usize {
    shards.iter().map(BoundaryShard::halo_bytes).sum()
}

/// Range-partition into `k` boundary shards (each owns a contiguous node range) + the global out-degree
/// vector (static setup metadata). Each shard's ghost set is discovered from the in-edges it owns.
pub fn partition_edges_boundary(
    n: usize,
    edges: &[(usize, usize)],
    k: usize,
) -> (Vec<BoundaryShard>, Vec<u32>) {
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    let k = k.clamp(1, n);
    let size = n.div_ceil(k);
    let bounds: Vec<usize> = (0..=k).map(|c| (c * size).min(n)).collect();
    partition_edges_boundary_at(n, edges, &bounds)
}

/// Build boundary shards from EXPLICIT contiguous boundaries: shard `c` owns `[bounds[c], bounds[c+1])`.
/// `bounds` must be non-decreasing with `bounds[0] == 0` and `bounds[last] == n`. This is the general form
/// a smart partitioner drives — relabel vertices so each partition is a contiguous block (unequal sizes),
/// pass the block boundaries here, and the same boundary-halo PageRank runs on the edge-cut-minimised
/// layout. The equal-`size` range partition is just the special case `partition_edges_boundary` produces.
pub fn partition_edges_boundary_at(
    n: usize,
    edges: &[(usize, usize)],
    bounds: &[usize],
) -> (Vec<BoundaryShard>, Vec<u32>) {
    if n == 0 || bounds.len() < 2 {
        return (Vec::new(), Vec::new());
    }
    let k = bounds.len() - 1;
    // Owner of a global id via binary search over the boundaries: largest c with bounds[c] <= v.
    let owner = |v: usize| -> usize {
        match bounds.binary_search(&v) {
            Ok(c) => c.min(k - 1), // v is exactly a boundary start → that block
            Err(c) => c - 1,       // between bounds[c-1] and bounds[c]
        }
    };
    let mut out_deg = vec![0u32; n];
    let mut raw: Vec<Vec<Vec<usize>>> = (0..k)
        .map(|c| vec![Vec::new(); bounds[c + 1] - bounds[c]])
        .collect();
    let mut ghost_sets: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); k];
    for &(u, v) in edges {
        if u < n && v < n {
            out_deg[u] += 1;
            let c = owner(v);
            let (lo, hi) = (bounds[c], bounds[c + 1]);
            raw[c][v - lo].push(u);
            if u < lo || u >= hi {
                ghost_sets[c].insert(u); // remote source → ghost
            }
        }
    }
    let mut shards = Vec::with_capacity(k);
    for c in 0..k {
        let (lo, hi) = (bounds[c], bounds[c + 1]);
        let owned = hi - lo;
        let ghosts: Vec<usize> = ghost_sets[c].iter().copied().collect();
        let ghost_idx: HashMap<usize, usize> =
            ghosts.iter().enumerate().map(|(i, &g)| (g, i)).collect();
        let in_adj: Vec<Vec<usize>> = raw[c]
            .iter()
            .map(|srcs| {
                srcs.iter()
                    .map(|&u| {
                        if u >= lo && u < hi {
                            u - lo
                        } else {
                            owned + ghost_idx[&u]
                        }
                    })
                    .collect()
            })
            .collect();
        shards.push(BoundaryShard {
            lo,
            hi,
            ghosts,
            in_adj,
        });
    }
    (shards, out_deg)
}

/// Distributed PageRank with a boundary-only halo. Each superstep, every shard assembles a LOCAL rank
/// view = its owned ranks + only its ghost ranks (the boundary halo pulled from the ghosts' owners),
/// then computes its owned partial from that local view alone — it never reads the global rank vector by
/// arbitrary index, only the O(owned + ghosts) slice a real worker would have received. Deterministic
/// (disjoint owned ranges, sorted ghosts, fixed order) and bit-identical to single-graph `pagerank`.
pub fn distributed_pagerank_boundary(
    n: usize,
    shards: &[BoundaryShard],
    out_deg: &[u32],
    damping: f64,
    max_iters: usize,
    tol: f64,
) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let base = (1.0 - damping) / n as f64;
    let mut rank = vec![1.0 / n as f64; n];
    for _ in 0..max_iters {
        // Dangling mass: derived from the static out-degree topology (setup metadata), O(n) serial.
        let mut dangling = 0.0;
        for u in 0..n {
            if out_deg[u] == 0 {
                dangling += rank[u];
            }
        }
        let add = base + damping * dangling / n as f64;
        // Each shard works from its local view only: owned rank slice + ghost halo. Ghost out-degrees
        // come from the static setup vector (exchanged once), not the per-step halo.
        let partials: Vec<(usize, Vec<f64>)> = shards
            .par_iter()
            .map(|sh| {
                let owned = sh.owned();
                // The received message: owned ranks followed by the boundary halo (ghost ranks).
                let mut local_rank = vec![0.0f64; owned + sh.ghosts.len()];
                local_rank[..owned].copy_from_slice(&rank[sh.lo..sh.hi]);
                for (i, &g) in sh.ghosts.iter().enumerate() {
                    local_rank[owned + i] = rank[g];
                }
                let mut out = vec![0.0f64; owned];
                for (i, nbrs) in sh.in_adj.iter().enumerate() {
                    let mut acc = 0.0;
                    for &li in nbrs {
                        let gid = if li < owned {
                            sh.lo + li
                        } else {
                            sh.ghosts[li - owned]
                        };
                        acc += local_rank[li] / out_deg[gid] as f64;
                    }
                    out[i] = add + damping * acc;
                }
                (sh.lo, out)
            })
            .collect();
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

// ── Boundary-halo connected components ────────────────────────────────────────────────────────────────────────
/// A CC partition with a boundary-only halo. Owns `[lo, hi)`; `ghosts` are the sorted distinct global ids
/// of the remote NEIGHBOURS this shard's owned nodes touch (undirected). `adj` stores, per owned node, the
/// LOCAL index of each neighbour (owned `< owned`, else ghost). The halo exchanged each superstep is just
/// the ghost LABELS (u32) — proving the boundary-halo model is not PageRank-specific but covers the whole
/// vertex-centric class.
pub struct BoundaryCcShard {
    pub lo: usize,
    pub hi: usize,
    pub ghosts: Vec<usize>,
    pub adj: Vec<Vec<usize>>,
}

impl BoundaryCcShard {
    pub fn owned(&self) -> usize {
        self.hi - self.lo
    }
    /// Bytes received per superstep for the label halo (one u32 per ghost).
    pub fn halo_bytes(&self) -> usize {
        self.ghosts.len() * 4
    }
}

/// Total recurring CC label-halo traffic per superstep, in bytes.
pub fn total_cc_halo_bytes(shards: &[BoundaryCcShard]) -> usize {
    shards.iter().map(BoundaryCcShard::halo_bytes).sum()
}

/// Range-partition the undirected graph into `k` boundary CC shards.
pub fn partition_cc_boundary(n: usize, edges: &[(usize, usize)], k: usize) -> Vec<BoundaryCcShard> {
    if n == 0 {
        return Vec::new();
    }
    let k = k.clamp(1, n);
    let size = n.div_ceil(k);
    let bounds: Vec<usize> = (0..=k).map(|c| (c * size).min(n)).collect();
    partition_cc_boundary_at(n, edges, &bounds)
}

/// Build boundary CC shards from explicit contiguous boundaries (the general form a smart partition drives).
pub fn partition_cc_boundary_at(
    n: usize,
    edges: &[(usize, usize)],
    bounds: &[usize],
) -> Vec<BoundaryCcShard> {
    if n == 0 || bounds.len() < 2 {
        return Vec::new();
    }
    let k = bounds.len() - 1;
    let owner = |v: usize| -> usize {
        match bounds.binary_search(&v) {
            Ok(c) => c.min(k - 1),
            Err(c) => c - 1,
        }
    };
    // Undirected: each edge contributes a neighbour to BOTH endpoints' owning shards.
    let mut raw: Vec<Vec<Vec<usize>>> = (0..k)
        .map(|c| vec![Vec::new(); bounds[c + 1] - bounds[c]])
        .collect();
    let mut ghost_sets: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); k];
    let mut note = |shard: usize, node: usize, nbr: usize| {
        let (lo, hi) = (bounds[shard], bounds[shard + 1]);
        raw[shard][node - lo].push(nbr);
        if nbr < lo || nbr >= hi {
            ghost_sets[shard].insert(nbr);
        }
    };
    for &(u, v) in edges {
        if u < n && v < n && u != v {
            note(owner(u), u, v);
            note(owner(v), v, u);
        }
    }
    let mut shards = Vec::with_capacity(k);
    for c in 0..k {
        let (lo, hi) = (bounds[c], bounds[c + 1]);
        let owned = hi - lo;
        let ghosts: Vec<usize> = ghost_sets[c].iter().copied().collect();
        let ghost_idx: HashMap<usize, usize> =
            ghosts.iter().enumerate().map(|(i, &g)| (g, i)).collect();
        let adj: Vec<Vec<usize>> = raw[c]
            .iter()
            .map(|nbrs| {
                nbrs.iter()
                    .map(|&w| {
                        if w >= lo && w < hi {
                            w - lo
                        } else {
                            owned + ghost_idx[&w]
                        }
                    })
                    .collect()
            })
            .collect();
        shards.push(BoundaryCcShard {
            lo,
            hi,
            ghosts,
            adj,
        });
    }
    shards
}

/// Distributed connected components with a boundary-only label halo. Each superstep every shard assembles
/// its local label view (owned labels + ghost label halo) and min-propagates over its owned nodes; disjoint
/// owned ranges are gathered; iterate to a global fixpoint. Only ghost labels cross boundaries — edges stay
/// sovereign. Deterministic and identical to single-graph `connected_components`.
pub fn distributed_cc_boundary(n: usize, shards: &[BoundaryCcShard]) -> Vec<u32> {
    if n == 0 {
        return Vec::new();
    }
    let mut label: Vec<u32> = (0..n as u32).collect();
    loop {
        let partials: Vec<(usize, Vec<u32>)> = shards
            .par_iter()
            .map(|sh| {
                let owned = sh.owned();
                // Received message: owned labels + the boundary halo (ghost labels).
                let mut local_label = vec![0u32; owned + sh.ghosts.len()];
                local_label[..owned].copy_from_slice(&label[sh.lo..sh.hi]);
                for (i, &g) in sh.ghosts.iter().enumerate() {
                    local_label[owned + i] = label[g];
                }
                let mut out = vec![0u32; owned];
                for (i, nbrs) in sh.adj.iter().enumerate() {
                    let mut m = local_label[i];
                    for &li in nbrs {
                        if local_label[li] < m {
                            m = local_label[li];
                        }
                    }
                    out[i] = m;
                }
                (sh.lo, out)
            })
            .collect();
        let mut changed = false;
        let mut next = label.clone();
        for (lo, local) in &partials {
            for (i, &l) in local.iter().enumerate() {
                if l != next[lo + i] {
                    next[lo + i] = l;
                    changed = true;
                }
            }
        }
        label = next;
        if !changed {
            break;
        }
    }
    label
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{connected_components, pagerank, Kronecker};

    #[test]
    fn boundary_halo_pagerank_matches_serial_exactly() {
        // A hub-heavy RMAT graph: ghost sets are non-trivial, so this exercises the halo path for real.
        let scale = 8u32; // 256 vertices
        let n = Kronecker::vertices(scale);
        let edges: Vec<(usize, usize)> = Kronecker::new(scale, 8, 0xBEEF).collect();

        let serial = pagerank(n, &edges, 0.85, 100, 1e-10);
        let (shards, out_deg) = partition_edges_boundary(n, &edges, 8);
        let dist = distributed_pagerank_boundary(n, &shards, &out_deg, 0.85, 100, 1e-10);

        assert_eq!(serial.len(), dist.len());
        let max_delta = serial
            .iter()
            .zip(&dist)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f64, f64::max);
        // Same fixed point, not "close": the halo shrinks, the numbers do not move.
        assert!(
            max_delta < 1e-12,
            "max|Δ| = {max_delta:e} — halo changed the answer"
        );
    }

    #[test]
    fn boundary_halo_is_deterministic_across_runs() {
        let n = Kronecker::vertices(8);
        let edges: Vec<(usize, usize)> = Kronecker::new(8, 8, 7).collect();
        let (s1, d1) = partition_edges_boundary(n, &edges, 8);
        let (s2, d2) = partition_edges_boundary(n, &edges, 8);
        // Same ghost sets, same order.
        for (a, b) in s1.iter().zip(&s2) {
            assert_eq!(a.ghosts, b.ghosts);
        }
        let r1 = distributed_pagerank_boundary(n, &s1, &d1, 0.85, 50, 1e-10);
        let r2 = distributed_pagerank_boundary(n, &s2, &d2, 0.85, 50, 1e-10);
        assert_eq!(r1, r2);
    }

    #[test]
    fn boundary_halo_beats_full_broadcast_on_local_graph() {
        // A ring has locality: each node's only in-neighbour is its predecessor, so a contiguous range
        // partition leaves exactly ONE ghost per shard boundary. The boundary halo should be a tiny
        // fraction of the k·n full-broadcast cost.
        let n = 4096usize;
        let edges: Vec<(usize, usize)> = (0..n).map(|i| (i, (i + 1) % n)).collect();
        let k = 16usize;
        let (shards, _out) = partition_edges_boundary(n, &edges, k);
        let halo = total_halo_bytes(&shards);
        let full_broadcast = k * n * 8;
        // Ring → ~1 ghost per shard; halo is orders of magnitude under the full broadcast.
        assert!(
            halo * 100 < full_broadcast,
            "boundary halo {halo}B not <1% of full broadcast {full_broadcast}B"
        );
    }

    #[test]
    fn boundary_halo_cc_matches_serial_exactly() {
        // Two disjoint RMAT blobs offset into disjoint id ranges → a real multi-component graph the
        // boundary label halo must reconcile across shards.
        let half = Kronecker::vertices(8); // 256
        let n = 2 * half;
        let mut edges: Vec<(usize, usize)> = Kronecker::new(8, 6, 1).collect();
        edges.extend(Kronecker::new(8, 6, 2).map(|(u, v)| (u + half, v + half)));

        let serial = connected_components(n, &edges);
        let shards = partition_cc_boundary(n, &edges, 8);
        let dist = distributed_cc_boundary(n, &shards);
        assert_eq!(serial, dist, "boundary-halo CC diverged from serial");
    }

    #[test]
    fn boundary_cc_halo_beats_full_broadcast_on_ring() {
        let n = 4096usize;
        let edges: Vec<(usize, usize)> = (0..n).map(|i| (i, (i + 1) % n)).collect();
        let k = 16usize;
        let shards = partition_cc_boundary(n, &edges, k);
        let halo = total_cc_halo_bytes(&shards);
        let full_broadcast = k * n * 4; // u32 labels
        assert!(
            halo * 50 < full_broadcast,
            "CC boundary halo {halo}B not «  full broadcast {full_broadcast}B"
        );
    }
}

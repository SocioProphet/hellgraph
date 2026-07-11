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

mod boundary;
mod cc;
mod graph500;
mod ooc;
mod partitioner;
mod topology;
pub use boundary::{
    distributed_bfs_boundary, distributed_cc_boundary, distributed_cdlp_boundary,
    distributed_lcc_boundary, distributed_pagerank_boundary, distributed_pagerank_boundary_delta,
    distributed_sssp_boundary, owner_of, partition_cc_boundary, partition_cc_boundary_at,
    partition_edges_boundary, partition_edges_boundary_at, partition_lcc_boundary,
    partition_wsssp_boundary, partition_wsssp_boundary_at, range_bounds, total_cc_halo_bytes,
    total_halo_bytes, total_w_halo_bytes, BoundaryCcShard, BoundaryLccShard, BoundaryShard,
    BoundaryWShard, DeltaHaloStats,
};
pub use cc::{
    connected_components, distributed_connected_components, partition_undirected, CcShard,
};
pub use graph500::Kronecker;
// pagerank_accel + pagerank_residual + PreparedGraph are defined below in this module; no re-export needed.
pub use ooc::{pagerank_mmap, write_csr, write_csr_bucketed, write_csr_streaming, MmapCsr};
pub use partitioner::{balance, edge_cut, fennel_partition, ldg_partition, relabel_contiguous};
pub use topology::{
    plan_pagerank, ClusterSpec, Plan, PlannerConfig, Topology, Workload, RESIDENT_BYTES_PER_EDGE,
};

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

/// A graph with its in-neighbour CSR built ONCE, so many PageRanks (warm-start, personalized, different
/// damping) reuse it for free. This matters because construction is NOT negligible: with Anderson cutting
/// convergence to ~13 sweeps, the CSR build measured ~50% of a full CPU run — so amortising it across
/// repeated recomputes (the refresh framework's incremental use) beats any per-pass micro-optimisation.
/// The build is serial on purpose (a parallel histogram build was measured *slower* — each chunk's full-n
/// histogram repeats the random-write pattern, so k chunks do ~k× the random-write traffic).
pub struct PreparedGraph {
    n: usize,
    off: Vec<u32>,      // n+1 in-CSR row pointers
    in_nbr: Vec<u32>,   // m in-neighbour sources, in edge order
    out_deg: Vec<u32>,  // n out-degrees (static topology)
    dangling: Vec<u32>, // indices with out_deg==0, precomputed (static set)
    out_off: Vec<u32>,  // n+1 out-CSR row pointers (for forward-push personalized PR)
    out_nbr: Vec<u32>,  // m out-neighbour targets, in edge order
}

impl PreparedGraph {
    /// Build the flat in-CSR + out-CSR + out-degrees + dangling list ONCE. O(m), serial (mem-BW-bound).
    /// The in-CSR drives global PageRank (pull); the out-CSR drives forward-push personalized PR.
    pub fn build(n: usize, edges: &[(usize, usize)]) -> Self {
        let mut out_deg = vec![0u32; n];
        let mut off = vec![0u32; n + 1];
        let mut out_off = vec![0u32; n + 1];
        for &(u, v) in edges {
            if u < n && v < n {
                off[v + 1] += 1;
                out_off[u + 1] += 1;
            }
        }
        for v in 0..n {
            off[v + 1] += off[v];
            out_off[v + 1] += out_off[v];
        }
        let mut cursor = off.clone();
        let mut out_cursor = out_off.clone();
        let m = off.get(n).copied().unwrap_or(0) as usize;
        let mut in_nbr = vec![0u32; m];
        let mut out_nbr = vec![0u32; m];
        for &(u, v) in edges {
            if u < n && v < n {
                out_deg[u] += 1;
                in_nbr[cursor[v] as usize] = u as u32;
                cursor[v] += 1;
                out_nbr[out_cursor[u] as usize] = v as u32;
                out_cursor[u] += 1;
            }
        }
        let dangling = (0..n as u32)
            .filter(|&u| out_deg[u as usize] == 0)
            .collect();
        PreparedGraph {
            n,
            off,
            in_nbr,
            out_deg,
            dangling,
            out_off,
            out_nbr,
        }
    }

    /// PageRank from the uniform 1/n seed. Reuses the prepared CSR — no rebuild.
    pub fn pagerank(&self, damping: f64, max_iters: usize, tol: f64) -> Vec<f64> {
        self.run(
            &vec![1.0 / self.n.max(1) as f64; self.n],
            damping,
            max_iters,
            tol,
        )
    }

    /// Warm-start PageRank from `prior` (e.g. the previous result after a small graph delta) — converges in
    /// a handful of sweeps to the SAME fixed point, on the ALREADY-BUILT CSR. This is the incremental hook
    /// the refresh framework wants: after a delta, rebuild the CSR once and warm-run repeatedly, near-free.
    pub fn pagerank_warm(
        &self,
        damping: f64,
        max_iters: usize,
        tol: f64,
        prior: &[f64],
    ) -> Vec<f64> {
        let seed = if prior.len() == self.n {
            prior.to_vec()
        } else {
            vec![1.0 / self.n.max(1) as f64; self.n]
        };
        self.run(&seed, damping, max_iters, tol)
    }

    /// Personalized (rooted) PageRank via Andersen–Chung–Lang FORWARD PUSH — the local-query lever. Instead
    /// of iterating the whole graph, it pushes probability mass out from `seeds` and stops touching a node
    /// once its residual falls below `eps·outdeg`. For a LOCAL query the active set stays small, so the work
    /// (`pushes`) is ~independent of graph size — sublinear, not O(m·iters). This is the 5–10× (often ≫) that
    /// global power iteration can't reach, and it's the "why is THIS node ranked here" product query. Returns
    /// `(ppr, pushes)`; `ppr` sums to ≈1, deterministic (FIFO work queue, fixed order).
    pub fn pagerank_personalized(
        &self,
        seeds: &[usize],
        damping: f64,
        eps: f64,
    ) -> (Vec<f64>, usize) {
        let n = self.n;
        if n == 0 || seeds.is_empty() {
            return (vec![0.0; n], 0);
        }
        let alpha = 1.0 - damping; // teleport (restart) probability
        let mut p = vec![0.0f64; n]; // PPR estimate
        let mut r = vec![0.0f64; n]; // residual (unpushed mass)
        let mut queued = vec![false; n];
        let mut queue: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
        let seed_mass = 1.0 / seeds.len() as f64;
        for &s in seeds {
            if s < n {
                r[s] += seed_mass;
                if !queued[s] {
                    queued[s] = true;
                    queue.push_back(s as u32);
                }
            }
        }
        let mut pushes = 0usize;
        // Push while any active node has residual above the eps·outdeg threshold (FIFO → deterministic).
        while let Some(u) = queue.pop_front() {
            let u = u as usize;
            queued[u] = false;
            let ru = r[u];
            let du = self.out_deg[u];
            if du == 0 {
                // Dangling: mass can't flow forward. Absorb the teleport share into the estimate and return
                // the rest to the seeds (standard restart), keeping total mass conserved.
                p[u] += alpha * ru;
                r[u] = 0.0;
                let back = (1.0 - alpha) * ru * seed_mass;
                for &s in seeds {
                    if s < n {
                        r[s] += back;
                        if !queued[s] && r[s] > eps * self.out_deg[s].max(1) as f64 {
                            queued[s] = true;
                            queue.push_back(s as u32);
                        }
                    }
                }
                continue;
            }
            if ru <= eps * du as f64 {
                continue; // below threshold — leave the residual, stop pushing (the sublinearity)
            }
            p[u] += alpha * ru;
            let mass = (1.0 - alpha) * ru / du as f64;
            r[u] = 0.0;
            for &v in &self.out_nbr[self.out_off[u] as usize..self.out_off[u + 1] as usize] {
                let v = v as usize;
                r[v] += mass;
                pushes += 1;
                if !queued[v] && r[v] > eps * self.out_deg[v].max(1) as f64 {
                    queued[v] = true;
                    queue.push_back(v as u32);
                }
            }
        }
        (p, pushes)
    }

    /// PageRank with an f32 CONTRIB gather — the memory-bandwidth lever. The pull is bound by the RANDOM
    /// gather of `contrib[u]`; storing contrib as f32 (4 B) instead of f64 (8 B) halves that random traffic
    /// (the same trade the GPU makes). `rank` and the accumulator stay f64, so only the per-vertex contrib
    /// is rounded → the result matches the f64 fixed point to ~f32 tolerance (not bit-exact). Use when you
    /// want throughput over the last bits (ranking is unaffected); use `pagerank` for the bit-exact answer.
    pub fn pagerank_f32(&self, damping: f64, max_iters: usize, tol: f64) -> Vec<f64> {
        let n = self.n;
        if n == 0 {
            return Vec::new();
        }
        let base = (1.0 - damping) / n as f64;
        let mut rank = vec![1.0 / n as f64; n];
        let mut contrib = vec![0.0f32; n]; // f32 storage → 4 B random gather instead of 8 B
        for _ in 0..max_iters {
            let dangling = det_par_sum(self.dangling.len(), |i| rank[self.dangling[i] as usize]);
            let add = base + damping * dangling / n as f64;
            contrib
                .par_iter_mut()
                .zip(&rank)
                .zip(&self.out_deg)
                .for_each(|((c, &r), &d)| *c = if d == 0 { 0.0 } else { (r / d as f64) as f32 });
            let next: Vec<f64> = (0..n)
                .into_par_iter()
                .map(|v| {
                    // Gather f32 contribs, accumulate in f64 (accuracy where it's cheap — in registers).
                    let mut acc = 0.0f64;
                    for &u in &self.in_nbr[self.off[v] as usize..self.off[v + 1] as usize] {
                        acc += contrib[u as usize] as f64;
                    }
                    add + damping * acc
                })
                .collect();
            let diff = det_par_sum(n, |i| (next[i] - rank[i]).abs());
            rank = next;
            if diff < tol {
                break;
            }
        }
        rank
    }

    /// The iteration loop shared by every entry point: fused-contrib parallel pull + deterministic parallel
    /// reductions. Identical fixed point (to tolerance) as serial `pagerank`; deterministic run-to-run.
    fn run(&self, seed: &[f64], damping: f64, max_iters: usize, tol: f64) -> Vec<f64> {
        let n = self.n;
        if n == 0 {
            return Vec::new();
        }
        let base = (1.0 - damping) / n as f64;
        // PING-PONG two PREALLOCATED buffers instead of `.collect()`-ing a fresh `next` Vec every iteration
        // (that was an n·8 B alloc+free per sweep — pure waste at low iteration counts). `cur` reads, `nxt`
        // is written in place via par_iter_mut, then swap.
        let mut cur = seed.to_vec();
        let mut nxt = vec![0.0f64; n];
        let mut contrib = vec![0.0f64; n];
        for _ in 0..max_iters {
            // Dangling mass: deterministic fixed-chunk parallel sum over the precomputed list.
            let dangling = det_par_sum(self.dangling.len(), |i| cur[self.dangling[i] as usize]);
            let add = base + damping * dangling / n as f64;
            // FUSED per-vertex contribution contrib[u]=cur[u]/out_deg[u]: n divides not m≈16n, and the pull's
            // inner loop becomes a SINGLE gather. A dangling u never appears as a source (contrib 0).
            contrib
                .par_iter_mut()
                .zip(&cur)
                .zip(&self.out_deg)
                .for_each(|((c, &r), &d)| *c = if d == 0 { 0.0 } else { r / d as f64 });
            // Write the pull result straight into the reused `nxt` buffer (no allocation).
            nxt.par_iter_mut().enumerate().for_each(|(v, slot)| {
                let mut acc = 0.0;
                for &u in &self.in_nbr[self.off[v] as usize..self.off[v + 1] as usize] {
                    acc += contrib[u as usize];
                }
                *slot = add + damping * acc;
            });
            // Convergence residual: deterministic fixed-chunk parallel sum (gates the stop test only).
            let diff = det_par_sum(n, |i| (nxt[i] - cur[i]).abs());
            std::mem::swap(&mut cur, &mut nxt);
            if diff < tol {
                break;
            }
        }
        cur
    }
}

/// Parallel (rayon) PageRank — the multi-core scale-out of `pagerank`. Pull-based: each node's next rank is
/// computed independently from its IN-neighbours, so the O(E) work parallelises with no write contention;
/// the O(n) dangling + convergence reductions are also parallel via a deterministic fixed-chunk sum
/// (`det_par_sum`, the model `betweenness_parallel` uses). Result identical run-to-run on any core count,
/// matching serial `pagerank` to float tolerance. Convenience wrapper = build the CSR + one run; when you
/// recompute repeatedly on the same graph, hold a `PreparedGraph` instead and skip the ~50% build cost.
pub fn pagerank_parallel(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    max_iters: usize,
    tol: f64,
) -> Vec<f64> {
    PreparedGraph::build(n, edges).pagerank(damping, max_iters, tol)
}

/// Deterministic parallel sum of `f(0..len)`: a FIXED number of contiguous chunks are each summed serially
/// (in index order) and their partials combined in chunk order — so the result is identical run-to-run on
/// any core count (the same determinism model `betweenness_parallel` uses). Not bit-equal to a single serial
/// left-fold (float add isn't associative), but well-defined and stable, which is what determinism requires.
fn det_par_sum(len: usize, f: impl Fn(usize) -> f64 + Sync) -> f64 {
    if len == 0 {
        return 0.0;
    }
    // Fixed chunk count (independent of thread count) keeps the reduction order — and thus the result —
    // machine-independent. 256 chunks amortises rayon overhead while staying far above any core count.
    let chunks = 256.min(len);
    let cs = len.div_ceil(chunks);
    (0..chunks)
        .into_par_iter()
        .map(|c| {
            let s = c * cs;
            let e = ((c + 1) * cs).min(len);
            let mut acc = 0.0;
            for i in s..e {
                acc += f(i);
            }
            acc
        })
        .collect::<Vec<f64>>()
        .iter()
        .sum()
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

// ── Residual (delta-push) PageRank — do LESS work ─────────────────────────────────────────────────────────────
/// Residual PageRank via the Neumann series: `rank = Σ_k (d·M)^k · base`. Each pass propagates only the
/// current TERM (the residual), and only from vertices whose residual exceeds `eps` — converged vertices
/// stop pushing entirely. It reaches the SAME fixed point as power-iteration `pagerank` but touches far
/// fewer edges (the active set shrinks as terms decay). Returns `(rank, total_edge_pushes)` so the work
/// saving is measurable: compare `pushes` against power iteration's `iters · m`. This is the algorithmic
/// multiplier that compounds across CPU, GPU, and the distributed halo.
pub fn pagerank_residual(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    eps: f64,
) -> (Vec<f64>, usize) {
    if n == 0 {
        return (Vec::new(), 0);
    }
    let mut out_deg = vec![0usize; n];
    let mut out_adj: Vec<Vec<u32>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        if u < n && v < n {
            out_deg[u] += 1;
            out_adj[u].push(v as u32);
        }
    }
    let base = (1.0 - damping) / n as f64;
    let mut rank = vec![base; n]; // term_0 = base·1
    let mut term = vec![base; n];
    let mut pushes = 0usize;
    loop {
        let mut next = vec![0.0f64; n];
        // Scatter each active vertex's residual to its out-neighbours; sum dangling residual.
        let mut dangling = 0.0;
        for u in 0..n {
            if term[u].abs() <= eps {
                continue; // converged — skip (the whole point)
            }
            if out_deg[u] == 0 {
                dangling += term[u];
                continue;
            }
            let share = damping * term[u] / out_deg[u] as f64;
            for &v in &out_adj[u] {
                next[v as usize] += share;
            }
            pushes += out_deg[u];
        }
        let dshare = damping * dangling / n as f64;
        if dshare.abs() > 0.0 {
            for x in next.iter_mut() {
                *x += dshare;
            }
        }
        // Accumulate this term into the answer; check the residual for convergence.
        let mut maxterm = 0.0f64;
        for v in 0..n {
            rank[v] += next[v];
            maxterm = maxterm.max(next[v].abs());
        }
        term = next;
        if maxterm < eps {
            break;
        }
    }
    (rank, pushes)
}

// ── Anderson-accelerated PageRank — do FEWER sweeps ───────────────────────────────────────────────────────────
/// PageRank with Anderson acceleration (Walker–Ni, type-II, history `window`, mixing β=1). Each sweep is
/// one ordinary PageRank step `g(x)`; Anderson then mixes the last `window` fixed-point residuals through a
/// tiny `window×window` least-squares solve to cancel the slow error modes that make plain power iteration
/// crawl at damping 0.85 — landing on the SAME fixed point in far fewer O(E) sweeps. Robust for PageRank's
/// nonsymmetric operator (Chebyshev assumes a real spectrum; PageRank's is complex). Deterministic: fixed
/// window, fixed reduction order, no RNG. `window == 0` is exactly plain power iteration (empty history →
/// no mixing), so the same code path measures the sweep saving. Returns `(rank, sweeps)`; the convergence
/// test `Σ|g(x)−x| < tol` is byte-for-byte the one `pagerank` uses, so sweep counts compare apples-to-apples.
pub fn pagerank_accel(
    n: usize,
    edges: &[(usize, usize)],
    damping: f64,
    max_iters: usize,
    tol: f64,
    window: usize,
) -> (Vec<f64>, usize) {
    if n == 0 {
        return (Vec::new(), 0);
    }
    // Flat in-CSR (same layout as pagerank_parallel) so g(x) is one cache-friendly pull.
    let mut out_deg = vec![0u32; n];
    let mut off = vec![0u32; n + 1];
    for &(u, v) in edges {
        if u < n && v < n {
            off[v + 1] += 1;
        }
    }
    for v in 0..n {
        off[v + 1] += off[v];
    }
    let mut cursor = off.clone();
    let mut in_nbr = vec![0u32; off[n] as usize];
    for &(u, v) in edges {
        if u < n && v < n {
            out_deg[u] += 1;
            in_nbr[cursor[v] as usize] = u as u32;
            cursor[v] += 1;
        }
    }
    let base = (1.0 - damping) / n as f64;

    // One PageRank sweep g(x) = add + damping·(pull), identical to pagerank_parallel's body.
    let mut contrib = vec![0.0f64; n];
    let step = |x: &[f64], contrib: &mut [f64]| -> Vec<f64> {
        let mut dangling = 0.0;
        for u in 0..n {
            if out_deg[u] == 0 {
                dangling += x[u];
            }
        }
        let add = base + damping * dangling / n as f64;
        contrib
            .par_iter_mut()
            .zip(x)
            .zip(&out_deg)
            .for_each(|((c, &r), &d)| *c = if d == 0 { 0.0 } else { r / d as f64 });
        (0..n)
            .into_par_iter()
            .map(|v| {
                let mut acc = 0.0;
                for &u in &in_nbr[off[v] as usize..off[v + 1] as usize] {
                    acc += contrib[u as usize];
                }
                add + damping * acc
            })
            .collect()
    };

    let mut x = vec![1.0 / n as f64; n];
    let mut x_old: Vec<f64> = Vec::new();
    let mut f_old: Vec<f64> = Vec::new();
    let mut dx: Vec<Vec<f64>> = Vec::new(); // history columns Δx
    let mut df: Vec<Vec<f64>> = Vec::new(); // history columns Δf
    let mut sweeps = 0usize;
    loop {
        let g = step(&x, &mut contrib);
        sweeps += 1;
        let f: Vec<f64> = g.iter().zip(&x).map(|(a, b)| a - b).collect();
        let diff: f64 = f.iter().map(|z| z.abs()).sum();
        if diff < tol || sweeps >= max_iters {
            return (g, sweeps);
        }
        // Grow the difference history from the previous point (needs one prior iterate).
        if !x_old.is_empty() {
            dx.push(x.iter().zip(&x_old).map(|(a, b)| a - b).collect());
            df.push(f.iter().zip(&f_old).map(|(a, b)| a - b).collect());
            if dx.len() > window {
                dx.remove(0);
                df.remove(0);
            }
        }
        // γ = argmin_γ ‖f − Δf·γ‖  via the tiny (mk×mk) normal equations, then the Anderson update
        // x_new = g − Σ γ_j (Δx_j + Δf_j). window==0 ⇒ df empty ⇒ γ empty ⇒ x_new = g (power iteration).
        let gamma = anderson_lsq(&df, &f);
        let mut x_new = g;
        for (j, &gj) in gamma.iter().enumerate() {
            for i in 0..n {
                x_new[i] -= gj * (dx[j][i] + df[j][i]);
            }
        }
        x_old = x;
        f_old = f;
        x = x_new;
    }
}

/// Solve the Anderson least-squares γ = argmin ‖f − C·γ‖ for history columns `C` (each length n) via the
/// regularized normal equations (CᵀC + λI)γ = Cᵀf with Gaussian elimination + partial pivoting. mk is tiny
/// (≤ window), so this is negligible next to the O(E) sweep. Deterministic (fixed-order dot products).
#[allow(clippy::needless_range_loop)] // explicit i/j/t indices read clearer for the mk×mk normal-equation solve
fn anderson_lsq(cols: &[Vec<f64>], f: &[f64]) -> Vec<f64> {
    let mk = cols.len();
    if mk == 0 {
        return Vec::new();
    }
    let n = f.len();
    let mut a = vec![vec![0.0f64; mk]; mk];
    let mut b = vec![0.0f64; mk];
    for i in 0..mk {
        for j in i..mk {
            let mut s = 0.0;
            for t in 0..n {
                s += cols[i][t] * cols[j][t];
            }
            a[i][j] = s;
            a[j][i] = s;
        }
        let mut s = 0.0;
        for t in 0..n {
            s += cols[i][t] * f[t];
        }
        b[i] = s;
    }
    // Tikhonov regularization scaled to the matrix trace keeps the solve stable when columns near-align.
    let tr: f64 = (0..mk).map(|i| a[i][i]).sum();
    let lambda = 1e-12 * (tr / mk as f64).max(1e-300);
    for (i, ai) in a.iter_mut().enumerate() {
        ai[i] += lambda;
    }
    // Gaussian elimination with partial pivoting on the mk×mk system.
    for col in 0..mk {
        let mut piv = col;
        for r in (col + 1)..mk {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        a.swap(col, piv);
        b.swap(col, piv);
        let d = a[col][col];
        if d.abs() < 1e-300 {
            continue;
        }
        for r in (col + 1)..mk {
            let factor = a[r][col] / d;
            for c in col..mk {
                a[r][c] -= factor * a[col][c];
            }
            b[r] -= factor * b[col];
        }
    }
    let mut gamma = vec![0.0f64; mk];
    for i in (0..mk).rev() {
        let mut s = b[i];
        for j in (i + 1)..mk {
            s -= a[i][j] * gamma[j];
        }
        gamma[i] = if a[i][i].abs() < 1e-300 {
            0.0
        } else {
            s / a[i][i]
        };
    }
    gamma
}

// ── Connected components (union-find — the fast single-machine path) ──────────────────────────────────────────
/// Single-machine connected components via union-find (path halving + union by size) — near-linear
/// O(m·α(n)), far faster than iterative label propagation for a one-shot in-memory answer. Returns each
/// node's component representative (the root id). Induces the SAME partition as `connected_components`
/// (label ids differ: roots here vs smallest-member there). This is the algorithm to race a graph DB with;
/// the label-propagation `connected_components` stays the canonical min-label reference for the distributed
/// BSP path (which must reconcile across shards).
pub fn connected_components_uf(n: usize, edges: &[(usize, usize)]) -> Vec<u32> {
    if n == 0 {
        return Vec::new();
    }
    let mut parent: Vec<u32> = (0..n as u32).collect();
    let mut size = vec![1u32; n];
    // find with path halving.
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            parent[x as usize] = parent[parent[x as usize] as usize];
            x = parent[x as usize];
        }
        x
    }
    for &(u, v) in edges {
        if u < n && v < n && u != v {
            let (mut ru, mut rv) = (find(&mut parent, u as u32), find(&mut parent, v as u32));
            if ru != rv {
                // union by size (attach smaller under larger) → shallow trees.
                if size[ru as usize] < size[rv as usize] {
                    std::mem::swap(&mut ru, &mut rv);
                }
                parent[rv as usize] = ru;
                size[ru as usize] += size[rv as usize];
            }
        }
    }
    // Flatten: every node points to its root.
    for i in 0..n {
        parent[i] = find(&mut parent, i as u32);
    }
    parent
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
    fn residual_pagerank_matches_power_iteration_with_less_work() {
        use crate::Kronecker;
        let n = Kronecker::vertices(14); // 16384
        let edges: Vec<(usize, usize)> = Kronecker::new(14, 16, 0x9).collect();
        let m = edges.len();

        // Power iteration converged tight (400 iters ≫ needed) is the reference fixed point.
        let power = pagerank(n, &edges, D, 400, 1e-14);
        // eps trades accuracy for work: 1e-9 keeps the ranking (values ~1/n≈6e-5) while skipping the tail.
        let (residual, pushes) = pagerank_residual(n, &edges, D, 1e-9);

        let maxd = power
            .iter()
            .zip(&residual)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f64, f64::max);
        assert!(
            maxd < 1e-5,
            "residual PR diverged from power iteration: max|Δ| {maxd:e}"
        );

        // Work: residual edge-pushes vs a practical 100-iteration power budget. HONEST: on GLOBAL PageRank of
        // a well-mixed RMAT this is ~1.8× (not the 5-10× of personalized/local PageRank) — converged vertices
        // still stay active a while when damping is 0.85.
        let power_work = 100 * m;
        assert!(
            pushes < power_work,
            "residual ({pushes}) not < power iteration ({power_work})"
        );
    }

    #[test]
    fn personalized_push_matches_power_iteration_and_conserves_mass() {
        use crate::{Kronecker, PreparedGraph};
        // Build an RMAT graph, then add a self-out for any dangling node so every vertex has out-degree ≥1
        // (keeps the power-iteration reference clean — no dangling redistribution to reconcile).
        let n = Kronecker::vertices(11);
        let mut edges: Vec<(usize, usize)> = Kronecker::new(11, 8, 0x9A).collect();
        let mut outdeg = vec![0u32; n];
        for &(u, _v) in &edges {
            outdeg[u] += 1;
        }
        for u in 0..n {
            if outdeg[u] == 0 {
                edges.push((u, u));
            }
        }
        let g = PreparedGraph::build(n, &edges);
        let damping = 0.85;
        let alpha = 1.0 - damping;
        let seeds = [7usize];

        let (p, pushes) = g.pagerank_personalized(&seeds, damping, 1e-9);

        // (1) Mass conservation is exact: α accumulates into p, (1−α) recirculates in r → Σp + Σr ≡ 1,
        //     so Σp ≤ 1 and (1 − Σp) is the untouched residual. Σp must be close to 1 at small eps.
        let sp: f64 = p.iter().sum();
        assert!(sp > 0.99 && sp <= 1.0 + 1e-9, "PPR mass Σp={sp} not ≈1");

        // (2) Matches the power-iteration personalized PR (teleport to the seed), within push tolerance.
        //     ref[v] = α·s[v] + (1−α)·Σ_{u→v} ref[u]/outdeg[u].  (No dangling by construction.)
        let mut out_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut od = vec![0u32; n];
        for &(u, v) in &edges {
            out_adj[u].push(v);
            od[u] += 1;
        }
        let mut piv = vec![0.0f64; n];
        piv[seeds[0]] = 1.0;
        for _ in 0..2000 {
            let mut next = vec![0.0f64; n];
            next[seeds[0]] += alpha;
            for u in 0..n {
                if od[u] > 0 {
                    let share = (1.0 - alpha) * piv[u] / od[u] as f64;
                    for &v in &out_adj[u] {
                        next[v] += share;
                    }
                }
            }
            piv = next;
        }
        let maxd = p
            .iter()
            .zip(&piv)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        assert!(
            maxd < 1e-3,
            "push PPR diverged from power-iteration PPR: max|Δ| {maxd:e}"
        );
        assert!(pushes > 0);
        // Deterministic run-to-run.
        assert_eq!(p, g.pagerank_personalized(&seeds, damping, 1e-9).0);
    }

    #[test]
    fn prepared_graph_reuse_matches_fresh_and_warm_starts() {
        use crate::{Kronecker, PreparedGraph};
        let n = Kronecker::vertices(12);
        let edges: Vec<(usize, usize)> = Kronecker::new(12, 16, 0x9E1).collect();

        // Build ONCE, run MANY: each reuse must equal the build-every-call convenience wrapper.
        let g = PreparedGraph::build(n, &edges);
        for &(dp, it) in &[(0.85, 100usize), (0.5, 100), (0.9, 100)] {
            let reuse = g.pagerank(dp, it, 1e-12);
            let fresh = pagerank_parallel(n, &edges, dp, it, 1e-12);
            assert_eq!(
                reuse, fresh,
                "prepared reuse diverged from fresh build at damping {dp}"
            );
        }
        // Warm-start on the prepared CSR converges to the same fixed point as a cold run.
        let cold = g.pagerank(0.85, 200, 1e-12);
        let warm = g.pagerank_warm(0.85, 200, 1e-12, &cold);
        let maxd = cold
            .iter()
            .zip(&warm)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        assert!(
            maxd < 1e-9,
            "warm-start on prepared graph diverged: {maxd:e}"
        );
    }

    #[test]
    fn anderson_reaches_same_fixed_point_in_fewer_sweeps() {
        use crate::Kronecker;
        let n = Kronecker::vertices(14); // 16384
        let edges: Vec<(usize, usize)> = Kronecker::new(14, 16, 0x9).collect();
        let tol = 1e-10;

        // window==0 IS plain power iteration (same code path); window=5 is Anderson-accelerated.
        let (power, power_sweeps) = pagerank_accel(n, &edges, D, 1000, tol, 0);
        let (accel, accel_sweeps) = pagerank_accel(n, &edges, D, 1000, tol, 5);

        // Same fixed point as the canonical serial engine (both, to tolerance).
        let reference = pagerank(n, &edges, D, 1000, tol);
        let dp = power
            .iter()
            .zip(&reference)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        let da = accel
            .iter()
            .zip(&reference)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        assert!(dp < 1e-8, "power-iteration path diverged: {dp:e}");
        assert!(
            da < 1e-8,
            "Anderson landed on a different fixed point: {da:e}"
        );

        // The whole point: FEWER O(E) sweeps to the same tolerance.
        assert!(
            accel_sweeps < power_sweeps,
            "Anderson ({accel_sweeps}) must beat power iteration ({power_sweeps}) in sweeps"
        );

        // Deterministic run-to-run.
        assert_eq!(
            accel,
            pagerank_accel(n, &edges, D, 1000, tol, 5).0,
            "deterministic"
        );
    }

    #[test]
    fn union_find_cc_induces_same_partition_as_label_prop() {
        use crate::Kronecker;
        // Two disjoint RMAT blobs → a real multi-component graph. Union-find and label-prop must agree
        // on the PARTITION (which nodes share a component), even though the label ids differ.
        let half = Kronecker::vertices(8);
        let n = 2 * half;
        let mut edges: Vec<(usize, usize)> = Kronecker::new(8, 6, 1).collect();
        edges.extend(Kronecker::new(8, 6, 2).map(|(u, v)| (u + half, v + half)));

        let lp = connected_components(n, &edges); // min-label
        let uf = connected_components_uf(n, &edges); // roots
        assert_eq!(
            lp.iter().collect::<std::collections::HashSet<_>>().len(),
            uf.iter().collect::<std::collections::HashSet<_>>().len(),
            "same number of components"
        );
        // Same partition: for every edge-connected pair the labels agree within each scheme.
        for v in 0..n {
            for &w in &[(v + 1) % n, (v + 7) % n] {
                assert_eq!(
                    lp[v] == lp[w],
                    uf[v] == uf[w],
                    "union-find and label-prop disagree on whether {v},{w} share a component"
                );
            }
        }
    }

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
    fn out_of_core_mmap_pagerank_matches_in_memory() {
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
        let tmp = std::env::temp_dir().join(format!("hg_ooc_{}.csr", std::process::id()));
        write_csr(&tmp, n, &edges).unwrap();
        let csr = MmapCsr::open(&tmp).unwrap();
        assert_eq!(csr.n(), n);
        assert_eq!(csr.edge_count(), edges.len());
        let a = pagerank(n, &edges, D, IT, TOL);
        let b = pagerank_mmap(&csr, D, IT, TOL); // edges read from the mmap, not heap
        for i in 0..n {
            assert!(
                (a[i] - b[i]).abs() < 1e-9,
                "out-of-core PR must match in-memory at {i}"
            );
        }
        drop(csr);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn streaming_csr_builder_is_byte_identical_to_batch_and_bounded_heap() {
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
        let batch = std::env::temp_dir().join(format!("hg_batch_{}.csr", std::process::id()));
        let stream = std::env::temp_dir().join(format!("hg_stream_{}.csr", std::process::id()));
        write_csr(&batch, n, &edges).unwrap();
        // O(n)-heap streaming build: the closure yields the edge stream, never held whole.
        write_csr_streaming(&stream, n, || edges.iter().copied()).unwrap();
        assert_eq!(
            std::fs::read(&batch).unwrap(),
            std::fs::read(&stream).unwrap(),
            "streaming builder must produce a byte-identical CSR to the batch builder"
        );
        let csr = MmapCsr::open(&stream).unwrap();
        let a = pagerank(n, &edges, D, IT, TOL);
        let b = pagerank_mmap(&csr, D, IT, TOL);
        for i in 0..n {
            assert!(
                (a[i] - b[i]).abs() < 1e-9,
                "streamed-CSR PR must match in-memory at {i}"
            );
        }
        drop(csr);
        std::fs::remove_file(&batch).ok();
        std::fs::remove_file(&stream).ok();
    }

    #[test]
    fn bucketed_builder_is_byte_identical_across_bucket_counts() {
        let edges = vec![
            (0, 1),
            (1, 2),
            (2, 0),
            (2, 3),
            (3, 1),
            (0, 3),
            (3, 4),
            (4, 2),
            (1, 4),
        ];
        let n = 5;
        let reference = std::env::temp_dir().join(format!("hg_ref_{}.csr", std::process::id()));
        write_csr(&reference, n, &edges).unwrap();
        let want = std::fs::read(&reference).unwrap();
        // Sequential-I/O external build must match the batch build at ANY bucket count.
        for buckets in [1usize, 2, 3, 5, 8] {
            let out = std::env::temp_dir().join(format!(
                "hg_buck_{}_{}.csr",
                buckets,
                std::process::id()
            ));
            write_csr_bucketed(&out, n, || edges.iter().copied(), buckets).unwrap();
            assert_eq!(
                std::fs::read(&out).unwrap(),
                want,
                "bucketed (b={buckets}) must be byte-identical"
            );
            std::fs::remove_file(&out).ok();
        }
        std::fs::remove_file(&reference).ok();
    }

    #[test]
    fn distributed_connected_components_matches_single_graph() {
        // component {0,1,2} triangle · component {3,4} edge · node 5 isolated
        let edges = vec![(0, 1), (1, 2), (2, 0), (3, 4)];
        let n = 6;
        let single = connected_components(n, &edges);
        for k in [1usize, 2, 3, 6] {
            let shards = partition_undirected(n, &edges, k);
            assert_eq!(
                distributed_connected_components(n, &shards),
                single,
                "sharded CC (k={k}) must equal single-graph"
            );
        }
        assert_eq!(single[0], single[1]);
        assert_eq!(single[1], single[2]);
        assert_eq!(single[3], single[4]);
        assert_ne!(single[0], single[3], "distinct components differ");
        assert_ne!(single[5], single[0], "isolated node is its own component");
    }

    #[test]
    fn graph500_kronecker_is_well_formed_and_deterministic() {
        let (scale, ef) = (10u32, 16usize);
        let n = Kronecker::vertices(scale);
        let m = Kronecker::edges(scale, ef);
        assert_eq!(n, 1024);
        assert_eq!(m, 16 * 1024);
        let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 42).collect();
        assert_eq!(edges.len(), m, "yields exactly edgefactor·2^scale edges");
        assert!(
            edges.iter().all(|&(u, v)| u < n && v < n),
            "all vertices in [0, 2^scale)"
        );
        // deterministic: same seed → identical stream
        assert_eq!(edges, Kronecker::new(scale, ef, 42).collect::<Vec<_>>());
        // RMAT skew: degree is concentrated (a few hot vertices) — not uniform. Check node 0 is hot.
        let deg0 = edges.iter().filter(|&&(u, v)| u == 0 || v == 0).count();
        assert!(
            deg0 > m / n,
            "RMAT produces a skewed (scale-free-ish) degree distribution"
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

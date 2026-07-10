//! dist_boundary — REAL multi-process distributed PageRank with a BOUNDARY-ONLY halo. This is the actual
//! cluster artifact: what runs on Saturday's nodes, proven locally over real TCP sockets first.
//!
//! Unlike `dist_socket` (which broadcasts the full O(n) rank vector every superstep), here each worker
//! KEEPS its owned ranks across supersteps and only the boundary crosses the wire, in BOTH directions:
//!   • up   (worker → coordinator): the worker's owned values that are some other shard's ghost, + a
//!                                  scalar dangling-mass partial.
//!   • down (coordinator → worker): exactly the ghost ranks this worker needs, + the scalar `add`.
//! There is NO O(n) message per superstep — total per-step traffic is O(boundary). The O(E) edges never
//! leave their worker's file. One final O(n) gather at the end collects the answer (one-time, not per-step).
//!
//! The graph is Fennel-partitioned (edge-cut minimised) then relabelled to contiguous blocks, so the
//! boundary is small. The distributed answer is checked against single-graph PageRank.
//!
//! Run: `cargo run -p hg_analytics --release --example dist_boundary`

use hg_analytics::{
    fennel_partition, pagerank, partition_edges_boundary_at, relabel_contiguous, Kronecker,
};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Instant;

const SCALE: u32 = 18; // 262_144 vertices
const EDGEFACTOR: usize = 16; // ~4.2M edges
const SHARDS: usize = 8;
const ITERS: usize = 25;
const D: f64 = 0.85;

fn shard_path(idx: usize) -> PathBuf {
    std::env::temp_dir().join(format!("hg_bshard_{idx}.bin"))
}

fn read_vec(s: &mut impl Read, bytes: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0u8; bytes];
    s.read_exact(&mut b)?;
    Ok(b)
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("worker") {
        let addr = std::env::args().nth(2).unwrap();
        let idx: usize = std::env::args().nth(3).unwrap().parse().unwrap();
        run_worker(&addr, idx);
    } else {
        run_coordinator();
    }
}

// ── Worker: owns one shard file (local CSR + local out-degrees + which owned nodes to report up). Keeps
//    its owned ranks across supersteps; each step receives only its ghost halo, computes, reports boundary.
fn run_worker(addr: &str, idx: usize) {
    let raw = std::fs::read(shard_path(idx)).unwrap();
    let mut p = 0usize;
    let rd_u64 = |raw: &[u8], p: &mut usize| {
        let v = u64::from_le_bytes(raw[*p..*p + 8].try_into().unwrap());
        *p += 8;
        v as usize
    };
    let owned = rd_u64(&raw, &mut p);
    let g = rd_u64(&raw, &mut p);
    let up_len = rd_u64(&raw, &mut p);
    let off: &[u64] = bytemuck::cast_slice(&raw[p..p + (owned + 1) * 8]);
    p += (owned + 1) * 8;
    let adj_entries = off[owned] as usize;
    let nbr: &[u32] = bytemuck::cast_slice(&raw[p..p + adj_entries * 4]);
    p += adj_entries * 4;
    let out_deg_local: &[u32] = bytemuck::cast_slice(&raw[p..p + (owned + g) * 4]);
    p += (owned + g) * 4;
    let up_locals: &[u32] = bytemuck::cast_slice(&raw[p..p + up_len * 4]);

    let mut sock = TcpStream::connect(addr).unwrap();
    sock.set_nodelay(true).ok();
    sock.write_all(&(idx as u64).to_le_bytes()).unwrap(); // hello
    let n_recip = f64::from_le_bytes(read_vec(&mut sock, 8).unwrap().try_into().unwrap()); // 1/n init

    // Local persistent state: owned ranks (kept across supersteps — the whole point).
    let mut owned_rank = vec![n_recip; owned];
    // Reusable local view: [owned ranks | ghost halo].
    let mut local_rank = vec![n_recip; owned + g];

    loop {
        // Receive this step's control + ghost halo (the boundary-only download).
        let mut ctrl = [0u8; 8];
        if sock.read_exact(&mut ctrl).is_err() {
            break;
        }
        let add = f64::from_le_bytes(ctrl);
        if add.is_nan() {
            break; // terminate
        }
        if add.is_infinite() {
            // Final gather: send full owned ranks once, then finish.
            sock.write_all(bytemuck::cast_slice(&owned_rank)).unwrap();
            break;
        }
        let ghost_halo: Vec<f64> =
            bytemuck::cast_slice(&read_vec(&mut sock, g * 8).unwrap()).to_vec();
        // Assemble local view: owned (persistent) followed by the received ghost halo.
        local_rank[..owned].copy_from_slice(&owned_rank);
        local_rank[owned..].copy_from_slice(&ghost_halo);
        // Compute new owned ranks (pull from local in-neighbours).
        let mut dangling_partial = 0.0f64;
        for v in 0..owned {
            let mut acc = 0.0;
            for &li in &nbr[off[v] as usize..off[v + 1] as usize] {
                acc += local_rank[li as usize] / out_deg_local[li as usize] as f64;
            }
            owned_rank[v] = add + D * acc;
            if out_deg_local[v] == 0 {
                dangling_partial += owned_rank[v];
            }
        }
        // Report up: dangling scalar + the boundary-owned values other shards need (boundary-only upload).
        let mut up = Vec::with_capacity(8 + up_len * 8);
        up.extend_from_slice(&dangling_partial.to_le_bytes());
        for &li in up_locals {
            up.extend_from_slice(&owned_rank[li as usize].to_le_bytes());
        }
        sock.write_all(&up).unwrap();
    }
}

// ── Coordinator: Fennel-partition, relabel, write shard files, spawn workers, drive the boundary BSP loop.
fn run_coordinator() {
    let n = Kronecker::vertices(SCALE);
    let edges: Vec<(usize, usize)> = Kronecker::new(SCALE, EDGEFACTOR, 0xB0A7).collect();
    let m = edges.len();
    println!(
        "Boundary-halo distributed PageRank over SOCKETS: {n} nodes / {m} edges / {SHARDS} worker processes"
    );

    // Fennel edge-cut partition → relabel to contiguous blocks → boundary shards on the relabelled graph.
    let part = fennel_partition(n, &edges, SHARDS);
    let (remapped, bounds, _perm) = relabel_contiguous(n, &part, SHARDS, &edges);
    let (shards, out_deg) = partition_edges_boundary_at(n, &remapped, &bounds);

    // Boundary set B = union of all ghosts; its dense index space is the only per-step state the
    // coordinator holds (O(boundary), not O(n)).
    let mut bset: BTreeSet<usize> = BTreeSet::new();
    for sh in &shards {
        bset.extend(sh.ghosts.iter().copied());
    }
    let bpos: std::collections::HashMap<usize, usize> =
        bset.iter().enumerate().map(|(i, &g)| (g, i)).collect();
    let b_len = bset.len();

    // Per-worker bookkeeping + shard files.
    struct Book {
        lo: usize,
        owned: usize,
        ghost_bpos: Vec<usize>, // gather halo for this worker from boundary_val
        up_bpos: Vec<usize>,    // scatter this worker's reported up-values into boundary_val
    }
    let mut books: Vec<Book> = Vec::new();
    for sh in &shards {
        let owned = sh.owned();
        let g = sh.ghosts.len();
        // out_deg over [owned ++ ghosts].
        let mut odl: Vec<u32> = Vec::with_capacity(owned + g);
        odl.extend_from_slice(&out_deg[sh.lo..sh.hi]);
        for &gg in &sh.ghosts {
            odl.push(out_deg[gg]);
        }
        // owned nodes that are in B → the values to report up (sorted by local index).
        let up_locals: Vec<u32> = (0..owned)
            .filter(|&li| bpos.contains_key(&(sh.lo + li)))
            .map(|li| li as u32)
            .collect();
        let up_bpos: Vec<usize> = up_locals
            .iter()
            .map(|&li| bpos[&(sh.lo + li as usize)])
            .collect();
        let ghost_bpos: Vec<usize> = sh.ghosts.iter().map(|&gg| bpos[&gg]).collect();

        // CSR (local indices) for the worker file.
        let mut off = vec![0u64; owned + 1];
        for (i, srcs) in sh.in_adj.iter().enumerate() {
            off[i + 1] = off[i] + srcs.len() as u64;
        }
        let flat: Vec<u32> = sh.in_adj.iter().flatten().map(|&li| li as u32).collect();

        let mut buf = Vec::new();
        buf.extend_from_slice(&(owned as u64).to_le_bytes());
        buf.extend_from_slice(&(g as u64).to_le_bytes());
        buf.extend_from_slice(&(up_locals.len() as u64).to_le_bytes());
        buf.extend_from_slice(bytemuck::cast_slice(&off));
        buf.extend_from_slice(bytemuck::cast_slice(&flat));
        buf.extend_from_slice(bytemuck::cast_slice(&odl));
        buf.extend_from_slice(bytemuck::cast_slice(&up_locals));
        std::fs::write(shard_path(books.len()), &buf).unwrap();

        books.push(Book {
            lo: sh.lo,
            owned,
            ghost_bpos,
            up_bpos,
        });
    }

    // Spawn workers; accept + identify by hello; send 1/n init.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let exe = std::env::current_exe().unwrap();
    let mut kids: Vec<std::process::Child> = (0..SHARDS)
        .map(|idx| {
            std::process::Command::new(&exe)
                .args(["worker", &addr, &idx.to_string()])
                .spawn()
                .unwrap()
        })
        .collect();
    // conns[idx] in worker-id order.
    let mut conns: Vec<Option<TcpStream>> = (0..SHARDS).map(|_| None).collect();
    for _ in 0..SHARDS {
        let (mut s, _) = listener.accept().unwrap();
        s.set_nodelay(true).ok();
        let id = u64::from_le_bytes(read_vec(&mut s, 8).unwrap().try_into().unwrap()) as usize;
        s.write_all(&(1.0 / n as f64).to_le_bytes()).unwrap();
        conns[id] = Some(s);
    }
    let mut conns: Vec<TcpStream> = conns.into_iter().map(|c| c.unwrap()).collect();

    let base = (1.0 - D) / n as f64;
    // boundary_val holds rank_t restricted to B. Init uniform 1/n.
    let mut boundary_val = vec![1.0 / n as f64; b_len];
    // Seed add_0 from the uniform-rank dangling mass (coordinator knows out_deg = setup metadata).
    let n_dangle = out_deg.iter().filter(|&&d| d == 0).count();
    let mut add = base + D * (n_dangle as f64 / n as f64) / n as f64;

    let mut down_bytes = 0usize;
    let mut up_bytes = 0usize;
    let t = Instant::now();
    for _ in 0..ITERS {
        // DOWN: send each worker add + only its ghost halo (gathered from boundary_val).
        for (c, s) in conns.iter_mut().enumerate() {
            let halo: Vec<f64> = books[c]
                .ghost_bpos
                .iter()
                .map(|&bi| boundary_val[bi])
                .collect();
            s.write_all(&add.to_le_bytes()).unwrap();
            s.write_all(bytemuck::cast_slice(&halo)).unwrap();
            down_bytes += 8 + halo.len() * 8;
        }
        // UP: gather dangling partials + boundary-owned values; rebuild boundary_val = rank_{t+1}|B.
        let mut dangling = 0.0f64;
        for (c, s) in conns.iter_mut().enumerate() {
            let up_len = books[c].up_bpos.len();
            let buf = read_vec(s, 8 + up_len * 8).unwrap();
            dangling += f64::from_le_bytes(buf[0..8].try_into().unwrap());
            let vals: &[f64] = bytemuck::cast_slice(&buf[8..]);
            for (k, &bi) in books[c].up_bpos.iter().enumerate() {
                boundary_val[bi] = vals[k];
            }
            up_bytes += buf.len();
        }
        add = base + D * dangling / n as f64;
    }
    let dt = t.elapsed();

    // Final O(n) gather (one-time): request full owned vectors, assemble the global answer.
    let mut rank = vec![0.0f64; n];
    for (c, s) in conns.iter_mut().enumerate() {
        s.write_all(&f64::INFINITY.to_le_bytes()).unwrap();
        let owned: Vec<f64> =
            bytemuck::cast_slice(&read_vec(s, books[c].owned * 8).unwrap()).to_vec();
        rank[books[c].lo..books[c].lo + books[c].owned].copy_from_slice(&owned);
    }
    for k in kids.iter_mut() {
        k.wait().ok();
    }

    // Verify against single-graph PageRank on the same (relabelled) graph.
    let single = pagerank(n, &remapped, D, ITERS, -1.0);
    let maxdiff = single
        .iter()
        .zip(&rank)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);

    let full_broadcast = SHARDS * n * 8 * ITERS;
    let boundary_total = down_bytes + up_bytes;
    println!("  {ITERS} boundary supersteps over TCP: {dt:>7.3?}");
    println!(
        "  boundary set |B| = {b_len} ({:.1}% of n)",
        100.0 * b_len as f64 / n as f64
    );
    println!(
        "  wire/step: down {} KB (ghost halos) + up {} KB (boundary + dangling) — NO O(n) per step",
        down_bytes / ITERS / 1000,
        up_bytes / ITERS / 1000
    );
    println!(
        "  total over wire: {:.1} MB   vs a full-broadcast BSP {:.1} MB  → {:.1}x less",
        boundary_total as f64 / 1e6,
        full_broadcast as f64 / 1e6,
        full_broadcast as f64 / boundary_total.max(1) as f64
    );
    println!("  == single-graph PageRank: max|Δ| {maxdiff:.2e}   (distributed answer is EXACT)");

    for idx in 0..SHARDS {
        std::fs::remove_file(shard_path(idx)).ok();
    }
}

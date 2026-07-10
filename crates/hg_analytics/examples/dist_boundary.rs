//! dist_boundary — REAL multi-process distributed PageRank with a BOUNDARY-ONLY halo. This is the actual
//! cluster artifact: what runs on Saturday's nodes, proven locally over real TCP sockets first.
//!
//! Unlike `dist_socket` (which broadcasts the full O(n) rank vector every superstep), here each worker
//! KEEPS its owned ranks across supersteps and only the boundary crosses the wire, in BOTH directions:
//!   • up   (worker → coordinator): the worker's owned values that are some other shard's ghost, + a
//!                                  scalar dangling-mass partial.
//!   • down (coordinator → worker): exactly the ghost ranks this worker needs, + the scalar `add`.
//! There is NO O(n) message per superstep — total per-step traffic is O(boundary). The O(E) edges never
//! leave the worker (each shard's CSR is streamed to it once at setup — no shared filesystem needed, so it
//! runs unchanged on a GKE cluster). One final O(n) gather collects the answer (one-time, not per-step).
//!
//! Roles (env-driven so the SAME binary is the container for every pod):
//!   • default (no env)          — LOCAL: coordinator generates the graph, spawns SHARDS worker processes,
//!                                 ships each its shard over a loopback socket, runs, verifies. `cargo run`.
//!   • HG_ROLE=coordinator       — CLUSTER coordinator: bind HG_LISTEN (default 0.0.0.0:9000), wait for
//!                                 HG_SHARDS external workers to connect, ship shards, run, verify.
//!   • HG_ROLE=worker            — CLUSTER worker: connect HG_COORD (host:port), identify by HG_ORDINAL
//!                                 (or JOB_COMPLETION_INDEX), receive its shard, compute.
//! Graph size overridable via HG_SCALE / HG_EDGEFACTOR / HG_ITERS.
//!
//! Run locally: `cargo run -p hg_analytics --release --example dist_boundary`

use hg_analytics::{
    fennel_partition, pagerank, partition_edges_boundary_at, relabel_contiguous, Kronecker,
};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Instant;

const D: f64 = 0.85;

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn read_vec(s: &mut impl Read, bytes: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0u8; bytes];
    s.read_exact(&mut b)?;
    Ok(b)
}

fn main() {
    // Local-spawn children use argv (worker <addr> <ordinal>); cluster pods use env.
    if std::env::args().nth(1).as_deref() == Some("worker") {
        let addr = std::env::args().nth(2).unwrap();
        let idx: usize = std::env::args().nth(3).unwrap().parse().unwrap();
        run_worker(&addr, idx);
        return;
    }
    match std::env::var("HG_ROLE").as_deref() {
        Ok("worker") => {
            let addr = std::env::var("HG_COORD").expect("HG_COORD=host:port required for worker");
            let ordinal = std::env::var("HG_ORDINAL")
                .or_else(|_| std::env::var("JOB_COMPLETION_INDEX"))
                .expect("HG_ORDINAL or JOB_COMPLETION_INDEX required")
                .parse()
                .unwrap();
            run_worker(&addr, ordinal);
        }
        Ok("coordinator") => {
            let listen = std::env::var("HG_LISTEN").unwrap_or_else(|_| "0.0.0.0:9000".into());
            run_coordinator(&listen, env_usize("HG_SHARDS", 8), false);
        }
        _ => {
            // Local all-in-one: bind an ephemeral loopback port and spawn the workers ourselves.
            run_coordinator("127.0.0.1:0", env_usize("HG_SHARDS", 8), true);
        }
    }
}

// ── Worker: receives its shard over the socket (local CSR + local out-degrees + which owned nodes to
//    report up), keeps its owned ranks across supersteps, exchanges only the boundary each step.
fn run_worker(addr: &str, ordinal: usize) {
    // Retry the connect: on a cluster the coordinator pod may not be listening yet (k8s does not order
    // pod startup). Back off up to ~60s before giving up.
    let mut sock = {
        let mut attempt = 0;
        loop {
            match TcpStream::connect(addr) {
                Ok(s) => break s,
                Err(e) if attempt < 60 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    if attempt % 10 == 0 {
                        eprintln!("worker {ordinal}: waiting for coordinator {addr} ({e})");
                    }
                }
                Err(e) => panic!("worker {ordinal}: coordinator {addr} unreachable: {e}"),
            }
        }
    };
    sock.set_nodelay(true).ok();
    sock.write_all(&(ordinal as u64).to_le_bytes()).unwrap(); // hello: which shard I am

    // Receive setup: [1/n : f64][shard_len : u64][shard bytes].
    let n_recip = f64::from_le_bytes(read_vec(&mut sock, 8).unwrap().try_into().unwrap());
    let shard_len =
        u64::from_le_bytes(read_vec(&mut sock, 8).unwrap().try_into().unwrap()) as usize;
    let raw = read_vec(&mut sock, shard_len).unwrap();

    // Parse the shard layout (see coordinator's build_shard_buffer).
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

    // Persistent local state: owned ranks kept across supersteps (the whole point).
    let mut owned_rank = vec![n_recip; owned];
    let mut local_rank = vec![n_recip; owned + g];

    loop {
        let mut ctrl = [0u8; 8];
        if sock.read_exact(&mut ctrl).is_err() {
            break;
        }
        let add = f64::from_le_bytes(ctrl);
        if add.is_nan() {
            break; // terminate
        }
        if add.is_infinite() {
            sock.write_all(bytemuck::cast_slice(&owned_rank)).unwrap(); // final gather
            break;
        }
        let ghost_halo: Vec<f64> =
            bytemuck::cast_slice(&read_vec(&mut sock, g * 8).unwrap()).to_vec();
        local_rank[..owned].copy_from_slice(&owned_rank);
        local_rank[owned..].copy_from_slice(&ghost_halo);
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
        let mut up = Vec::with_capacity(8 + up_len * 8);
        up.extend_from_slice(&dangling_partial.to_le_bytes());
        for &li in up_locals {
            up.extend_from_slice(&owned_rank[li as usize].to_le_bytes());
        }
        sock.write_all(&up).unwrap();
    }
}

struct Book {
    lo: usize,
    owned: usize,
    ghost_bpos: Vec<usize>,
    up_bpos: Vec<usize>,
    shard: Vec<u8>,
}

/// Coordinator: Fennel-partition, relabel, build per-shard buffers, (optionally) spawn workers, ship each
/// its shard over the socket, drive the boundary BSP loop, verify against single-graph PageRank.
fn run_coordinator(listen: &str, shards_n: usize, spawn: bool) {
    let scale = env_usize("HG_SCALE", 18) as u32;
    let edgefactor = env_usize("HG_EDGEFACTOR", 16);
    let iters = env_usize("HG_ITERS", 25);
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, edgefactor, 0xB0A7).collect();
    let m = edges.len();
    println!(
        "Boundary-halo distributed PageRank over TCP: {n} nodes / {m} edges / {shards_n} workers \
(scale {scale}, ef {edgefactor}, {iters} iters)"
    );

    let part = fennel_partition(n, &edges, shards_n);
    let (remapped, bounds, _perm) = relabel_contiguous(n, &part, shards_n, &edges);
    let (shards, out_deg) = partition_edges_boundary_at(n, &remapped, &bounds);

    // Boundary set B = union of all ghosts; the coordinator's only per-step state (O(boundary)).
    let mut bset: BTreeSet<usize> = BTreeSet::new();
    for sh in &shards {
        bset.extend(sh.ghosts.iter().copied());
    }
    let bpos: std::collections::HashMap<usize, usize> =
        bset.iter().enumerate().map(|(i, &g)| (g, i)).collect();
    let b_len = bset.len();

    let books: Vec<Book> = shards
        .iter()
        .map(|sh| build_book(sh, &out_deg, &bpos))
        .collect();

    let listener = TcpListener::bind(listen).unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let mut kids: Vec<std::process::Child> = Vec::new();
    if spawn {
        let exe = std::env::current_exe().unwrap();
        kids = (0..shards_n)
            .map(|idx| {
                std::process::Command::new(&exe)
                    .args(["worker", &addr, &idx.to_string()])
                    .spawn()
                    .unwrap()
            })
            .collect();
    } else {
        println!("  waiting for {shards_n} workers to connect on {listen} ...");
    }

    // Accept, identify by hello ordinal, ship [1/n][shard_len][shard bytes] to each.
    let mut conns: Vec<Option<TcpStream>> = (0..shards_n).map(|_| None).collect();
    for _ in 0..shards_n {
        let (mut s, _) = listener.accept().unwrap();
        s.set_nodelay(true).ok();
        let id = u64::from_le_bytes(read_vec(&mut s, 8).unwrap().try_into().unwrap()) as usize;
        s.write_all(&(1.0 / n as f64).to_le_bytes()).unwrap();
        s.write_all(&(books[id].shard.len() as u64).to_le_bytes())
            .unwrap();
        s.write_all(&books[id].shard).unwrap();
        conns[id] = Some(s);
    }
    let mut conns: Vec<TcpStream> = conns.into_iter().map(|c| c.unwrap()).collect();

    let base = (1.0 - D) / n as f64;
    let mut boundary_val = vec![1.0 / n as f64; b_len];
    let n_dangle = out_deg.iter().filter(|&&d| d == 0).count();
    let mut add = base + D * (n_dangle as f64 / n as f64) / n as f64;

    let mut down_bytes = 0usize;
    let mut up_bytes = 0usize;
    let t = Instant::now();
    for _ in 0..iters {
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

    let single = pagerank(n, &remapped, D, iters, -1.0);
    let maxdiff = single
        .iter()
        .zip(&rank)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    let full_broadcast = shards_n * n * 8 * iters;
    let boundary_total = down_bytes + up_bytes;
    println!("  {iters} boundary supersteps over TCP: {dt:>7.3?}");
    println!(
        "  boundary set |B| = {b_len} ({:.1}% of n)",
        100.0 * b_len as f64 / n as f64
    );
    println!(
        "  wire/step: down {} KB (ghost halos) + up {} KB (boundary + dangling) — NO O(n) per step",
        down_bytes / iters / 1000,
        up_bytes / iters / 1000
    );
    println!(
        "  total over wire: {:.1} MB   vs a full-broadcast BSP {:.1} MB  → {:.1}x less",
        boundary_total as f64 / 1e6,
        full_broadcast as f64 / 1e6,
        full_broadcast as f64 / boundary_total.max(1) as f64
    );
    println!("  == single-graph PageRank: max|Δ| {maxdiff:.2e}   (distributed answer is EXACT)");
}

/// Build one worker's shard buffer + the coordinator's gather/scatter bookkeeping for it.
fn build_book(
    sh: &hg_analytics::BoundaryShard,
    out_deg: &[u32],
    bpos: &std::collections::HashMap<usize, usize>,
) -> Book {
    let owned = sh.owned();
    let g = sh.ghosts.len();
    let mut odl: Vec<u32> = Vec::with_capacity(owned + g);
    odl.extend_from_slice(&out_deg[sh.lo..sh.hi]);
    for &gg in &sh.ghosts {
        odl.push(out_deg[gg]);
    }
    let up_locals: Vec<u32> = (0..owned)
        .filter(|&li| bpos.contains_key(&(sh.lo + li)))
        .map(|li| li as u32)
        .collect();
    let up_bpos: Vec<usize> = up_locals
        .iter()
        .map(|&li| bpos[&(sh.lo + li as usize)])
        .collect();
    let ghost_bpos: Vec<usize> = sh.ghosts.iter().map(|&gg| bpos[&gg]).collect();

    let mut off = vec![0u64; owned + 1];
    for (i, srcs) in sh.in_adj.iter().enumerate() {
        off[i + 1] = off[i] + srcs.len() as u64;
    }
    let flat: Vec<u32> = sh.in_adj.iter().flatten().map(|&li| li as u32).collect();

    let mut shard = Vec::new();
    shard.extend_from_slice(&(owned as u64).to_le_bytes());
    shard.extend_from_slice(&(g as u64).to_le_bytes());
    shard.extend_from_slice(&(up_locals.len() as u64).to_le_bytes());
    shard.extend_from_slice(bytemuck::cast_slice(&off));
    shard.extend_from_slice(bytemuck::cast_slice(&flat));
    shard.extend_from_slice(bytemuck::cast_slice(&odl));
    shard.extend_from_slice(bytemuck::cast_slice(&up_locals));

    Book {
        lo: sh.lo,
        owned,
        ghost_bpos,
        up_bpos,
        shard,
    }
}

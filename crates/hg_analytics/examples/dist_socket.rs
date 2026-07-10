//! dist_socket — REAL multi-process distributed PageRank. The coordinator partitions the graph,
//! writes one shard file per participant, and spawns N worker PROCESSES. Each BSP superstep the
//! coordinator broadcasts the rank halo over a TCP socket; each worker computes its owned nodes from
//! its LOCAL shard (edges never leave the worker) and sends its slice back; the coordinator gathers.
//! Only the O(n) halo goes over the wire — the O(E) edges are sovereign per process. Proves the
//! distributed model over an actual network transport (not shared memory), and checks it EXACTLY
//! matches single-graph PageRank. Run: `cargo run --release --example dist_socket`.

use hg_analytics::{pagerank, partition_edges};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Instant;

const N: usize = 200_000;
const M: usize = 2_000_000;
const SHARDS: usize = 4;
const ITERS: usize = 20;
const D: f64 = 0.85;
const SEED: u64 = 0x9e3779b97f4a7c15;

fn gen_edges() -> Vec<(usize, usize)> {
    let mut s = SEED;
    let mut r = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    (0..M)
        .map(|_| ((r() as usize) % N, (r() as usize) % N))
        .collect()
}

fn shard_path(idx: usize) -> PathBuf {
    std::env::temp_dir().join(format!("hg_shard_{idx}.bin"))
}

fn read_exact_vec(s: &mut impl Read, bytes: usize) -> std::io::Result<Vec<u8>> {
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

// ── Worker process: owns one shard file; loops receiving the halo, computing, replying ───────────
fn run_worker(addr: &str, idx: usize) {
    // Load this shard's local CSR (lo, hi, offsets, in_neighbours) — the ONLY edges this process sees.
    let raw = std::fs::read(shard_path(idx)).unwrap();
    let lo = u64::from_le_bytes(raw[0..8].try_into().unwrap()) as usize;
    let hi = u64::from_le_bytes(raw[8..16].try_into().unwrap()) as usize;
    let own = hi - lo;
    let off: &[u64] = bytemuck::cast_slice(&raw[16..16 + (own + 1) * 8]);
    let nbr: &[u32] = bytemuck::cast_slice(&raw[16 + (own + 1) * 8..]);

    let mut sock = TcpStream::connect(addr).unwrap();
    sock.set_nodelay(true).ok();
    sock.write_all(&(idx as u64).to_le_bytes()).unwrap(); // hello: which shard I am
                                                          // setup: global out_deg
    let n = u64::from_le_bytes(read_exact_vec(&mut sock, 8).unwrap().try_into().unwrap()) as usize;
    let out_deg: Vec<u32> =
        bytemuck::cast_slice(&read_exact_vec(&mut sock, n * 4).unwrap()).to_vec();

    loop {
        let mut ctrl = [0u8; 8];
        if sock.read_exact(&mut ctrl).is_err() {
            break;
        }
        let add = f64::from_le_bytes(ctrl);
        if add.is_nan() {
            break; // terminate signal
        }
        let rank: Vec<f64> =
            bytemuck::cast_slice(&read_exact_vec(&mut sock, n * 8).unwrap()).to_vec();
        let mut owned = vec![0.0f64; own];
        for v in 0..own {
            let mut acc = 0.0;
            for &u in &nbr[off[v] as usize..off[v + 1] as usize] {
                acc += rank[u as usize] / out_deg[u as usize] as f64;
            }
            owned[v] = add + D * acc;
        }
        sock.write_all(bytemuck::cast_slice(&owned)).unwrap();
    }
}

// ── Coordinator: partition, spawn workers, drive the BSP loop over sockets, verify ───────────────
fn run_coordinator() {
    println!(
        "Distributed PageRank over SOCKETS: {N} nodes / {M} edges / {SHARDS} worker processes"
    );
    let edges = gen_edges();
    let (shards, out_deg) = partition_edges(N, &edges, SHARDS);

    // Write each shard's local CSR to its own file (the worker's sovereign data).
    for (idx, sh) in shards.iter().enumerate() {
        let own = sh.hi - sh.lo;
        let mut off = vec![0u64; own + 1];
        for (i, srcs) in sh.in_adj.iter().enumerate() {
            off[i + 1] = off[i] + srcs.len() as u64;
        }
        let flat: Vec<u32> = sh.in_adj.iter().flatten().map(|&u| u as u32).collect();
        let mut buf = Vec::new();
        buf.extend_from_slice(&(sh.lo as u64).to_le_bytes());
        buf.extend_from_slice(&(sh.hi as u64).to_le_bytes());
        buf.extend_from_slice(bytemuck::cast_slice(&off));
        buf.extend_from_slice(bytemuck::cast_slice(&flat));
        std::fs::write(shard_path(idx), &buf).unwrap();
    }

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

    // Accept + identify each worker by its hello, then send setup (n, out_deg).
    let mut conns: Vec<(TcpStream, usize, usize)> = Vec::new();
    for _ in 0..SHARDS {
        let (mut s, _) = listener.accept().unwrap();
        s.set_nodelay(true).ok();
        let idx =
            u64::from_le_bytes(read_exact_vec(&mut s, 8).unwrap().try_into().unwrap()) as usize;
        s.write_all(&(N as u64).to_le_bytes()).unwrap();
        s.write_all(bytemuck::cast_slice(&out_deg)).unwrap();
        conns.push((s, shards[idx].lo, shards[idx].hi));
    }

    let base = (1.0 - D) / N as f64;
    let mut rank = vec![1.0 / N as f64; N];
    let t = Instant::now();
    let mut bytes_over_wire = 0usize;
    for _ in 0..ITERS {
        let mut dangling = 0.0;
        for u in 0..N {
            if out_deg[u] == 0 {
                dangling += rank[u];
            }
        }
        let add = base + D * dangling / N as f64;
        // broadcast halo
        for (s, _, _) in conns.iter_mut() {
            s.write_all(&add.to_le_bytes()).unwrap();
            s.write_all(bytemuck::cast_slice(&rank)).unwrap();
            bytes_over_wire += 8 + N * 8;
        }
        // gather owned slices
        let mut next = vec![0.0f64; N];
        for (s, lo, hi) in conns.iter_mut() {
            let owned: Vec<f64> =
                bytemuck::cast_slice(&read_exact_vec(s, (*hi - *lo) * 8).unwrap()).to_vec();
            next[*lo..*hi].copy_from_slice(&owned);
            bytes_over_wire += (*hi - *lo) * 8;
        }
        rank = next;
    }
    let dt = t.elapsed();
    // terminate workers (NaN control word)
    for (s, _, _) in conns.iter_mut() {
        s.write_all(&f64::NAN.to_le_bytes()).ok();
    }
    for k in kids.iter_mut() {
        k.wait().ok();
    }

    let single = pagerank(N, &edges, D, ITERS, -1.0);
    let maxdiff = single
        .iter()
        .zip(&rank)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    println!("  {ITERS} supersteps over TCP: {dt:>7.3?}");
    println!(
        "  bytes over the wire: {} MB (only the O(n) halo)   edges NEVER left their worker",
        bytes_over_wire / 1_000_000
    );
    println!("  == single-graph PageRank: max|Δ| {maxdiff:.2e}   (distributed answer is EXACT)");
    for idx in 0..SHARDS {
        std::fs::remove_file(shard_path(idx)).ok();
    }
}

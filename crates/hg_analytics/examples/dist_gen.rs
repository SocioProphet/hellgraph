#![allow(clippy::needless_range_loop, clippy::doc_lazy_continuation)]
//! dist_gen — DISTRIBUTED generation + edge shuffle (#12): the coordinator-materialization killer.
//!
//! Every prior runtime made the coordinator generate the WHOLE graph in RAM before sharding, so a single
//! run was capped by the coordinator node's memory (the reason the billion needed a 192 GB coordinator, and
//! why 100B was impossible — 12.6 TB fits no node). Here NO node ever holds the whole graph:
//!   1. Each worker generates ONLY its edge slice `[id·m/k, (id+1)·m/k)` via the O(1)-seekable Kronecker.
//!   2. Workers ALL-TO-ALL shuffle: each edge (u,v) is routed to the worker that owns v (range partition).
//!   3. Each worker assembles the in-edges to its OWNED vertices + discovers its ghosts — a local shard.
//! The coordinator only relays addresses + verifies. Aggregate memory, not one node, bounds the graph → the
//! path to 100B. This proves the distributed partition is BIT-IDENTICAL to the centralized one (the invariant
//! `distributed_generation_reproduces_centralized_partition`, now as a live multi-process runtime).
//!
//!   cargo run -p hg_analytics --release --example dist_gen          # local: spawns k workers over loopback
//!   HG_SCALE=18 HG_SHARDS=8 cargo run -p hg_analytics --release --example dist_gen

use hg_analytics::{owner_of, range_bounds, Kronecker};
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Instant;

fn env_usize(key: &str, d: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}
fn read_vec(s: &mut impl Read, bytes: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0u8; bytes];
    s.read_exact(&mut b)?;
    Ok(b)
}
fn rd_u64(raw: &[u8], p: &mut usize) -> u64 {
    let v = u64::from_le_bytes(raw[*p..*p + 8].try_into().unwrap());
    *p += 8;
    v
}
fn connect_retry(addr: &str) -> TcpStream {
    for _ in 0..240 {
        if let Ok(s) = TcpStream::connect(addr) {
            return s;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    panic!("{addr} unreachable");
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("worker") {
        run_worker(
            &std::env::args().nth(2).unwrap(),
            std::env::args().nth(3).unwrap().parse().unwrap(),
        );
        return;
    }
    match std::env::var("HG_ROLE").as_deref() {
        Ok("worker") => {
            let addr = std::env::var("HG_COORD").expect("HG_COORD");
            let id = std::env::var("HG_ORDINAL")
                .or_else(|_| std::env::var("JOB_COMPLETION_INDEX"))
                .expect("ordinal")
                .parse()
                .unwrap();
            run_worker(&addr, id);
        }
        Ok("coordinator") => run_coordinator(
            &std::env::var("HG_LISTEN").unwrap_or_else(|_| "0.0.0.0:9000".into()),
            env_usize("HG_SHARDS", 8),
            false,
        ),
        _ => run_coordinator("127.0.0.1:0", env_usize("HG_SHARDS", 8), true),
    }
}

// ══ Worker ═══════════════════════════════════════════════════════════════════════════════════════════
fn run_worker(coord_addr: &str, id: usize) {
    let mut ctrl = connect_retry(coord_addr);
    ctrl.set_nodelay(true).ok();
    let advertise = std::env::var("HG_ADVERTISE").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = TcpListener::bind("0.0.0.0:0")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let my_addr = format!("{advertise}:{}", listener.local_addr().unwrap().port());
    ctrl.write_all(&(id as u64).to_le_bytes()).unwrap();
    ctrl.write_all(&(my_addr.len() as u64).to_le_bytes())
        .unwrap();
    ctrl.write_all(my_addr.as_bytes()).unwrap();

    // Params + bounds + roster.
    let hdr = read_vec(&mut ctrl, 40).unwrap();
    let mut p = 0;
    let scale = rd_u64(&hdr, &mut p) as u32;
    let ef = rd_u64(&hdr, &mut p) as usize;
    let seed = rd_u64(&hdr, &mut p);
    let k = rd_u64(&hdr, &mut p) as usize;
    let _iters = rd_u64(&hdr, &mut p);
    let bounds: Vec<usize> = (0..=k)
        .map(|_| rd_u64(&read_vec(&mut ctrl, 8).unwrap(), &mut 0) as usize)
        .collect();
    let roster: Vec<String> = (0..k)
        .map(|_| {
            let al = rd_u64(&read_vec(&mut ctrl, 8).unwrap(), &mut 0) as usize;
            String::from_utf8(read_vec(&mut ctrl, al).unwrap()).unwrap()
        })
        .collect();

    // 1. Generate ONLY this worker's edge slice (O(1) seek — no coordinator, no whole graph).
    let n = Kronecker::vertices(scale);
    let m = Kronecker::edges(scale, ef);
    let start = id * m / k;
    let count = (id + 1) * m / k - start;
    // 2. Bucket by target-owner. Also accumulate a per-SOURCE out-degree partial: each edge (u,v) is one of
    //    u's out-edges. Out-degree is a source property but edges shuffle by TARGET, so out_deg can't be
    //    counted from the received in-edges — we count it here (over the generated slice) and reduce it.
    let mut buckets: Vec<Vec<(u32, u32)>> = vec![Vec::new(); k];
    let mut out_deg_partial = vec![0u32; n];
    for (u, v) in Kronecker::slice(scale, seed, start, count) {
        out_deg_partial[u] += 1;
        buckets[owner_of(v, &bounds)].push((u as u32, v as u32));
    }

    // 3. ALL-TO-ALL shuffle. Mesh: connect to higher ids, accept from lower ids (id announced first).
    let mut peers: Vec<Option<TcpStream>> = (0..k).map(|_| None).collect();
    let lis = listener.try_clone().unwrap();
    let lower = id; // accept from ids 0..id
    let accept = std::thread::spawn(move || {
        let mut got: Vec<(usize, TcpStream)> = Vec::new();
        for _ in 0..lower {
            let (mut s, _) = lis.accept().unwrap();
            s.set_nodelay(true).ok();
            let peer = rd_u64(&read_vec(&mut s, 8).unwrap(), &mut 0) as usize;
            got.push((peer, s));
        }
        got
    });
    for d in (id + 1)..k {
        let mut s = connect_retry(&roster[d]);
        s.set_nodelay(true).ok();
        s.write_all(&(id as u64).to_le_bytes()).unwrap();
        peers[d] = Some(s);
    }
    for (peer, s) in accept.join().unwrap() {
        peers[peer] = Some(s);
    }
    // CONCURRENT writers + readers (thread per peer): sends must overlap receives, or a large write_all to
    // one peer serial-blocks (socket buffer fills) while that peer is likewise blocked writing to us → the
    // classic all-to-all deadlock (which large 8-worker buckets hit). Length-prefixed payloads.
    let mut writers = Vec::new();
    for d in 0..k {
        if d == id {
            continue;
        }
        let mut wr = peers[d].as_ref().unwrap().try_clone().unwrap();
        let b = std::mem::take(&mut buckets[d]);
        writers.push(std::thread::spawn(move || {
            wr.write_all(&(b.len() as u64).to_le_bytes()).unwrap();
            let mut payload = Vec::with_capacity(b.len() * 8);
            for &(u, v) in &b {
                payload.extend_from_slice(&u.to_le_bytes());
                payload.extend_from_slice(&v.to_le_bytes());
            }
            wr.write_all(&payload).unwrap();
        }));
    }
    let mut rx = Vec::new();
    for d in 0..k {
        if d == id {
            continue;
        }
        let mut rd = peers[d].as_ref().unwrap().try_clone().unwrap();
        let (tx, r) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let cnt = rd_u64(&read_vec(&mut rd, 8).unwrap(), &mut 0) as usize;
            let body = read_vec(&mut rd, cnt * 8).unwrap();
            tx.send(body).ok();
        });
        rx.push(r);
    }
    // My in-edges = my own self-bucket + everything received targeting my range.
    let mut in_edges: Vec<(u32, u32)> = std::mem::take(&mut buckets[id]);
    for r in rx {
        let body = r.recv().unwrap();
        for ch in body.chunks_exact(8) {
            let u = u32::from_le_bytes(ch[0..4].try_into().unwrap());
            let v = u32::from_le_bytes(ch[4..8].try_into().unwrap());
            in_edges.push((u, v));
        }
    }
    for w in writers {
        w.join().unwrap();
    }

    // 4. Local shard: owned range, ghost discovery, and the local in-CSR for the BSP PageRank.
    let (lo, hi) = (bounds[id], bounds[id + 1]);
    let owned = hi - lo;
    let mut ghost_set: BTreeSet<usize> = BTreeSet::new();
    for &(u, _v) in &in_edges {
        if (u as usize) < lo || (u as usize) >= hi {
            ghost_set.insert(u as usize);
        }
    }
    let ghosts: Vec<usize> = ghost_set.into_iter().collect();
    let ghost_idx: HashMap<usize, usize> =
        ghosts.iter().enumerate().map(|(i, &g)| (g, i)).collect();
    // Sort in-edges by (target, source): the network arrival order is nondeterministic, so sorting makes
    // the in-CSR — and thus the PageRank sum order — DETERMINISTIC run-to-run (and independent of node
    // count). Not bit-identical to the centralized generation-order build, but the same fixed point to
    // float tolerance, which is the bar for the distributed path.
    in_edges.sort_unstable_by_key(|&(u, v)| (v, u));
    let mut off = vec![0u32; owned + 1];
    for &(_u, v) in &in_edges {
        off[(v as usize - lo) + 1] += 1;
    }
    for v in 0..owned {
        off[v + 1] += off[v];
    }
    let mut nbr = vec![0u32; in_edges.len()];
    let mut cur = off.clone();
    for &(u, v) in &in_edges {
        let li = if (u as usize) >= lo && (u as usize) < hi {
            (u as usize - lo) as u32
        } else {
            (owned + ghost_idx[&(u as usize)]) as u32
        };
        let t = v as usize - lo;
        nbr[cur[t] as usize] = li;
        cur[t] += 1;
    }
    let _ = (&off, &nbr); // in-CSR ready for the BSP layer (round 2)

    // Fingerprint the in-edge SET in the CANONICAL (u,v) order (matches the coordinator's centralized sort,
    // independent of my (v,u) CSR ordering) so the cross-check compares SETS, not orderings.
    let mut fp_sorted = in_edges.clone();
    fp_sorted.sort_unstable();
    let fp = fnv1a(&fp_sorted);
    ctrl.write_all(&(in_edges.len() as u64).to_le_bytes())
        .unwrap();
    ctrl.write_all(&(ghosts.len() as u64).to_le_bytes())
        .unwrap();
    ctrl.write_all(&fp.to_le_bytes()).unwrap();
    // Send the out-degree partial (n u32) for the GLOBAL out-degree reduce on the coordinator (O(n), not
    // O(m) — the coordinator still never holds the edges).
    ctrl.write_all(bytemuck::cast_slice(&out_deg_partial))
        .unwrap();
}

fn fnv1a(edges: &[(u32, u32)]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for &(u, v) in edges {
        for b in u.to_le_bytes().iter().chain(v.to_le_bytes().iter()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

// ══ Coordinator ══════════════════════════════════════════════════════════════════════════════════════
fn run_coordinator(listen: &str, k: usize, spawn: bool) {
    let scale = env_usize("HG_SCALE", 18) as u32;
    let ef = env_usize("HG_EDGEFACTOR", 16);
    let iters = env_usize("HG_ITERS", 25);
    let seed = 0xB0A7u64;
    let n = Kronecker::vertices(scale);
    let m = Kronecker::edges(scale, ef);
    let bounds = range_bounds(n, k);
    println!("dist_gen: {n} nodes / {m} edges / {k} workers (scale {scale}, ef {ef}) — NO coordinator materialization");

    let listener = TcpListener::bind(listen).unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let mut kids = Vec::new();
    if spawn {
        let exe = std::env::current_exe().unwrap();
        kids = (0..k)
            .map(|i| {
                std::process::Command::new(&exe)
                    .args(["worker", &addr, &i.to_string()])
                    .spawn()
                    .unwrap()
            })
            .collect();
    } else {
        println!("  waiting for {k} workers on {listen} ...");
    }
    let mut roster = vec![String::new(); k];
    let mut conns: Vec<Option<TcpStream>> = (0..k).map(|_| None).collect();
    for _ in 0..k {
        let (mut s, _) = listener.accept().unwrap();
        s.set_nodelay(true).ok();
        let id = rd_u64(&read_vec(&mut s, 8).unwrap(), &mut 0) as usize;
        let al = rd_u64(&read_vec(&mut s, 8).unwrap(), &mut 0) as usize;
        roster[id] = String::from_utf8(read_vec(&mut s, al).unwrap()).unwrap();
        conns[id] = Some(s);
    }
    let roster_blob = {
        let mut b = Vec::new();
        for a in &roster {
            b.extend_from_slice(&(a.len() as u64).to_le_bytes());
            b.extend_from_slice(a.as_bytes());
        }
        b
    };
    for s in conns.iter_mut().flatten() {
        let mut hdr = Vec::new();
        for x in [scale as u64, ef as u64, seed, k as u64, iters as u64] {
            hdr.extend_from_slice(&x.to_le_bytes());
        }
        s.write_all(&hdr).unwrap();
        for &b in &bounds {
            s.write_all(&(b as u64).to_le_bytes()).unwrap();
        }
        s.write_all(&roster_blob).unwrap();
    }

    // Collect per-worker summaries (edge count, ghost count, fingerprint) + the out-degree partial reduce.
    // Summing n-length partials is O(n)·k coordinator work — NOT O(m); the coordinator still never holds
    // the edges (the #12 win). Ghost out-degrees + routing come from these in round 2.
    let t = Instant::now();
    let mut total_edges = 0u64;
    let mut total_ghosts = 0u64;
    let mut fps = vec![0u64; k];
    let mut out_deg = vec![0u32; n];
    for (c, s) in conns
        .iter_mut()
        .enumerate()
        .map(|(c, o)| (c, o.as_mut().unwrap()))
    {
        total_edges += rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
        total_ghosts += rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
        fps[c] = rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
        let raw = read_vec(s, n * 4).unwrap();
        for (v, ch) in raw.chunks_exact(4).enumerate() {
            out_deg[v] += u32::from_le_bytes(ch.try_into().unwrap());
        }
    }
    let dt = t.elapsed();
    for kid in kids.iter_mut() {
        kid.wait().ok();
    }

    println!("  distributed gen+shuffle: {dt:.2?}, {total_edges} in-edges assembled, {total_ghosts} total ghosts");
    assert_eq!(
        total_edges, m as u64,
        "distributed shuffle lost/duplicated edges"
    );

    // VERIFY: the distributed per-shard partition must equal the centralized range-partition, bit-for-bit.
    // (Only at verifiable scale — the whole point is the coordinator does NOT do this at billion scale.)
    if std::env::var("HG_VERIFY").as_deref() != Ok("0") {
        let mut central: Vec<Vec<(u32, u32)>> = vec![Vec::new(); k];
        let mut central_outdeg = vec![0u32; n];
        for (u, v) in Kronecker::new(scale, ef, seed) {
            central[owner_of(v, &bounds)].push((u as u32, v as u32));
            central_outdeg[u] += 1;
        }
        let mut ok = true;
        for c in 0..k {
            central[c].sort_unstable();
            if fnv1a(&central[c]) != fps[c] {
                ok = false;
                eprintln!("  shard {c} MISMATCH vs centralized");
            }
        }
        let outdeg_ok = out_deg == central_outdeg;
        println!(
            "  == vs centralized range-partition: {} (each shard's in-edge SET bit-identical)",
            if ok { "EXACT ✓" } else { "MISMATCH ✗" }
        );
        println!(
            "  == distributed out-degree reduce: {} (global out_deg == centralized)",
            if outdeg_ok {
                "EXACT ✓"
            } else {
                "MISMATCH ✗"
            }
        );
        assert!(
            ok && outdeg_ok,
            "distributed partition/out-degree diverged from centralized"
        );
    } else {
        println!(
            "  [HG_VERIFY=0: skipped the centralized cross-check — the coordinator holds NO edges]"
        );
    }
}

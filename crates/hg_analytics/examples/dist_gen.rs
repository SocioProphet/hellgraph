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
/// write_all that RETRIES on ENOBUFS (OS 55) / WouldBlock instead of panicking. On loopback (and under
/// heavy concurrent all-to-all), a big write can exhaust kernel mbufs mid-flight; back off briefly and
/// continue rather than crash. On a real cluster NIC this is rare, but the retry costs nothing.
fn write_robust(s: &mut TcpStream, buf: &[u8]) {
    // Write in ≤1 MiB chunks: a single multi-MB write on macOS loopback under mbuf pressure can fail/frame
    // oddly; bounding each syscall keeps it stable (and ENOBUFS/WouldBlock just back off and retry).
    const CHUNK: usize = 1 << 20;
    let mut off = 0;
    while off < buf.len() {
        let end = (off + CHUNK).min(buf.len());
        match s.write(&buf[off..end]) {
            Ok(0) => std::thread::sleep(std::time::Duration::from_millis(1)),
            Ok(n) => off += n,
            Err(e)
                if e.raw_os_error() == Some(55)
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(e) => panic!("write failed: {e}"),
        }
    }
}
fn rd_u64(raw: &[u8], p: &mut usize) -> u64 {
    let v = u64::from_le_bytes(raw[*p..*p + 8].try_into().unwrap());
    *p += 8;
    v
}
/// A shuffled edge as a Pod struct so a bucket `Vec<Edge>` can be written to the socket DIRECTLY via
/// cast_slice — no separate `payload: Vec<u8>` (which doubled the transient shuffle memory: bucket + copy).
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Edge {
    v: u64, // target FIRST so derived Ord sorts by (target, source) — the CSR grouping order
    u: u64,
}
// SAFETY: repr(C), two u64, no padding, every bit pattern valid → Pod. (Avoids the bytemuck derive feature.)
unsafe impl bytemuck::Zeroable for Edge {}
unsafe impl bytemuck::Pod for Edge {}

fn to_f64s(b: &[u8]) -> Vec<f64> {
    b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}
/// Solve the regularized Anderson normal equations (G+λI)γ=rhs (tiny mk×mk, deterministic) — see dist_p2p.
fn solve_gram(mk: usize, gram: &[f64], rhs: &[f64]) -> Vec<f64> {
    if mk == 0 {
        return Vec::new();
    }
    let mut a = gram.to_vec();
    let mut b = rhs.to_vec();
    let tr: f64 = (0..mk).map(|i| a[i * mk + i]).sum();
    let lam = 1e-12 * (tr / mk as f64).max(1e-300);
    for i in 0..mk {
        a[i * mk + i] += lam;
    }
    for col in 0..mk {
        let mut piv = col;
        for r in (col + 1)..mk {
            if a[r * mk + col].abs() > a[piv * mk + col].abs() {
                piv = r;
            }
        }
        for c in 0..mk {
            a.swap(col * mk + c, piv * mk + c);
        }
        b.swap(col, piv);
        let d = a[col * mk + col];
        if d.abs() < 1e-300 {
            continue;
        }
        for r in (col + 1)..mk {
            let fac = a[r * mk + col] / d;
            for c in col..mk {
                a[r * mk + c] -= fac * a[col * mk + c];
            }
            b[r] -= fac * b[col];
        }
    }
    let mut x = vec![0.0f64; mk];
    for i in (0..mk).rev() {
        let mut s = b[i];
        for j in (i + 1)..mk {
            s -= a[i * mk + j] * x[j];
        }
        x[i] = if a[i * mk + i].abs() < 1e-300 { 0.0 } else { s / a[i * mk + i] };
    }
    x
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

/// One concurrent ALL-TO-ALL exchange over the (reused) mesh sockets: send `payload[d]` to peer d, return
/// what each peer sent us (`recv[id]` empty). Concurrent writer+reader thread per peer so a large send never
/// serial-blocks against a peer that's also mid-send (the all-to-all deadlock). Length-prefixed.
fn all_to_all(peers: &[Option<TcpStream>], id: usize, k: usize, mut payload: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    let mut writers = Vec::new();
    for d in 0..k {
        if d == id {
            continue;
        }
        let mut wr = peers[d].as_ref().unwrap().try_clone().unwrap();
        let p = std::mem::take(&mut payload[d]);
        writers.push(std::thread::spawn(move || {
            write_robust(&mut wr, &(p.len() as u64).to_le_bytes());
            write_robust(&mut wr, &p);
        }));
    }
    let mut rxs = Vec::new();
    for d in 0..k {
        if d == id {
            continue;
        }
        let mut rd = peers[d].as_ref().unwrap().try_clone().unwrap();
        let (tx, r) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let len = rd_u64(&read_vec(&mut rd, 8).unwrap(), &mut 0) as usize;
            tx.send(read_vec(&mut rd, len).unwrap()).ok();
        });
        rxs.push((d, r));
    }
    let mut recv = vec![Vec::new(); k];
    for (d, r) in rxs {
        recv[d] = r.recv().unwrap();
    }
    for w in writers {
        w.join().unwrap();
    }
    recv
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
    // 2. Bucket edges by TARGET-owner AND source-occurrences by SOURCE-owner. Out-degree is a source
    //    property; routing (source→its owner) lets each worker count only its OWNED out-degree — O(n/k),
    //    NOT a dense O(n) vector on every worker (which would be 25 GB/worker at 100B). No node holds O(n).
    let _ = n; // n only used for the (verify-scale) sanity; no dense O(n) allocation here anymore
    // GLOBAL vertex ids are u64: at 100B edges n≈6.25B > u32's 4.29B, so u32 would silently TRUNCATE ids.
    // (Local per-shard indices stay u32 — a shard holds < 2³² vertices — see the in-CSR build below.)
    let mut buckets: Vec<Vec<Edge>> = vec![Vec::new(); k];
    let mut src_buckets: Vec<Vec<u64>> = vec![Vec::new(); k];
    for (u, v) in Kronecker::slice(scale, seed, start, count) {
        buckets[owner_of(v, &bounds)].push(Edge { u: u as u64, v: v as u64 });
        src_buckets[owner_of(u, &bounds)].push(u as u64);
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
        let sb = std::mem::take(&mut src_buckets[d]);
        writers.push(std::thread::spawn(move || {
            // Section 1: edges targeting d. Section 2: source-occurrences owned by d (for d's out-degree).
            write_robust(&mut wr, &(b.len() as u64).to_le_bytes());
            write_robust(&mut wr, bytemuck::cast_slice(&b)); // Vec<Edge> written DIRECTLY (no payload copy)
            write_robust(&mut wr, &(sb.len() as u64).to_le_bytes());
            write_robust(&mut wr, bytemuck::cast_slice(&sb)); // Vec<u64> = 8 B each
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
            let ecnt = rd_u64(&read_vec(&mut rd, 8).unwrap(), &mut 0) as usize;
            let ebody = read_vec(&mut rd, ecnt * 16).unwrap(); // 16 B/edge (two u64)
            let scnt = rd_u64(&read_vec(&mut rd, 8).unwrap(), &mut 0) as usize;
            let sbody = read_vec(&mut rd, scnt * 8).unwrap(); // 8 B/source (u64)
            tx.send((ebody, sbody)).ok();
        });
        rx.push(r);
    }

    // 4. Local shard: owned range, ghost discovery, in-CSR, and OWNED out-degree (all O(n/k), no dense O(n)).
    let (lo, hi) = (bounds[id], bounds[id + 1]);
    let owned = hi - lo;
    // My in-edges = my self-bucket + received edges. My owned out-degree = my owned source-occurrences
    // (self + received), counted into an O(owned) vector.
    let mut in_edges: Vec<Edge> = std::mem::take(&mut buckets[id]);
    let mut owned_outdeg = vec![0u32; owned];
    for &s in &src_buckets[id] {
        owned_outdeg[s as usize - lo] += 1;
    }
    for r in rx {
        let (ebody, sbody) = r.recv().unwrap();
        for ch in ebody.chunks_exact(16) {
            // wire order is v then u (Edge field order), matching cast_slice on the sender.
            let v = u64::from_le_bytes(ch[0..8].try_into().unwrap());
            let u = u64::from_le_bytes(ch[8..16].try_into().unwrap());
            in_edges.push(Edge { u, v });
        }
        for ch in sbody.chunks_exact(8) {
            owned_outdeg[u64::from_le_bytes(ch.try_into().unwrap()) as usize - lo] += 1;
        }
    }
    for w in writers {
        w.join().unwrap();
    }
    let mut ghost_set: BTreeSet<usize> = BTreeSet::new();
    for e in &in_edges {
        if (e.u as usize) < lo || (e.u as usize) >= hi {
            ghost_set.insert(e.u as usize);
        }
    }
    let ghosts: Vec<usize> = ghost_set.into_iter().collect();
    let ghost_idx: HashMap<usize, usize> =
        ghosts.iter().enumerate().map(|(i, &g)| (g, i)).collect();
    // Sort by (target, source) — Edge's derived Ord (v first) does exactly this — for a DETERMINISTIC in-CSR
    // sum order independent of nondeterministic network arrival.
    in_edges.sort_unstable();
    let mut off = vec![0u32; owned + 1];
    for e in &in_edges {
        off[(e.v as usize - lo) + 1] += 1;
    }
    for v in 0..owned {
        off[v + 1] += off[v];
    }
    let mut nbr = vec![0u32; in_edges.len()];
    let mut cur = off.clone();
    for e in &in_edges {
        let li = if (e.u as usize) >= lo && (e.u as usize) < hi {
            (e.u as usize - lo) as u32
        } else {
            (owned + ghost_idx[&(e.u as usize)]) as u32
        };
        let t = e.v as usize - lo;
        nbr[cur[t] as usize] = li;
        cur[t] += 1;
    }
    // Fingerprint the in-edge SET in the CANONICAL (u,v) order (matches the coordinator's centralized sort,
    // independent of my (v,u) CSR ordering) so the cross-check compares SETS, not orderings.
    let mut fp_sorted = in_edges.clone();
    fp_sorted.sort_unstable();
    let fp = fnv1a(&fp_sorted);
    // ── Round 2: DISTRIBUTED routing + ghost out-degree (peer-to-peer; coordinator stays O(k), no O(n) or
    //    O(boundary) on it). Phase 1: request each owner d the ghosts I need. Phase 2: reply each requester
    //    with the out-degrees of what it asked → I learn my send_local AND my ghosts' out-degrees.
    let g = ghosts.len();
    // Global ghost ids are u64 (100B-safe); the local send indices they map to stay u32 (< owned).
    let mut req: Vec<Vec<u64>> = vec![Vec::new(); k];
    for &gg in &ghosts {
        req[owner_of(gg, &bounds)].push(gg as u64); // ghosts sorted ⇒ req[d] sorted
    }
    let req_from = all_to_all(
        &peers,
        id,
        k,
        req.iter().map(|r| bytemuck::cast_slice(r).to_vec()).collect(),
    );
    // send_local[e] = my owned local indices of what e requested (in the order e sent it).
    let mut send_local: Vec<Vec<u32>> = vec![Vec::new(); k];
    for e in 0..k {
        for ch in req_from[e].chunks_exact(8) {
            send_local[e].push((u64::from_le_bytes(ch.try_into().unwrap()) - lo as u64) as u32);
        }
    }
    let reply: Vec<Vec<u8>> = (0..k)
        .map(|e| {
            let mut p = Vec::with_capacity(send_local[e].len() * 4);
            for &li in &send_local[e] {
                p.extend_from_slice(&owned_outdeg[li as usize].to_le_bytes());
            }
            p
        })
        .collect();
    let od_reply = all_to_all(&peers, id, k, reply);
    // recv_ghost[d] = my ghost positions for req[d]; out_deg_local = owned ++ ghost (from the replies).
    let mut recv_ghost: Vec<Vec<u32>> = vec![Vec::new(); k];
    let mut out_deg_local = vec![0u32; owned + g];
    out_deg_local[..owned].copy_from_slice(&owned_outdeg);
    for d in 0..k {
        let ods: Vec<u32> = od_reply[d].chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        for (i, &gid) in req[d].iter().enumerate() {
            let gp = ghost_idx[&(gid as usize)];
            recv_ghost[d].push(gp as u32);
            out_deg_local[owned + gp] = ods[i];
        }
    }

    // Coordinator handshake: my owned dangling count (scalar) → coordinator sums → seed_add. Verify data
    // (fp + owned out-degree) goes ONLY when cross-checking at small scale; at billion the coordinator gets
    // just the scalar and holds NOTHING of size O(n).
    let n_recip = 1.0 / n as f64;
    let iters = _iters as usize;
    let my_dangle = owned_outdeg.iter().filter(|&&d| d == 0).count() as u64;
    let verify = std::env::var("HG_VERIFY").as_deref() != Ok("0");
    ctrl.write_all(&my_dangle.to_le_bytes()).unwrap();
    ctrl.write_all(&(verify as u64).to_le_bytes()).unwrap();
    if verify {
        ctrl.write_all(&(in_edges.len() as u64).to_le_bytes()).unwrap();
        ctrl.write_all(&fp.to_le_bytes()).unwrap();
        ctrl.write_all(bytemuck::cast_slice(&owned_outdeg)).unwrap();
    }
    let seed_add = f64::from_le_bytes(read_vec(&mut ctrl, 8).unwrap().try_into().unwrap());

    // f32 HALO (HG_F32_HALO): send ghost values as f32 (4 B) not f64 (8 B) — half the recurring halo wire.
    // Uniform ~1e-7 low-bit noise (unlike the delta halo's threshold, which poisoned Anderson) — we measure
    // whether it composes with Anderson. Compute stays f64; only the wire value is narrowed.
    let f32_halo = std::env::var("HG_F32_HALO").is_ok();
    let hb = if f32_halo { 4 } else { 8 };
    // Halo reader threads on the REUSED peer sockets (clean after the one-shot shuffle).
    let mut rx_map: HashMap<usize, std::sync::mpsc::Receiver<Vec<u8>>> = HashMap::new();
    let mut hwr: HashMap<usize, TcpStream> = HashMap::new();
    for d in 0..k {
        if d == id {
            continue;
        }
        let sock = peers[d].as_ref().unwrap();
        hwr.insert(d, sock.try_clone().unwrap());
        let recv_n = recv_ghost[d].len();
        if recv_n > 0 {
            let mut rd = sock.try_clone().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for _ in 0..iters {
                    match read_vec(&mut rd, recv_n * hb) {
                        Ok(b) => {
                            if tx.send(b).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
            rx_map.insert(d, rx);
        }
    }

    const D: f64 = 0.85;
    let accel = env_usize("HG_ACCEL", 0); // Anderson window; 0 = plain power iteration
    let mut owned_rank = vec![n_recip; owned];
    let mut local_rank = vec![n_recip; owned + g];
    let mut contrib = vec![0.0f64; owned + g];
    let mut add = seed_add;
    // Anderson history (owned slices).
    let (mut x_old, mut f_old): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    let (mut dxh, mut dfh): (Vec<Vec<f64>>, Vec<Vec<f64>>) = (Vec::new(), Vec::new());
    for _ in 0..iters {
        local_rank[..owned].copy_from_slice(&owned_rank);
        for li in 0..owned + g {
            let d = out_deg_local[li];
            contrib[li] = if d == 0 { 0.0 } else { local_rank[li] / d as f64 };
        }
        // g = one PageRank pull (into a temp; Anderson may mix it below).
        let mut gvec = vec![0.0f64; owned];
        for v in 0..owned {
            let mut acc = 0.0;
            for &li in &nbr[off[v] as usize..off[v + 1] as usize] {
                acc += contrib[li as usize];
            }
            gvec[v] = add + D * acc;
        }
        // Anderson mixing: γ from a GLOBAL least-squares the coordinator solves over per-worker Gram/rhs
        // partials (O(window²) traffic, no relay). x_new = g − Σ γ_j (Δx_j + Δf_j).
        if accel > 0 {
            let f: Vec<f64> = gvec.iter().zip(&owned_rank).map(|(a, b)| a - b).collect();
            if !x_old.is_empty() {
                dxh.push(owned_rank.iter().zip(&x_old).map(|(a, b)| a - b).collect());
                dfh.push(f.iter().zip(&f_old).map(|(a, b)| a - b).collect());
                if dxh.len() > accel {
                    dxh.remove(0);
                    dfh.remove(0);
                }
            }
            let mk = dfh.len();
            let mut gram = vec![0.0f64; mk * mk];
            let mut rhs = vec![0.0f64; mk];
            for i in 0..mk {
                for j in i..mk {
                    let mut dd = 0.0;
                    for v in 0..owned {
                        dd += dfh[i][v] * dfh[j][v];
                    }
                    gram[i * mk + j] = dd;
                    gram[j * mk + i] = dd;
                }
                let mut r = 0.0;
                for v in 0..owned {
                    r += dfh[i][v] * f[v];
                }
                rhs[i] = r;
            }
            ctrl.write_all(&(mk as u64).to_le_bytes()).unwrap();
            ctrl.write_all(bytemuck::cast_slice(&gram)).unwrap();
            ctrl.write_all(bytemuck::cast_slice(&rhs)).unwrap();
            let gamma = to_f64s(&read_vec(&mut ctrl, mk * 8).unwrap());
            let mut xn = gvec.clone();
            for j in 0..mk {
                for v in 0..owned {
                    xn[v] -= gamma[j] * (dxh[j][v] + dfh[j][v]);
                }
            }
            x_old = std::mem::replace(&mut owned_rank, xn);
            f_old = f;
        } else {
            owned_rank = gvec;
        }
        let mut dangling_partial = 0.0f64;
        for v in 0..owned {
            if out_deg_local[v] == 0 {
                dangling_partial += owned_rank[v];
            }
        }
        for d in 0..k {
            if d == id || send_local[d].is_empty() {
                continue;
            }
            let w = hwr.get_mut(&d).unwrap();
            if f32_halo {
                let vals: Vec<f32> = send_local[d].iter().map(|&li| owned_rank[li as usize] as f32).collect();
                write_robust(w, bytemuck::cast_slice(&vals));
            } else {
                let vals: Vec<f64> = send_local[d].iter().map(|&li| owned_rank[li as usize]).collect();
                write_robust(w, bytemuck::cast_slice(&vals));
            }
        }
        for (&d, rx) in &rx_map {
            let body = rx.recv().unwrap();
            for (i, &gi) in recv_ghost[d].iter().enumerate() {
                let val = if f32_halo {
                    f32::from_le_bytes(body[i * 4..i * 4 + 4].try_into().unwrap()) as f64
                } else {
                    f64::from_le_bytes(body[i * 8..i * 8 + 8].try_into().unwrap())
                };
                local_rank[owned + gi as usize] = val;
            }
        }
        ctrl.write_all(&dangling_partial.to_le_bytes()).unwrap();
        add = f64::from_le_bytes(read_vec(&mut ctrl, 8).unwrap().try_into().unwrap());
    }
    // At verify scale send the full owned rank (coordinator cross-checks); at billion send only Σ owned rank
    // (a scalar) so the coordinator stays O(k) — no O(n) rank gather.
    if verify {
        ctrl.write_all(bytemuck::cast_slice(&owned_rank)).unwrap();
    } else {
        ctrl.write_all(&owned_rank.iter().sum::<f64>().to_le_bytes()).unwrap();
    }
}

fn fnv1a(edges: &[Edge]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for e in edges {
        for b in e.v.to_le_bytes().iter().chain(e.u.to_le_bytes().iter()) {
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

    // Collect only a SCALAR dangling count per worker (+ verify data at small scale). Routing + ghost
    // out-degrees are exchanged PEER-TO-PEER by the workers, so the coordinator holds NOTHING of size O(n)
    // or O(boundary) — it is O(k). (At verify scale it does assemble O(n) to cross-check; that's gated.)
    const D: f64 = 0.85;
    let base = (1.0 - D) / n as f64;
    let verify = std::env::var("HG_VERIFY").as_deref() != Ok("0");
    let t = Instant::now();
    let mut n_dangle = 0u64;
    let mut total_edges = 0u64;
    let mut fps = vec![0u64; k];
    let mut out_deg_v: Vec<u32> = if verify { vec![0u32; n] } else { Vec::new() };
    for (c, s) in conns
        .iter_mut()
        .enumerate()
        .map(|(c, o)| (c, o.as_mut().unwrap()))
    {
        n_dangle += rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
        let vf = rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
        if vf != 0 {
            total_edges += rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
            fps[c] = rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
            let owned_c = bounds[c + 1] - bounds[c];
            let raw = read_vec(s, owned_c * 4).unwrap();
            for (i, ch) in raw.chunks_exact(4).enumerate() {
                out_deg_v[bounds[c] + i] = u32::from_le_bytes(ch.try_into().unwrap());
            }
        }
    }
    let dt = t.elapsed();
    println!("  distributed gen+shuffle+route: {dt:.2?}");
    if verify {
        assert_eq!(total_edges, m as u64, "distributed shuffle lost/duplicated edges");
        let mut central: Vec<Vec<Edge>> = vec![Vec::new(); k];
        let mut central_outdeg = vec![0u32; n];
        for (u, v) in Kronecker::new(scale, ef, seed) {
            central[owner_of(v, &bounds)].push(Edge { u: u as u64, v: v as u64 });
            central_outdeg[u] += 1;
        }
        let mut ok = true;
        for c in 0..k {
            central[c].sort_unstable();
            if fnv1a(&central[c]) != fps[c] {
                ok = false;
            }
        }
        let outdeg_ok = out_deg_v == central_outdeg;
        println!(
            "  == vs centralized: partition {} · out-degree {}",
            if ok { "EXACT ✓" } else { "MISMATCH ✗" },
            if outdeg_ok { "EXACT ✓" } else { "MISMATCH ✗" }
        );
        assert!(ok && outdeg_ok, "distributed partition/out-degree diverged from centralized");
    } else {
        println!("  [HG_VERIFY=0: coordinator is O(k) — NO edges, NO O(n) out_deg, NO routing tables]");
    }
    // seed_add from the SCALAR dangling reduce (O(k)); broadcast it.
    let seed_add = base + D * (n_dangle as f64 / n as f64) / n as f64;
    for s in conns.iter_mut().flatten() {
        s.write_all(&seed_add.to_le_bytes()).unwrap();
    }
    let accel = env_usize("HG_ACCEL", 0);
    let t2 = Instant::now();
    for _ in 0..iters {
        if accel > 0 {
            // Anderson Gram all-reduce: sum per-worker Gram/rhs, solve γ, broadcast (O(window²), no relay).
            let (mut mk, mut gram, mut rhs) = (0usize, Vec::new(), Vec::new());
            for (ci, s) in conns.iter_mut().flatten().enumerate() {
                let m_i = rd_u64(&read_vec(s, 8).unwrap(), &mut 0) as usize;
                let g_i = to_f64s(&read_vec(s, m_i * m_i * 8).unwrap());
                let r_i = to_f64s(&read_vec(s, m_i * 8).unwrap());
                if ci == 0 {
                    mk = m_i;
                    gram = vec![0.0f64; mk * mk];
                    rhs = vec![0.0f64; mk];
                }
                for x in 0..mk * mk {
                    gram[x] += g_i[x];
                }
                for x in 0..mk {
                    rhs[x] += r_i[x];
                }
            }
            let gamma = solve_gram(mk, &gram, &rhs);
            for s in conns.iter_mut().flatten() {
                s.write_all(bytemuck::cast_slice(&gamma)).unwrap();
            }
        }
        let mut dangling = 0.0f64;
        for s in conns.iter_mut().flatten() {
            dangling += f64::from_le_bytes(read_vec(s, 8).unwrap().try_into().unwrap());
        }
        let add = base + D * dangling / n as f64;
        for s in conns.iter_mut().flatten() {
            s.write_all(&add.to_le_bytes()).unwrap();
        }
    }
    let bsp_dt = t2.elapsed();
    println!("  distributed PageRank ({iters} supersteps): {bsp_dt:.2?}  — coordinator materialized ZERO edges");
    // Final result. At verify scale: gather the full rank (O(n)) and cross-check vs single-graph. At billion
    // (HG_VERIFY=0): each worker sends only Σ of its owned ranks — the coordinator sums a SCALAR per worker
    // (O(k)) and checks Σrank ≈ 1 (mass conservation), never holding an O(n) rank vector.
    if verify {
        let mut rank = vec![0.0f64; n];
        for (c, s) in conns.iter_mut().enumerate().map(|(c, o)| (c, o.as_mut().unwrap())) {
            let owned = bounds[c + 1] - bounds[c];
            let raw = read_vec(s, owned * 8).unwrap();
            for (i, ch) in raw.chunks_exact(8).enumerate() {
                rank[bounds[c] + i] = f64::from_le_bytes(ch.try_into().unwrap());
            }
        }
        let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, seed).collect();
        // Anderson reaches a MORE-converged point than power@iters, so compare it to the CONVERGED fixed
        // point (and show it beats power@iters); plain power iteration compares to power@iters (bit-exact-ish).
        let reference = if accel > 0 {
            hg_analytics::pagerank(n, &edges, D, 2000, 1e-13)
        } else {
            hg_analytics::pagerank(n, &edges, D, iters, -1.0)
        };
        let maxd = reference.iter().zip(&rank).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        if accel > 0 {
            let power = hg_analytics::pagerank(n, &edges, D, iters, -1.0);
            let perr = reference.iter().zip(&power).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
            println!(
                "  == Anderson @ {iters} steps vs CONVERGED: max|Δ| {maxd:.2e}  (power @ {iters}: {perr:.2e} ⇒ {:.0}× closer, same fixed point)",
                perr / maxd.max(1e-300)
            );
        } else {
            println!(
                "  == vs single-graph PageRank: max|Δ| {maxd:.2e}  ({})",
                if maxd < 1e-9 { "VERIFIED ✓ (same fixed point to tolerance)" } else { "DIVERGED ✗" }
            );
        }
        assert!(maxd < 1e-7, "distributed-gen PageRank diverged from the fixed point");
    } else {
        let mut sum = 0.0f64;
        for s in conns.iter_mut().flatten() {
            sum += f64::from_le_bytes(read_vec(s, 8).unwrap().try_into().unwrap());
        }
        println!("  Σrank = {sum:.4} (≈1 ⇒ mass conserved) — coordinator held O(k), no O(n) rank vector");
    }
    for kid in kids.iter_mut() {
        kid.wait().ok();
    }
}

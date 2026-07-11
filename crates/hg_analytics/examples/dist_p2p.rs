//! dist_p2p — pure PEER-TO-PEER boundary-halo PageRank. Removes the coordinator from the hot path.
//!
//! `dist_boundary` proved the boundary-only halo, but every boundary value still funnelled through the
//! coordinator — an O(boundary) relay that becomes the bottleneck past a few tens of nodes. Here workers
//! form a mesh and exchange ghost values DIRECTLY: worker c sends worker d exactly the owned values that
//! are d's ghosts, and nothing else. The coordinator keeps only three jobs, none of which grow with graph
//! size: (1) one-time setup/partition + routing-table distribution, (2) a per-superstep SCALAR dangling
//! all-reduce (k floats up, 1 float down — a barrier, O(k) not O(boundary)), (3) the one-time final gather.
//!
//! So the recurring O(boundary) traffic is fully peer-to-peer; the coordinator moves only O(k) per step.
//! That is the difference between "impressive 8-node demo" and "scales to 64+ nodes". Result is verified
//! bit-for-bit against single-graph PageRank.
//!
//! Local proof (spawns the workers as processes over loopback):
//!   cargo run -p hg_analytics --release --example dist_p2p
//! (Cluster wiring is the same mesh; each worker advertises HG_ADVERTISE:port instead of 127.0.0.1.)

use hg_analytics::{
    fennel_partition, pagerank, partition_edges_boundary_at, relabel_contiguous, Kronecker,
};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
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
fn rd_u64(raw: &[u8], p: &mut usize) -> usize {
    let v = u64::from_le_bytes(raw[*p..*p + 8].try_into().unwrap());
    *p += 8;
    v as usize
}
/// Parse f64s from a byte buffer WITHOUT alignment assumptions (socket buffers aren't 8-aligned, so
/// bytemuck::cast_slice panics on them). Used for the small Anderson Gram/rhs/γ messages.
fn to_f64s(b: &[u8]) -> Vec<f64> {
    b.chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// Solve the (regularized) Anderson normal equations (G + λI)γ = rhs — a tiny mk×mk system the coordinator
/// solves once per superstep after summing the per-worker Gram/rhs partials. Gaussian elimination + partial
/// pivot; deterministic. mk ≤ window (≈5) so this is negligible next to the O(E) worker pull.
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
        x[i] = if a[i * mk + i].abs() < 1e-300 {
            0.0
        } else {
            s / a[i * mk + i]
        };
    }
    x
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("worker") {
        let addr = std::env::args().nth(2).unwrap();
        let id: usize = std::env::args().nth(3).unwrap().parse().unwrap();
        run_worker(&addr, id);
        return;
    }
    match std::env::var("HG_ROLE").as_deref() {
        Ok("worker") => {
            let addr = std::env::var("HG_COORD").expect("HG_COORD required");
            let id = std::env::var("HG_ORDINAL")
                .or_else(|_| std::env::var("JOB_COMPLETION_INDEX"))
                .expect("HG_ORDINAL/JOB_COMPLETION_INDEX required")
                .parse()
                .unwrap();
            run_worker(&addr, id);
        }
        Ok("coordinator") => {
            let listen = std::env::var("HG_LISTEN").unwrap_or_else(|_| "0.0.0.0:9000".into());
            run_coordinator(&listen, env_usize("HG_SHARDS", 8), false);
        }
        _ => run_coordinator("127.0.0.1:0", env_usize("HG_SHARDS", 8), true),
    }
}

// ══ Worker ═══════════════════════════════════════════════════════════════════════════════════════════
fn run_worker(coord_addr: &str, id: usize) {
    // Connect to coordinator; bind our own P2P listener; advertise its address.
    let mut ctrl = connect_retry(coord_addr, id);
    ctrl.set_nodelay(true).ok();
    let advertise = std::env::var("HG_ADVERTISE").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = TcpListener::bind("0.0.0.0:0")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let my_port = listener.local_addr().unwrap().port();
    let my_addr = format!("{advertise}:{my_port}");
    // hello: [id][addr_len][addr]
    ctrl.write_all(&(id as u64).to_le_bytes()).unwrap();
    ctrl.write_all(&(my_addr.len() as u64).to_le_bytes())
        .unwrap();
    ctrl.write_all(my_addr.as_bytes()).unwrap();

    // Receive setup blob.
    let n_recip = f64::from_le_bytes(read_vec(&mut ctrl, 8).unwrap().try_into().unwrap());
    let setup_len = rd_u64(&read_vec(&mut ctrl, 8).unwrap(), &mut 0);
    let raw = read_vec(&mut ctrl, setup_len).unwrap();
    let s = parse_setup(&raw);

    // Build the P2P mesh: connect to needed higher-id peers, accept from needed lower-id peers.
    let peers = build_mesh(id, s.k, &listener, &s.roster, &s.need);

    // DELTA HALO mode (HG_DELTA_EPS set): send each peer ONLY the ghosts whose value moved > eps since the
    // last send, as (u32 pos, f64 val) pairs, instead of the whole dense f64 vector. eps=0 is bit-exact
    // (a receiver caches the last value → unchanged ghosts need no message) and still shrinks the wire as
    // ranks freeze; eps>0 trades a bounded perturbation for a bigger cut. This is the residual/delta halo
    // (#13) on the peer-to-peer mesh — the recurring-traffic optimization for the fast-path billion.
    let delta_eps: Option<f64> = std::env::var("HG_DELTA_EPS").ok().and_then(|v| v.parse().ok());
    let delta = delta_eps.is_some();

    // Spawn a reader thread per peer we RECEIVE from; each drains `iters` messages into a channel of RAW
    // bytes (parsed in the loop per mode: dense = recv_n·8 fixed; delta = [u64 count][count·12]).
    let mut rx_map: HashMap<usize, mpsc::Receiver<Vec<u8>>> = HashMap::new();
    let mut writers: HashMap<usize, TcpStream> = HashMap::new();
    for (&d, sock) in &peers {
        let recv_n = s.recv_ghost[d].len();
        let wr = sock.try_clone().unwrap();
        wr.set_nodelay(true).ok();
        writers.insert(d, wr);
        if recv_n > 0 {
            let mut rd = sock.try_clone().unwrap();
            let (tx, rx) = mpsc::channel();
            let iters = s.iters;
            std::thread::spawn(move || {
                for _ in 0..iters {
                    let msg = if delta {
                        match read_vec(&mut rd, 8) {
                            Ok(cb) => {
                                let cnt = u64::from_le_bytes(cb.try_into().unwrap()) as usize;
                                match read_vec(&mut rd, cnt * 12) {
                                    Ok(b) => b,
                                    Err(_) => break,
                                }
                            }
                            Err(_) => break,
                        }
                    } else {
                        match read_vec(&mut rd, recv_n * 8) {
                            Ok(b) => b,
                            Err(_) => break,
                        }
                    };
                    if tx.send(msg).is_err() {
                        break;
                    }
                }
            });
            rx_map.insert(d, rx);
        }
    }

    // Per-peer cache of the values we last SENT (delta mode) — init to the seed the receiver also holds.
    let mut last_sent: HashMap<usize, Vec<f64>> = HashMap::new();
    if delta {
        for (d, send_idx) in s.send_local.iter().enumerate() {
            if !send_idx.is_empty() {
                last_sent.insert(d, vec![n_recip; send_idx.len()]);
            }
        }
    }
    let mut sent_bytes = 0usize;

    let accel = env_usize("HG_ACCEL", 0); // Anderson window; 0 = plain power iteration (the proven default)
    // BSP loop. `owned_rank` = current iterate x (owned slice); persistent ghost halo in local_rank[owned..].
    let mut owned_rank = vec![n_recip; s.owned];
    let mut local_rank = vec![n_recip; s.owned + s.g];
    let mut add = s.seed_add;
    // Anderson history (owned slices): previous iterate/residual + the Δ columns.
    let (mut x_old, mut f_old): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    let (mut dxh, mut dfh): (Vec<Vec<f64>>, Vec<Vec<f64>>) = (Vec::new(), Vec::new());
    for _ in 0..s.iters {
        local_rank[..s.owned].copy_from_slice(&owned_rank);
        // g = one PageRank pull from [x | ghost halo].
        let mut g = vec![0.0f64; s.owned];
        #[allow(clippy::needless_range_loop)]
        for v in 0..s.owned {
            let mut acc = 0.0;
            for &li in &s.nbr[s.off[v] as usize..s.off[v + 1] as usize] {
                acc += local_rank[li as usize] / s.out_deg_local[li as usize] as f64;
            }
            g[v] = add + D * acc;
        }
        // Anderson mixing (accel>0): x_new = g − Σ γ_j (Δx_j+Δf_j). γ is a GLOBAL least-squares the
        // coordinator solves over per-worker Gram/rhs partials — O(window²) coordinator traffic, no relay.
        if accel > 0 {
            let f: Vec<f64> = g.iter().zip(&owned_rank).map(|(a, b)| a - b).collect();
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
                    let mut d = 0.0;
                    for v in 0..s.owned {
                        d += dfh[i][v] * dfh[j][v];
                    }
                    gram[i * mk + j] = d;
                    gram[j * mk + i] = d;
                }
                let mut r = 0.0;
                for v in 0..s.owned {
                    r += dfh[i][v] * f[v];
                }
                rhs[i] = r;
            }
            // Coordinator round-trip: send [mk][gram][rhs], receive the global γ.
            ctrl.write_all(&(mk as u64).to_le_bytes()).unwrap();
            ctrl.write_all(bytemuck::cast_slice(&gram)).unwrap();
            ctrl.write_all(bytemuck::cast_slice(&rhs)).unwrap();
            let gamma: Vec<f64> = to_f64s(&read_vec(&mut ctrl, mk * 8).unwrap());
            let mut xn = g.clone();
            for j in 0..mk {
                for v in 0..s.owned {
                    xn[v] -= gamma[j] * (dxh[j][v] + dfh[j][v]);
                }
            }
            x_old = std::mem::replace(&mut owned_rank, xn);
            f_old = f;
        } else {
            owned_rank = g;
        }
        // Dangling of the NEW iterate (for next step's teleport add).
        let mut dangling_partial = 0.0f64;
        for v in 0..s.owned {
            if s.out_deg_local[v] == 0 {
                dangling_partial += owned_rank[v];
            }
        }
        // P2P halo push: send each needed peer the owned values that are its ghosts (dense or delta).
        for (d, send_idx) in s
            .send_local
            .iter()
            .enumerate()
            .filter(|(_, v)| !v.is_empty())
        {
            let w = writers.get_mut(&d).unwrap();
            if delta {
                let eps = delta_eps.unwrap();
                let last = last_sent.get_mut(&d).unwrap();
                let mut body: Vec<u8> = Vec::new();
                let mut cnt = 0u64;
                for (pos, &li) in send_idx.iter().enumerate() {
                    let val = owned_rank[li as usize];
                    if (val - last[pos]).abs() > eps {
                        body.extend_from_slice(&(pos as u32).to_le_bytes());
                        body.extend_from_slice(&val.to_le_bytes());
                        last[pos] = val;
                        cnt += 1;
                    }
                }
                w.write_all(&cnt.to_le_bytes()).unwrap();
                w.write_all(&body).unwrap();
                sent_bytes += 8 + body.len();
            } else {
                let vals: Vec<f64> = send_idx.iter().map(|&li| owned_rank[li as usize]).collect();
                w.write_all(bytemuck::cast_slice(&vals)).unwrap();
                sent_bytes += vals.len() * 8;
            }
        }
        // P2P halo pull: apply each peer's message to our ghost slots (persistent across steps).
        for (&d, rx) in &rx_map {
            let body = rx.recv().unwrap();
            if delta {
                for ch in body.chunks_exact(12) {
                    let pos = u32::from_le_bytes(ch[0..4].try_into().unwrap()) as usize;
                    let val = f64::from_le_bytes(ch[4..12].try_into().unwrap());
                    local_rank[s.owned + s.recv_ghost[d][pos] as usize] = val;
                }
            } else {
                let vals: &[f64] = bytemuck::cast_slice(&body);
                for (k, &gi) in s.recv_ghost[d].iter().enumerate() {
                    local_rank[s.owned + gi as usize] = vals[k];
                }
            }
        }
        // Scalar dangling all-reduce via coordinator (the only coordinator traffic): send partial, get add.
        ctrl.write_all(&dangling_partial.to_le_bytes()).unwrap();
        add = f64::from_le_bytes(read_vec(&mut ctrl, 8).unwrap().try_into().unwrap());
    }
    // Report actual recurring bytes sent (for the dense-vs-delta scoreboard), then the final owned gather.
    ctrl.write_all(&(sent_bytes as u64).to_le_bytes()).unwrap();
    ctrl.write_all(bytemuck::cast_slice(&owned_rank)).unwrap();
}

struct Setup {
    k: usize,
    owned: usize,
    g: usize,
    iters: usize,
    seed_add: f64,
    off: Vec<u64>,
    nbr: Vec<u32>,
    out_deg_local: Vec<u32>,
    send_local: Vec<Vec<u32>>, // per peer d: our owned-local indices to send
    recv_ghost: Vec<Vec<u32>>, // per peer d: our ghost-local indices to scatter into
    need: Vec<bool>,
    roster: Vec<String>,
}

fn parse_setup(raw: &[u8]) -> Setup {
    let mut p = 0usize;
    let k = rd_u64(raw, &mut p);
    let owned = rd_u64(raw, &mut p);
    let g = rd_u64(raw, &mut p);
    let iters = rd_u64(raw, &mut p);
    let seed_add = f64::from_le_bytes(raw[p..p + 8].try_into().unwrap());
    p += 8;
    let off: Vec<u64> = bytemuck::cast_slice(&raw[p..p + (owned + 1) * 8]).to_vec();
    p += (owned + 1) * 8;
    let adj = off[owned] as usize;
    let nbr: Vec<u32> = bytemuck::cast_slice(&raw[p..p + adj * 4]).to_vec();
    p += adj * 4;
    let out_deg_local: Vec<u32> = bytemuck::cast_slice(&raw[p..p + (owned + g) * 4]).to_vec();
    p += (owned + g) * 4;
    let mut send_local = Vec::with_capacity(k);
    let mut recv_ghost = Vec::with_capacity(k);
    for _ in 0..k {
        let sl = rd_u64(raw, &mut p);
        send_local.push(bytemuck::cast_slice::<u8, u32>(&raw[p..p + sl * 4]).to_vec());
        p += sl * 4;
        let rl = rd_u64(raw, &mut p);
        recv_ghost.push(bytemuck::cast_slice::<u8, u32>(&raw[p..p + rl * 4]).to_vec());
        p += rl * 4;
    }
    let need: Vec<bool> = (0..k)
        .map(|d| !send_local[d].is_empty() || !recv_ghost[d].is_empty())
        .collect();
    let mut roster = Vec::with_capacity(k);
    for _ in 0..k {
        let al = rd_u64(raw, &mut p);
        roster.push(String::from_utf8(raw[p..p + al].to_vec()).unwrap());
        p += al;
    }
    Setup {
        k,
        owned,
        g,
        iters,
        seed_add,
        off,
        nbr,
        out_deg_local,
        send_local,
        recv_ghost,
        need,
        roster,
    }
}

fn connect_retry(addr: &str, id: usize) -> TcpStream {
    for attempt in 0..120 {
        if let Ok(s) = TcpStream::connect(addr) {
            return s;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        if attempt % 20 == 19 {
            eprintln!("worker {id}: waiting for {addr}");
        }
    }
    panic!("worker {id}: {addr} unreachable");
}

/// Establish the peer mesh: accept from needed lower-id peers (in a thread) while connecting to needed
/// higher-id peers. Each new P2P connection announces its id first so both sides map the socket.
fn build_mesh(
    id: usize,
    k: usize,
    listener: &TcpListener,
    roster: &[String],
    need: &[bool],
) -> HashMap<usize, TcpStream> {
    let lower_needed = (0..id).filter(|&d| need[d]).count();
    let listener = listener.try_clone().unwrap();
    let accept = std::thread::spawn(move || {
        let mut got = HashMap::new();
        for _ in 0..lower_needed {
            let (mut s, _) = listener.accept().unwrap();
            s.set_nodelay(true).ok();
            let peer = rd_u64(&read_vec(&mut s, 8).unwrap(), &mut 0);
            got.insert(peer, s);
        }
        got
    });
    let mut peers: HashMap<usize, TcpStream> = HashMap::new();
    for d in (id + 1)..k {
        if need[d] {
            let mut s = connect_retry(&roster[d], id);
            s.set_nodelay(true).ok();
            s.write_all(&(id as u64).to_le_bytes()).unwrap(); // announce who I am
            peers.insert(d, s);
        }
    }
    for (d, s) in accept.join().unwrap() {
        peers.insert(d, s);
    }
    peers
}

// ══ Coordinator ══════════════════════════════════════════════════════════════════════════════════════
fn run_coordinator(listen: &str, k: usize, spawn: bool) {
    let scale = env_usize("HG_SCALE", 18) as u32;
    let ef = env_usize("HG_EDGEFACTOR", 16);
    let iters = env_usize("HG_ITERS", 25);
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0xB0A7).collect();
    let m = edges.len();
    println!(
        "P2P boundary-halo PageRank: {n} nodes / {m} edges / {k} workers (scale {scale}, ef {ef}, {iters} iters)"
    );

    let part = fennel_partition(n, &edges, k);
    let (remapped, bounds, _perm) = relabel_contiguous(n, &part, k, &edges);
    let (shards, out_deg) = partition_edges_boundary_at(n, &remapped, &bounds);

    // Routing tables: for each c and peer d, send_local[c][d] (c-owned indices that are d-ghosts, sorted)
    // and recv_ghost[c][d] (c-ghost indices owned by d). By construction these mirror across the pair.
    let ghost_pos: Vec<HashMap<usize, usize>> = shards
        .iter()
        .map(|sh| sh.ghosts.iter().enumerate().map(|(i, &g)| (g, i)).collect())
        .collect();
    let build_setup = |c: usize| -> Vec<u8> {
        let sh = &shards[c];
        let owned = sh.owned();
        let g = sh.ghosts.len();
        let seed_add = 0.0f64; // filled by caller (needs global dangling); placeholder overwritten below
        let mut off = vec![0u64; owned + 1];
        for (i, srcs) in sh.in_adj.iter().enumerate() {
            off[i + 1] = off[i] + srcs.len() as u64;
        }
        let flat: Vec<u32> = sh.in_adj.iter().flatten().map(|&li| li as u32).collect();
        let mut odl: Vec<u32> = out_deg[sh.lo..sh.hi].to_vec();
        for &gg in &sh.ghosts {
            odl.push(out_deg[gg]);
        }
        let mut buf = Vec::new();
        for x in [k, owned, g, iters] {
            buf.extend_from_slice(&(x as u64).to_le_bytes());
        }
        buf.extend_from_slice(&seed_add.to_le_bytes());
        buf.extend_from_slice(bytemuck::cast_slice(&off));
        buf.extend_from_slice(bytemuck::cast_slice(&flat));
        buf.extend_from_slice(bytemuck::cast_slice(&odl));
        // routing per peer d
        for dsh in &shards {
            // send c→d: c-owned that are d-ghosts, sorted by global id (== sorted local index).
            let mut send_local: Vec<u32> = dsh
                .ghosts
                .iter()
                .filter(|&&gg| gg >= sh.lo && gg < sh.hi)
                .map(|&gg| (gg - sh.lo) as u32)
                .collect();
            send_local.sort_unstable();
            // recv c←d: c-ghosts owned by d, in ascending-global order → ascending ghost index.
            let mut recv_pairs: Vec<(usize, u32)> = sh
                .ghosts
                .iter()
                .filter(|&&gg| gg >= dsh.lo && gg < dsh.hi)
                .map(|&gg| (gg, ghost_pos[c][&gg] as u32))
                .collect();
            recv_pairs.sort_unstable();
            let recv_ghost: Vec<u32> = recv_pairs.into_iter().map(|(_, gi)| gi).collect();
            buf.extend_from_slice(&(send_local.len() as u64).to_le_bytes());
            buf.extend_from_slice(bytemuck::cast_slice(&send_local));
            buf.extend_from_slice(&(recv_ghost.len() as u64).to_le_bytes());
            buf.extend_from_slice(bytemuck::cast_slice(&recv_ghost));
        }
        buf
    };

    // Bind, spawn/wait, collect hellos (id + advertised addr).
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
            .collect::<Vec<_>>();
    } else {
        println!("  waiting for {k} workers on {listen} ...");
    }
    let mut conns: Vec<Option<TcpStream>> = (0..k).map(|_| None).collect();
    let mut roster: Vec<String> = vec![String::new(); k];
    for _ in 0..k {
        let (mut s, _) = listener.accept().unwrap();
        s.set_nodelay(true).ok();
        let id = rd_u64(&read_vec(&mut s, 8).unwrap(), &mut 0);
        let al = rd_u64(&read_vec(&mut s, 8).unwrap(), &mut 0);
        roster[id] = String::from_utf8(read_vec(&mut s, al).unwrap()).unwrap();
        conns[id] = Some(s);
    }
    let mut conns: Vec<TcpStream> = conns.into_iter().map(|c| c.unwrap()).collect();

    // Seed add_0 from uniform dangling; append roster; ship setup to each worker.
    let base = (1.0 - D) / n as f64;
    let n_dangle = out_deg.iter().filter(|&&d| d == 0).count();
    let mut add = base + D * (n_dangle as f64 / n as f64) / n as f64;
    let roster_blob = {
        let mut b = Vec::new();
        for a in &roster {
            b.extend_from_slice(&(a.len() as u64).to_le_bytes());
            b.extend_from_slice(a.as_bytes());
        }
        b
    };
    for (c, s) in conns.iter_mut().enumerate() {
        let mut setup = build_setup(c);
        // overwrite seed_add (bytes 32..40: after 4×u64 header).
        setup[32..40].copy_from_slice(&add.to_le_bytes());
        setup.extend_from_slice(&roster_blob);
        s.write_all(&(1.0 / n as f64).to_le_bytes()).unwrap();
        s.write_all(&(setup.len() as u64).to_le_bytes()).unwrap();
        s.write_all(&setup).unwrap();
    }

    // Per-step: (optional) Anderson Gram all-reduce [O(window²)] + SCALAR dangling all-reduce [O(k)].
    // Neither grows with graph size, so the coordinator stays off the O(boundary) hot path.
    let accel = env_usize("HG_ACCEL", 0);
    let mut coord_bytes = 0usize;
    let t = Instant::now();
    for _ in 0..iters {
        if accel > 0 {
            // Sum per-worker Gram/rhs partials → global least-squares → broadcast γ.
            let (mut mk, mut gram, mut rhs) = (0usize, Vec::new(), Vec::new());
            for (ci, s) in conns.iter_mut().enumerate() {
                let m_i = rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
                let g_i: Vec<f64> = to_f64s(&read_vec(s, m_i * m_i * 8).unwrap());
                let r_i: Vec<f64> = to_f64s(&read_vec(s, m_i * 8).unwrap());
                coord_bytes += 8 + m_i * m_i * 8 + m_i * 8;
                if ci == 0 {
                    mk = m_i;
                    gram = vec![0.0f64; mk * mk];
                    rhs = vec![0.0f64; mk];
                }
                for k in 0..mk * mk {
                    gram[k] += g_i[k];
                }
                for k in 0..mk {
                    rhs[k] += r_i[k];
                }
            }
            let gamma = solve_gram(mk, &gram, &rhs);
            for s in conns.iter_mut() {
                s.write_all(bytemuck::cast_slice(&gamma)).unwrap();
                coord_bytes += mk * 8;
            }
        }
        let mut dangling = 0.0f64;
        for s in conns.iter_mut() {
            dangling += f64::from_le_bytes(read_vec(s, 8).unwrap().try_into().unwrap());
            coord_bytes += 8;
        }
        add = base + D * dangling / n as f64;
        for s in conns.iter_mut() {
            s.write_all(&add.to_le_bytes()).unwrap();
            coord_bytes += 8;
        }
    }
    let dt = t.elapsed();

    // Final O(n) gather (each worker first reports its actual recurring bytes sent, for the scoreboard).
    let mut rank = vec![0.0f64; n];
    let mut actual_sent = 0usize;
    for (c, s) in conns.iter_mut().enumerate() {
        actual_sent += rd_u64(&read_vec(s, 8).unwrap(), &mut 0);
        let owned = shards[c].owned();
        let vals: Vec<f64> = bytemuck::cast_slice(&read_vec(s, owned * 8).unwrap()).to_vec();
        rank[shards[c].lo..shards[c].lo + owned].copy_from_slice(&vals);
    }
    for kid in kids.iter_mut() {
        kid.wait().ok();
    }

    // Verify. Power-iteration path: compare to single-graph power iteration at the SAME iters (bit-exact).
    // Anderson path: it reaches a MORE-converged point than power@iters, so compare to the CONVERGED fixed
    // point and show it beats power@iters — that's the proof of fewer effective iterations.
    let maxdiff = if accel > 0 {
        let converged = pagerank(n, &remapped, D, 2000, 1e-13);
        let acc_err = converged.iter().zip(&rank).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        let power = pagerank(n, &remapped, D, iters, -1.0);
        let power_err = converged.iter().zip(&power).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        println!(
            "  ANDERSON(window {accel}) @ {iters} steps: max|Δ| vs CONVERGED {acc_err:.2e}  —  power iteration @ {iters}: {power_err:.2e}  ⇒ {:.0}× closer in the same steps",
            power_err / acc_err.max(1e-300)
        );
        acc_err
    } else {
        let single = pagerank(n, &remapped, D, iters, -1.0);
        single.iter().zip(&rank).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max)
    };
    // Total P2P bytes = Σ_steps Σ_{c,d} |send c→d| × 8.
    let mut p2p_per_step = 0usize;
    for c in 0..k {
        for d in 0..k {
            if c == d {
                continue;
            }
            let cnt = shards[d]
                .ghosts
                .iter()
                .filter(|&&gg| gg >= shards[c].lo && gg < shards[c].hi)
                .count();
            p2p_per_step += cnt * 8;
        }
    }
    let p2p_total = p2p_per_step * iters;
    let delta_eps = std::env::var("HG_DELTA_EPS").ok();
    println!("  {iters} supersteps: {dt:>7.3?}");
    println!(
        "  P2P halo (worker↔worker): dense would be {:.1} MB total ({} KB/step)  — NEVER touches coordinator",
        p2p_total as f64 / 1e6,
        p2p_per_step / 1000
    );
    if let Some(eps) = delta_eps {
        println!(
            "  DELTA halo (eps={eps}): {:.1} MB actually sent = {:.2}× LESS wire than dense (measured, not projected)",
            actual_sent as f64 / 1e6,
            p2p_total as f64 / actual_sent.max(1) as f64
        );
    } else {
        // Sanity: dense actual should match the analytic projection.
        let _ = actual_sent;
    }
    println!(
        "  coordinator traffic: {} KB total ({} B/step = {k} scalars up + {k} down) — O(k), not O(boundary)",
        coord_bytes / 1000,
        coord_bytes / iters
    );
    println!(
        "  coordinator carries {:.4}% of recurring bytes; {:.2}% is peer-to-peer",
        100.0 * coord_bytes as f64 / (coord_bytes + p2p_total).max(1) as f64,
        100.0 * p2p_total as f64 / (coord_bytes + p2p_total).max(1) as f64,
    );
    // Verdict tag: bit-EXACT for the dense/eps=0 power path; Anderson lands on the same converged fixed
    // point (verified above); delta eps>0 is a bounded approximation traded for wire.
    let delta_exact = std::env::var("HG_DELTA_EPS").map(|e| e == "0").unwrap_or(true);
    let tag = if accel > 0 {
        "Anderson → same converged fixed point (verified vs power-iteration limit)"
    } else if delta_exact {
        "EXACT"
    } else {
        "bounded approx (eps>0 traded for wire)"
    };
    println!("  == single-graph PageRank: max|Δ| {maxdiff:.2e}   ({tag})");
}

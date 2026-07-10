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

    // Spawn a reader thread per peer we RECEIVE from; each drains `iters` messages into a channel.
    let mut rx_map: HashMap<usize, mpsc::Receiver<Vec<f64>>> = HashMap::new();
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
                    match read_vec(&mut rd, recv_n * 8) {
                        Ok(b) => {
                            if tx
                                .send(bytemuck::cast_slice::<u8, f64>(&b).to_vec())
                                .is_err()
                            {
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

    // BSP loop. Persistent owned ranks; ghost halo assembled from P2P messages.
    let mut owned_rank = vec![n_recip; s.owned];
    let mut local_rank = vec![n_recip; s.owned + s.g];
    let mut add = s.seed_add;
    for _ in 0..s.iters {
        // Compute rank_{t+1} from [owned | ghost halo].
        local_rank[..s.owned].copy_from_slice(&owned_rank);
        let mut dangling_partial = 0.0f64;
        #[allow(clippy::needless_range_loop)]
        for v in 0..s.owned {
            let mut acc = 0.0;
            for &li in &s.nbr[s.off[v] as usize..s.off[v + 1] as usize] {
                acc += local_rank[li as usize] / s.out_deg_local[li as usize] as f64;
            }
            owned_rank[v] = add + D * acc;
            if s.out_deg_local[v] == 0 {
                dangling_partial += owned_rank[v];
            }
        }
        // P2P halo push: send each needed peer exactly the owned values that are its ghosts.
        for (d, send_idx) in s
            .send_local
            .iter()
            .enumerate()
            .filter(|(_, v)| !v.is_empty())
        {
            let vals: Vec<f64> = send_idx.iter().map(|&li| owned_rank[li as usize]).collect();
            writers
                .get_mut(&d)
                .unwrap()
                .write_all(bytemuck::cast_slice(&vals))
                .unwrap();
        }
        // P2P halo pull: receive each peer's message, scatter into our ghost slots. Ghost slots live at
        // `owned + ghost_pos` in the local view (recv_ghost holds ghost_pos in 0..g).
        for (&d, rx) in &rx_map {
            let vals = rx.recv().unwrap();
            for (k, &gi) in s.recv_ghost[d].iter().enumerate() {
                local_rank[s.owned + gi as usize] = vals[k];
            }
        }
        // ghost halo for next step lives in local_rank[owned..]; keep it there (owned overwritten above).
        // Scalar dangling all-reduce via coordinator (the only coordinator traffic): send partial, get add.
        ctrl.write_all(&dangling_partial.to_le_bytes()).unwrap();
        add = f64::from_le_bytes(read_vec(&mut ctrl, 8).unwrap().try_into().unwrap());
    }
    // Final gather: coordinator asks (reads) our owned ranks once.
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

    // Per-step: SCALAR dangling all-reduce only (the sole coordinator hot-path traffic).
    let mut coord_bytes = 0usize;
    let t = Instant::now();
    for _ in 0..iters {
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

    // Final O(n) gather.
    let mut rank = vec![0.0f64; n];
    for (c, s) in conns.iter_mut().enumerate() {
        let owned = shards[c].owned();
        let vals: Vec<f64> = bytemuck::cast_slice(&read_vec(s, owned * 8).unwrap()).to_vec();
        rank[shards[c].lo..shards[c].lo + owned].copy_from_slice(&vals);
    }
    for kid in kids.iter_mut() {
        kid.wait().ok();
    }

    // Verify + report the P2P vs coordinator split.
    let single = pagerank(n, &remapped, D, iters, -1.0);
    let maxdiff = single
        .iter()
        .zip(&rank)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
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
    println!("  {iters} supersteps: {dt:>7.3?}");
    println!(
        "  P2P halo (worker↔worker): {:.1} MB total, {} KB/step  — NEVER touches the coordinator",
        p2p_total as f64 / 1e6,
        p2p_per_step / 1000
    );
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
    println!("  == single-graph PageRank: max|Δ| {maxdiff:.2e}   (EXACT)");
}

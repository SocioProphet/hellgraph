//! graphdb_server — a real TCP query server: clients connect and send openCypher text; the server parses
//! it, executes ACROSS the distributed sharded engine, and returns JSON results sealed with a SHA-256
//! receipt. This closes "it's a library nobody can connect to" — it's now a networked graph database.
//! Self-contained: it starts the server, connects a client over TCP, and runs real queries end-to-end.
//!
//! Run: `cargo run -p hg_analytics --release --example graphdb_server`

use hg_analytics::{parse_cypher, ShardedGraph, Store};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

/// Parse + execute one Cypher line against the distributed engine, returning a JSON response with a receipt.
fn handle(store: &Store, g: &ShardedGraph, query: &str) -> String {
    match parse_cypher(query) {
        Ok(q) => {
            let res = q.run_dist(g); // executed across shards — no shard holds the whole graph
            let receipt = store.receipt(query, &res);
            let ids = res.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",");
            format!(
                "{{\"count\":{},\"result\":[{}],\"state_digest\":\"{}\",\"result_digest\":\"{}\"}}",
                res.len(),
                ids,
                receipt.state_digest,
                receipt.result_digest
            )
        }
        Err(e) => format!("{{\"error\":\"{}\"}}", e.replace('"', "'")),
    }
}

fn main() {
    // Build a small labeled property graph and shard it across 4 participants.
    let mut store = Store::memory(1);
    for id in 0..8 {
        store.add_node(id).unwrap();
    }
    for (u, v) in [(0, 1), (1, 2), (2, 3), (0, 4), (4, 5), (5, 6), (1, 6), (6, 7)] {
        store.add_edge(u, v, "KNOWS").unwrap();
    }
    let g = ShardedGraph::from_store(&store, 4);
    let shared = Arc::new((store, g));

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    println!("graphdb query server listening on {addr} — distributed over 4 shards, SHA-256 receipts\n");

    // Server thread: handle the client connection, one Cypher line → one JSON response.
    let srv = Arc::clone(&shared);
    let server = thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut w = stream;
            let mut line = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let q = line.trim();
                if q.is_empty() || q == "QUIT" {
                    break;
                }
                let resp = handle(&srv.0, &srv.1, q);
                writeln!(w, "{resp}").ok();
            }
        }
    });

    // Client: connect and fire real Cypher queries over TCP.
    let mut stream = TcpStream::connect(addr).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let queries = [
        "MATCH (a)-[:KNOWS*1..2]->(b) WHERE a = 0 RETURN b",
        "MATCH (a {id: 0})-[:KNOWS]->()-[:KNOWS]->(c) RETURN c",
        "MATCH (a)-[:KNOWS]->(b) WHERE a = 1 RETURN b",
        "SELECT oops",
    ];
    for q in queries {
        writeln!(stream, "{q}").unwrap();
        let mut resp = String::new();
        reader.read_line(&mut resp).unwrap();
        println!("  Q: {q}");
        println!("  → {}\n", resp.trim());
    }
    writeln!(stream, "QUIT").ok();
    drop(stream);
    server.join().ok();
    println!("OK — Cypher executed over TCP against the distributed engine, each answer sealed with a SHA-256 receipt.");
}

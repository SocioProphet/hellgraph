//! Load-balance receipt: for a Graph500/RMAT graph, count in-edges per shard under the RANGE partition
//! (contiguous vertex ranges) vs the CYCLIC partition (v % k), and report the imbalance factor
//! max_shard / mean_shard. This is the measurement behind "the hub-skew is gone" — the range partition
//! piles the power-law hubs onto shard 0; the cyclic partition scatters them.
//!
//!   cargo run --release --example skew_check -- <scale> <edgefactor> <k>
use hg_analytics::{balanced_owner, balanced_to_global, mix_bits, owner_of, range_bounds, Kronecker};

fn report(name: &str, counts: &[usize], m: usize) {
    let k = counts.len();
    let mean = m as f64 / k as f64;
    let max = *counts.iter().max().unwrap();
    let min = *counts.iter().min().unwrap();
    println!(
        "  {name:6}: max shard = {max:>12} ({:.2}× mean) · min = {min:>12} · imbalance max/mean = {:.2}×",
        max as f64 / mean,
        max as f64 / mean,
    );
    // Show shard 0 specifically — it's the one the range partition overloads.
    println!(
        "          shard 0 holds {} edges = {:.1}% of all {m}",
        counts[0],
        100.0 * counts[0] as f64 / m as f64
    );
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let scale: u32 = a.get(1).map(|s| s.parse().unwrap()).unwrap_or(22);
    let ef: usize = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(16);
    let k: usize = a.get(3).map(|s| s.parse().unwrap()).unwrap_or(16);
    let n = Kronecker::vertices(scale);
    let m = Kronecker::edges(scale, ef);

    // Bijection self-test: mix∘unmix must be identity on ALL of [0, n) (else ownership loses/duplicates
    // vertices). balanced_to_global(mix(v)%k-slot) must round-trip v.
    let mut roundtrip_ok = true;
    for v in 0..n {
        let c = balanced_owner(v, scale, k);
        let l = hg_analytics::balanced_local(v, scale, k);
        if balanced_to_global(l, scale, k, c) != v {
            roundtrip_ok = false;
            break;
        }
    }
    // mix must be a permutation of [0, n): every mixed value distinct and in-range.
    let mut seen = vec![false; n];
    let mut perm_ok = true;
    for v in 0..n {
        let w = mix_bits(v, scale);
        if w >= n || seen[w] {
            perm_ok = false;
            break;
        }
        seen[w] = true;
    }

    let bounds = range_bounds(n, k);
    let mut range = vec![0usize; k];
    let mut balanced = vec![0usize; k];
    for (_u, v) in Kronecker::new(scale, ef, 0xB0A7) {
        range[owner_of(v, &bounds)] += 1;
        balanced[balanced_owner(v, scale, k)] += 1;
    }
    println!("skew_check: scale {scale} · ef {ef} · {n} nodes / {m} edges / {k} shards");
    println!(
        "  bijection: mix∘unmix roundtrip {} · mix is permutation of [0,n) {}",
        if roundtrip_ok { "OK ✓" } else { "BROKEN ✗" },
        if perm_ok { "OK ✓" } else { "BROKEN ✗" },
    );
    report("RANGE", &range, m);
    report("BALANCED", &balanced, m);
}

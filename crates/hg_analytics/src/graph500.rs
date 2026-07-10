//! graph500 — Graph500 Kronecker (RMAT) synthetic graph generator: the standard, reproducible,
//! on-the-fly dataset for scale benchmarks (no download). `scale` → 2^scale vertices; `edgefactor`
//! edges per vertex. Standard RMAT quadrant probabilities A=0.57, B=0.19, C=0.19, D=0.05.
//! Deterministic (seeded splitmix64). Feeds straight into the CSR builders as a re-iterable stream.

/// splitmix64 step → uniform f64 in [0,1). Deterministic, fast, well-distributed.
#[inline]
fn split_next(state: &mut u64) -> f64 {
    *state = state.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^= z >> 31;
    (z >> 11) as f64 / ((1u64 << 53) as f64)
}

/// A deterministic RMAT edge stream. Create a fresh one per pass (same seed → same edges), so it
/// works with the two-pass CSR builders.
pub struct Kronecker {
    state: u64,
    scale: u32,
    remaining: usize,
}

impl Kronecker {
    pub fn new(scale: u32, edgefactor: usize, seed: u64) -> Self {
        Kronecker {
            state: seed,
            scale,
            remaining: edgefactor * (1usize << scale),
        }
    }
    /// Vertex count for a scale (= 2^scale).
    pub fn vertices(scale: u32) -> usize {
        1usize << scale
    }
    /// Edge count for a scale + edgefactor.
    pub fn edges(scale: u32, edgefactor: usize) -> usize {
        edgefactor * (1usize << scale)
    }
}

impl Iterator for Kronecker {
    type Item = (usize, usize);
    #[inline]
    fn next(&mut self) -> Option<(usize, usize)> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        // RMAT: recurse into a quadrant `scale` times, setting one bit of (u,v) per level.
        const A: f64 = 0.57;
        const AB: f64 = 0.76; // A + B
        const ABC: f64 = 0.95; // A + B + C
        let (mut u, mut v) = (0u64, 0u64);
        for i in 0..self.scale {
            let r = split_next(&mut self.state);
            let bit = 1u64 << i;
            if r >= ABC {
                u |= bit;
                v |= bit; // D: bottom-right
            } else if r >= AB {
                u |= bit; // C: bottom-left
            } else if r >= A {
                v |= bit; // B: top-right
            }
            // else A: top-left — no bits set
        }
        Some((u as usize, v as usize))
    }
}

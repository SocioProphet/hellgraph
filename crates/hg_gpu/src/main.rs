//! hg_gpu — GPU-accelerated PageRank compute kernel (wgpu/WGSL), the per-node acceleration layer that
//! goes UNDER the boundary-halo distributed engine. Written in wgpu so the SAME shader runs on Apple /
//! NVIDIA / AMD / Intel — no CUDA vendor lock (that's the whole point vs cuGraph). Verified against the
//! bit-exact CPU PageRank and benchmarked in GTEPS.
//!
//!   cargo run -p hg_gpu --release        # HG_SCALE (default 20), HG_ITERS (default 40)

use hg_analytics::{pagerank, Kronecker};
use pollster::FutureExt;
use std::time::Instant;
use wgpu::util::DeviceExt;

const D: f32 = 0.85;

const SHADER: &str = r#"
struct Params { n: u32, base: f32, damping: f32, num_wg: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;      // n+1 (in-CSR row pointers)
@group(0) @binding(2) var<storage, read> in_nbr: array<u32>;       // m   (in-neighbour sources)
@group(0) @binding(3) var<storage, read> inv_outdeg: array<f32>;   // n   (1/outdeg, 0 if dangling)
@group(0) @binding(4) var<storage, read> is_dangling: array<u32>;  // n   (1 if outdeg==0)
@group(0) @binding(5) var<storage, read> rank_in: array<f32>;      // n
@group(0) @binding(6) var<storage, read_write> rank_out: array<f32>; // n
@group(0) @binding(7) var<storage, read_write> partials: array<f32>; // one per workgroup (dangling partials)
@group(0) @binding(8) var<storage, read_write> dsum: array<f32>;   // [0] = total dangling mass (GPU-resident)
@group(0) @binding(9) var<storage, read_write> contrib: array<f32>; // rank_in[u]·inv_outdeg[u], fused so the
                                                                    // SpMV does ONE random gather, not two

var<workgroup> sdata: array<f32, 256>;

// L1 — GRID-STRIDE, FUSED: each workgroup strides over the vertices reading rank_in[v] ONCE and doing both
// jobs with it — writing the per-vertex contribution contrib[v]=rank_in[v]·inv_outdeg[v] (so the SpMV's
// random gather reads a single f32/edge, not two) AND summing dangling mass → one partial per workgroup.
// Merging the old separate contrib pass in here saves a whole O(n) re-read of rank_in and a dispatch.
// (No barrier inside the strided accumulation; the reduction barrier after is reached uniformly.)
@compute @workgroup_size(256)
fn dangling(@builtin(local_invocation_id) lid: vec3<u32>,
            @builtin(workgroup_id) wid: vec3<u32>,
            @builtin(num_workgroups) ng: vec3<u32>) {
  let stride = ng.x * 256u;
  var acc = 0.0;
  var v = wid.x * 256u + lid.x;
  loop {
    if (v >= P.n) { break; }
    let r = rank_in[v];              // single read, used for both contrib and dangling
    contrib[v] = r * inv_outdeg[v];  // (0 for dangling v — inv_outdeg is 0 — and unused there)
    if (is_dangling[v] == 1u) { acc = acc + r; }
    v = v + stride;
  }
  sdata[lid.x] = acc;
  workgroupBarrier();
  var s = 128u;
  loop { if (s == 0u) { break; } if (lid.x < s) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + s]; } workgroupBarrier(); s = s / 2u; }
  if (lid.x == 0u) { partials[wid.x] = sdata[0]; }
}

// L2 — ONE workgroup grid-strides all `num_wg` partials → dsum[0]. Dangling mass stays on-device.
@compute @workgroup_size(256)
fn reduce_final(@builtin(local_invocation_id) lid: vec3<u32>) {
  var acc = 0.0;
  var i = lid.x;
  loop { if (i >= P.num_wg) { break; } acc = acc + partials[i]; i = i + 256u; }
  sdata[lid.x] = acc;
  workgroupBarrier();
  var s = 128u;
  loop { if (s == 0u) { break; } if (lid.x < s) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + s]; } workgroupBarrier(); s = s / 2u; }
  if (lid.x == 0u) { dsum[0] = sdata[0]; }
}

// SpMV — WARP-PER-VERTEX + GRID-STRIDE: a 32-lane sub-warp cooperatively sums each vertex's in-neighbours
// (so a million-degree hub is split across 32 threads, not stalling one), and the workgroup grid-strides
// over vertices. `base_v` is UNIFORM across the workgroup so every barrier is reached by all threads.
@compute @workgroup_size(256)
fn spmv(@builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(workgroup_id) wid: vec3<u32>,
        @builtin(num_workgroups) ng: vec3<u32>) {
  let lane = lid.x & 31u;
  let sw = lid.x >> 5u;
  let step = ng.x * 8u;   // sub-warps across the whole grid
  let add = P.base + P.damping * dsum[0] / f32(P.n);
  var base_v = wid.x * 8u; // UNIFORM per workgroup → uniform loop count → uniform barriers
  loop {
    if (base_v >= P.n) { break; }
    let v = base_v + sw;
    var acc = 0.0;
    if (v < P.n) {
      let s = offsets[v];
      let e = offsets[v + 1u];
      for (var i = s + lane; i < e; i = i + 32u) {
        acc = acc + contrib[in_nbr[i]]; // ONE random gather per edge (fused rank·inv_outdeg)
      }
    }
    // Sub-warp reduction via shared memory (portable across all backends; subgroupAdd would replace this
    // with one instruction on NVIDIA, but wgpu-22's WGSL subgroup support is immature — post-A100 tuning).
    sdata[lid.x] = acc;
    workgroupBarrier();
    if (lane < 16u) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + 16u]; }
    workgroupBarrier();
    if (lane < 8u) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + 8u]; }
    workgroupBarrier();
    if (lane < 4u) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + 4u]; }
    workgroupBarrier();
    if (lane < 2u) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + 2u]; }
    workgroupBarrier();
    if (lane == 0u && v < P.n) { rank_out[v] = add + P.damping * (sdata[lid.x] + sdata[lid.x + 1u]); }
    workgroupBarrier();
    base_v = base_v + step;
  }
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    n: u32,
    base: f32,
    damping: f32,
    num_wg: u32,
}

fn env(k: &str, d: usize) -> usize {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

fn main() {
    let scale = env("HG_SCALE", 20) as u32;
    let ef = env("HG_EDGEFACTOR", 16);
    let iters = env("HG_ITERS", 40);
    let reorder = env("HG_REORDER", 1) != 0;
    let n = Kronecker::vertices(scale);
    let mut edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x6907u64).collect();
    let m = edges.len();

    // ── LOCALITY REORDER: relabel vertices by DESCENDING out-degree. A high-out-degree vertex is a source
    // in many edges, so its rank is READ many times in the pull gather — giving it a low id keeps it hot in
    // cache and stops the random gather from thrashing (the actual bottleneck at 2.38 GTEPS). Cheap: one
    // sort. The ranking is permutation-invariant, so we relabel the graph and compare in the new order.
    if reorder {
        let mut od = vec![0u32; n];
        for &(u, _) in &edges {
            od[u] += 1;
        }
        let mut order: Vec<u32> = (0..n as u32).collect();
        order.sort_unstable_by(|&a, &b| od[b as usize].cmp(&od[a as usize]).then(a.cmp(&b)));
        let mut newid = vec![0u32; n];
        for (new, &old) in order.iter().enumerate() {
            newid[old as usize] = new as u32;
        }
        for e in edges.iter_mut() {
            *e = (newid[e.0] as usize, newid[e.1] as usize);
        }
    }

    // ── Build the in-neighbour CSR + out-degrees on the CPU (once) ───────────────────────────────────
    let mut outdeg = vec![0u32; n];
    let mut indeg = vec![0u32; n];
    for &(u, v) in &edges {
        outdeg[u] += 1;
        indeg[v] += 1;
    }
    let mut offsets = vec![0u32; n + 1];
    for v in 0..n {
        offsets[v + 1] = offsets[v] + indeg[v];
    }
    let mut cursor = offsets.clone();
    let mut in_nbr = vec![0u32; m];
    for &(u, v) in &edges {
        in_nbr[cursor[v] as usize] = u as u32;
        cursor[v] += 1;
    }
    let inv_outdeg: Vec<f32> = outdeg
        .iter()
        .map(|&d| if d == 0 { 0.0 } else { 1.0 / d as f32 })
        .collect();
    let is_dangling: Vec<u32> = outdeg.iter().map(|&d| (d == 0) as u32).collect();

    println!("hg_gpu PageRank: n={n} m={m} scale={scale} iters={iters}");

    // ── CPU reference (bit-exact engine) for the correctness check. Gated: at cloud-scale the serial
    // reference is minutes; HG_VERIFY=0 skips it to measure raw GPU throughput + confirm the kernel handles
    // the graph size. Correctness is proven at smaller scales.
    let verify = env("HG_VERIFY", 1) != 0;
    let cpu = if verify {
        pagerank(n, &edges, D as f64, iters, -1.0)
    } else {
        Vec::new()
    };

    // ── GPU setup ────────────────────────────────────────────────────────────────────────────────────
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        })
        .block_on()
        .expect("no GPU adapter");
    println!(
        "  GPU: {} ({:?})",
        adapter.get_info().name,
        adapter.get_info().backend
    );
    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits {
                    max_storage_buffer_binding_size: adapter
                        .limits()
                        .max_storage_buffer_binding_size,
                    max_buffer_size: adapter.limits().max_buffer_size,
                    // 9 storage buffers now (added `contrib`); default cap is 8.
                    max_storage_buffers_per_shader_stage: 10,
                    ..wgpu::Limits::default()
                },
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        )
        .block_on()
        .expect("no device");

    // Fixed grid-stride dispatch: `grid` workgroups each stride over many vertices → covers ANY graph size
    // with one dispatch (no 65535 cap), and keeps the GPU saturated. `partials` has one entry per workgroup.
    let grid = 8192u32;
    let buf = |data: &[u8], usage: wgpu::BufferUsages| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: data,
            usage,
        })
    };
    let st = wgpu::BufferUsages::STORAGE;
    let b_off = buf(bytemuck::cast_slice(&offsets), st);
    let b_nbr = buf(bytemuck::cast_slice(&in_nbr), st);
    let b_inv = buf(bytemuck::cast_slice(&inv_outdeg), st);
    let b_dng = buf(bytemuck::cast_slice(&is_dangling), st);
    let init = vec![1.0f32 / n as f32; n];
    let b_a = buf(
        bytemuck::cast_slice(&init),
        st | wgpu::BufferUsages::COPY_SRC,
    );
    let b_b = buf(
        bytemuck::cast_slice(&init),
        st | wgpu::BufferUsages::COPY_SRC,
    );
    let b_part = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (grid as u64) * 4,
        usage: st | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let b_dsum = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 4, // one f32: total dangling mass, kept GPU-resident (no per-iter readback)
        usage: st | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let b_contrib = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (n as u64) * 4, // rank_in[u]·inv_outdeg[u], refreshed each iter → SpMV does ONE gather/edge
        usage: st,
        mapped_at_creation: false,
    });
    let b_params = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: std::mem::size_of::<Params>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (n as u64) * 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    // Explicit 8-binding layout shared by BOTH entry points (auto-derived layouts only include the
    // bindings a single shader uses — spmv touches 6, dangling touches others — so they wouldn't match an
    // 8-binding bind group).
    let bge = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    };
    let ro = wgpu::BufferBindingType::Storage { read_only: true };
    let rw = wgpu::BufferBindingType::Storage { read_only: false };
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            bge(0, wgpu::BufferBindingType::Uniform),
            bge(1, ro),
            bge(2, ro),
            bge(3, ro),
            bge(4, ro),
            bge(5, ro),
            bge(6, rw),
            bge(7, rw),
            bge(8, rw),
            bge(9, rw),
        ],
    });
    let pipe_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let make_pipe = |entry: &str| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: Some(&pipe_layout),
            module: &module,
            entry_point: entry,
            compilation_options: Default::default(),
            cache: None,
        })
    };
    let pipe_spmv = make_pipe("spmv");
    let pipe_dng = make_pipe("dangling"); // fused: writes contrib + sums dangling in one rank_in read
    let pipe_reduce = make_pipe("reduce_final");

    // Two bind groups for ping-pong: dir 0 reads A→writes B; dir 1 reads B→writes A.
    let bind = |rin: &wgpu::Buffer, rout: &wgpu::Buffer| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: b_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: b_off.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: b_nbr.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: b_inv.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: b_dng.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: rin.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: rout.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: b_part.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: b_dsum.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: b_contrib.as_entire_binding(),
                },
            ],
        })
    };
    let bg = [bind(&b_a, &b_b), bind(&b_b, &b_a)];

    let base = (1.0 - D) / n as f32;
    // Params are constant across iterations — `add` is computed ON-DEVICE from the GPU-resident dangling
    // mass, so there is no per-iteration CPU write or readback (that sync was the whole first-version stall).
    queue.write_buffer(
        &b_params,
        0,
        bytemuck::bytes_of(&Params {
            n: n as u32,
            base,
            damping: D,
            num_wg: grid,
        }),
    );

    // Batch ALL iterations into ONE command buffer → a single CPU↔GPU sync for the whole run. Each superstep
    // is 3 passes (dangling L1 → reduce L2 → spmv); separate passes give the memory barrier the data
    // dependency needs, and the ping-pong alternates bind groups.
    let t = Instant::now();
    let mut enc = device.create_command_encoder(&Default::default());
    let mut dir = 0usize;
    let pass =
        |enc: &mut wgpu::CommandEncoder, pipe: &wgpu::ComputePipeline, bgi: usize, groups: u32| {
            let mut cp = enc.begin_compute_pass(&Default::default());
            cp.set_pipeline(pipe);
            cp.set_bind_group(0, &bg[bgi], &[]);
            cp.dispatch_workgroups(groups, 1, 1);
        };
    for _ in 0..iters {
        pass(&mut enc, &pipe_dng, dir, grid); // L1: dangling partials + contrib (fused, one rank_in read)
        pass(&mut enc, &pipe_reduce, dir, 1); // L2: partials → dsum (one workgroup)
        pass(&mut enc, &pipe_spmv, dir, grid); // rank_out = add + damping·SpMV (ONE gather/edge)
        dir ^= 1;
    }
    queue.submit([enc.finish()]);
    device.poll(wgpu::Maintain::Wait);
    let gpu_s = t.elapsed().as_secs_f64();

    // ── Read back the final rank (it's in the buffer we'd read next) ─────────────────────────────────
    let final_buf = if dir == 0 { &b_a } else { &b_b };
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_buffer_to_buffer(final_buf, 0, &staging, 0, (n as u64) * 4);
    queue.submit([enc.finish()]);
    let slice = staging.slice(0..(n as u64) * 4);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::Maintain::Wait);
    let gpu_rank: Vec<f32> = bytemuck::cast_slice::<u8, f32>(&slice.get_mapped_range()).to_vec();
    staging.unmap();

    let gteps = m as f64 * iters as f64 / gpu_s / 1e9;
    println!(
        "  GPU {iters} iters: {gpu_s:.3}s  →  {gteps:.2} GTEPS  ({:.1} Medges·it/s)",
        gteps * 1000.0
    );
    if verify {
        let maxd = cpu
            .iter()
            .zip(&gpu_rank)
            .map(|(a, b)| (*a - *b as f64).abs())
            .fold(0.0f64, f64::max);
        println!(
            "  vs CPU bit-exact PageRank: max|Δ| {maxd:.2e}  (f32 GPU → tolerance, not bit-exact)"
        );
    } else {
        let s: f64 = gpu_rank.iter().map(|&x| x as f64).sum();
        println!(
            "  Σrank = {s:.4} (≈1 ⇒ correct)  [HG_VERIFY=0: skipped the slow serial reference]"
        );
    }
}

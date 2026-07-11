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
const WG: u32 = 256; // workgroup size

const SHADER: &str = r#"
struct Params { n: u32, base: f32, damping: f32, add: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;      // n+1 (in-CSR row pointers)
@group(0) @binding(2) var<storage, read> in_nbr: array<u32>;       // m   (in-neighbour sources)
@group(0) @binding(3) var<storage, read> inv_outdeg: array<f32>;   // n   (1/outdeg, 0 if dangling)
@group(0) @binding(4) var<storage, read> is_dangling: array<u32>;  // n   (1 if outdeg==0)
@group(0) @binding(5) var<storage, read> rank_in: array<f32>;      // n
@group(0) @binding(6) var<storage, read_write> rank_out: array<f32>; // n
@group(0) @binding(7) var<storage, read_write> partials: array<f32>; // one per workgroup (dangling sum)

// SpMV pull: rank_out[v] = add + damping * sum_{u->v} rank_in[u] * inv_outdeg[u].
@compute @workgroup_size(256)
fn spmv(@builtin(global_invocation_id) gid: vec3<u32>) {
  let v = gid.x;
  if (v >= P.n) { return; }
  var acc = 0.0;
  let s = offsets[v];
  let e = offsets[v + 1u];
  for (var i = s; i < e; i = i + 1u) {
    let u = in_nbr[i];
    acc = acc + rank_in[u] * inv_outdeg[u];
  }
  rank_out[v] = P.add + P.damping * acc;
}

// Dangling mass: workgroup reduction of rank_in[v] over dangling v → one partial per workgroup.
var<workgroup> sdata: array<f32, 256>;
@compute @workgroup_size(256)
fn dangling(@builtin(global_invocation_id) gid: vec3<u32>,
            @builtin(local_invocation_id) lid: vec3<u32>,
            @builtin(workgroup_id) wid: vec3<u32>) {
  let v = gid.x;
  var val = 0.0;
  if (v < P.n && is_dangling[v] == 1u) { val = rank_in[v]; }
  sdata[lid.x] = val;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) { break; }
    if (lid.x < stride) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + stride]; }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (lid.x == 0u) { partials[wid.x] = sdata[0]; }
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    n: u32,
    base: f32,
    damping: f32,
    add: f32,
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
    let n = Kronecker::vertices(scale);
    let edges: Vec<(usize, usize)> = Kronecker::new(scale, ef, 0x6907u64).collect();
    let m = edges.len();

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

    // ── CPU reference (bit-exact engine) for the correctness check ───────────────────────────────────
    let cpu = pagerank(n, &edges, D as f64, iters, -1.0);

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
                    ..wgpu::Limits::default()
                },
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        )
        .block_on()
        .expect("no device");

    let num_wg = n.div_ceil(WG as usize) as u32;
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
        size: (num_wg as u64) * 4,
        usage: st | wgpu::BufferUsages::COPY_SRC,
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
        size: (n as u64).max(num_wg as u64) * 4,
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
    let pipe_dng = make_pipe("dangling");

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
            ],
        })
    };
    let bg = [bind(&b_a, &b_b), bind(&b_b, &b_a)];

    let base = (1.0 - D) / n as f32;
    // Read back `num_wg` partials, sum → dangling.
    let read_partials = |device: &wgpu::Device, queue: &wgpu::Queue| -> f32 {
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(&b_part, 0, &staging, 0, (num_wg as u64) * 4);
        queue.submit([enc.finish()]);
        let slice = staging.slice(0..(num_wg as u64) * 4);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::Maintain::Wait);
        let sum: f32 = bytemuck::cast_slice::<u8, f32>(&slice.get_mapped_range())
            .iter()
            .sum();
        staging.unmap();
        sum
    };

    // ── Run: dangling → add → spmv, ping-ponging, for `iters` supersteps ─────────────────────────────
    let t = Instant::now();
    let mut dir = 0usize; // which bind group / read buffer
    for _ in 0..iters {
        // 1) dangling reduction over the current rank (rank_in of this dir).
        let mut enc = device.create_command_encoder(&Default::default());
        {
            let mut cp = enc.begin_compute_pass(&Default::default());
            cp.set_pipeline(&pipe_dng);
            cp.set_bind_group(0, &bg[dir], &[]);
            cp.dispatch_workgroups(num_wg, 1, 1);
        }
        queue.submit([enc.finish()]);
        let dangling = read_partials(&device, &queue);
        let add = base + D * dangling / n as f32;
        queue.write_buffer(
            &b_params,
            0,
            bytemuck::bytes_of(&Params {
                n: n as u32,
                base,
                damping: D,
                add,
            }),
        );
        // 2) spmv.
        let mut enc = device.create_command_encoder(&Default::default());
        {
            let mut cp = enc.begin_compute_pass(&Default::default());
            cp.set_pipeline(&pipe_spmv);
            cp.set_bind_group(0, &bg[dir], &[]);
            cp.dispatch_workgroups(num_wg, 1, 1);
        }
        queue.submit([enc.finish()]);
        dir ^= 1;
    }
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

    let maxd = cpu
        .iter()
        .zip(&gpu_rank)
        .map(|(a, b)| (*a - *b as f64).abs())
        .fold(0.0f64, f64::max);
    let gteps = m as f64 * iters as f64 / gpu_s / 1e9;
    println!(
        "  GPU {iters} iters: {gpu_s:.3}s  →  {gteps:.2} GTEPS  ({:.1} Medges·it/s)",
        gteps * 1000.0
    );
    println!(
        "  vs CPU bit-exact PageRank: max|Δ| {maxd:.2e}  (f32 GPU → tolerance, not bit-exact)"
    );
}

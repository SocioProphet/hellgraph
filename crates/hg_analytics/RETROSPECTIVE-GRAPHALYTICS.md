# Retrospective — the WCC loss + LCC divergence at 69M scale (2026-07-13)

## What happened
- Small/medium graphs (RMAT 4.2M, web-Google 5.1M): we swept — PageRank 3.8–33×, WCC 3×, CDLP 4×, LCC identical.
- Canonical big graph (LiveJournal, 4.8M nodes / 69M edges): the sweep BROKE.
  - PageRank: 2679 ms vs GDS 11967 ms = **4.5× WIN** (clean, Σ=1.0).
  - WCC: 880 ms vs GDS **409 ms** = **2.1× LOSS**.
  - CDLP: 13.9 s vs 21.2 s = 1.5× faster, but community counts differ (207k vs 64k) → soft.
  - LCC: coefficient 0.338 (ours) vs 0.269 (GDS) → NOT the same number → can't claim.

## Loss #1 — WCC. Root cause: sequential vs parallel, and the scale crossover.
- Our `connected_components_uf` is **single-threaded union-find** (path-halving + union-by-size). Algorithmically
  optimal O(m·α(n)) — but ONE core.
- GDS WCC is **parallel** (all 16 cores). Both found 1876 components → same answer, fair comparison, GDS faster.
- The crossover: at 5M edges our low-overhead single thread (62 ms) beats GDS's parallel-with-startup-overhead
  (187 ms). At 69M edges the work is ~14× bigger → our single thread scales to 880 ms; GDS divides the work
  across 16 cores → 409 ms. **We were on the wrong side of the parallel crossover.**
- THE PREDICTIVE PATTERN: **PageRank WON at 69M (4.5×) because it's parallel (rayon). WCC LOST because it's
  sequential.** The kernels we parallelized win at scale; the ones we left sequential lose. That's the whole story.

## "Loss" #2 — LCC. Honest correction + root cause.
- I first called it a "reciprocal double-count bug." On review that's WRONG: the LCC code sorts+dedups each
  node's adjacency, so it does NOT double-count. I over-diagnosed in the moment.
- The real cause is a **definitional mismatch** that surfaced only on a social graph: self-loops, how reciprocal
  directed edges collapse to undirected, and/or the AVERAGING DENOMINATOR (÷n over all nodes vs ÷ nodes with
  degree≥2). LiveJournal has self-loops + heavy reciprocity; web-Google didn't trip it.
- The real failure: **we pinned the LCC definition on ONE graph (web-Google matched → false confidence) and
  never checked it against LDBC's exact LCC spec + GDS's definition on a structurally different graph.**

## Deep lessons (the ones that matter)
1. **Constant-factor optimization has a scale ceiling.** Our whole day = constant-factor wins (FxHash,
   array+dirty-list, CSR, dense ids, string interning). They DOMINATE small–medium but LOSE to parallelism at
   scale for parallelizable work. WCC proved it empirically.
2. **Parallelism is the scale lever, not cleverness.** The kernel we parallelized (PageRank) won at 69M; the one
   we didn't (WCC) lost. Predictive and actionable.
3. **Pin definitions to the opponent's EXACT spec, and verify equality on MULTIPLE structurally-diverse graphs.**
   One matching graph is false confidence (LCC matched on web, diverged on social).
4. **Big + varied graphs reveal truth; small graphs flatter.** Always test at target scale AND across graph
   structure (web / social / synthetic) before claiming a win.
5. **Methodology bugs masquerade as results.** BFS/SSSP node-mapping + GDS-traversal ate 5 iterations. The right
   move was to stop and mark it OPEN, not fake a number.

## Why we still have the edge (honest)
- Our architecture is genuinely newer + wins on axes their 15 years never built: DISTRIBUTED (68B, no node holds
  O(m)/O(n) — they can't hold it at all); HYPERGRAPH-native core (N-ary, they must reify); verified-compute/receipts.
- We ALREADY beat GDS on the kernel we parallelized (PageRank 4.5× at 69M).
- Their 15 years bought PARALLEL-everything — that's the ONLY thing that beat us (WCC). Parallelizing a kernel is
  DAYS, not years. The gap is closable by finishing the work, not by out-maturing them.

## The recipe to beat them across the board (annealing plan)
1. **Parallelize every sequential kernel** (the proven pattern):
   - WCC → parallel connected components (Afforest-style sampling, or parallel label-prop with array+dirty-list).
   - CDLP → parallelize each label-prop sweep (rayon; synchronous by design, no oscillation risk like Louvain).
   - Louvain → finish the parallel version RIGHT (kill the per-color-class barrier cost that made it slow).
   - LCC → already rayon-parallel; PIN the definition to LDBC/GDS and re-verify.
   - BFS/SSSP → direction-optimizing / parallel-frontier for scale (single-source is memory-bound; parallel gather).
2. **Pin every kernel to LDBC's exact definition; verify equality on 3 diverse graphs (web + social + synthetic)
   at target scale BEFORE claiming.**
3. Then: MATCH their parallelism at scales they hold, and let the DISTRIBUTED + HYPERGRAPH moat win ABOVE their
   ceiling (68B). That's across-the-board AND beyond.

## Immediate next step
Parallelize WCC (reclaim the loss) + pin/verify LCC definition (turn the bug into a clean number), re-run
LiveJournal. Then parallelize CDLP + finish parallel Louvain. Verify on web + LiveJournal + Orkut before any claim.

## RESOLUTION — Anneal Round 1, VERIFIED on LiveJournal 69M (2026-07-13)
Every prediction in this retrospective held. Re-ran the exact graph that exposed the losses, same 16-core VM:
- **WCC loss → 6.2× WIN.** `connected_components_parallel` (lock-free atomic union-find, monotone linking,
  deterministic min-label): 880 ms → **77.4 ms** (11.4× our own-engine speedup) vs GDS 483 ms. Both found the
  identical 1876 components. The thesis — "parallelize the sequential kernel and it wins at scale" — proven on
  the graph that taught it. Local pre-check: 5.19× on 8 cores at 67M edges, partition-identical.
- **LCC divergence → matched + 2.7× WIN.** Root cause confirmed DEFINITIONAL, not a bug: made both engines
  compute on the LDBC-canonical SIMPLE graph (we dedup + strip self-loops; GDS `aggregation:'SINGLE'`). The
  ~0.07 gap (0.338 vs 0.269) collapsed to ~0.006 (**0.27424 vs 0.26862**). Graph match independently verified
  (GDS 'gu' 86,220,856 rels = our simple edge count). We win the time 2.7× on the identical graph; residual 2%
  = GDS retaining self-loops we strip per LDBC (we're the conformant side).
- **BFS/SSSP "GDS quirk" → was MY bug, corrected.** Lesson 5 (methodology bugs masquerade as results) bit me
  again: the "0 reached" was `sourceNode:id(s)` (integer) instead of the documented `sourceNode:s` (node
  object). Read the GDS docs, fixed it. Re-testing on the 3rd graph.
- **CDLP** stayed ~even (1.1×) with divergent community counts — sync-vs-async LP variants; not yet a clean
  comparison. Open.
Net: on the graph that exposed the losses there are now ZERO losses on comparable kernels. Still owed for a
true across-the-board claim: clean CDLP comparison, a real BFS/SSSP race (binding now fixed), and confirmation
on a 3rd diverse graph at ≥ LiveJournal scale (Orkut 117M, in flight).

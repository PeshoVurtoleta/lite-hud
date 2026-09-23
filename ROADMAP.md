# lite-hud -- improvement roadmap (v2.0.0 -> v3.0: the observability HUD)

Blueprint: `../LiteSketch/ROADMAP.md` + `../LiteAdaptive/ROADMAP.md` (milestone table, shared law,
gate spec, per-member briefs). See `RESEARCH.md` for the full evaluation of the current state, the
integration matrix, the wiring model, and the open questions. ASCII-only (`->`, `<=`, `x`, "p99").

Status: SETTLED (2026-09-23). lite-hud is SHIPPED at v2.0.0; this is an improvement roadmap, not a
new package. The wiring model (CORE / PARITY / PEER with dependency injection) and the release line
(additive v2.x, v3.0 = redesign + frozen DI contract) are accepted; every peer's real API was audited
(RESEARCH.md section 12), which supersedes the tool choices below where they differ. Each milestone is then a full pipeline
session (planner -> settle -> coder -> reviewer -> qa); the maintainer commits/publishes; /release
gate + catalog card sync after, exactly as the rest of the suite.

## Milestones

| # | Milestone | Version | Headline | Wiring | Status |
|---|-----------|---------|----------|--------|--------|
| **M1** | Technical health: torture gate + fix the openPool GC hole + lite-viewport rendering | 2.1.0 | genuinely 0-B/op write path (witnessed) + crisp DPR-correct, resize-aware canvas | PARITY (openPool) + PEER (viewport, inline fallback) + perf gate | DONE 2026-09-23 (verify green; awaiting /release) |
| **M2** | **DDSketch percentiles** (the headline) | 2.2.0 | per-channel p50 / p90 / p99 / p99.9 readouts + a p50-p99 band on latency traces | PEER (inject `quantiles` factory) | planned |
| **M3** | Hot spots + cardinality | 2.3.0 | SpaceSaving top-k hot-spots panel + HyperLogLog distinct-count readout (+ optional CountMinSketch per-label frequency) | PEER (inject `topk` / `distinct` / `freq`) | planned |
| **M4** | Rolling aggregates + partial redraw | 2.4.0 | WindowFold / MonoDeque O(1) rolling mean/min/max (replace the O(n) render rescan) + inline dirty-set partial redraw | PEER (lite-o1) + PARITY (dirty-set) | planned |
| **M5** | Exact range/rank + dedup | 2.5.0 | lite-logn Fenwick / SegmentTree exact sub-window aggregates + WaveletTree exact quantile cross-check; lite-filter first-seen + lite-lru TTL windowed dedup | PEER | planned |
| -- | **v3.0** -- the observability HUD | 3.0.0 | freeze the analytics + DI / optional-peer contract as STABLE; the visual redesign (summary tiles + bands + hot-spots panel) | -- | planned |
| M6+ | lite-adaptive drift markers (recent p99, "regime changed") | post-3.0 | sliding-window / decayed stats + drift cursors | PEER | backlog (after lite-adaptive 1.0.0) |

The core SPP demux (LUT, rings, CONT/paired/complete SPAN, meta stream) stays BYTE-STABLE across all
milestones; every addition is additive and opt-in. With no peers injected, lite-hud remains today's
zero-dep package (M1's parity fixes aside, which only make the existing claim true).

## 1. Shared law (every milestone)

- Zero runtime deps BY DEFAULT. The suite tools integrate by dependency INJECTION (optional peers) or
  design-parity copy -- NEVER a hard import of a primitive. Reuse the idiom, not the dep.
- ASCII-only source. `node:test` only. `sideEffects: false`. Single-file `Hud.js`, additive.
- ZERO allocation on the WRITE path (`write` / `push` / paired open+close / the injected-analytics
  `add`). Render is a disclosed COLD path (caller-throttled) and may allocate to draw. The line is
  strict and stated.
- Fail closed: a bad option / injected-factory misuse / bad channel desc throws with the file's
  existing `@zakkster/lite-hud:` prefix, typeof-first; queries (`stats` / `inspect` / getters) never throw.
- Peers never throw into the write path: several peers THROW on bad input (DDSketch on NaN /
  negative / Infinity, Fenwick/SegmentTree on non-finite, WindowFold when full). lite-hud
  pre-validates, counts a drop, and keeps every peer inside its preconditions (RESEARCH 12.7).
- Optional `peerDependencies` are declared per milestone, when code first uses the peer.
- Backward compatible: the v2.0.0 API is a strict subset; no existing call changes shape.
- DESIGN-PARITY, never a dep, for the CORE/PARITY tier (CuckooMap idiom, BitSet dirty-set).

## 2. Design calls to settle FIRST (from RESEARCH.md section 5 + 11)

- **The WIRING MODEL** (SETTLED 2026-09-23): CORE (unchanged) + PARITY (inline, zero-dep fixes) +
  PEER (optional peers via DI). Analytics activate only when the consumer injects factories:
  `createHud(el, { viewport, stats: { quantiles, topk, distinct, freq } })` + a per-channel override
  on `hud.channel()`. `peerDependencies` declared OPTIONAL.
- **Per-milestone**: DDSketch alpha per channel (M2); SpaceSaving capacity + what the top-k ranks by
  (total time vs count) (M3); WindowFold operator per channel kind (M4); the exact vs approximate
  quantile cross-check policy (M5).

## 3. Gates -- what "proven" means (shared spec)

### 3.1 The torture gate (`test/torture.mjs`) -- NEW in M1, the load-bearing witness
`node --expose-gc test/torture.mjs` (lite-leak + lite-gc-profiler): 0 B/op and 0 retained growth on
`write()`, every `push()` kind, the paired-span open+close path, and -- with analytics injected --
the `add` calls into the injected sketches. gc major 0 over the window. This is the proof of the
"Zero-GC Hot path" badge the README already flies; M1 makes the badge TRUE (it catches the current
openPool Map allocation and gates its fix). "The HUD does not perturb what it profiles."

### 3.2 The functional suite (`test/Hud.test.js`) -- extend the existing 59 tests
Per milestone: the new readouts/panels compute the right numbers against a known stream + an exact
oracle (the DDSketch p99 vs a sorted-array oracle; the SpaceSaving top-k vs an exact Map; the HLL
distinct vs an exact Set) -- the lite-sketch witness discipline, run headless (`mountEl = null`).

### 3.3 The perf gate (`test/perf/PerfGate.test.mjs`) -- NEW in M1
`@zakkster/lite-perf-gate` `zgcSuite` in the lite-o1 shape (RESEARCH 12.6): N 200000, k 8,
0 scavenges / old-gen / arrayBuffers KB, `grows: 0`, retained <= 64 KB, one `mustFail` control.
M1 covers every write/push kind + paired open/close + pool eviction churn + meta records; from M2 on,
each milestone adds its analytics-ON scenarios (the per-op cost class must not change vs OFF).

### 3.4 The rendering check (M1)
With `lite-viewport` injected: correct backing-store size at DPR 1/2/3, a simulated DPR change and a
parent-resize both re-size the canvas, `maxDpr` caps the backing store, and no cumulative-scaling
drift across repeated resizes. Headless-guarded where DOM is absent.

### 3.5 The control (fail-path)
A bad `createHud` option / bad injected factory / bad channel desc throws before use; with NO peers
injected, every M2-M5 feature degrades gracefully to the v2.0.0 behavior (no throw, no readout).

## 4. Session order

Settle the wiring model -> M1 (health: torture gate + openPool fix + viewport) -> M2 (DDSketch p99)
-> M3 (SpaceSaving + HLL) -> M4 (WindowFold + dirty-set) -> M5 (lite-logn + lite-filter) -> v3.0
(freeze DI contract + visual redesign) -> post-3.0 lite-adaptive drift. M1 is correctness-first and
unlocks the honest base every later milestone builds on (a witnessed 0-B/op write path).

## 5. The briefs

### M1 -- Technical health (v2.1.0)
- PURPOSE: make the zero-GC claim TRUE and witnessed, and the rendering DPR-correct -- no data-model
  change.
- WORK: (a) add `test/torture.mjs` (lite-leak + lite-gc-profiler) over write/push/paired/analytics-off,
  written FIRST against the current code (it must fail on paired spans) + a `torture:controls` run;
  (a2) add `test/perf/PerfGate.test.mjs` (lite-perf-gate, section 3.3);
  (b) replace the paired-span `openPool` JS Map with an inline integer-keyed open-addressing pool
  (CuckooMap idiom, design-parity: `Float64Array` correlId + t_open + a Uint8 occupancy so id 0 is
  legal, backshift delete, oldest-first eviction via an inline FIFO; NaN correlId on open = drop,
  -0 -> +0) -> 0-B/op open/close (no suite map fits -- RESEARCH 12.1); (c) adopt `lite-viewport`
  (injected `Viewport` CLASS, HUD-owned sized wrapper div so the viewport measures the HUD not the
  page, synchronous `vp.resize()` on row growth, `onResize` -> redraw) with the current inline DPR
  path as the fallback (plus the `setTransform` reset); (c2) BUDGET_SET meta records stop
  allocating: preallocated per-channel budget slots, a repeat BUDGET_SET for a channel REPLACES its
  meta budget (today it appends a fresh object per record -> unbounded retention); (d) package.json: devDeps (3 gates +
  lite-viewport), optional peer lite-viewport, scripts `torture` / `torture:controls` / `test:perf` /
  `verify`.
- GATE: `npm run verify` green: torture "ok" (0 B/op incl. paired spans), controls fail as they
  must, perf gate passes with its mustFail caught; the 59 tests still pass (+ eviction-order, key
  edge cases, bad `viewport` option);
  the rendering check passes at DPR 1/2/3 + a DPR-change + a parent-resize.
- DONE WHEN: 0-B/op write path witnessed, openPool + BUDGET_SET allocations eliminated, viewport rendering in with a
  fallback, /release 2.1.0 clean.

### M2 -- DDSketch percentiles (v2.2.0) -- the headline
- PURPOSE: per-channel latency percentiles, the number a profiler HUD exists to show.
- WORK: inject `stats.quantiles` (a `() => DDSketch` factory); on `write`/`push` for SPAN (and opt-in
  LEVEL) channels pre-check the value (finite, >= 0, not subnormal; else a counted drop) then call
  `sketch.add(value)` (0-B/op); window by rotating two sketches + 0-alloc `merge` into a scratch at
  render (DDSketch has no decay); on render draw p50/p90/p99/p99.9 tiles + a shaded
  p50-p99 band behind the trace. A per-channel override on `hud.channel({ quantiles })`.
- GATE: the reported p99 is within DDSketch alpha of a sorted-array oracle on a known stream; torture
  shows the analytics-ON write path still 0 B/op.
- NON-GOALS: per-label sketches (M3+); exact quantiles (M5 cross-check).

### M3 -- Hot spots + cardinality (v2.3.0)
- PURPOSE: "which few things dominate" + "how many distinct."
- WORK: inject `stats.topk` (`() => SpaceSaving`) -> a hot-spots panel ranking spans/labels by total
  time (integer microseconds -- SpaceSaving weights are integers) or count (a settle-time choice);
  render via 0-alloc `forEach` into a preallocated top-N buffer (`topK()` allocates); inject `stats.distinct` (`() => HyperLogLog`) -> a distinct
  correlId / event-key readout; optional `stats.freq` (`() => CountMinSketch`) for per-label frequency
  on a high-cardinality dimension without a channel per key.
- GATE: top-k recall vs an exact Map oracle; distinct within HLL error vs an exact Set; 0-B/op write.

### M4 -- Rolling aggregates + partial redraw (v2.4.0)
- PURPOSE: kill the O(n) render rescan and redraw only what changed.
- WORK: inject lite-o1 `WindowFold` / `WindowFoldUint32` per channel (one op per instance; `evict()`
  before `push()` when full -- it throws otherwise) -> O(1) rolling mean/sum/min/max
  (and flag-mask OR/AND/XOR) readouts, replacing the render-time min/max scan; `MonoDeque` -> a rolling
  min/max envelope band; a design-parity `BitSet` dirty-channel set so `render()` redraws only channels
  that received a record since the last frame (inline -- a few Uint32 words; no lite-o1 BitSet dep).
- GATE: rolling values match a brute-force window oracle; render touches only dirty channels; 0-B/op write.

### M5 -- Exact range/rank + dedup (v2.5.0)
- PURPOSE: exact sub-window analysis + an approximate/exact cross-check + event dedup.
- WORK: inject `lite-logn` `Fenwick` / `SegmentTree` -> exact range-sum / range-min/max over the ring
  for a dragged sub-window (`set(slot, v)` follows ring overwrites; a wrapped window = two queries);
  `WaveletTree` built cold from the ring snapshot -> exact windowed `quantile(lo, hi, k)` as an EXACT
  cross-check against the DDSketch p99 (print both, show the gap is within alpha) -- MergeSortTree is
  static with an ~88 KB rebuild and is rejected (RESEARCH 12.4); inject `lite-filter` `Bloom`
  (`keys:'int'`) -> unbounded first-seen error signatures; inject `lite-lru` (`keys:'int'`, `ttl`,
  `clock` = HUD time) -> exact windowed "suppress the same signature within N ms" (lazy reap in
  `get()`, never `purgeStale()` on the hot path). Signature = (sid, op, code) folded into int32.
- GATE: exact aggregates match a brute-force oracle; the DDSketch-vs-WaveletTree gap is within alpha;
  dedup matches an exact Map+timestamp oracle.

### v3.0 -- the observability HUD (3.0.0)
- Freeze the analytics + DI / optional-peer contract as STABLE (the promise to consumers like lite-pick).
- The visual redesign: summary tiles (last / mean / p99) + p50-p99 bands + the live hot-spots panel; a
  layout beyond the single 290px trace column. The demo (RESEARCH.md section 9).
- Post-3.0 (M6+): lite-adaptive drift markers once lite-adaptive reaches 1.0.0.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

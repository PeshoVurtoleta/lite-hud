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
| **M1** | Technical health: torture gate + fix the openPool GC hole + lite-viewport rendering | 2.1.0 | genuinely 0-B/op write path (witnessed) + crisp DPR-correct, resize-aware canvas | PARITY (openPool) + PEER (viewport, inline fallback) + perf gate | RELEASED 2.1.0 (commit 27914a7, 2026-09-23; card synced) |
| **M2** | **DDSketch percentiles** (the headline) | 2.2.0 | per-channel p50 / p90 / p99 / p99.9 readouts + a p50-p99 band on latency traces | PEER (inject `quantiles` factory) | DONE 2026-09-23 (verify green on lite-sketch 1.1.0 from the registry; reviewer APPROVED, qa PASS; awaiting /release 2.2.0) -- section 6.1 |
| **M3** | Hot spots + cardinality | 2.3.0 | SpaceSaving top-k hot-spots panel + HyperLogLog distinct-count readout (+ optional CountMinSketch per-label frequency) | PEER (inject `topk` / `distinct` / `freq`) | planned |
| **M4** | Rolling aggregates + partial redraw | 2.4.0 | WindowFold / MonoDeque O(1) rolling mean/min/max (replace the O(n) render rescan) + inline dirty-set partial redraw | PEER (lite-o1) + PARITY (dirty-set) | planned |
| **M5** | Exact range/rank + dedup | 2.5.0 | lite-logn Fenwick / SegmentTree exact sub-window aggregates + WaveletTree exact quantile cross-check; lite-filter first-seen + lite-lru TTL windowed dedup | PEER | planned |
| -- | **v3.0** -- the observability HUD | 3.0.0 | freeze the analytics + DI / optional-peer contract as STABLE; the visual redesign (summary tiles + bands + hot-spots panel) | -- | planned |
| **D** | **Pro-tier demo** (after v3.0; every milestone implemented) | repo-only (no version bump) | a multi-scene live demo on the REAL shipped Hud.js + REAL peers + a real lite-scope, with a Truth Panel (0 B/op frame path + live error-vs-bound) -- the LiteSketch / LiteO1 demo tier | -- | planned (section 7) |
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
(freeze DI contract + visual redesign) -> D (pro-tier demo) -> post-3.0 lite-adaptive drift. M1 is correctness-first and
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
- CANDIDATE (2026-09-23): lite-adaptive `ExponentialHistogram` (in development in parallel). The HUD
  window is TIME-based (`windowSec`), while WindowFold is count-based (the last N records). EH gives
  count / sum / mean / rate over the last W seconds within epsilon, with a caller-supplied monotone
  `now` (= HUD record time) and a fixed bucket pool. Likely split: EH for time-window sum / mean / rate,
  MonoDeque for the exact min/max envelope. Settle at the M4 planner against lite-adaptive's shipped
  API. It must expose `addFrom(buf, i)` and config getters (LiteAdaptive ROADMAP section 1 + 3.5b).

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
  The fold MUST be SIGNED (`... | 0`), never `>>> 0`: lite-filter `keys:'int'` accepts signed int32
  only and THROWS on [2^31, 2^32) (LiteFilter RESEARCH.md 1.5 N1; negatives are 0-alloc, measured).
- GATE: exact aggregates match a brute-force oracle; the DDSketch-vs-WaveletTree gap is within alpha;
  dedup matches an exact Map+timestamp oracle.

### v3.0 -- the observability HUD (3.0.0)
- Freeze the analytics + DI / optional-peer contract as STABLE (the promise to consumers like lite-pick).
- The visual redesign: summary tiles (last / mean / p99) + p50-p99 bands + the live hot-spots panel; a
  layout beyond the single 290px trace column. The demo (RESEARCH.md section 9).
- Post-3.0 (M6+): lite-adaptive drift markers once lite-adaptive reaches 1.0.0.

## 6. NEXT SESSION -- M2 (DDSketch percentiles, v2.2.0)

Entry state: 2.1.0 committed (27914a7), `npm run verify` green (86 tests, torture ok, controls ok,
perf 11/11). Peer: `@zakkster/lite-sketch` 1.0.0 (`DDSketch`). Pipeline: planner -> settle -> coder
-> reviewer -> qa -> /release 2.2.0 -> /sync-card lite-hud.

Peer facts the planner must build on (from `../LiteSketch/llms.txt`, re-read before the planner runs):
- `new DDSketch(alpha, { maxBins = 2048, range? })`. `add(value, count=1)` is O(1) and 0-alloc, but it
  THROWS on a non-number / NaN / +-Infinity / a negative value / a value outside the indexable range
  (about [2.2e-308, 8.6e307] at alpha=0.01, and the window widens with alpha).
- `quantile(q)` is a COLD O(bins) walk and never throws (it returns NaN on empty). `merge(other)`
  requires the same alpha and throws otherwise. `clear()` reuses the storage.
- The default is collapsing-lowest (unbounded range, bounded memory, upper quantiles preserved). With
  `range` it is strict and THROWS out of range.

Settle calls -- SETTLED 2026-09-23: all six take the lean; rejected values go to a NEW
`stats().quantileDrops` (existing `drops` unchanged). Planner verified merge/clear 0-alloc
(Sketch.js:1159, 1196).
1. Where the factory lives: `createHud(el, { stats: { quantiles } })`, or `attach(scope, { stats })`,
   plus the per-channel `hud.channel({ quantiles })` override. Lean: createHud, so manual channels
   made before attach are covered.
2. The hot-path pre-check under the peer no-throw law. `add()` throws, so the HUD must reject exactly
   the set `add()` would reject: `typeof v !== 'number' || v !== v || v < 0 || v === Infinity`, plus
   `v > 0 && (v < lo || v > hi)`, where lo/hi are derived ONCE at attach from the sketch's alpha.
   Every rejection is a counted drop. Never try/catch on the hot path: the throw allocates an Error.
   Lean: derive lo/hi cold by a bisect probe against a scratch sketch, not a hardcoded 2.2e-308.
3. A strict-range sketch from the factory. `add()` would throw on out-of-range values. Lean: probe at
   attach (add a far-out value to a scratch instance inside try/catch; cold, so allowed) and throw
   `@zakkster/lite-hud:` fail-closed if the factory returns a strict sketch.
4. The window. Rotate two sketches every `windowSec/2`, then at render `clear()` + `merge` both into a
   scratch sketch. Coverage is between windowSec/2 and windowSec. Confirm that `merge` is 0-alloc with
   a scratch of the same alpha (reviewer gate). Memory is 3 x maxBins x 8 B per channel (48 KB at
   2048 bins). Lean: maxBins stays with the factory owner; the HUD documents the cost.
5. What is sketched. SPAN durations: always when injected. LEVEL: opt-in per channel. COUNTER /
   INSTANT: never. Units are the channel's own (ms for spans).
6. What a readout tile shows. p50 / p90 / p99 / p99.9 + N. An empty window shows "--", never 0
   (null is not zero).

Gates (added to the M1 set; they do not replace it):
- Oracle: on uniform, lognormal and pareto span streams, each displayed quantile is within alpha of a
  sorted-Float64Array oracle over the SAME window (including across a rotation boundary).
- Torture: an analytics-ON lane is 0 B/op for write/push on paired, complete and LEVEL channels. The
  analytics-OFF lane is unchanged.
- Perf gate: +analytics-ON scenarios, plus a mustFail control (for example, a factory whose add()
  allocates must be caught).
- Controls: `LITE_HUD_TORTURE_BREAK` gains an analytics break (for example, a per-add closure) that
  must exit non-zero.
- Degrade: with no factory, render output and stats are byte-identical to 2.1.0 (golden
  `stats()` + render call trace). A rejected value is counted in `stats().drops` (or a new
  `quantileDrops`, settle) and never reaches `add()`.
- Docs: README (allocation table + DDSketch section + the pre-check law), llms.txt (and fix its
  stale "80 tests"; there are 86), d.ts, CHANGELOG, RESEARCH/ROADMAP status.

### 6.1 M2 review outcome (2026-09-23): REJECTED -> BLOCKED on the peer

The coder delivered the settled design, uncommitted (98/98 tests, perf 14/14, torture ok, break
control exits 1). The coder moved paired-span analytics off the perf 0-scavenge lane and called it
"caller-side call-boundary boxing". The reviewer REJECTED that and measured it (zgcSuite scaling
lane, --max-semi-space-size=4, fractional performance.now()-like inputs):
- Per-op, library-owned. `Hud.js` passes the library-computed duration (`t - tOpen`) into the peer's
  `add(value)`; V8 boxes a fractional tagged argument when the call does not inline. Measured scaling:
  paired minorLo=4 -> minorHi=36, proportional to k. (The review's first claim that complete/LEVEL box
  too, 1 -> 12, was CORRECTED by the probe below: that was the caller's own write() argument box,
  present with analytics OFF.)
- Hidden by SMI inputs. Every analytics gate fed integer durations (3, 5, `v & 63`), which box as Smi
  and read 0.
- Not fixable HUD-side. Inlining the pre-check and rotation into `write()` left paired 5 -> 36: the
  box sits at the peer boundary. The 1-first / 7-last difference was a baseline shift, not
  megamorphism or heap pressure.

PROBE RESULT (2026-09-23, scratchpad copies; zgcSuite N=200000 k=8, 4 MB semi-space, fractional
t and values, full-suite order; minorLo -> minorHi):
  kind      analytics OFF   ON add()    ON addFrom()
  paired    4 -> 24         5 -> 43     4 -> 24
  complete  3 -> 24         3 -> 24     4 -> 24
  LEVEL     3 -> 24         3 -> 24     4 -> 24
The OFF baseline (-> 24) is the caller passing fractional t/a into write(): V8 boxes that argument.
It is caller-side and already exempt. Against that baseline, only PAIRED carried a real analytics box:
the library-computed `t - tOpen` (43 vs 24). addFrom removes it exactly. Complete and LEVEL had no
analytics delta. GATE YARDSTICK: analytics-ON scaling == analytics-OFF scaling (delta 0) on
fractional inputs. Literal 0 is unreachable for any fractional-input path; integer inputs must still
read 0.

DECISION (maintainer, 2026-09-23): fix at the peer (option B). lite-sketch 1.1.0 adds
`DDSketch.addFrom(buf, i)` (the value read unboxed from a Float64Array inside the peer; LiteSketch
ROADMAP section 6 task 7, RESEARCH 12.5) plus the N1 getters (`strict`, `minIndexable`,
`maxIndexable`). lite-sketch is in development; the maintainer pings when it is implemented and
measured. REJECTED alternatives: drain-at-render (write() stores only; render replays new ring records
into the sketch; 0-alloc hot path, but records overwritten between drains are lost and nothing is
sketched while render is not called), and accept-and-disclose (breaks the suite's zero-allocation law).

M2 REWORK (after lite-sketch 1.1.0; coder -> reviewer -> qa):
1. The hot path stores the value into a per-channel `Float64Array(1)` scratch and calls
   `ch.q.addFrom(ch.qBuf, 0)`. The factory contract requires `addFrom`, checked when the sketch is
   created (fail closed if missing).
2. Replace the cold bisect probe + the TypeError/RangeError strict sniff with the N1 getters: throw on
   `strict`, and the pre-check bounds = `minIndexable` / `maxIndexable`.
3. Gates drive FRACTIONAL values on every analytics lane (torture measureAllocs + scavenge lane, perf
   scaling lane: paired, complete, LEVEL, push), plus a control lane through `add(value)` that MUST
   show the box (proves the lane has teeth). Target: analytics-ON scaling == analytics-OFF
   scaling (delta 0) on all three kinds; integer inputs still 0. Paired goes back on the perf lane.
4. Docs: README:286/292/297, llms.txt:131, PerfGate note :290. Delete the false "add allocates
   nothing" and the "caller-side" labelling; state the addFrom design.
5. Regenerate package-lock.json (lite-sketch devDep + optional peer ^1.1.0). Drop the local
   node_modules symlink once the real package resolves.
6. Nit: `stats().quantileDrops` is always present (allowed by settle 6); say so in the CHANGELOG.

OUTCOME (2026-09-23): rework DONE. Reviewer APPROVED (after two narrow fixes: a false test NOTE, and
the lockfile regenerated against lite-sketch 1.1.0 from the registry; `strict === false` is required
explicitly). QA PASS on A1-A5 with +11 boundary tests. QA also found a defect that predates M2
(render() threw on a reentrant destroy() from inside a draw call); it is fixed with a per-frame local
ctx snapshot, and the test now asserts no throw + full teardown. Final: 112/112 node:test, perf 17/17
(analytics paired/complete/LEVEL at 0 scavenges; fractional ON == OFF: 3 -> 24 for every kind, while
a direct add(qv) boxes to 36), torture `alloc=0 B/op | paired-scavenge=0 | analytics-scavenge=0 | ok`,
break control exits 1. Torture phase 2c stays INTEGER on purpose: the fractional delta lives in
test/perf/AnalyticsBox.test.mjs.

## 7. The pro-tier demo (D) -- after v3.0, once M2-M5 + the redesign are implemented

Tier = the LiteSketch / LiteO1 demo standard: `demo/index.html` + `demo/kernels.mjs` +
`demo/serve.mjs` + `demo/Demo.test.mjs`, npm scripts `demo` (`node --expose-gc --test
demo/Demo.test.mjs`) and `demo:serve`, and a blueprint `DEMO.md` written FIRST (modeled on
`../LiteSketch/DEMO.md`: the non-negotiables, template, roster -> scene map, per-scene spec, Truth Panel,
layout, demo-side zero-GC guardrails, honesty proof, packaging, settle calls). demo/ never ships (pack
gate). It replaces today's 463-line single-file `demo/index.html`.

Non-negotiables (these mirror LiteSketch DEMO.md section 0):
1. The demo frame path is itself 0 B/op. `kernels.mjs` step and renderPrep functions are gated at
   0 B/op in Demo.test.mjs. Only the exact oracles may allocate, and they are the contrast.
2. Every number shown is re-derived live from the SHIPPED `Hud.js` plus the REAL peers (lite-sketch,
   lite-o1, lite-logn, lite-filter, lite-lru, lite-viewport) against an exact in-tab oracle. Nothing
   is hardcoded. The version trinity holds: kernels VERSION === Hud.js VERSION === package.json.
3. The workload flows through a REAL `@zakkster/lite-scope` scope (`hud.attach(scope)`), not only
   manual channels, so the SPP demux itself is on display.

Scenes (one per shipped capability; a toolbar toggles each peer on/off live to show graceful degrade):
- 01 Baseline SPP: level / instant / paired and complete span / counter / CONT traces, BUDGET_SET dashed
  lines + VERDICT, and pool eviction under an open-span flood (drops counter). Also a viewport on/off
  + DPR 1/2/3 toggle.
- 02 Percentiles (M2): an injected latency spike. The p99 tile jumps and the p50-p99 band fattens;
  live |p99 - oracle| / oracle <= alpha shown next to the bound.
- 03 Hot spots + cardinality (M3): the SpaceSaving panel reorders live vs an exact Map (recall,
  count-error <= N/k). HLL distinct vs an exact Set within the HLL bound.
- 04 Rolling + partial redraw (M4): WindowFold mean/min/max vs a brute-force window; the MonoDeque
  envelope band; a "channels redrawn this frame" counter proving the dirty-set.
- 05 Exact sub-window + dedup (M5): drag a sub-window and get exact Fenwick/SegmentTree aggregates. The
  WaveletTree exact p99 is shown beside the DDSketch p99 with the gap <= alpha. A signature flood shows
  lite-filter first-seen + lite-lru TTL suppression vs an exact Map+timestamp oracle.
- (post-3.0) 06 Drift markers once lite-adaptive ships M6.

Truth Panel (always visible): measured demo-frame allocation (0 B/op), HUD `stats()` drops, the
current scene's live error vs its bound, peer versions, and a gate badge that goes red if any bound is
violated.

Honesty proof (`demo/Demo.test.mjs`, qa-gated): faithfulness (numbers re-derived from the real
classes), witness (the same thresholds as the unit gates), version trinity, a 0-B/op kernel gate per
scene with the oracle as the non-vacuous contrast, and a boundary matrix per scene (empty, 0/1/N-1/N/N+1,
NaN/-0, destroy mid-render, re-entrant render, peer absent).

Session shape: planner writes DEMO.md -> settle (scene count, whether lite-scope is a devDep or an
inline stub, serve port) -> coder -> reviewer -> qa. No version bump: demo/ is repo-only. Update
the README "Demo" link + the catalog card only if the README changes.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

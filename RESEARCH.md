# lite-hud Research Notes -- evaluation + integration plan

Blueprint: the RESEARCH spine of `../LiteSketch/RESEARCH.md` + `../LiteAdaptive/RESEARCH.md`
(identity, the analytical anchor, the roster/matrix, the honesty hook, the boundaries, the
reference work, the central design call, the demo, the path, the open questions). Unlike those
two this is an EXISTING, shipped package (v2.0.0) -- so this document is an EVALUATION of the
current state plus an INTEGRATION roadmap to a v3.0, not a from-scratch design. ASCII-only
(`->`, `<=`, `x`, "p99", "epsilon", "alpha" -- never Unicode).

Status: SETTLED (evaluation 2026-09-23; wiring + leans accepted, peer APIs audited in
section 12). Written at the maintainer's request: lite-hud "is a bit unused and unuseful in
its state" and "can be vastly improved, not only visually, but technically"
by evaluating and integrating the suite's tools (lite-sketch, lite-o1, lite-filter, lite-logn)
and lite-viewport. The wiring model (section 5) is the one call to settle before any
integration milestone -- now settled (section 11). Nothing here is coded yet.

---

## 1. Core Identity -- what it is, and what it should become

**Today (v2.0.0):** `@zakkster/lite-hud` is a zero-GC, single-file, zero-dependency canvas
overlay -- a duck-typed SINK for the `@zakkster` Streaming Profiler Protocol (SPP). It attaches
to a `lite-scope` mux, builds an O(1) LUT per stream, keeps a per-channel `Float64Array` ring of
`[t, a, b]` records (LEVEL / INSTANT / SPAN / COUNTER), and draws a phosphor-green oscilloscope
at ~10-15 Hz. It also works as a `stats.js` replacement via `hud.channel().push()`.

It is a competent DEMUX + a passive SCOPE. That is exactly the ceiling it has hit: it faithfully
TRANSPORTS and DRAWS the raw stream, but it DERIVES nothing from it. A profiler HUD that cannot
tell you your **p99 latency**, your **hottest spans**, or your **event cardinality** is a pretty
trace, not an observability tool -- which is why it reads as "unused / unuseful."

**The proposed identity (v3.0):** the read-side ANALYTICS HUD of the suite -- the surface that
turns the raw profiler stream into the numbers an engineer actually watches (percentiles, top-k
hot spots, distinct counts, rolling aggregates, drift), by consuming the suite's OWN zero-GC
tools. lite-hud becomes the DOGFOOD SHOWCASE: the HUD that proves lite-sketch / lite-o1 /
lite-logn on live data, while staying zero-dep-by-default through dependency injection (section 5).

The one-line reframe: **from "an SPP oscilloscope" to "the zero-GC observability HUD that
computes real statistics on the profiler stream -- and witnesses that it does so for free."**

---

## 2. The Evaluation (honest critique of the current state)

### What works (keep it)
- The SPP demux is clean: arithmetic packed-decode (correctly avoids the Int32 sign trap for
  `sid >= 0x8000`), an O(1) per-stream LUT, CONT-chained wide records, paired + complete SPAN
  layouts, meta-stream EPOCH / VERDICT / BUDGET_SET handling. This is the load-bearing core and
  should stay byte-stable.
- Zero-dep, single-file, `sideEffects:false`, headless test mode (`mountEl = null`), 59 node:tests.
- The manual-channel path (`hud.channel().push()`) as a `stats.js` drop-in is a good on-ramp.

### The gaps (what makes it "unuseful")
1. **No derived statistics -- the headline gap.** SPAN records ARE latencies; the single most
   important observability number, **p99**, is nowhere. LEVEL/COUNTER channels get only a
   last-value readout and a min/max autoscale. There is no percentile, no top-k, no
   distinct-count, no rolling mean/rate -- the HUD stores the data to answer all of these and
   answers none.
2. **A real ZERO-GC HOLE on the hot path.** Paired spans match open/close through a JS
   `Map<correlId, t_open>` (`Hud.js:291-303`): `openPool.set(a,t)` / `.get(a)` / `.delete(a)`
   allocate map entries, and the eviction path `openPool.keys().next().value` allocates an
   iterator -- per span, on the WRITE path. lite-hud advertises "Zero-GC Hot path" but its
   paired-span path is not. (See section 6.)
   A second hole (found in the M1 planning pass): a meta `BUDGET_SET` record does
   `channels[ci].budgets.push({threshold, label})` (`Hud.js:259`) -- an object per record AND an
   unbounded append on repeats (retention, not just allocation).
3. **No torture gate.** The package CLAIMS zero-GC but ships NO `test/torture.mjs`
   (lite-leak + lite-gc-profiler) -- the suite's standard proof. The 59 tests are functional
   only. The claim is currently unwitnessed (and, per gap 2, partly false).
4. **DPR-naive, resize-fragile rendering.** `resize()` reads `devicePixelRatio` once, re-`getContext`
   + re-`scale` on each call, resizes only LAZILY when the row count grows, and never reacts to a
   CSS-box change, a monitor swap, or an OS display-scale change. No `maxDpr` cap (a 3x phone pays
   full fill-rate). This is precisely what `lite-viewport` exists to fix (section 8).
5. **O(n) render-time rescans.** Every `render()` rescans each LEVEL ring to recompute window
   min/max (`Hud.js:597-608`) -- O(n) per channel per frame -- and redraws every channel whether
   or not it changed. Rolling aggregates + a dirty-set make this O(1)/O(changed).
6. **Cosmetically dated.** One fixed 290px column of stacked 48px traces, phosphor-green only, no
   panels, no summary tiles, no percentile band. The visual is a 2000s stats.js pastiche; the data
   now available (once gaps 1/5 close) deserves tiles + bands + a hot-spots panel.

The through-line: lite-hud has all the raw material and does the least possible with it. Every gap
above is closed by a tool the suite ALREADY SHIPS.

---

## 3. The Thesis: the dogfood observability HUD

The suite has four foundational toolkits and no flagship CONSUMER that shows them working together
on live data. lite-hud is the natural one: a profiler HUD is a streaming-analytics problem, and the
suite is a streaming-analytics toolbox. Turning lite-hud into that consumer:
- makes lite-hud genuinely useful (it answers the questions engineers watch);
- gives the suite a living, visible proof (the DDSketch p99 on the HUD is measured on YOUR stream);
- and does it under the suite's own discipline (0-B/op, witnessed), so the HUD does not perturb the
  thing it profiles.

This is the same move lite-pick made (it designs in `DDSketch` as an optional peer for p99-aware
balancing); lite-hud should make it the centerpiece.

---

## 4. The Integration Matrix (the heart of this evaluation)

Each row: the suite tool, the HUD capability it unlocks, and the recommended wiring (section 5
defines the wiring tiers: CORE = zero-dep inline; PARITY = design-parity copy, no dep; PEER =
optional peer via dependency injection).

| Suite tool | HUD capability it unlocks | Wiring |
|------------|---------------------------|--------|
| **lite-viewport** | DPR-correct, resize-aware, DPR-capped crisp rendering; fixes every `resize()` gap (4) in one drop-in | PEER (rendering; graceful fallback to current inline path if absent) |
| **lite-o1 CuckooMap** | 0-GC paired-span open/close matching -- FIXES the `openPool` Map hot-path allocation (gap 2) | PARITY (small integer-keyed open-addressing pool inlined; no dep) |
| **lite-sketch DDSketch** | per-SPAN / per-LEVEL live **p50 / p90 / p99 / p99.9** readouts + a percentile band on the trace -- THE headline feature | PEER (0-B/op `add` on write; `quantile(q)` on render) |
| **lite-sketch SpaceSaving** | **top-k hot spots** panel: which spans / labels dominate total time or fire most often | PEER |
| **lite-sketch HyperLogLog** | **distinct-count** readout: unique correlIds / event keys in the window (cardinality) | PEER |
| **lite-sketch CountMinSketch** | per-label **frequency** for a HIGH-CARDINALITY dimension (per-route counts) with NO channel-per-key blowup | PEER |
| **lite-o1 WindowFold / WindowFoldUint32** | O(1) rolling **sum / mean / min / max** (and OR/AND/XOR of flag masks) per channel -- replaces the O(n) render rescan (gap 5) | PEER / PARITY |
| **lite-o1 MonoDeque** | O(1) rolling **min/max envelope** -> a cheap min-max band behind the trace | PEER / PARITY |
| **lite-o1 BitSet / SparseSet** | a **dirty-channel set** -> partial redraw (only channels that got a record since last frame) (gap 5) | PARITY (inline; section 12.3) |
| **lite-o1 Reservoir** | a uniform **sample** of span durations for a detail histogram without buffering all | PEER |
| **lite-logn Fenwick / SegmentTree** | **exact** range-sum / range-min/max over the ring for an arbitrary sub-window (drag-to-zoom) | PEER |
| **lite-logn WaveletTree** (was MergeSortTree -- static, ~88 KB rebuild; section 12.4) | **exact** windowed `quantile(lo, hi, k)` built cold -- the EXACT cross-check to DDSketch's approximate p99 | PEER |
| **lite-filter Bloom** | unbounded **first-seen** error-signature detection (`keys:'int'`) | PEER |
| **lite-lru (ttl)** | exact **windowed dedup** -- suppress the same signature within N ms (lazy 0-alloc reap in `get`) | PEER (section 12.5) |
| **lite-perf-gate** | the `zgcSuite` perf gate (0 scavenges, mustFail control) from M1 on | devDep (section 12.6) |
| **lite-adaptive (future)** | sliding-window / decayed stats + **drift markers** on the HUD (recent p99, "regime changed") | PEER (post lite-adaptive 1.0.0) |

The headline three, in priority order: **DDSketch (p99)** > **the openPool fix + torture gate +
lite-viewport (technical health)** > **SpaceSaving / HLL (hot spots + cardinality)**. Everything
else is incremental polish on a now-correct base.

---

## 5. The Central Design Call: the wiring model (load-bearing)

lite-hud is APP-LEVEL (a leaf consumer), not a foundational primitive -- so "zero runtime deps"
is a marketing promise it can keep OR relax deliberately. The recommended model is THREE TIERS,
which integrate the suite WITHOUT breaking the zero-dep-by-default identity:

1. **CORE (unchanged, zero-dep, duck-typed).** The SPP sink + LUT + rings + the basic
   oscilloscope stay exactly as they are and keep working with no peers installed. Backward
   compatible; the current API is a strict subset.
2. **PARITY (design-parity, still zero-dep).** Small, self-contained fixes copied inline by the
   family's "reuse the idiom, never the dep" law: the integer-keyed open-addressing pool that
   replaces the `openPool` Map (CuckooMap idiom), and the dirty-channel BitSet. These ship in
   core, add no dependency, and close the real bug + the render-scan.
3. **PEER (optional peers via DEPENDENCY INJECTION).** The analytics + rendering upgrades are
   ACTIVATED by the consumer passing instances / factories -- lite-hud never imports them:
   ```js
   createHud(el, {
     viewport: Viewport,                    // optional: DPR-aware renderer (else inline fallback)
     stats: {
       quantiles: () => new DDSketch(0.01), // per channel -> p50/p90/p99 readouts + band
       topk:      () => new SpaceSaving(64), // hot-spots panel
       distinct:  () => new HyperLogLog(12), // cardinality readout
     },
   });
   ```
   On the write path lite-hud calls the injected instance's `add(value)` (0-B/op if the injected
   impl is -- and the suite's are); on render it calls `quantile(q)` / `topK()` / `count()` (cold).
   `peerDependencies` are declared OPTIONAL; with none installed, lite-hud is byte-for-byte today's
   package.

Why DI over hard deps: it preserves the zero-dep default, keeps the bundle tiny, is trivially
testable (inject a mock), matches the lite-pick precedent, and lets a consumer pick EXACTLY the
analytics they want to pay for. `lite-viewport` is the one candidate for a soft-direct dep (rendering
is core) -- but ship it as an injectable peer too, with the current inline DPR path as the fallback,
so nothing regresses.

The knobs a consumer sets (each disclosed): DDSketch `alpha`, SpaceSaving `capacity`, HLL `p`,
the sample size -- lite-hud validates them fail-closed and shows the achieved accuracy in the HUD.

---

## 6. The Honesty Hook: the profiler must not perturb what it profiles

lite-sketch's hook is error-honesty; lite-o1's is complexity-honesty. lite-hud's is
NON-PERTURBATION: a HUD that allocates on the write path corrupts the very GC timing it is meant
to measure. So the load-bearing witness for v3 is a `test/torture.mjs` (the suite standard, which
lite-hud is MISSING today) that drives `write()` + every `push()` kind + the paired-span
open/close path + the injected-analytics write path (DDSketch.add etc.) under
lite-leak + lite-gc-profiler and asserts **0 B/op and 0 retained growth**. This immediately:
- catches the current `openPool` Map allocation (gap 2) -- and gates its fix;
- proves the "Zero-GC Hot path" badge the README already flies;
- proves that turning ON the analytics (injected sketches) keeps the write path at 0 B/op, so
  observing costs nothing measurable. "The p99 readout is free; here is the gate that proves it."

Render is explicitly a COLD path (caller-throttled ~10-15 Hz) and MAY allocate a little (it draws);
the discipline is strictly on `write` / `push` -- stated, not blurred.

---

## 7. Boundaries -- what lite-hud does NOT become

- **Not a profiler / not a protocol.** Emitting SPP records and the mux registry are `lite-scope`'s
  job; lite-hud stays the read-side SINK. It consumes streams, it does not define them.
- **Not a metrics backend / TSDB.** It summarizes the RECENT window on screen; long-term storage,
  querying, and alerting are out (a HUD, not Prometheus).
- **Not a chart library.** `lite-charts` / `lite-chartforge` own general charting; lite-hud is the
  fixed-purpose profiler overlay (traces + tiles + hot-spots), not a plotting toolkit.
- **The tools stay tools.** lite-hud reuses lite-sketch / lite-o1 / lite-logn by INJECTION or
  design-parity; it never forks or re-exports them.

---

## 8. lite-viewport adoption (the maintainer's flag) -- details

`lite-viewport`'s `Viewport({ canvas, autoResize, maxDpr, onResize, contextOptions })` is a
one-for-one replacement for lite-hud's hand-rolled `resize()` and fixes every rendering gap (4):
- ResizeObserver on the parent -> reacts to CSS flex/grid reflow, not just row-count growth.
- A re-armed `matchMedia('(resolution: Ndppx)')` DPR watch -> a monitor swap / OS display-scale
  change re-sizes the canvas even when the CSS box did not change (lite-hud currently never does).
- `maxDpr` cap -> bounded backing store + fill-rate on high-DPR phones.
- `setTransform(1,0,0,1,0,0)` then `scale(dpr,dpr)` on every resize -> fixes the cumulative-scaling
  risk in lite-hud's repeated `ctx.scale(dpr,dpr)`.
- RAF-deduped -> no observer double-fire.
Wiring: inject `Viewport` (PEER); `vp.ctx` / `vp.width` / `vp.height` / `vp.dpr` replace the local
`ctx`/`dpr`; `onResize` drives a redraw. Fallback to the current inline path when not injected, so
the zero-dep default is preserved. This is the M1 rendering half -- pure upside, low risk.

---

## 9. The Demo / visual direction (later)

Once the analytics land, the HUD earns a redesign: keep the oscilloscope traces, but add a row of
SUMMARY TILES (last / mean / p99 per channel), a shaded p50-p99 BAND behind each latency trace, and
a HOT-SPOTS panel (SpaceSaving top-k) that reorders live. The demo: a synthetic workload with an
injected latency spike + a regime change -- the p99 tile jumps, the band fattens, the hot-spots
panel reshuffles, and (post lite-adaptive) a drift marker drops. The suite's tools made visible on
their own profiler. Repo-only, zero-GC frame path (the lite-o1 / lite-sketch demo law).

---

## 10. Recommended Path (see ROADMAP.md)

1. **M1 -- technical health (v2.1):** add the torture gate; fix the `openPool` GC hole (design-parity
   integer pool); adopt `lite-viewport` (injected, with fallback). Ship a genuinely-zero-GC,
   crisp-rendering base. NO behavior change to the data model -- pure correctness + rendering.
2. **M2 -- percentiles (v2.2):** DDSketch via DI -- per-channel p50/p90/p99 readouts + band. The
   headline feature; the reason to reach for v3.
3. **M3 -- hot spots + cardinality (v2.3):** SpaceSaving top-k panel + HyperLogLog distinct readout
   (+ CountMinSketch per-label frequency).
4. **M4 -- rolling aggregates + partial redraw (v2.4):** WindowFold / MonoDeque O(1) readouts
   replacing the render rescan; BitSet dirty-set partial redraw.
5. **M5 -- exact range/rank + dedup (v2.5):** lite-logn Fenwick / SegmentTree (exact sub-window
   aggregates) + WaveletTree (exact quantile cross-check); lite-filter first-seen + lite-lru TTL dedup.
6. **v3.0:** freeze the analytics + DI / optional-peer contract as stable; the visual redesign
   (tiles + bands + hot-spots panel). Post-v3: lite-adaptive drift markers.

Each milestone is a full pipeline session (planner -> settle -> coder -> reviewer -> qa); the
maintainer commits/publishes; /release gate + card sync after -- identical to the rest of the suite.

---

## 11. Open Questions

1. **The wiring model** (section 5) -- confirm the three-tier CORE / PARITY / PEER approach with
   dependency injection for analytics, so lite-hud stays zero-dep-by-default. This is the call that
   gates every integration milestone. LEAN: as framed.
2. **lite-viewport: injected peer or soft-direct dep?** Rendering is core, so a direct (optional)
   dep is defensible; injection keeps the zero-dep default. LEAN: inject with an inline fallback.
3. **DDSketch per channel or per (channel x label)?** Per-channel is the simple win; per-label needs
   a keyed map of sketches (CountMinSketch-of-sketches territory). LEAN: per-channel in M2, keyed in
   a later pass.
4. **Is v3.0 a breaking change?** The core API is a strict subset, so v2.x can land M1-M5 additively
   and reserve v3.0 for the visual redesign + the frozen DI contract. LEAN: additive v2.x, v3.0 for
   the redesign + stability promise.
5. **The openPool fix -- design-parity or CuckooMap peer?** A tiny inline integer pool keeps M1
   dependency-free and fixes the bug now. LEAN: design-parity inline.
6. **Naming / API for injected stats** (`stats: { quantiles, topk, distinct }` factories vs a single
   `analytics` object vs per-channel opts). LEAN: a `stats` factory bag on `createHud` + a per-channel
   override on `hud.channel()`.
7. **Repo / scope**: `@zakkster/lite-hud`, folder `LiteHud`, main file `Hud.js` (unchanged); confirm
   the v2.x line vs a v3 branch before wiring.

**SETTLED (2026-09-23, maintainer):** all LEANs above accepted. Plus, from the M1 pre-plan:
- (A) lite-viewport sizes the canvas to its PARENT's rect (`Viewport.js:102`) but the HUD is a
  content-sized overlay (290 x rows). When a Viewport is injected the HUD owns a sized wrapper
  `<div>` (positioning moves to it, canvas inside, the Viewport observes the wrapper); row growth
  sets the wrapper height and calls `vp.resize()` SYNCHRONOUSLY (the RO/RAF path is async). The
  fallback path keeps today's DOM; it gains `setTransform(1,0,0,1,0,0)` before `scale(dpr,dpr)`.
  `viewport` is injected as the CLASS (the HUD creates the canvas), not an instance.
- (B) openPool eviction on full stays OLDEST-FIRST (today's Map insertion order), O(1) via a
  Float64Array FIFO of open keys with lazy skip of already-closed entries. Pinned by a new test.
- (C) correlId keys: hash the lo/hi 32-bit lanes, exact compare. `-0` normalizes to `+0`; a NaN
  correlId on OPEN is a counted drop (the Map matched NaN; documented in the CHANGELOG).
- (D) test tooling: devDeps `@zakkster/lite-gc-profiler ^1.16.0`, `@zakkster/lite-leak ^1.10.0`,
  `@zakkster/lite-perf-gate ^1.4.2` (the suite-wide pins); a perf gate lands in M1, not M2.

---

## 12. Peer Surface Audit (2026-09-23) -- the tools as they ACTUALLY are

Sections 4-5 were written from the tools' reputations. Before M1 every candidate peer was read at
its current version. The wiring below supersedes the matrix in section 4 where they disagree.
All six share the suite's test spine (devDeps lite-gc-profiler ^1.16.0 / lite-leak ^1.10.0 /
lite-perf-gate ^1.4.2; scripts `torture`, `test:perf`, `verify`); none declares a peer or a dep;
all are single `"."` export, `sideEffects:false`, node >= 18.

### 12.1 The openPool fix -- no suite map fits; PARITY confirmed on evidence

| Candidate | Blocker for `Map<correlId (Float64), t_open (Float64)>` bounded, oldest-first |
|-----------|-----------------------------------------------------------------------------|
| lite-o1 1.11.0 `CuckooMap` | keys must be SAFE INTEGERS (a fractional correlId throws); throws `RangeError` at the 0.90 load ceiling -- no eviction; a stalled insert re-seeds in place and ALLOCATES two Float64Array snapshots |
| lite-lru 1.18.0 `LiteLru` / `Sieve` (`keys:'int'`) | keys int32 only; values live in a plain `Array` -- non-SMI doubles (`t_open`) are likely boxed per `put` (its perf gate only stores small ints -- unproven either way) |
| lite-lru default (Map) backing | only AMORTIZED 0-alloc (Map resize) -- the exact hole we are closing |

-> Inline open-addressing pool: Float64Array keys + t_open, Uint8Array occupancy (id 0 legal),
linear probe + backshift delete, pow2 >= 2 x cap, a Float64Array FIFO for oldest-first eviction
(the lite-o1 RingDeque idiom, inlined). Zero deps.

### 12.2 lite-sketch 1.0.0 (M2, M3) -- PEER

- `DDSketch(alpha, { maxBins = 2048, range? })`; `add(value, count = 1)` is 0 B/op in steady state
  (torture-witnessed) BUT THROWS on NaN / +-Infinity / negative / subnormal / non-integer count.
  -> the HUD pre-checks on the write path and counts a DROP; it never lets an injected peer throw
  into the caller's hot loop. Zero is exact (`zeroCount`). `quantile(q)` is cold O(bins), NaN on
  empty; one q per call. No decay / window API: windowing = rotate two sketches + 0-alloc `merge`
  into a scratch sketch at render (`clear()` / `merge()` are 0-alloc). `alpha` getter for the
  achieved-accuracy disclosure.
- `SpaceSaving(k, { seed })`: `add(key, count)` 0 B/op, key = safe integer, count = positive
  INTEGER -> "top-k by total time" weights by integer microseconds. `topK()` / `heavyHitters()` /
  `merge()` ALLOCATE -> render reads via 0-alloc `forEach` into a preallocated top-N buffer.
- `HyperLogLog(p = 14)`: `add(number)` 0 B/op (any non-NaN number -> correlIds as-is);
  `count()` cold, 0-alloc; `standardError` getter. String labels: `hashString` + `addHashed`.
- `CountMinSketch(d, w, { conservative })` / `withAccuracy(eps, delta)`: `add(key, count)` +
  `addHashed`, 0 B/op; `estimate` never throws.

### 12.3 lite-o1 1.11.0 (M4) -- PEER, except BitSet (PARITY)

- `WindowFold(cap, 'SUM'|'MIN'|'MAX'|'PRODUCT')`: O(1) worst case, 0-alloc; ONE op per instance
  (sum + min + max = 3 instances; mean = SUM / size); THROWS when full -> the HUD calls `evict()`
  before `push()` at `size === capacity`. SUM is plain `+` (no Kahan) -- disclose drift.
- `WindowFoldUint32(cap, 'OR'|'AND'|'XOR')`: strict uint32 masks (all-ones = `0xFFFFFFFF`).
- `MonoDeque(cap, 'min'|'max')`: amortized O(1), O(k) worst; `evictOlderThan(seq)`.
- `Reservoir(k, seed)`: 0-alloc `add`, deterministic LCG, `reset()` replays.
- `BitSet` works (0-alloc `firstSet` / `nextSet` loop) but the channel count fits a few Uint32
  words -> inline PARITY, no dep for a 10-line dirty-set.

### 12.4 lite-logn 1.1.0 (M5) -- PEER; MergeSortTree REPLACED by WaveletTree

- `Fenwick(n)`: `set(i, v)` / `rangeSum(lo, hi)` O(log n), 0-alloc -> follows the ring's slot
  overwrite in place. `SegmentTree(n, 'min'|'max'|'sum')`: `update(i, v)` / `query(lo, hi)`,
  0-alloc, one fold per tree. Both require `lo <= hi` -> a WRAPPED ring window is two queries.
  Non-finite values throw -> pre-check (same rule as DDSketch).
- `MergeSortTree`: STATIC (no update), O(n log n) rebuild allocating ~88 KB at n = 1024, ~17x
  memory -> REJECTED for a live ring.
- `WaveletTree` (new in 1.1.0; documented only in the .d.ts + CHANGELOG): static, but
  `quantile(lo, hi, k)` gives the EXACT k-th smallest in a range, 0 B/op queries. Built on demand
  from the ring snapshot at render/inspect (cold, allocating, disclosed) -> the exact p99 that
  cross-checks the DDSketch p99.
- `BinaryHeap(cap)` with `changeKey` / `remove` by id (slot index) is available if a windowed
  exact top-k is ever wanted; not planned.

### 12.5 lite-filter 1.1.0 + lite-lru 1.18.0 (M5 dedup) -- PEER, split by semantics

- UNBOUNDED "first-seen error signature": lite-filter `Bloom(cap, { keys:'int', fpp })` -- 0 B/op
  only with `keys:'int'` (int32). No rotating / aging member exists; `clear()` is 0-alloc.
  `Cuckoo` supports delete but THROWS when full and stores duplicates (`has` before `add`).
- WINDOWED "suppress the same signature within N ms": lite-lru `LiteLru(cap, { keys:'int', ttl,
  clock })` -- exact, bounded, int32 keys, SMI counts as values. Stale entries are reaped LAZILY
  inside `get()` (`Lru.js:1192-1196`, 0-alloc, fires `onEvict`); never call `purgeStale()` on the
  hot path (it allocates). `clock` is injectable -> drive it from the HUD's own time source.
  `stats:true` gives a 0-B/op `evictions` counter.
- Both need an int32 signature key: the HUD folds (sid, op, code) into int32 on the write path.

### 12.6 lite-perf-gate (all milestones, from M1) -- devDep

The lite-o1 / lite-sketch / lite-lru pattern: `zgcSuite({ N: 200000, k: 8, maxScavenges: 0,
maxOldGen: 0, maxArrayBuffersKB: 0, counters: { grows: 0 }, maxRetainedKB: 64, scenarios,
mustFail })`; each scenario `{ name, setup, hot(s, n), statsOf(s) -> { grows } }` where `grows`
sums backing-buffer byteLengths; SMI keys, `| 0` accumulators, callbacks hoisted to module scope;
one `mustFail` control that allocates per op. Script:
`node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs`.

### 12.7 What changed vs sections 4-5

- MergeSortTree -> WaveletTree (exact windowed quantile), built cold.
- lite-lru joins M5 (TTL windowed dedup); lite-filter keeps unbounded first-seen.
- BitSet -> inline parity (not a lite-o1 peer).
- New write-path rule for EVERY peer: pre-validate the value, count a drop, never propagate a
  peer's throw into `write()` / `push()`.
- `peerDependencies` (optional) are declared per milestone, when code first uses the peer --
  M1 declares only lite-viewport.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- never "Karadjov".

# @zakkster/lite-hud -- Changelog

## 2.2.0 (2026-09-23) -- DDSketch percentiles (optional peer)

Additive; the v2.1.0 API is a strict subset. With no factory injected, behavior,
`stats()` (except the additive `quantileDrops`, always 0), and the render call
trace are byte-identical to 2.1.0 (gated by the degrade tests).

Requires `@zakkster/lite-sketch` >= 1.1.0 when analytics is injected (for the
zero-box `DDSketch.addFrom` + the N1 getters). Optional peer -- with none
installed the package is unchanged.

### Added

- **`stats.quantiles` option (optional peer).** Inject a `() => DDSketch` factory
  (`@zakkster/lite-sketch` >= 1.1.0) for per-channel p50 / p90 / p99 / p99.9
  readouts + a shaded p50-p99 band behind LEVEL traces. The HUD never imports
  lite-sketch. A per-channel override `hud.channel({ quantiles })` takes a factory
  (opt IN; SPAN or LEVEL) or `false` (opt OUT); a scope LEVEL op opts in with
  `quantiles: true`. Complete + paired SPAN durations are sketched automatically;
  LEVEL is opt-in; COUNTER / INSTANT never. Declared as an OPTIONAL `peerDependency`.
- **`stats().quantileDrops`** -- sum of per-channel values rejected by the
  analytics pre-check (never reached the sketch). Separate from `drops`. The key is
  ALWAYS PRESENT (0 when no factory is injected), so `stats()` has a stable shape.
- **`inspect(name).quantiles`** -- `{ p50, p90, p99, p999, n }` for a sketched
  channel (present only when analytics is on; `n:0` + NaN on an empty window).

### Changed

- `package.json`: `@zakkster/lite-sketch` ^1.1.0 added as a devDependency and an
  OPTIONAL peerDependency (`peerDependenciesMeta.optional`). Zero runtime deps.
- `Hud.d.ts` (additive): `QuantileSketch` (requires `addFrom`, `quantile`, `merge`,
  `clear`, `count`, `strict`, `minIndexable`, `maxIndexable`), `QuantileFactory`,
  `HudStatsOptions`, `QuantileReadout`; `HudOptions.stats`; `quantiles` on
  `ChannelDescriptor` / `StreamOpDescriptor`; `quantileDrops`; optional
  `inspect().quantiles`.
- `npm run test:perf` runs the whole `test/perf/` directory (adds
  `AnalyticsBox.test.mjs`).
- Tests: 86 -> 112 node:tests.

### Fixed

- **`render()` survives a reentrant `destroy()`.** A `destroy()` called from inside
  a draw call during `render()` (e.g. from a patched `ctx.fillText`) used to null
  the closure context mid-frame and throw `TypeError: Cannot set properties of null`.
  `render()` now takes a per-frame LOCAL snapshot of the context and draws only
  through it, so a mid-frame `destroy()` lets the frame finish harmlessly on the
  detached context and the next `render()` is a no-op. Pre-existing (render read the
  closure context directly); M2's percentile-tile `fillText` calls just widened the
  window. No hot-path change (render is the cold path).

### Design

- **Zero-box hot path (`addFrom`).** The value is written into a per-channel
  `Float64Array(1)` in `write()`'s own frame and fed to the peer via
  `DDSketch.addFrom(buf, 0)`, which reads it UNBOXED -- so a FRACTIONAL value never
  boxes at the call boundary (passing it as an `add(value)` argument would box a
  ~16 B transient when the call is not inlined). Requires lite-sketch >= 1.1.0; a
  factory missing `addFrom` fails closed.
- **Peer no-throw pre-check.** `addFrom` throws on NaN / negative / +-Infinity /
  out-of-range. The hot path rejects exactly that set -- plus `v>0` outside the
  accepted band `minIndexable < v <= maxIndexable` (EXCLUSIVE low, INCLUSIVE high)
  -- counting a `quantileDrops`, so the peer never throws into `write()`; there is
  NO try/catch on the hot path. `v === 0` is legal; `-0` sums as 0.
- **Getter-based validation (no probe).** The bounds and the strict check come from
  the sketch's own getters (`strict`, `minIndexable`, `maxIndexable`), read ONCE,
  cold, when the channel sketch is created. A strict-range DDSketch (`strict ===
  true`), a missing `addFrom`, or non-finite indexable getters throw
  `@zakkster/lite-hud:` fail-closed. The sketch must report `strict === false`
  explicitly; a missing `strict` getter fails closed.
- **Window.** Two sketches A/B rotate every windowSec/2 by record time (O(1) on
  the hot path; the retiring one is `clear()`ed); render/inspect `clear()` a
  scratch and `merge()` A+B into it, then `quantile()`. `merge`/`clear` are 0-alloc.
- **Memory.** 3 x maxBins x 8 B per sketched channel (48 KB at 2048 bins); window
  coverage is windowSec/2 .. windowSec.

### Proof

- Suite: 112 node:tests (0 failures); perf 17/17; torture ok; break control exits 1.
- Oracle: p50/p90/p99/p99.9 within alpha (0.01) of a sorted-Float64Array oracle on
  uniform / lognormal / pareto streams over one rotation boundary; empty -> "--".
  Pre-check boundaries verified against the peer's exact accept/reject at both edges.
- Torture (`node --expose-gc test/torture.mjs`): the analytics-ON write path
  (paired + complete SPAN + opted-in LEVEL + `channel().push()`) is 0 RETAINED B/op
  with FRACTIONAL inputs, gc major 0 / minor 0, leak size 0 over 4096
  create/attach/feed cycles, arrayBuffers delta <= 0 over 64 cycles. Control: an
  injected `addFrom` per-op closure trips the gate (non-zero exit).
- Perf gate: analytics-ON LEVEL / complete-SPAN / PAIRED integer scenarios at 0
  scavenges (4 MB semi-space) + a mustFail (an injected sketch whose `addFrom`
  allocates) is caught. `AnalyticsBox.test.mjs` drives the FRACTIONAL yardstick:
  analytics-ON minor-GC scaling == analytics-OFF scaling (delta ~0). Measured (8N,
  minorLo->minorHi): paired OFF 4->24 / ON 4->24; complete OFF 4->24 / ON 3->24;
  LEVEL OFF 3->24 / ON 3->24. `addFrom` removes the paired-duration box exactly:
  on the same Node (26.8.2), passing the same unboxed value as `add(qv)` scales to
  36 for paired / complete / LEVEL. A teeth control (an
  injected sketch whose `addFrom` allocates per op) scales well above the baseline.

## 2.1.0 (2026-09-23) -- technical health: witnessed zero-GC + DPR-correct rendering

Additive; the v2.0.0 API is a strict subset. No data-model change.

### Fixed

- **Paired-span `openPool` allocation + retention.** The `Map<correlId, t_open>`
  allocated a map entry per open and an iterator per eviction on the WRITE path.
  Replaced by an inline integer-keyed open-addressing pool (design-parity with the
  CuckooMap idiom, no dep): `Float64Array` correlId + t_open, a `Uint8Array`
  occupancy byte (id 0 is legal), linear probe + backshift delete, slots =
  `pow2(2*cap)`, and a `Float64Array` FIFO of open keys (with a per-slot sequence
  for lazy skip) for O(1) oldest-first eviction. Allocated once at attach (cold);
  0 B/op on open / close / eviction.
- **`BUDGET_SET` allocation + unbounded retention.** A meta `BUDGET_SET` record
  used to `push({threshold, label})` a fresh object per record onto the channel's
  budget array. Now it writes a preallocated per-channel meta-budget slot; a
  repeat `BUDGET_SET` for a channel REPLACES its threshold (no object per record,
  no unbounded append). DI `attach({ budgets })` budgets are unchanged (cold).

### Added

- **`viewport` option (optional peer).** Inject a `@zakkster/lite-viewport`-style
  Viewport CLASS for DPR-correct, resize-aware, DPR-capped rendering. The HUD owns
  a sized wrapper `<div>` (so the viewport measures the HUD, not the page), creates
  the canvas inside it, renders through `vp.ctx` / `vp.dpr`, calls `vp.resize()`
  synchronously on row growth, and tears it down in `destroy()`. Declared as an
  OPTIONAL `peerDependency`; with none installed the inline fallback path is used.
- **`maxDpr` option.** Cap devicePixelRatio for the backing store (finite >= 1, or
  Infinity). Applies to both the injected viewport and the inline fallback.
- **`test/torture.mjs`** (lite-leak + lite-gc-profiler): 0 B/op (measureAllocs) on
  every `write()` kind, every `channel().push()` kind, paired open+close, pool
  eviction churn, and meta records; 0 retained growth; gc major 0; a GcProfiler
  scavenge lane over a long paired open+close + eviction loop (`paired-scavenge=0`).
  Against the 2.0.0 `Hud.js` it fails: `alloc 40 B/op` (BUDGET_SET) and
  `paired-scavenge=3`. `npm run torture`; `npm run torture:controls` (a
  `LITE_HUD_TORTURE_BREAK=1` arm that must exit non-zero).
- **`test/perf/PerfGate.test.mjs`** (lite-perf-gate `zgcSuite`) -- 0 scavenges /
  old-gen / arrayBuffers over every write-path record kind (11 tests, incl. a
  reused-constant fractional value and a must-fail control). Against 2.0.0 it fails
  3 scenarios (paired open+close oldgen 10; eviction churn scavenges 3 + oldgen 2;
  BUDGET_SET scavenges 5, retained 77615 KB). `npm run test:perf`. `npm run verify`
  runs all gates.
- Functional suite: 59 -> 86 tests (eviction order, key edge cases 0 / -0 / NaN /
  fractional / 2^53-1 / > 2^32 / negative, BUDGET_SET replace, viewport + maxDpr
  validation, DPR 1/2/3 + DPR change + maxDpr cap + no cumulative scaling, setup
  failure leaks nothing).

### Changed

- **NaN correlId on a paired OPEN is now a counted drop** (previously the JS Map
  stored a NaN key). `-0` normalizes to `+0` on open and close so a `-0` open
  matches a `+0` close. Re-open of an already-open key overwrites `t_open` and
  keeps its FIFO position (matching the old `Map.set` semantics).
- **Setup fails closed:** if an injected `viewport` constructor throws, `createHud()`
  detaches the wrapper, destroys any partial viewport, adds no listener, and
  rethrows the original error.
- "Zero-GC hot path" means zero LIBRARY-OWNED allocation: a distinct fractional
  double passed as an argument is boxed by V8 at the call boundary (~16 B
  transient, caller-side, never retained). Documented in README / llms.txt.
- Fallback rendering resets the transform (`setTransform(1,0,0,1,0,0)`) before
  `scale(dpr,dpr)` on every resize -- no cumulative-scaling drift.

## 2.0.0 (2026-07-08) -- SPP-native rewrite (BREAKING)

**Breaking:** v1 API (`hud.track()`, `push()` handle with `hi`/`lo`/`warnBelow`, sample-indexed ring) is completely removed.

### New model

- **Live mux sink.** `hud.attach(scope)` registers the HUD as a `{ write }` sink via `scope.addSink()`. Records flow directly from the scope fan-out; no polling, no copy, zero overwrite races.
- **Registry-driven channels.** At `attach()` time the HUD reads `scope.streams()` and builds one channel per declared op. LUT routing (`lut[sid][opLow]`) is O(1) with no allocations on the hot path.
- **Time axis.** Shared scrolling window (`windowSec`, default 5 s) across all channels. Rings are sized to `hz × windowSec` records (power-of-2 capacity).
- **CONT reassembly.** CONT sequences are reassembled into a single ring record using a per-stream `Float64Array` pending buffer, sized at attach time to `3 * maxWidth` across the stream's ops. Any width is supported; the buffer grows if a later op needs more slots.
- **Paired SPAN channels.** Open and close ops route to the same channel. Open times park in an `openPool` Map until the matching close arrives; completed spans flush `[t_open, t_close, correlId]` to the ring.
- **BUDGET_SET (0x0F41).** New meta opcode transports threshold lines at runtime. Budget DI is also available via `hud.attach(scope, { budgets })`.
- **GATE_VERDICT (0x0F40).** Stored in a 64-entry verdict ring and rendered as vertical cursors (green pass / red fail / amber recapture).
- **Manual channel polyfill (D4).** `hud.channel({ name, unit?, hz?, kind? })` returns a `{ push(v) }` handle. `push()` synthesizes a valid SPP record and calls `write()` directly -- one rendering truth, no separate ring or draw path. Synthetic stream IDs start at `0x8000`.
- **Complete SPAN layout (D5).** For non-paired SPAN ops: `t = t_start`, `a = duration_ms`. Manual `push(durationMs)` follows the same layout.
- **Phosphor-green oscilloscope theme.** CRT grid, glow pass + sharp pass for LEVEL/COUNTER, blip ticks for INSTANT, filled rects for SPAN, dashed budget lines, colour-coded verdict cursors.
- **Legend.** Click a channel label to toggle visibility. `hud.show()`, `hud.hide()`, configurable hotkey (default `` ` ``).

### Attach-time validation

- **Opcode low-byte collision throws.** SPP routes records by `op.code & 0xFF` per stream, so two ops on the same stream that share a low byte would silently orphan one channel. `attach()` now throws with the offending stream and low byte if a collision is detected. Cross-stream reuse of the same low byte is still fine.
- **CONT width is unbounded.** The old fixed-9-slot pending buffer silently truncated records for `width > 3`; now the buffer is sized from the stream's declared widths at attach time.

### Type surface

- `HudScope.addSink` is now optional in `Hud.d.ts`, matching the runtime `typeof scope.addSink === 'function'` guard. A scope that omits `addSink` still works -- the HUD is populated by direct `hud.write()` calls.

### Removed

- `hud.track(name, opts)` -- replaced by `hud.channel()` (manual) or `hud.attach()` (scope-driven).
- Per-track `hi`, `lo`, `warnBelow` options -- replaced by protocol-level `BUDGET_SET` and DI `budgets` option.
- Sample-indexed rendering -- replaced by shared time-axis window.

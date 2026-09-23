# @zakkster/lite-hud -- Changelog

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

# @zakkster/lite-hud -- Changelog

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

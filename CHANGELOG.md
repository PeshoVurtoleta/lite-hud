# Changelog

## [1.0.0] - 2026-07-07

Initial release. Single-canvas zero-GC perf overlay.

### Added

- `createHud(canvas?, options?)` -- create a HUD with auto-positioned
  fixed-position canvas and hotkey toggle.
- `hud.track(name, options?)` -- register a named track backed by a
  preallocated power-of-two ring buffer (`Float64Array`).
- `track.push(value)` -- **zero-GC hot path**: one typed-array write
  with a bitmask index. No closures, no objects, no strings.
  Non-finite values (`Infinity`, `-Infinity`, `NaN`) are silently
  dropped to prevent a single bad sample from locking `max` to
  `Infinity` and flattening every bar in the ring buffer.
- `hud.render()` -- cold-path canvas 2D drawing at 10-15Hz. Bar chart
  per track, threshold lines, min/avg/max stats, current value display.
- `hud.resize()` -- exposed publicly for manual resize wiring. Also
  called automatically via a `matchMedia` DPR listener so the canvas
  stays sharp when the window is dragged between monitors with
  different pixel density.
- Threshold coloring: amber above `hi` (frame time, draws) or below
  `lo` with `warnBelow: true` (FPS, throughput).
- 6-color auto-palette (phosphor green, cyan, purple, amber, sky, coral)
  with per-track override.
- Hotkey toggle (default backtick) and `hud.visible` get/set.
- `hud.destroy()` for cleanup.
- Full `Hud.d.ts` (typechecks under `nodenext` + `strict`).
- 15 tests under `node --test`.
- Interactive demo with 4-track simulated game loop (FPS, frame time,
  draw calls, signal nodes) and spike injection.

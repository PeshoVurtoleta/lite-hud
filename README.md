# @zakkster/lite-hud

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-hud.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-hud)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-hud?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-hud)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-hud?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-hud)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-hud?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-hud)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Single-canvas zero-GC perf overlay. stats.js replacement that allocates nothing per frame.

Preallocated ring-buffer tracks, composable sink API for any profiler, oscilloscope phosphor-green aesthetic, hotkey toggle. Ship it inside a Twitch overlay behind a hotkey without worrying about GC pauses.

```bash
npm install @zakkster/lite-hud
```

## Quick start

```js
import { createHud } from '@zakkster/lite-hud';

const hud = createHud(null, { position: 'top-right', hotkey: '`' });

const fps   = hud.track('fps',   { unit: 'fps', lo: 30, warnBelow: true });
const frame = hud.track('frame', { unit: 'ms',  hi: 16.67 });
const draws = hud.track('draws', { hi: 200 });

function loop() {
    // Your frame work here...

    // HOT PATH: one typed-array write per push. Zero allocation.
    fps.push(currentFps);
    frame.push(frameDeltaMs);
    draws.push(drawCallCount);

    // COLD PATH: render at 10-15Hz.
    hud.render();

    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

Press `` ` `` to toggle the overlay.

## Why this exists

`stats.js` allocates per frame (DOM text updates, style recalculations, layout thrash). For a Twitch Extension overlay with a 1MB bundle cap and zero-GC-within-16ms requirement, that's disqualifying. Nothing modern exists that's composable (plug in any profiler as a track) and safe to ship in production behind a hotkey.

## Design

**Two paths, one contract.**

The hot path is `track.push(value)` -- a single typed-array write with a bitmask index. No closures, no objects, no string operations. The ring buffer is preallocated at track creation (power-of-two capacity, default 128 samples). Push never allocates.

The cold path is `hud.render()` -- canvas 2D drawing at 10-15Hz. This reads from the ring buffers and draws bars, threshold lines, labels, and stats. Call it on a throttle counter, not every frame.

**Composable sinks.** Each `hud.track()` returns an independent handle. Any profiler pushes into its own track:

```js
// lite-gc-profiler
gcTrack.push(bytesPerCall);

// lite-signal-profiler
nodesTrack.push(registry.stats().activeNodes);

// lite-gpu-profiler
stallTrack.push(stallCount);

// Your own metrics
customTrack.push(whatever);
```

The HUD doesn't know or care what the numbers mean. It renders bars, computes min/avg/max, and colors them by threshold.

## API

### `createHud(canvas, options?)`

Create a HUD. If `canvas` is null, one is created and appended to `document.body` with fixed positioning.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `width` | number | 280 | Canvas width (CSS px) |
| `height` | number | auto | Canvas height; auto-computed from track count |
| `position` | string | `'top-left'` | Corner: `top-left`, `top-right`, `bottom-left`, `bottom-right` |
| `hotkey` | string | `` '`' `` | Key to toggle visibility |
| `zIndex` | number | 100000 | CSS z-index |
| `visible` | boolean | true | Initial visibility |

### `hud.track(name, options?)`

Register a named track. Returns a `TrackHandle`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `label` | string | name | Display label |
| `unit` | string | `''` | Unit suffix (e.g. `'ms'`, `'fps'`) |
| `lo` | number | null | Low threshold |
| `hi` | number | null | High threshold (values above render amber) |
| `warnBelow` | boolean | false | Warn when BELOW `lo` (for FPS-style metrics) |
| `color` | string | auto | Override color (hex or oklch) |
| `samples` | number | 128 | Ring buffer capacity (rounded to power of two) |

### `TrackHandle`

| Method | Description |
|--------|-------------|
| `push(value)` | Push a sample. **Zero-GC hot path.** Non-finite values (`Infinity`, `-Infinity`, `NaN`) are silently dropped. |
| `peek()` | Last pushed value. |
| `name` | Track name (readonly). |
| `count` | Samples in buffer (readonly, caps at capacity). |

### `hud.render()`

Draw all tracks. Call at 10-15Hz (cold path).

### `hud.resize()`

Recompute canvas size for the current `devicePixelRatio`. Called automatically on track registration and when the browser DPR changes (window dragged between monitors with different pixel density). Call manually if you resize a container the HUD is embedded in.

### `hud.destroy()`

Remove canvas, keyboard listener, clear tracks.

### `hud.visible`

Get/set visibility. The hotkey toggles this.

## Threshold coloring

Each bar is colored by threshold:

- **`hi` set, `warnBelow` false (default):** green when at or below `hi`, amber when above. Use for frame time, draw calls, memory.
- **`lo` set, `warnBelow` true:** green when at or above `lo`, amber when below. Use for FPS, throughput.

A dashed threshold line is drawn at the `hi` or `lo` value for visual reference.

## Display

Each track shows: label, current value with unit, min/avg/max stats, and a bar chart of the ring buffer history. Colors cycle through a 6-color palette unless overridden.

## License

MIT (c) Zahary Shinikchiev

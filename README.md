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


> SPP-native zero-GC canvas overlay for the `@zakkster` profiler suite.

Single-file ESM, no runtime dependencies, phosphor-green oscilloscope aesthetic.
Designed as the read-side consumer of `@zakkster/lite-scope`'s mux registry.
Also works as a drop-in `stats.js` replacement via `hud.channel()`.

**v2.0.0 is a breaking rewrite.** See the [migration guide](#migration-from-v1) below.

---

## Install

```sh
npm install @zakkster/lite-hud
```

---

## Scope-driven mode (primary)

```js
import { createHud } from '@zakkster/lite-hud';
import { createScope } from '@zakkster/lite-scope';

const scope = createScope();
const hud   = createHud(document.body, { windowSec: 5, position: 'top-right' });

hud.attach(scope, {
  budgets: [
    { channel: 'frame', threshold: 16.67, label: '60fps budget' },
  ],
});

// Rendering loop -- call at ~10-15 Hz
function loop() {
  requestAnimationFrame(loop);
  if (frameCount++ % 4 === 0) hud.render();
}
loop();
```

`attach()` reads `scope.streams()`, builds an O(1) LUT per stream, and registers the HUD as a live mux sink via `scope.addSink()`. From that point every SPP record emitted by any probe flows directly into the HUD with no copy.

---

## Manual channel mode (drop-in stats.js replacement)

No scope setup required.

```js
const hud   = createHud(document.body);
const fps   = hud.channel({ name: 'fps',       kind: 0 }); // LEVEL
const gc    = hud.channel({ name: 'gc',        kind: 1 }); // INSTANT
const frame = hud.channel({ name: 'frame',     kind: 2 }); // SPAN (complete)
const draws = hud.channel({ name: 'draw calls', kind: 3 }); // COUNTER

// Anywhere in your code:
fps.push(59.8);
gc.push();
frame.push(12.4);   // duration in ms; t_start = now - 12.4  (D5 layout)
draws.push(312);
```

`push()` synthesizes a valid SPP record and calls `hud.write()` directly -- the
same demux path used by scope probes. There is no separate ring or draw path.

---

## API reference

### `createHud(mountEl, opts?): Hud`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `windowSec` | `number` | `5` | Scrolling time window width in seconds |
| `position` | `'top-right' \| 'top-left' \| 'bottom-right' \| 'bottom-left'` | `'top-right'` | Canvas corner |
| `hotkey` | `string` | `` '`' `` | Key that toggles visibility. `''` to disable |
| `zIndex` | `number` | `9999` | CSS z-index of the canvas |
| `viewport` | Viewport CLASS | `undefined` | Optional DPR-aware renderer (see below). Must be a constructor function, else throws |
| `maxDpr` | `number` | `Infinity` | Cap devicePixelRatio for the backing store. Finite `>= 1` or `Infinity`, else throws |
| `stats` | `{ quantiles?: () => DDSketch }` | `undefined` | Optional analytics factories (see [Percentiles](#percentiles-ddsketch-optional-peer)). `stats.quantiles` must be a function, else throws |

Pass `null` as `mountEl` for headless / test mode. All DOM and canvas operations are skipped; the full state layer remains active.

#### DPR-correct rendering (`viewport` + `maxDpr`)

By default the HUD sizes its own canvas from `devicePixelRatio` (capped at
`maxDpr`) and resets the transform before scaling on every resize, so repeated
resizes never compound.

Inject a [`@zakkster/lite-viewport`](https://www.npmjs.com/package/@zakkster/lite-viewport)
Viewport **class** for a resize-aware, DPR-change-aware backing store:

```js
import { createHud } from '@zakkster/lite-hud';
import { Viewport } from '@zakkster/lite-viewport';

const hud = createHud(document.body, { viewport: Viewport, maxDpr: 2 });
```

The HUD owns a sized wrapper `<div>` (positioning moves to it, the canvas sits
inside) so the viewport measures the HUD, not the page; it constructs
`new Viewport({ canvas, maxDpr, onResize })`, renders through `vp.ctx` / `vp.dpr`,
calls `vp.resize()` synchronously when the row count grows, and tears the viewport
down in `destroy()`. `@zakkster/lite-viewport` is an **optional peer dependency**:
with none installed, the inline fallback path above is used and nothing regresses.

`viewport` must be a function (a class); `maxDpr` must be a finite number `>= 1`
or `Infinity`. Either violation throws with the `@zakkster/lite-hud:` prefix
before any DOM work (fail-closed).

---

### `hud.attach(scope, opts?)`

Reads `scope.streams()`, builds the LUT, and calls `scope.addSink(hud)`.

`opts.budgets` is an array of inline threshold lines applied at attach time:

```js
{ channel: 'fps', threshold: 60, label: 'min fps' }
```

Budget thresholds are also transported at runtime via the `BUDGET_SET` (0x0F41) meta opcode: `a = interned_name_id`, `b = threshold_value`.

---

### `hud.channel(desc): { push(v?) }`

Creates a manual channel. Synthetic stream IDs are assigned from `0x8000` and never conflict with scope-registered stream IDs (dense from 1).

| Field | Type | Default |
|-------|------|---------|
| `name` | `string` | `'ch<n>'` |
| `unit` | `string` | `''` |
| `hz` | `number` | `null` (256-record ring) |
| `kind` | `0\|1\|2\|3` | `0` (LEVEL) |
| `quantiles` | `(() => DDSketch) \| false` | inherit default | Per-channel analytics override: a factory (opt IN; SPAN or LEVEL) or `false` (opt OUT). See [Percentiles](#percentiles-ddsketch-optional-peer) |

**`push()` semantics by kind:**

| Kind | Call | What is stored |
|------|------|----------------|
| LEVEL (0) | `push(value)` | `t=now, a=value` |
| INSTANT (1) | `push()` | `t=now, a=0` |
| SPAN (2) | `push(durationMs)` | `t=now-dur, a=dur` (D5) |
| COUNTER (3) | `push(value)` | `t=now, a=value` |

---

### `hud.write(packed, t, a, b)`

Duck-typed SPP sink entry point. Called automatically by the scope mux after `attach()`; also used directly by `push()` for manual channels.

Packed field decoding uses arithmetic (not bitwise) to handle the full u16 stream ID range:

```js
const sid = (packed / 65536) | 0;
const op  = (packed - sid * 65536) | 0;
```

---

### `hud.stats()`

```ts
{
  drops:        number;    // unrouted records (LUT miss or pool eviction)
  channels:     number;
  epoch:        number | null;  // t from last EPOCH (0x0F00) meta record
  verdicts:     number;    // gate verdicts stored (capped at 64)
  budgets:      number;    // total threshold lines across all channels
  quantileDrops: number;   // values rejected by the analytics pre-check (0 if off)
  channelStats: Array<{ name: string; count: number; head: number }>;
}
```

### `hud.inspect(name): { count, last: { t, a, b }, quantiles? } | null`

Returns the most recent ring record for a named channel. Cold path -- allocates. Do not call from a frame loop. For a sketched channel it also returns `quantiles: { p50, p90, p99, p999, n }` (`n:0` + `NaN` quantiles on an empty window).

### `hud.render()`

Draws all visible channels. Caller-throttled to ~10--15 Hz. No-op when `mountEl` is `null` or overlay is hidden.

### `hud.show() / hud.hide() / hud.destroy()`

`destroy()` removes the canvas from the DOM, removes the keydown listener, and calls `scope.removeSink()` if the scope provides it.

---

## Percentiles (DDSketch, optional peer)

Inject a `() => DDSketch` factory and the HUD draws per-channel **p50 / p90 / p99
/ p99.9 + N** tiles and a shaded **p50-p99 band** behind LEVEL traces -- the
number a profiler HUD exists to show. The HUD never imports
[`@zakkster/lite-sketch`](https://www.npmjs.com/package/@zakkster/lite-sketch);
you inject it (an **optional peer dependency**).

```js
import { createHud } from '@zakkster/lite-hud';
import { DDSketch } from '@zakkster/lite-sketch';

const hud = createHud(document.body, { stats: { quantiles: () => new DDSketch(0.01) } });
// per-channel override: a factory opts IN (SPAN or LEVEL), false opts OUT
const rtt = hud.channel({ name: 'rtt', kind: 2, quantiles: () => new DDSketch(0.005) });
// read from code (cold): { p50, p90, p99, p999, n }
hud.inspect('rtt').quantiles;
```

**What is sketched:** complete + paired **SPAN durations** always (when a factory
is injected); **LEVEL** opt-in (a per-channel `quantiles` factory, or a scope op
with `quantiles: true`); **COUNTER / INSTANT** never.

**Zero-box hot path (`addFrom`).** lite-sketch >= 1.1.0 exposes
`DDSketch.addFrom(buf, i)`: the value is read UNBOXED from a caller-owned
`Float64Array` inside the peer, so a fractional value never boxes at the call
boundary (`add(fractionalDouble)` would box a ~16 B transient when the call is not
inlined). The HUD stores the value into a per-channel `Float64Array(1)` in
`write()`'s own frame, then feeds the peer via `addFrom` -- so the analytics write
path adds **no allocation** over the caller's own baseline, for integer AND
fractional values.

**Pre-check law (peers never throw into the write path).** `addFrom` throws on a
NaN / negative / `+-Infinity` / out-of-range value. The hot path rejects
**exactly** that set -- plus `v>0` outside the accepted band `minIndexable < v <=
maxIndexable` (EXCLUSIVE low floor, INCLUSIVE high ceiling) -- counts a
`stats().quantileDrops`, and never lets `addFrom` throw into `write()`. There is no
`try/catch` on the hot path. `v === 0` is legal; `-0` sums as `0`. The bounds and
the strict check come from the sketch's own **getters** (`strict`, `minIndexable`,
`maxIndexable`) read **once**, cold, when the channel sketch is created (no probe).
A **strict-range** DDSketch (`new DDSketch(a, { range })`) has `strict === true`
and is rejected `@zakkster/lite-hud:` **fail-closed** -- inject a default
collapsing sketch (no `range`), so out-of-range values collapse instead of throw.
A factory missing `addFrom` or with non-finite indexable getters also fails closed.

**Window.** Two sketches A/B rotate every `windowSec/2` by record time (O(1) on
the hot path; the retiring sketch is `clear()`ed); render/inspect `clear()` a
scratch and `merge()` A+B into it, then `quantile()`. `merge` / `clear` are
0-alloc. Coverage is between `windowSec/2` and `windowSec`.

**Memory cost:** `3 x maxBins x 8 B` per sketched channel (the A/B window pair +
the render scratch) -- **48 KB at 2048 bins** (the DDSketch default), owned by the
injected factory. With no factory injected, none of this exists and behavior +
`stats()` + the render call trace are byte-identical to 2.1.0.

---

## Ring layout

| Kind | Stride | Slots |
|------|--------|-------|
| LEVEL / INSTANT / COUNTER (width=1) | 3 | `[t, a, b]` |
| Complete SPAN (non-paired) | 3 | `[t_start, duration_ms, 0]` |
| Paired SPAN (closed) | 3 | `[t_open, t_close, correlId]` |
| width=N (CONT) | 3N | primary `[t, a, b]` + (N-1) CONT triplets |

Ring capacity = `pow2(ceil(hz × windowSec) + 1)` for LEVEL channels, `256` otherwise.

---

## Zero-GC (witnessed)

The write path performs zero LIBRARY-OWNED allocation. Every record kind, the
paired open/close path, the pool eviction churn, and meta records are 0 B/op --
the rings and the paired-span open pool are fixed typed arrays allocated once at
attach and never reallocated or grown. Render is a disclosed COLD path
(caller-throttled to ~10-15 Hz) and may allocate to draw.

The one caller-side caveat: a DISTINCT fractional double passed as an argument is
boxed by V8 at the JS call boundary (a ~16 B transient nursery HeapNumber, never
retained), exactly as for any JS function taking a double. Storing a fractional
MAGNITUDE into the ring costs nothing (a reused constant is witnessed at 0 in the
perf gate); only a varying distinct fractional value boxes, caller-side.

| Write-path op | Bytes/op | Witnessed by |
|---------------|----------|--------------|
| `write()` LEVEL / INSTANT / COUNTER | 0 | torture + perf gate |
| `write()` CONT-chained wide record | 0 | torture + perf gate |
| `write()` complete (D5) SPAN | 0 | torture + perf gate |
| paired SPAN open + close | 0 | torture + perf gate |
| paired pool eviction churn (backshift + FIFO) | 0 | torture + perf gate |
| meta EPOCH / VERDICT / BUDGET_SET (replace) | 0 | torture + perf gate |
| `channel().push()` (all kinds) | 0 retained | torture |
| analytics-ON `write()` LEVEL / complete SPAN / paired (addFrom) | 0 | torture + perf gate |
| Retained growth over fill/clear cycles | 0 | torture (arrayBuffers flat) |
| GC major / minor collections over the window | 0 | torture |

Injecting the analytics (a `() => DDSketch` factory) keeps the write path at
0 B/op for all three sketched kinds -- LEVEL, complete SPAN, and paired SPAN
durations -- because the value is written into a per-channel `Float64Array` in
`write()`'s frame and fed to the peer via the zero-box `addFrom(buf, i)`; the
pre-check + O(1) window rotate allocate nothing, the A/B window sketches are fixed
typed arrays allocated once at attach, and `merge` / `clear` (render/inspect only)
are 0-alloc. The **yardstick** is measured with FRACTIONAL inputs in
`test/perf/AnalyticsBox.test.mjs`: analytics-ON minor-GC scaling equals
analytics-OFF scaling (delta ~0 -- the only box is the caller passing fractional
`t`/`a` into `write()`, present with analytics OFF too). A control (an injected
sketch whose `addFrom` allocates per op) MUST scale above the baseline, and the
perf-gate `mustFail` catches an allocating injected sketch -- both prove the
instrument has teeth.

`channel().push()` reads wall-clock time (`performance.now()`, a fractional
double); V8 boxes a fractional double as a transient nursery value when passing
it to a large function, so it is gated on the RETAINED lane (torture, 0 B/op),
not the scavenge lane -- the box is orthogonal to lite-hud's own allocation.

```sh
node --expose-gc test/torture.mjs   # lite-leak + lite-gc-profiler
npm run test:perf                    # lite-perf-gate (0 scavenges, must-fail control)
npm run verify                       # test + torture + torture:controls + test:perf
```

---

## Test suite

```sh
npm test
# 112 tests, 0 failures
```

All tests run headless (`mountEl = null`). The mock scope factory in the test file is a useful reference for testing your own probes against the HUD.

---

## Migration from v1

### Channel creation

```js
// v1
const fps = hud.track('fps', { hi: 120, lo: 0, warnBelow: 30 });
fps.push(59.8);

// v2 -- manual channel
const fps = hud.channel({ name: 'fps', kind: 0 });
fps.push(59.8);
// Budget lines via attach option:
hud.attach(scope, { budgets: [{ channel: 'fps', threshold: 30, label: 'min fps' }] });
```

### Scope integration

```js
// v1 -- HUD polled a memory sink separately
// v2 -- HUD is a live mux sink
hud.attach(scope);           // that's it
```

### Rendering

```js
// v1 and v2 -- same
hud.render();  // call at ~10-15Hz
```

---

## Protocol reference (SPP v1 constants, inlined)

```
Meta stream (sid 0):  EPOCH 0x0F00 | CONT 0x0F01 | VERDICT 0x0F40 | BUDGET_SET 0x0F41
Kinds:                LEVEL 0 | INSTANT 1 | SPAN 2 | COUNTER 3
```

---

## License

MIT -- Copyright (c) 2026 Zahary Shinikchiev

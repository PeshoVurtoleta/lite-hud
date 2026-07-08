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

Pass `null` as `mountEl` for headless / test mode. All DOM and canvas operations are skipped; the full state layer remains active.

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
  channelStats: Array<{ name: string; count: number; head: number }>;
}
```

### `hud.inspect(name): { count, last: { t, a, b } } | null`

Returns the most recent ring record for a named channel. Cold path -- allocates. Do not call from a frame loop.

### `hud.render()`

Draws all visible channels. Caller-throttled to ~10--15 Hz. No-op when `mountEl` is `null` or overlay is hidden.

### `hud.show() / hud.hide() / hud.destroy()`

`destroy()` removes the canvas from the DOM, removes the keydown listener, and calls `scope.removeSink()` if the scope provides it.

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

## Test suite

```sh
npm test
# 59 tests, 0 failures
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

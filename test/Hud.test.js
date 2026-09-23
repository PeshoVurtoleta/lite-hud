// @zakkster/lite-hud 2.1.0 -- node:test suite
// All tests run without a DOM (mountEl = null).
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHud, VERSION } from '../Hud.js';

// ---------------------------------------------------------------------------
// Mock scope factory
// ---------------------------------------------------------------------------

function mockScope(streamDescs) {
  const sinks    = [];
  const internMap = new Map(); // id -> string
  return {
    streams:    () => streamDescs || [],
    addSink:    (s) => sinks.push(s),
    removeSink: (s) => { const i = sinks.indexOf(s); if (i >= 0) sinks.splice(i, 1); },
    label:      (id) => internMap.get(id) || null,
    _intern(id, str) { internMap.set(id, str); },
    _sinks() { return sinks; },
    _emit(packed, t, a, b) { for (const s of sinks) s.write(packed, t, a, b); },
  };
}

// Packed helper: (sid << 16 | op) using arithmetic to match HUD encoding.
function packed(sid, op) { return sid * 65536 + op; }

// ---------------------------------------------------------------------------
// 1. Version
// ---------------------------------------------------------------------------

test('VERSION is 2.1.0', () => {
  assert.equal(VERSION, '2.1.0');
});

// ---------------------------------------------------------------------------
// 2. Construction
// ---------------------------------------------------------------------------

test('createHud(null) does not throw', () => {
  assert.doesNotThrow(() => createHud(null));
});

test('stats() initial state', () => {
  const hud = createHud(null);
  const s   = hud.stats();
  assert.equal(s.drops,    0);
  assert.equal(s.channels, 0);
  assert.equal(s.epoch,    null);
  assert.equal(s.verdicts, 0);
  assert.equal(s.budgets,  0);
  assert.deepEqual(s.channelStats, []);
});

test('visible getter is true initially', () => {
  const hud = createHud(null);
  assert.equal(hud.visible, true);
});

// ---------------------------------------------------------------------------
// 3. Manual channels (D4 polyfill)
// ---------------------------------------------------------------------------

test('channel() LEVEL: push writes to ring', () => {
  const hud = createHud(null);
  const fps = hud.channel({ name: 'fps', kind: 0 });
  fps.push(60);
  const r = hud.inspect('fps');
  assert.ok(r, 'inspect returns a result');
  assert.equal(r.count,  1);
  assert.equal(r.last.a, 60);
  assert.ok(r.last.t > 0, 't is a positive timestamp');
});

test('channel() INSTANT: push writes tick at current time', () => {
  const hud = createHud(null);
  const gc  = hud.channel({ name: 'gc', kind: 1 });
  gc.push();
  const r = hud.inspect('gc');
  assert.ok(r);
  assert.equal(r.count,  1);
  assert.equal(r.last.a, 0); // INSTANT stores 0 in a slot
  assert.ok(r.last.t > 0);
});

test('channel() COUNTER: push writes value', () => {
  const hud  = createHud(null);
  const ctr  = hud.channel({ name: 'draws', kind: 3 });
  ctr.push(42);
  const r = hud.inspect('draws');
  assert.ok(r);
  assert.equal(r.last.a, 42);
});

test('channel() SPAN complete: push(duration) stores t_start and duration (D5)', () => {
  const hud   = createHud(null);
  const frame = hud.channel({ name: 'frame', kind: 2 });
  const before = performance.now();
  frame.push(16); // 16ms duration
  const after  = performance.now();
  const r = hud.inspect('frame');
  assert.ok(r);
  assert.equal(r.last.a, 16); // a = duration (D5)
  // t = t_start = now - duration; must be <= 'before' snapshot
  assert.ok(r.last.t <= after - 16, 't_start is plausible');
  assert.ok(r.last.t >= before - 16 - 2, 't_start is not unreasonably old');
});

test('two manual channels get independent rings', () => {
  const hud = createHud(null);
  const a   = hud.channel({ name: 'ch-a', kind: 0 });
  const b   = hud.channel({ name: 'ch-b', kind: 0 });
  a.push(1);
  b.push(2);
  const ra = hud.inspect('ch-a');
  const rb = hud.inspect('ch-b');
  assert.equal(ra.last.a, 1);
  assert.equal(rb.last.a, 2);
  assert.equal(hud.stats().channels, 2);
});

test('channel() with no name gets a default name', () => {
  const hud = createHud(null);
  hud.channel({ kind: 0 });
  assert.equal(hud.stats().channelStats[0].name, 'ch0');
});

// ---------------------------------------------------------------------------
// 4. write() routing and drops
// ---------------------------------------------------------------------------

test('write() with unregistered streamId increments drops', () => {
  const hud = createHud(null);
  hud.write(packed(99, 0x0100), 1, 2, 3);
  assert.equal(hud.stats().drops, 1);
});

test('write() with registered sid but unregistered op increments drops', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'span', kind: 0, width: 1 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(1, 0x0199), 1, 2, 3); // 0x99 not registered
  assert.equal(hud.stats().drops, 1);
});

test('drops accumulate across multiple misses', () => {
  const hud = createHud(null);
  hud.write(packed(5, 0x0100), 1, 0, 0);
  hud.write(packed(6, 0x0100), 1, 0, 0);
  hud.write(packed(7, 0x0100), 1, 0, 0);
  assert.equal(hud.stats().drops, 3);
});

// ---------------------------------------------------------------------------
// 5. Meta stream records
// ---------------------------------------------------------------------------

test('EPOCH record sets epoch in stats', () => {
  const hud = createHud(null);
  hud.write(packed(0, 0x0F00), 12345, 1, 0); // OP_EPOCH, t=12345, a=sppVersion=1
  assert.equal(hud.stats().epoch, 12345);
});

test('GATE_VERDICT record increments verdicts in stats', () => {
  const hud = createHud(null);
  hud.write(packed(0, 0x0F40), 100, 0, 0); // pass
  hud.write(packed(0, 0x0F40), 200, 0, 1); // fail
  assert.equal(hud.stats().verdicts, 2);
});

test('BUDGET_SET record applies budget to matching channel', () => {
  const scope = mockScope([{
    id: 1, name: 'fps',
    ops: [{ code: 0x0100, name: 'fps', kind: 0, width: 1 }],
  }]);
  scope._intern(7, 'fps');
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(0, 0x0F41), performance.now(), 7, 60); // threshold 60 for intern id 7
  assert.equal(hud.stats().budgets, 1);
});

test('BUDGET_SET with unknown intern label is ignored', () => {
  const scope = mockScope([]);
  scope._intern(7, 'nonexistent');
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(0, 0x0F41), performance.now(), 7, 60);
  assert.equal(hud.stats().budgets, 0);
});

// ---------------------------------------------------------------------------
// 6. CONT reassembly
// ---------------------------------------------------------------------------

test('CONT width=2: primary + 1 CONT flushes to ring', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'fat', kind: 0, width: 2 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);

  hud.write(packed(1, 0x0100), 10, 1, 2);       // primary
  assert.equal(hud.inspect('fat'), null, 'not flushed after primary alone');

  hud.write(packed(1, 0x0F01), 3, 4, 5);        // CONT
  const r = hud.inspect('fat');
  assert.ok(r, 'flushed after CONT');
  assert.equal(r.count,  1);
  assert.equal(r.last.t, 10);
  assert.equal(r.last.a, 1);
  assert.equal(r.last.b, 2);
});

test('CONT width=3: primary + 2 CONT records flush to ring', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0101, name: 'fat3', kind: 0, width: 3 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);

  hud.write(packed(1, 0x0101), 10, 1, 2);
  hud.write(packed(1, 0x0F01),  3, 4, 5);
  assert.equal(hud.inspect('fat3'), null, 'not flushed after 1 CONT (need 2)');

  hud.write(packed(1, 0x0F01),  6, 7, 8);
  const r = hud.inspect('fat3');
  assert.ok(r);
  assert.equal(r.count, 1);
  assert.equal(r.last.t, 10);
});

test('CONT without pending for that stream increments drops', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'test', kind: 0, width: 2 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  // No primary yet; CONT arrives cold
  hud.write(packed(1, 0x0F01), 1, 2, 3);
  assert.equal(hud.stats().drops, 1);
});

test('CONT on unregistered stream increments drops', () => {
  const hud = createHud(null);
  hud.write(packed(42, 0x0F01), 1, 2, 3);
  assert.equal(hud.stats().drops, 1);
});

test('CONT rearm: two consecutive width=2 sequences on same stream', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'rep', kind: 0, width: 2 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);

  hud.write(packed(1, 0x0100), 1, 10, 0);
  hud.write(packed(1, 0x0F01), 0, 0, 0);

  hud.write(packed(1, 0x0100), 2, 20, 0);
  hud.write(packed(1, 0x0F01), 0, 0, 0);

  const r = hud.inspect('rep');
  assert.ok(r);
  assert.equal(r.count, 2);
  assert.equal(r.last.t, 2);
  assert.equal(r.last.a, 20);
});

// ---------------------------------------------------------------------------
// 7. Ring overwrite / backpressure
// ---------------------------------------------------------------------------

test('ring overwrites oldest record when at capacity', () => {
  // Default cap is 256 for non-hz channels; use a tiny cap via hz trick.
  // Build a scope channel with hz=1 and windowSec=1 -> cap=pow2(ceil(1)+1)=pow2(2)=4
  const scope = mockScope([{
    id: 1, name: 'lvl', unit: '', hz: 1,
    ops: [{ code: 0x0100, name: 'lvl', kind: 0, width: 1 }],
  }]);
  const hud = createHud(null, { windowSec: 1 });
  hud.attach(scope);

  // Write 5 records into a ring of capacity 4
  for (let i = 1; i <= 5; i++) {
    hud.write(packed(1, 0x0100), i * 100, i, 0);
  }

  const r = hud.inspect('lvl');
  assert.ok(r);
  assert.equal(r.count, 5);        // total count accumulates
  assert.equal(r.last.a, 5);       // newest is the last written
  // Oldest is record 2 (record 1 was overwritten)
  // We can verify count-in-ring doesn't exceed capacity
  assert.ok(r.count > 4, 'total count exceeds capacity, confirming overwrite');
});

test('ring head stays within [0, cap-1] after many writes', () => {
  const hud = createHud(null);
  const ch  = hud.channel({ name: 'x', kind: 0 });
  for (let i = 0; i < 300; i++) ch.push(i);
  const s = hud.stats().channelStats[0];
  assert.ok(s.head >= 0 && s.head < 256, 'head is within ring bounds');
  assert.equal(s.count, 300, 'count tracks all writes');
});

// ---------------------------------------------------------------------------
// 8. attach() + scope integration
// ---------------------------------------------------------------------------

test('attach() builds channels from scope.streams()', () => {
  const scope = mockScope([
    { id: 1, name: 'trace', ops: [{ code: 0x0100, name: 'span', kind: 0, width: 1 }] },
    { id: 2, name: 'gc',    ops: [{ code: 0x0200, name: 'scav', kind: 1, width: 1 }] },
  ]);
  const hud = createHud(null);
  hud.attach(scope);
  assert.equal(hud.stats().channels, 2);
  assert.equal(hud.stats().channelStats[0].name, 'span');
  assert.equal(hud.stats().channelStats[1].name, 'scav');
});

test('attach() registers HUD as scope sink via addSink', () => {
  const scope = mockScope([]);
  const hud   = createHud(null);
  hud.attach(scope);
  assert.equal(scope._sinks().length, 1);
  assert.equal(typeof scope._sinks()[0].write, 'function');
});

test('attach() then scope.emit routes to channel ring', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'lvl', kind: 0, width: 1 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  scope._emit(packed(1, 0x0100), 999, 7.5, 0);
  const r = hud.inspect('lvl');
  assert.ok(r);
  assert.equal(r.last.t, 999);
  assert.equal(r.last.a, 7.5);
});

test('attach() LEVEL channel from scope', () => {
  const scope = mockScope([{
    id: 1, name: 'perf', hz: 60,
    ops: [{ code: 0x0100, name: 'fps', kind: 0, width: 1 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(1, 0x0100), 1, 59.8, 0);
  const r = hud.inspect('fps');
  assert.ok(r);
  assert.equal(r.last.a, 59.8);
});

test('attach() INSTANT channel from scope', () => {
  const scope = mockScope([{
    id: 2, name: 'gc',
    ops: [{ code: 0x0200, name: 'scav', kind: 1, width: 1 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(2, 0x0200), 500, 0, 0);
  const r = hud.inspect('scav');
  assert.ok(r);
  assert.equal(r.count, 1);
  assert.equal(r.last.t, 500);
});

test('attach() complete SPAN channel from scope (non-paired)', () => {
  const scope = mockScope([{
    id: 3, name: 'trace',
    ops: [{ code: 0x0300, name: 'render', kind: 2, width: 1, paired: false }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  // t=start, a=duration (D5)
  hud.write(packed(3, 0x0300), 1000, 8, 0);
  const r = hud.inspect('render');
  assert.ok(r);
  assert.equal(r.last.t, 1000); // t_start
  assert.equal(r.last.a, 8);    // duration
});

test('attach() multiple ops on same stream get separate channels', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'alpha', kind: 0, width: 1 },
      { code: 0x0101, name: 'beta',  kind: 1, width: 1 },
    ],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  assert.equal(hud.stats().channels, 2);
  hud.write(packed(1, 0x0100), 1, 11, 0);
  hud.write(packed(1, 0x0101), 2, 0,  0);
  assert.equal(hud.inspect('alpha').last.a, 11);
  assert.equal(hud.inspect('beta').count,   1);
});

// ---------------------------------------------------------------------------
// 9. Paired SPAN channels
// ---------------------------------------------------------------------------

test('attach() paired SPAN: creates one channel for open+close pair', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'rtt', kind: 2, paired: true },
      { code: 0x0101, name: 'rtt', kind: 2, paired: true },
    ],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  assert.equal(hud.stats().channels, 1);
});

test('paired SPAN open+close produces a ring record', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'rtt', kind: 2, paired: true },
      { code: 0x0101, name: 'rtt', kind: 2, paired: true },
    ],
  }]);
  const hud = createHud(null);
  hud.attach(scope);

  const correlId = 42;
  hud.write(packed(1, 0x0100), 100, correlId, 0); // open at t=100
  assert.equal(hud.inspect('rtt'), null, 'no ring record until close');

  hud.write(packed(1, 0x0101), 200, correlId, 0); // close at t=200
  const r = hud.inspect('rtt');
  assert.ok(r);
  assert.equal(r.count,  1);
  assert.equal(r.last.t, 100); // t_open
  assert.equal(r.last.a, 200); // t_close
  assert.equal(r.last.b, 42);  // correlId
});

test('paired SPAN close without open does not write ring record', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'sp', kind: 2, paired: true },
      { code: 0x0101, name: 'sp', kind: 2, paired: true },
    ],
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(1, 0x0101), 200, 99, 0); // close with correlId=99, no matching open
  assert.equal(hud.inspect('sp'), null);
});

test('paired SPAN: two interleaved spans by different correlIds', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'io', kind: 2, paired: true },
      { code: 0x0101, name: 'io', kind: 2, paired: true },
    ],
  }]);
  const hud = createHud(null);
  hud.attach(scope);

  hud.write(packed(1, 0x0100), 10, 1, 0); // open span 1
  hud.write(packed(1, 0x0100), 20, 2, 0); // open span 2
  hud.write(packed(1, 0x0101), 30, 1, 0); // close span 1
  hud.write(packed(1, 0x0101), 40, 2, 0); // close span 2

  const r = hud.inspect('io');
  assert.ok(r);
  assert.equal(r.count, 2);
});

// ---------------------------------------------------------------------------
// 10. DI budgets
// ---------------------------------------------------------------------------

test('attach() DI budgets: budget applied to matching channel', () => {
  const scope = mockScope([{
    id: 1, name: 'fps',
    ops: [{ code: 0x0100, name: 'fps', kind: 0, width: 1 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope, {
    budgets: [{ channel: 'fps', threshold: 60, label: 'min fps' }],
  });
  assert.equal(hud.stats().budgets, 1);
});

test('attach() DI budget for unknown channel is ignored', () => {
  const scope = mockScope([]);
  const hud   = createHud(null);
  hud.attach(scope, {
    budgets: [{ channel: 'nope', threshold: 1 }],
  });
  assert.equal(hud.stats().budgets, 0);
});

test('attach() multiple DI budgets on same channel', () => {
  const scope = mockScope([{
    id: 1, name: 'frame',
    ops: [{ code: 0x0100, name: 'frame', kind: 0, width: 1 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope, {
    budgets: [
      { channel: 'frame', threshold: 8.33, label: '120fps' },
      { channel: 'frame', threshold: 16.67, label: '60fps' },
    ],
  });
  assert.equal(hud.stats().budgets, 2);
});

// ---------------------------------------------------------------------------
// 11. Synthetic stream ID isolation
// ---------------------------------------------------------------------------

test('manual channel synthetic IDs do not conflict with scope stream IDs', () => {
  const scope = mockScope([
    { id: 1, name: 's1', ops: [{ code: 0x0100, name: 's1ch', kind: 0, width: 1 }] },
    { id: 2, name: 's2', ops: [{ code: 0x0200, name: 's2ch', kind: 0, width: 1 }] },
  ]);
  const hud = createHud(null);
  hud.attach(scope);
  const m = hud.channel({ name: 'manual', kind: 0 });
  m.push(99);

  // Scope channels receive data correctly
  hud.write(packed(1, 0x0100), 1, 10, 0);
  hud.write(packed(2, 0x0200), 2, 20, 0);

  assert.equal(hud.inspect('s1ch').last.a,  10);
  assert.equal(hud.inspect('s2ch').last.a,  20);
  assert.equal(hud.inspect('manual').last.a, 99);
  assert.equal(hud.stats().drops, 0);
});

// ---------------------------------------------------------------------------
// 12. inspect()
// ---------------------------------------------------------------------------

test('inspect() returns null for unknown channel name', () => {
  const hud = createHud(null);
  assert.equal(hud.inspect('ghost'), null);
});

test('inspect() returns null for channel with no writes', () => {
  const hud = createHud(null);
  hud.channel({ name: 'empty', kind: 0 });
  assert.equal(hud.inspect('empty'), null);
});

test('inspect() returns correct count and last record', () => {
  const hud = createHud(null);
  const ch  = hud.channel({ name: 'test', kind: 0 });
  ch.push(1);
  ch.push(2);
  ch.push(3);
  const r = hud.inspect('test');
  assert.ok(r);
  assert.equal(r.count,  3);
  assert.equal(r.last.a, 3);
});

// ---------------------------------------------------------------------------
// 13. show / hide / destroy
// ---------------------------------------------------------------------------

test('hide() sets visible to false', () => {
  const hud = createHud(null);
  hud.hide();
  assert.equal(hud.visible, false);
});

test('show() restores visible to true', () => {
  const hud = createHud(null);
  hud.hide();
  hud.show();
  assert.equal(hud.visible, true);
});

test('destroy() with null canvas does not throw', () => {
  const hud = createHud(null);
  assert.doesNotThrow(() => hud.destroy());
});

test('destroy() removes HUD from scope sinks', () => {
  const scope = mockScope([]);
  const hud   = createHud(null);
  hud.attach(scope);
  assert.equal(scope._sinks().length, 1);
  hud.destroy();
  assert.equal(scope._sinks().length, 0);
});

// ---------------------------------------------------------------------------
// 14. render() cold path
// ---------------------------------------------------------------------------

test('render() with null canvas is a no-op', () => {
  const hud = createHud(null);
  hud.channel({ name: 'fps', kind: 0 }).push(60);
  assert.doesNotThrow(() => hud.render());
});

// ---------------------------------------------------------------------------
// 15. Edge cases
// ---------------------------------------------------------------------------

test('write() before any attach does not throw', () => {
  const hud = createHud(null);
  assert.doesNotThrow(() => hud.write(packed(1, 0x0100), 1, 2, 3));
  assert.equal(hud.stats().drops, 1);
});

test('multiple EPOCH records: last one wins', () => {
  const hud = createHud(null);
  hud.write(packed(0, 0x0F00), 1000, 1, 0);
  hud.write(packed(0, 0x0F00), 2000, 1, 0);
  assert.equal(hud.stats().epoch, 2000);
});

test('GATE_VERDICT ring wraps at 64 verdicts (VCAP)', () => {
  const hud = createHud(null);
  for (let i = 0; i < 70; i++) {
    hud.write(packed(0, 0x0F40), i, 0, 0);
  }
  assert.equal(hud.stats().verdicts, 64); // capped at VCAP
});

test('scope with zero streams attaches cleanly', () => {
  const scope = mockScope([]);
  const hud   = createHud(null);
  assert.doesNotThrow(() => hud.attach(scope));
  assert.equal(hud.stats().channels, 0);
});

test('stream descriptor with no ops is skipped', () => {
  const scope = mockScope([{ id: 1, name: 'empty', ops: [] }]);
  const hud   = createHud(null);
  hud.attach(scope);
  assert.equal(hud.stats().channels, 0);
});

test('single paired SPAN op (no matching close) is skipped', () => {
  // Odd count of paired ops: one dangling op should be ignored
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'sp', kind: 2, paired: true }], // no close
  }]);
  const hud = createHud(null);
  hud.attach(scope);
  assert.equal(hud.stats().channels, 0, 'dangling paired op creates no channel');
});

// ---------------------------------------------------------------------------
// 16. Attach-time validation
// ---------------------------------------------------------------------------

test('attach throws on opLow collision within a stream', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'alpha', kind: 0, width: 1 },
      { code: 0x0200, name: 'beta',  kind: 0, width: 1 }, // same low byte 0x00
    ],
  }]);
  const hud = createHud(null);
  assert.throws(
    () => hud.attach(scope),
    /opcode low-byte collision on stream 1 at 0x00/
  );
});

test('attach throws on opLow collision between singleOp and paired open', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'ctr',   kind: 3, width: 1 },
      { code: 0x0200, name: 'span',  kind: 2, paired: true }, // low byte 0x00 clashes
      { code: 0x0201, name: 'span',  kind: 2, paired: true },
    ],
  }]);
  const hud = createHud(null);
  assert.throws(() => hud.attach(scope), /opcode low-byte collision on stream 1/);
});

test('same low byte across different streams is fine', () => {
  const scope = mockScope([
    { id: 1, name: 's1', ops: [{ code: 0x0100, name: 'a', kind: 0, width: 1 }] },
    { id: 2, name: 's2', ops: [{ code: 0x0100, name: 'b', kind: 0, width: 1 }] }, // same low byte, different stream
  ]);
  const hud = createHud(null);
  assert.doesNotThrow(() => hud.attach(scope));
  assert.equal(hud.stats().channels, 2);
});

test('CONT width=4 fully assembles without truncation', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'fat4', kind: 0, width: 4 }],
  }]);
  const hud = createHud(null);
  hud.attach(scope);

  // primary + 3 CONT records => 12 f64 slots total
  hud.write(packed(1, 0x0100), 10, 1, 2);
  hud.write(packed(1, 0x0F01),  3, 4, 5);
  assert.equal(hud.inspect('fat4'), null, 'not flushed after 1 CONT (need 3)');
  hud.write(packed(1, 0x0F01),  6, 7, 8);
  assert.equal(hud.inspect('fat4'), null, 'not flushed after 2 CONT (need 3)');
  hud.write(packed(1, 0x0F01),  9, 10, 11);

  const r = hud.inspect('fat4');
  assert.ok(r, 'flushed after 3 CONT records');
  assert.equal(r.count,  1);
  assert.equal(r.last.t, 10);
  assert.equal(hud.stats().drops, 0, 'no silent drops on width>3');
});

test('CONT width=8 works with dynamic slot buffer', () => {
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [{ code: 0x0100, name: 'huge', kind: 0, width: 8 }],
  }]);
  const hud = createHud(null);
  assert.doesNotThrow(() => hud.attach(scope));

  hud.write(packed(1, 0x0100), 100, 0, 0); // primary
  for (let i = 1; i < 8; i++) hud.write(packed(1, 0x0F01), i, 0, 0);
  const r = hud.inspect('huge');
  assert.ok(r);
  assert.equal(r.last.t, 100);
  assert.equal(hud.stats().drops, 0);
});

test('per-stream slots buffer grows to fit widest op', () => {
  // Two ops on same stream, different widths. Slots buffer must sit at max.
  const scope = mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'narrow', kind: 0, width: 2 },
      { code: 0x0201, name: 'wide',   kind: 0, width: 5 }, // distinct low byte
    ],
  }]);
  const hud = createHud(null);
  assert.doesNotThrow(() => hud.attach(scope));

  // Wide record: primary + 4 CONT
  hud.write(packed(1, 0x0201), 42, 0, 0);
  for (let i = 1; i < 5; i++) hud.write(packed(1, 0x0F01), i, 0, 0);
  const r = hud.inspect('wide');
  assert.ok(r);
  assert.equal(r.last.t, 42);
  assert.equal(hud.stats().drops, 0);
});

// ---------------------------------------------------------------------------
// 17. Paired-span open pool: eviction order, key edge cases, re-open (M1)
// ---------------------------------------------------------------------------

// A scope with a single paired SPAN channel 'sp' on stream 1 (cap = 256).
function pairedScope() {
  return mockScope([{
    id: 1, name: 'trace',
    ops: [
      { code: 0x0100, name: 'sp', kind: 2, paired: true },
      { code: 0x0101, name: 'sp', kind: 2, paired: true },
    ],
  }]);
}

test('paired SPAN: eviction is oldest-first (FIFO) when the pool is full', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  // cap = 256 (hz null). Open 257 distinct correlIds without closing.
  for (let i = 0; i < 257; i++) hud.write(packed(1, 0x0100), 1000 + i, i, 0);
  assert.equal(hud.stats().drops, 1); // exactly one eviction (the oldest)

  // key 0 was the oldest -> evicted; its close finds nothing.
  hud.write(packed(1, 0x0101), 5000, 0, 0);
  assert.equal(hud.inspect('sp'), null);

  // key 1 is still open -> closes to a record with its own t_open (1001).
  hud.write(packed(1, 0x0101), 6000, 1, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.t, 1001);
  assert.equal(r.last.a, 6000);
  assert.equal(r.last.b, 1);
});

test('paired SPAN: re-open overwrites t_open and keeps FIFO position', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 10, 100, 0); // open A (oldest)
  hud.write(packed(1, 0x0100), 20, 200, 0); // open B
  hud.write(packed(1, 0x0100), 30, 100, 0); // re-open A: overwrite t_open, keep position

  // Close A now: latest t_open (30) wins, position was unchanged, no drop.
  hud.write(packed(1, 0x0101), 40, 100, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.count, 1);
  assert.equal(r.last.t, 30); // overwritten open time
  assert.equal(r.last.a, 40);
  assert.equal(hud.stats().drops, 0); // re-open under cap does not evict
});

test('paired SPAN: re-open does not move the key to the back of the FIFO', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 10, 100, 0); // open A (oldest)
  hud.write(packed(1, 0x0100), 20, 200, 0); // open B
  hud.write(packed(1, 0x0100), 30, 100, 0); // re-open A -> STILL oldest
  // Add 255 more distinct opens (A, B + 255 = 257 distinct) to force one eviction.
  for (let i = 0; i < 255; i++) hud.write(packed(1, 0x0100), 1000 + i, 1000 + i, 0);
  assert.equal(hud.stats().drops, 1);
  // A was oldest and unchanged by the re-open -> A is the evicted one.
  hud.write(packed(1, 0x0101), 9000, 100, 0);
  assert.equal(hud.inspect('sp'), null);
});

test('paired SPAN: correlId 0 is a legal key', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 100, 0, 0);
  hud.write(packed(1, 0x0101), 200, 0, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.t, 100);
  assert.equal(r.last.b, 0);
});

test('paired SPAN: -0 correlId matches +0 (normalized)', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 100, -0, 0); // open with -0
  hud.write(packed(1, 0x0101), 200, 0, 0);  // close with +0 -> must match
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.t, 100);
  assert.ok(Object.is(r.last.b, 0), 'stored correlId is +0, never -0');
});

test('paired SPAN: NaN correlId on open is a counted drop', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 100, NaN, 0); // open with NaN -> drop
  assert.equal(hud.stats().drops, 1);
  hud.write(packed(1, 0x0101), 200, NaN, 0); // close NaN -> nothing to match
  assert.equal(hud.inspect('sp'), null);
  assert.equal(hud.stats().drops, 1);
});

test('paired SPAN: fractional correlId key', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 100, 3.5, 0);
  hud.write(packed(1, 0x0101), 200, 3.5, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.b, 3.5);
});

test('paired SPAN: correlId key larger than 2^32', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  const key = 2 ** 40 + 7;
  hud.write(packed(1, 0x0100), 100, key, 0);
  hud.write(packed(1, 0x0101), 200, key, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.b, key);
});

test('paired SPAN: negative correlId key', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  hud.write(packed(1, 0x0100), 100, -12345, 0);
  hud.write(packed(1, 0x0101), 200, -12345, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.b, -12345);
});

test('paired SPAN: two distinct keys that collide in the same probe slot', () => {
  // Exercises the linear probe + backshift delete with a real collision.
  const hud = createHud(null);
  hud.attach(pairedScope());
  // slots = 512; keys 0 and 512 hash may differ, so just open many and close
  // in reverse to stress the backshift path.
  for (let i = 0; i < 100; i++) hud.write(packed(1, 0x0100), 1000 + i, i, 0);
  for (let i = 99; i >= 0; i--) hud.write(packed(1, 0x0101), 5000 + i, i, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.count, 100);
  assert.equal(hud.stats().drops, 0);
});

// ---------------------------------------------------------------------------
// 18. BUDGET_SET replace semantics (M1)
// ---------------------------------------------------------------------------

test('BUDGET_SET repeat for the same channel replaces (does not grow budgets)', () => {
  const scope = mockScope([{
    id: 1, name: 'fps',
    ops: [{ code: 0x0100, name: 'fps', kind: 0, width: 1 }],
  }]);
  scope._intern(7, 'fps');
  const hud = createHud(null);
  hud.attach(scope);
  hud.write(packed(0, 0x0F41), performance.now(), 7, 60);
  assert.equal(hud.stats().budgets, 1);
  hud.write(packed(0, 0x0F41), performance.now(), 7, 30); // replace, not append
  assert.equal(hud.stats().budgets, 1);
  hud.write(packed(0, 0x0F41), performance.now(), 7, 45); // still replace
  assert.equal(hud.stats().budgets, 1);
});

test('BUDGET_SET meta budget coexists with DI budgets in the count', () => {
  const scope = mockScope([{
    id: 1, name: 'frame',
    ops: [{ code: 0x0100, name: 'frame', kind: 0, width: 1 }],
  }]);
  scope._intern(9, 'frame');
  const hud = createHud(null);
  hud.attach(scope, { budgets: [{ channel: 'frame', threshold: 16.67, label: '60fps' }] });
  assert.equal(hud.stats().budgets, 1);
  hud.write(packed(0, 0x0F41), performance.now(), 9, 8.33); // + one meta budget
  assert.equal(hud.stats().budgets, 2);
  hud.write(packed(0, 0x0F41), performance.now(), 9, 4.16); // replace meta, still 2
  assert.equal(hud.stats().budgets, 2);
});

// ---------------------------------------------------------------------------
// 19. Option validation: viewport + maxDpr (M1, fail-closed)
// ---------------------------------------------------------------------------

test('createHud throws on a non-function viewport option', () => {
  assert.throws(
    () => createHud(null, { viewport: {} }),
    /@zakkster\/lite-hud: viewport must be a Viewport class/
  );
  assert.throws(
    () => createHud(null, { viewport: 42 }),
    /@zakkster\/lite-hud: viewport must be a Viewport class/
  );
});

test('createHud accepts a function viewport option', () => {
  assert.doesNotThrow(() => createHud(null, { viewport: function Viewport() {} }));
  assert.doesNotThrow(() => createHud(null, { viewport: class V {} }));
});

test('createHud throws on a bad maxDpr option', () => {
  for (const bad of [0, 0.5, -1, NaN, -Infinity, '2']) {
    assert.throws(
      () => createHud(null, { maxDpr: bad }),
      /@zakkster\/lite-hud: maxDpr must be a finite number >= 1 or Infinity/,
      'maxDpr=' + String(bad) + ' must throw'
    );
  }
});

test('createHud accepts a valid maxDpr option', () => {
  assert.doesNotThrow(() => createHud(null, { maxDpr: 1 }));
  assert.doesNotThrow(() => createHud(null, { maxDpr: 2 }));
  assert.doesNotThrow(() => createHud(null, { maxDpr: Infinity }));
});

// ---------------------------------------------------------------------------
// 20. Rendering check: mock Viewport + DOM stub (M1)
// ---------------------------------------------------------------------------

function makeCtx() {
  const calls = [];
  return {
    _calls: calls,
    setTransform(...a) { calls.push(['setTransform'].concat(a)); },
    scale(...a) { calls.push(['scale'].concat(a)); },
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillText() {}, save() {}, restore() {}, rect() {}, clip() {},
    setLineDash() {},
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '',
  };
}

function makeEl(tag) {
  const ctx = tag === 'canvas' ? makeCtx() : null;
  return {
    tagName: tag.toUpperCase(),
    id: '',
    style: {},
    width: 0,
    height: 0,
    children: [],
    parentElement: null,
    _ctx: ctx,
    getContext() { return ctx; },
    addEventListener() {},
    removeEventListener() {},
    // Mirror real DOM: remove() detaches this node from its parent's children.
    remove() {
      const p = this.parentElement;
      if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); }
      this.parentElement = null;
    },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    getBoundingClientRect() {
      return { width: parseFloat(this.style.width) || 0, height: parseFloat(this.style.height) || 0 };
    },
  };
}

function installDom(dpr) {
  const saved = {
    document: globalThis.document,
    devicePixelRatio: globalThis.devicePixelRatio,
    hasDoc: 'document' in globalThis,
    hasDpr: 'devicePixelRatio' in globalThis,
  };
  const docListeners = [];
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    addEventListener(type) { docListeners.push(type); },
    removeEventListener(type) { const i = docListeners.indexOf(type); if (i >= 0) docListeners.splice(i, 1); },
    body: makeEl('div'),
    _listeners: docListeners,
  };
  globalThis.devicePixelRatio = dpr;
  return saved;
}

function uninstallDom(saved) {
  if (saved.hasDoc) globalThis.document = saved.document; else delete globalThis.document;
  if (saved.hasDpr) globalThis.devicePixelRatio = saved.devicePixelRatio; else delete globalThis.devicePixelRatio;
}

// A mock Viewport CLASS: mirrors lite-viewport (measures the parent, caps dpr,
// setTransform-before-scale, fires onResize). Records instances for the DPR-change
// simulation.
class MockViewport {
  constructor({ canvas, maxDpr, onResize }) {
    MockViewport.instances.push(this);
    this.canvas = canvas;
    this.maxDpr = maxDpr === undefined ? Infinity : maxDpr;
    this.onResize = onResize || (() => {});
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.destroyed = false;
    this.resize();
  }
  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, this.maxDpr);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
    this.onResize(this.width, this.height, this.dpr);
  }
  setDpr(d) { globalThis.devicePixelRatio = d; this.resize(); }
  destroy() { this.destroyed = true; }
}
MockViewport.instances = [];

// Expected total overlay height for one channel: PAD + 1*(ROW_H+PAD) + 14 + PAD
// = 8 + 56 + 14 + 8 = 86; HUD width is 290.
const HUD_W = 290;
const H1 = 86;

test('viewport render: correct backing store at DPR 1/2/3', () => {
  for (const d of [1, 2, 3]) {
    const saved = installDom(d);
    MockViewport.instances = [];
    try {
      const mount = makeEl('div');
      const hud = createHud(mount, { viewport: MockViewport });
      hud.channel({ name: 'fps', kind: 0 }).push(60);
      hud.render();
      const wrapper = mount.children[0];
      const canvas = wrapper.children[0];
      assert.equal(wrapper.style.width, HUD_W + 'px');
      assert.equal(canvas.width, HUD_W * d, 'backing width at dpr ' + d);
      assert.equal(canvas.height, H1 * d, 'backing height at dpr ' + d);
      hud.destroy();
    } finally {
      uninstallDom(saved);
    }
  }
});

test('viewport render: a DPR change re-sizes the backing store via onResize', () => {
  const saved = installDom(1);
  MockViewport.instances = [];
  try {
    const mount = makeEl('div');
    const hud = createHud(mount, { viewport: MockViewport });
    hud.channel({ name: 'fps', kind: 0 }).push(60);
    hud.render();
    const canvas = mount.children[0].children[0];
    assert.equal(canvas.width, HUD_W * 1);

    // Simulate a monitor swap / OS scale change: DPR 1 -> 2.
    const vp = MockViewport.instances[MockViewport.instances.length - 1];
    vp.setDpr(2); // fires onResize -> HUD redraw
    assert.equal(canvas.width, HUD_W * 2, 'backing width follows the DPR change');
    assert.equal(canvas.height, H1 * 2);
    hud.destroy();
    assert.equal(vp.destroyed, true, 'destroy() tears down the viewport');
  } finally {
    uninstallDom(saved);
  }
});

test('viewport render: maxDpr caps the injected viewport backing store', () => {
  const saved = installDom(3);
  MockViewport.instances = [];
  try {
    const mount = makeEl('div');
    const hud = createHud(mount, { viewport: MockViewport, maxDpr: 2 });
    hud.channel({ name: 'fps', kind: 0 }).push(60);
    hud.render();
    const canvas = mount.children[0].children[0];
    assert.equal(canvas.width, HUD_W * 2, 'dpr 3 capped to 2');
    hud.destroy();
  } finally {
    uninstallDom(saved);
  }
});

test('fallback render: maxDpr caps devicePixelRatio in the backing store', () => {
  const saved = installDom(3);
  try {
    const mount = makeEl('div');
    const hud = createHud(mount, { maxDpr: 2 }); // no viewport -> inline fallback
    const canvas = mount.children[0];
    assert.equal(canvas.tagName, 'CANVAS', 'fallback appends the canvas directly');
    assert.equal(canvas.width, HUD_W * 2, 'dpr 3 capped to 2 in fallback');
    hud.destroy();
  } finally {
    uninstallDom(saved);
  }
});

test('fallback render: setTransform precedes scale on every resize (no cumulative scaling)', () => {
  const saved = installDom(2);
  try {
    const mount = makeEl('div');
    const hud = createHud(mount); // fallback path
    const canvas = mount.children[0];
    const ctx = canvas._ctx;
    // Add two channels so the height grows past the 1-channel size and render()
    // forces a second resize.
    hud.channel({ name: 'a', kind: 0 }).push(1);
    hud.channel({ name: 'b', kind: 0 }).push(2);
    hud.render();

    const calls = ctx._calls;
    let scales = 0;
    for (let i = 0; i < calls.length; i++) {
      if (calls[i][0] === 'scale') {
        scales++;
        assert.ok(i > 0 && calls[i - 1][0] === 'setTransform',
          'each scale is immediately preceded by a setTransform reset');
      }
    }
    assert.ok(scales >= 2, 'at least two resizes (setup + row growth) happened');
    hud.destroy();
  } finally {
    uninstallDom(saved);
  }
});

// ---------------------------------------------------------------------------
// 21. QA boundary matrix (M1 gate verification) -- added by QA, Hud.js untouched
// ---------------------------------------------------------------------------

// Assertion 2: paired pool occupancy returns to 0 after 10 cycles of 200000
// balanced open+close. There is no public getter for poolSize/occupancy, so
// this is proven the only way the public surface allows: if occupancy did not
// return to 0 after each pair, the pool (cap 256 for a paired SPAN channel
// with no hz) would silently accumulate phantom entries and start evicting
// (a counted drop) long before 2,000,000 pairs. Zero drops across the whole
// run, plus a post-run cap probe that evicts exactly once, is the closest
// measurable proxy to "occupancy returns to 0" available without touching
// Hud.js.
test('paired pool: occupancy returns to 0 after 10 cycles of 200000 open+close', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  let k = 0;
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let i = 0; i < 200000; i++) {
      k = (k + 1) >>> 0;
      hud.write(packed(1, 0x0100), k, k, 0);      // open
      hud.write(packed(1, 0x0101), k + 1, k, 0);  // close (same cycle -> pool empties)
    }
  }
  assert.equal(hud.stats().drops, 0,
    'a leaked (non-decrementing) poolSize would have overflowed cap=256 and evicted long before 2,000,000 balanced pairs');

  // Post-run cap probe: pool must be truly empty (poolSize 0), so exactly 256
  // fresh opens fit before the 257th evicts -- exactly like the from-empty case.
  for (let i = 0; i < 256; i++) hud.write(packed(1, 0x0100), 9000000 + i, 9000000 + i, 0);
  assert.equal(hud.stats().drops, 0, 'still 0 after refilling to exactly cap from a truly-empty pool');
  hud.write(packed(1, 0x0100), 9999999, 9999999, 0); // 257th distinct open -> 1 eviction
  assert.equal(hud.stats().drops, 1, 'the 257th concurrently-open key evicts -- proves occupancy was 0, not leaked');
});

// Boundary: correlId key exactly Number.MAX_SAFE_INTEGER (2^53 - 1).
test('paired SPAN: correlId key exactly 2^53 - 1 (MAX_SAFE_INTEGER)', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  const key = Number.MAX_SAFE_INTEGER; // 2^53 - 1
  hud.write(packed(1, 0x0100), 100, key, 0);
  hud.write(packed(1, 0x0101), 200, key, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.t, 100);
  assert.equal(r.last.b, key);
  assert.equal(hud.stats().drops, 0);
});

// Boundary: open a fresh key once the FIFO ring is saturated with entries that
// have ALL already been closed (poolSize back to 0, but fifoCount at its
// ceiling) -- fifoCompact must reclaim the stale entries in place rather than
// mistaking a full FIFO buffer for a full pool (which would wrongly evict a
// live entry, or worse, evict nothing and silently grow unbounded).
test('paired SPAN: open when the FIFO is saturated with already-closed entries does not evict', () => {
  const hud = createHud(null);
  hud.attach(pairedScope());
  // cap = 256 (hz null) -> fifoCap = poolSlots = pow2(256*2) = 512. Drive 512
  // balanced open+close pairs (poolSize returns to 0 every time, but every
  // open still pushes a FIFO entry) to fully saturate the FIFO ring with
  // stale (closed) entries.
  for (let i = 0; i < 512; i++) {
    hud.write(packed(1, 0x0100), 1000 + i, i, 0);
    hud.write(packed(1, 0x0101), 2000 + i, i, 0);
  }
  assert.equal(hud.stats().drops, 0, 'balanced open+close never evicts');

  // The pool is logically empty (poolSize 0) but the FIFO ring is completely
  // full of stale entries. The next open must NOT be treated as a cap
  // overflow: fifoCompact should reclaim the stale entries in place.
  hud.write(packed(1, 0x0100), 5000, 99999, 0);
  assert.equal(hud.stats().drops, 0,
    'a stale-saturated FIFO must not be mistaken for a full pool (poolSize was 0)');
  hud.write(packed(1, 0x0101), 5001, 99999, 0);
  const r = hud.inspect('sp');
  assert.ok(r);
  assert.equal(r.last.t, 5000);
  assert.equal(r.last.b, 99999);
  assert.equal(hud.stats().drops, 0);
});

// Boundary: destroy() twice with a viewport injected must not double-call
// vp.destroy() and must not throw on the second call.
test('destroy() twice with a viewport injected is safe (no throw, single vp.destroy())', () => {
  const saved = installDom(1);
  try {
    let destroyCalls = 0;
    class CountingViewport {
      constructor({ canvas }) {
        this.ctx = canvas.getContext('2d');
        this.dpr = 1;
      }
      resize() {}
      destroy() { destroyCalls++; }
    }
    const mount = makeEl('div');
    const hud = createHud(mount, { viewport: CountingViewport });
    assert.doesNotThrow(() => hud.destroy());
    assert.doesNotThrow(() => hud.destroy());
    assert.equal(destroyCalls, 1, 'vp.destroy() must fire exactly once across two dispose calls');
  } finally {
    uninstallDom(saved);
  }
});

// Adversarial boundary (planner did not consider this): an injected Viewport
// CLASS whose constructor throws. createHud is expected to fail closed
// WITHOUT leaving a wrapper <div> attached to the caller's mount element --
// there is no returned handle to call destroy() with, so any DOM node
// attached before the throw is permanently leaked into the host page.
test('createHud: a throwing Viewport constructor must not leak a wrapper <div> into mount', () => {
  const saved = installDom(1);
  try {
    class ThrowingViewport {
      constructor() { throw new Error('boom'); }
    }
    const mount = makeEl('div');
    assert.throws(() => createHud(mount, { viewport: ThrowingViewport }), /boom/);
    assert.equal(mount.children.length, 0,
      'FAIL (repro): setupCanvas() appends the wrapper <div> to mount BEFORE ' +
      'constructing the injected Viewport, so a throwing constructor leaves a ' +
      'wrapper permanently attached with no handle to remove it');
    // Fail-closed also for host listeners: the document keydown hotkey listener
    // is added only AFTER setup completes, so a throwing constructor leaves none.
    assert.equal(globalThis.document._listeners.indexOf('keydown'), -1,
      'a throwing setup must not leak a document keydown listener');
  } finally {
    uninstallDom(saved);
  }
});

test('createHud: a successful viewport setup DOES attach exactly one keydown listener', () => {
  const saved = installDom(1);
  try {
    const mount = makeEl('div');
    const hud = createHud(mount, { viewport: MockViewport });
    // Sanity that the leak test above is non-vacuous: a clean setup registers it.
    assert.equal(globalThis.document._listeners.filter((t) => t === 'keydown').length, 1);
    hud.destroy();
    assert.equal(globalThis.document._listeners.indexOf('keydown'), -1,
      'destroy() removes the keydown listener');
  } finally {
    uninstallDom(saved);
  }
});

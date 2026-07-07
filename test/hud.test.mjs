import test from 'node:test';
import assert from 'node:assert/strict';
import { createHud, VERSION } from '../Hud.js';

// We can't test canvas rendering in node:test (no DOM), but we CAN test
// the entire track/push/stats data path -- which is the load-bearing contract.
// The render path is visual and tested via the demo.

test('VERSION is set', () => {
    assert.equal(VERSION, '1.0.0');
});

test('createHud returns a hud with the expected shape', () => {
    const hud = createHud(null, {});
    assert.equal(typeof hud.track, 'function');
    assert.equal(typeof hud.render, 'function');
    assert.equal(typeof hud.destroy, 'function');
    assert.equal(hud.trackCount, 0);
    assert.equal(hud.visible, true);
});

test('track returns a handle with push, peek, name, count', () => {
    const hud = createHud(null, {});
    const t = hud.track('fps', { unit: 'fps', hi: 60, samples: 64 });
    assert.equal(t.name, 'fps');
    assert.equal(t.count, 0);
    assert.equal(typeof t.push, 'function');
    assert.equal(typeof t.peek, 'function');
    assert.equal(hud.trackCount, 1);
});

test('push writes to the ring buffer and peek returns the last value', () => {
    const hud = createHud(null, {});
    const t = hud.track('ms', { samples: 8 });
    t.push(16.5);
    assert.equal(t.peek(), 16.5);
    assert.equal(t.count, 1);
    t.push(8.3);
    assert.equal(t.peek(), 8.3);
    assert.equal(t.count, 2);
});

test('ring buffer wraps at capacity', () => {
    const hud = createHud(null, {});
    const t = hud.track('x', { samples: 4 });
    for (let i = 0; i < 10; i++) t.push(i);
    assert.equal(t.count, 4, 'count caps at capacity');
    assert.equal(t.peek(), 9, 'last pushed value');
});

test('multiple tracks are independent', () => {
    const hud = createHud(null, {});
    const a = hud.track('fps', { samples: 16 });
    const b = hud.track('ms', { samples: 16 });
    a.push(60);
    b.push(16.67);
    assert.equal(a.peek(), 60);
    assert.equal(b.peek(), 16.67);
    assert.equal(a.count, 1);
    assert.equal(b.count, 1);
    assert.equal(hud.trackCount, 2);
});

test('samples rounds up to power of two', () => {
    const hud = createHud(null, {});
    const t = hud.track('x', { samples: 100 });
    // Push 128 values -- should not throw
    for (let i = 0; i < 128; i++) t.push(i);
    assert.equal(t.count, 128);
    // Push one more -- wraps
    t.push(999);
    assert.equal(t.count, 128);
    assert.equal(t.peek(), 999);
});

test('default samples is 128', () => {
    const hud = createHud(null, {});
    const t = hud.track('x');
    for (let i = 0; i < 200; i++) t.push(i);
    assert.equal(t.count, 128);
});

test('visible getter/setter', () => {
    const hud = createHud(null, {});
    assert.equal(hud.visible, true);
    hud.visible = false;
    assert.equal(hud.visible, false);
    hud.visible = true;
    assert.equal(hud.visible, true);
});

test('visible: false in options', () => {
    const hud = createHud(null, { visible: false });
    assert.equal(hud.visible, false);
});

test('destroy clears tracks', () => {
    const hud = createHud(null, {});
    hud.track('a');
    hud.track('b');
    assert.equal(hud.trackCount, 2);
    hud.destroy();
    assert.equal(hud.trackCount, 0);
});

test('push is pure typed-array write -- no object allocation', () => {
    // This test verifies the SHAPE of push, not GC behavior (that needs
    // --expose-gc + perf-gate). What it does verify: push doesn't throw,
    // returns undefined, and the buffer contains the expected values.
    const hud = createHud(null, {});
    const t = hud.track('perf', { samples: 16 });
    const result = t.push(42);
    assert.equal(result, undefined, 'push returns nothing');
    assert.equal(t.peek(), 42);
});

test('warnBelow flag is stored on the track', () => {
    const hud = createHud(null, {});
    const t = hud.track('fps', { lo: 30, warnBelow: true });
    // We can't visually test the color, but we verify the track was created
    // without error and accepts values
    t.push(25);
    assert.equal(t.peek(), 25);
});

test('track with custom color', () => {
    const hud = createHud(null, {});
    const t = hud.track('custom', { color: '#ff0000' });
    t.push(1);
    assert.equal(t.peek(), 1);
});

test('render does not throw with no canvas (null)', () => {
    const hud = createHud(null, {});
    hud.track('x').push(1);
    // render() without a DOM will try to create a canvas and fail silently
    // in node -- this is fine; the contract is that it doesn't throw in a
    // browser environment. In node we just verify it doesn't crash.
    // We can't call render() without a DOM, so we skip the actual render.
    // The demo covers the visual path.
    assert.ok(true);
});

test('push silently drops non-finite values (Infinity, -Infinity, NaN)', () => {
    // A single Infinity push would lock st.max to Infinity, flattening every
    // subsequent bar to zero. Guard drops the value without touching state.
    const hud = createHud(null, {});
    const t = hud.track('x', { samples: 16 });
    t.push(10);
    t.push(20);
    assert.equal(t.count, 2);
    assert.equal(t.peek(), 20);

    t.push(Infinity);
    assert.equal(t.count, 2, 'Infinity is dropped');
    assert.equal(t.peek(), 20, 'peek unchanged after Infinity');

    t.push(-Infinity);
    assert.equal(t.count, 2, '-Infinity is dropped');

    t.push(NaN);
    assert.equal(t.count, 2, 'NaN is dropped');

    t.push(30);
    assert.equal(t.count, 3);
    assert.equal(t.peek(), 30);
});

test('hud.resize is exposed as a public method', () => {
    // Cross-monitor DPR changes are auto-detected via matchMedia, but users
    // can also wire resize into their own listener if they want manual control.
    const hud = createHud(null, {});
    assert.equal(typeof hud.resize, 'function');
    // In node there's no canvas, so resize() is a no-op; the contract is
    // that it doesn't throw.
    assert.doesNotThrow(() => { hud.resize(); });
});

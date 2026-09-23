/**
 * @zakkster/lite-hud -- the analytics FRACTIONAL zero-box yardstick.
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/AnalyticsBox.test.mjs
 *
 * The zgcSuite lanes in PerfGate.test.mjs feed SMI-domain inputs (baseline 0
 * scavenges). This file drives FRACTIONAL values -- the realistic case, where a
 * fractional double passed as an argument to a non-inlined function boxes a ~16 B
 * transient nursery HeapNumber. lite-sketch 1.1.0's `addFrom(buf, i)` is the
 * zero-box entry point: the HUD writes the (fractional) value into a per-channel
 * Float64Array in write()'s own frame and the peer reads it UNBOXED, so the
 * analytics write path adds NO box beyond the caller's own baseline (the caller
 * passing fractional t/a into write() -- present with analytics OFF too, and
 * exempt).
 *
 * YARDSTICK: analytics-ON minor-GC scaling == analytics-OFF scaling (delta ~0)
 * under fractional inputs, for paired, complete, and LEVEL. A TEETH control (an
 * injected sketch whose addFrom allocates per op) MUST scale well above the
 * baseline, proving the measurement can see an analytics allocation.
 *
 * Why addFrom matters here (measured on THIS machine, Node 26.8.2, 4 MB
 * semi-space, N=200000 k=8, shipping shape with only add/addFrom differing):
 * `add(qv)` -- passing the unboxed double read from qBuf as an ARGUMENT to the
 * peer -- boxes a fresh fractional HeapNumber per op: paired 6 -> 36,
 * complete 4 -> 36, level 4 -> 36. `addFrom(qBuf, 0)` reads the value unboxed
 * INSIDE the peer: paired/complete/level 3 -> 24, exactly the analytics-OFF
 * baseline (3 -> 24). So on this Node `add(fractionalDouble)` genuinely boxes, and
 * addFrom removes it.
 *
 * TEETH control: a factory whose addFrom allocates a REAL object per op. It is
 * used (over an add()-routing control) because a real allocation is
 * V8-VERSION-INDEPENDENT -- a strength, not because add cannot box. (A
 * factory-wrapper that routes the value through `add(qv)` does NOT reliably box in
 * THIS measure() harness: the wrapper's `addFrom -> d.add` chain is monomorphic
 * and V8 inlines it, keeping qv unboxed -- it read 24, not 36, across 3 runs. The
 * reviewer's 36 came from the box appearing when the SHIPPED HUD calls add(qv)
 * directly. So the second add()-routing teeth lane is deliberately SKIPPED as
 * non-deterministic in this harness; the real-allocation teeth lane below is the
 * deterministic proof the yardstick is non-vacuous.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { measure } from '@zakkster/lite-perf-gate';
import { DDSketch } from '@zakkster/lite-sketch';
import { createHud } from '../../Hud.js';

const OP_LEVEL = 0x0100;
const OP_SPAN = 0x0500;
const OP_OPEN = 0x0600;
const OP_CLOSE = 0x0601;
const packed = (sid, op) => sid * 65536 + op;

function makeScope() {
    return {
        streams() {
            return [
                { id: 1, name: 'lvl', hz: 60, ops: [{ code: OP_LEVEL, name: 'lvl', kind: 0, width: 1, quantiles: true }] },
                { id: 5, name: 'cspan', ops: [{ code: OP_SPAN, name: 'cspan', kind: 2, width: 1, paired: false }] },
                { id: 6, name: 'pspan', ops: [
                    { code: OP_OPEN, name: 'pspan', kind: 2, paired: true },
                    { code: OP_CLOSE, name: 'pspan', kind: 2, paired: true },
                ] },
            ];
        },
        label() { return null; },
        addSink() {}, removeSink() {},
    };
}

const mkAddFrom = () => new DDSketch(0.01);

// TEETH control: a sketch whose addFrom pushes a fresh object per op (a real,
// V8-version-independent allocation). It carries the N1 getters so enableSketch
// accepts it. It MUST make the measurement scale far above the OFF baseline.
const teethSink = [];
const mkTeeth = () => {
    const d = new DDSketch(0.01);
    return {
        addFrom(buf, i) { teethSink.push({ v: buf[i] }); if (teethSink.length > 8192) teethSink.length = 0; return d.addFrom(buf, i); },
        quantile(q) { return d.quantile(q); },
        merge(o) { return d; },
        clear() { return d.clear(); },
        get strict() { return d.strict; },
        get minIndexable() { return d.minIndexable; },
        get maxIndexable() { return d.maxIndexable; },
        get count() { return d.count; },
    };
};

// Distinct fractional value per op (forces per-op boxing on any V8 that boxes).
function scenario(name, factory, kind) {
    return {
        name,
        setup() {
            const hud = factory ? createHud(null, { stats: { quantiles: factory } }) : createHud(null);
            hud.attach(makeScope());
            return { hud, v: 0 };
        },
        hot(s, n) {
            const hud = s.hud;
            let v = s.v;
            for (let i = 0; i < n; i++) {
                v = v + 1;
                const t = v + 0.5;                       // fractional record time
                const x = 1 + (v % 9973) * 0.001;        // distinct fractional value
                if (kind === 'paired') {
                    hud.write(packed(6, OP_OPEN), t, v & 63, 0);
                    hud.write(packed(6, OP_CLOSE), t + x, v & 63, 0); // duration x
                } else if (kind === 'complete') {
                    hud.write(packed(5, OP_SPAN), t, x, 0);
                } else {
                    hud.write(packed(1, OP_LEVEL), t, x, 0);
                }
            }
            s.v = v;
        },
        statsOf() { return {}; },
    };
}

// Delta tolerance: the fractional caller baseline is ~24 scavenges at 8N; a real
// per-op analytics box would roughly double it. TOL cleanly separates "no added
// box" (delta ~0) from "a box" (delta >> 10) while absorbing GC-timing jitter.
const TOL = 10;
const TEETH_MIN = 20;
const OPTS = { N: 200000, k: 8 };

test('analytics fractional write path: ON scaling == OFF scaling (delta ~0)', async () => {
    // Warm up the harness/JIT so the first measured scenario is not inflated.
    await measure(scenario('warmup', mkAddFrom, 'paired'), OPTS);

    for (const kind of ['paired', 'complete', 'level']) {
        const off = await measure(scenario('off ' + kind, null, kind), OPTS);
        const on = await measure(scenario('on ' + kind, mkAddFrom, kind), OPTS);
        const delta = on.minorHi - off.minorHi;
        assert.ok(delta <= TOL,
            kind + ': analytics-ON added ' + delta + ' scavenges over OFF (' +
            off.minorHi + ' -> ' + on.minorHi + '); addFrom must add no box (TOL ' + TOL + ')');
    }
});

test('teeth: an allocating injected sketch DOES scale (the yardstick is non-vacuous)', async () => {
    await measure(scenario('warmup', mkAddFrom, 'complete'), OPTS);
    const off = await measure(scenario('off complete', null, 'complete'), OPTS);
    const teeth = await measure(scenario('teeth complete', mkTeeth, 'complete'), OPTS);
    const delta = teeth.minorHi - off.minorHi;
    assert.ok(delta >= TEETH_MIN,
        'a per-op-allocating injected sketch must scale well above OFF (' +
        off.minorHi + ' -> ' + teeth.minorHi + ', delta ' + delta + ' >= ' + TEETH_MIN + ')');
});

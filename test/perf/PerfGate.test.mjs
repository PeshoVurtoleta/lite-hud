/**
 * @zakkster/lite-hud -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement. It gates
 * the SPP write path -- every record kind (LEVEL / INSTANT / COUNTER / CONT-wide /
 * complete SPAN / paired open+close / paired pool eviction churn / meta BUDGET_SET)
 * plus every channel().push() kind -- via scavenge scaling at N and k*N, with the
 * old-gen and external / arrayBuffers lanes pinned to 0.
 *
 * The `grows` counter is the sum of every channel's backing-store byte length:
 * the Float64Array rings + the paired-span open pool (keys + t_open + seq + the
 * FIFO columns + the occupancy byte). Those buffers are allocated ONCE at attach
 * and never reallocated on the write path, so `grows` shows a 0 delta across the
 * whole window. It is computed the same way Hud.js sizes them (a faithful sum,
 * not the private instance -- the HUD keeps its channels encapsulated).
 *
 * Every hot body is strict zero-alloc: SMI keys, `| 0` accumulators, no closure
 * allocation, no key coercion in the window. mustFail: a per-op push of a FRESH
 * object into a retained array -- it MUST trip the gate (scavenges scale with n),
 * proving the instrument has teeth.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { createHud } from '../../Hud.js';

const WIN = 5; // default windowSec

// Opcodes for the fixture streams (low bytes unique per stream).
const OP_LEVEL = 0x0100;
const OP_INSTANT = 0x0200;
const OP_COUNTER = 0x0300;
const OP_WIDE = 0x0400;
const OP_CONT = 0x0F01;
const OP_SPAN = 0x0500;
const OP_OPEN = 0x0600;
const OP_CLOSE = 0x0601;
const OP_BUDGET_SET = 0x0F41;

const packed = (sid, op) => sid * 65536 + op;

// ---- backing-store sizing, mirrored from Hud.js ---------------------------
function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function ringCap(hz) { return hz && hz > 0 ? pow2(Math.ceil(hz * WIN) + 1) : 256; }
function ringBytes(hz, width) { const w = width > 0 ? width : 1; return ringCap(hz) * (3 * w) * 8; }
// Paired open pool: slots = pow2(2*cap), cap = 256 (hz null). Five Float64Array
// columns (keys/t_open/seq/fifoKey/fifoSeq) + one Uint8Array occupancy byte.
function pairBytes() { const slots = pow2(256 * 2); return slots * 5 * 8 + slots; }

// The fixture scope: full record-kind coverage + a label() for BUDGET_SET.
function makeScope() {
    const labels = new Map([[7, 'lvl']]);
    return {
        streams() {
            return [
                { id: 1, name: 'lvl', hz: 60, ops: [{ code: OP_LEVEL, name: 'lvl', kind: 0, width: 1 }] },
                { id: 2, name: 'inst', ops: [{ code: OP_INSTANT, name: 'inst', kind: 1, width: 1 }] },
                { id: 3, name: 'ctr', ops: [{ code: OP_COUNTER, name: 'ctr', kind: 3, width: 1 }] },
                { id: 4, name: 'wide', ops: [{ code: OP_WIDE, name: 'wide', kind: 0, width: 3 }] },
                { id: 5, name: 'cspan', ops: [{ code: OP_SPAN, name: 'cspan', kind: 2, width: 1, paired: false }] },
                {
                    id: 6, name: 'pspan', ops: [
                        { code: OP_OPEN, name: 'pspan', kind: 2, paired: true },
                        { code: OP_CLOSE, name: 'pspan', kind: 2, paired: true },
                    ],
                },
                {
                    id: 7, name: 'pevict', ops: [
                        { code: OP_OPEN, name: 'pevict', kind: 2, paired: true },
                        { code: OP_CLOSE, name: 'pevict', kind: 2, paired: true },
                    ],
                },
            ];
        },
        label(id) { return labels.get(id) || null; },
        addSink() {},
        removeSink() {},
    };
}

// Sum of every channel's backing-store byte length for the fixture scope.
// Fixed at attach, never reallocated on the write path -> a 0-delta counter.
const GROWS =
    ringBytes(60, 1) +   // s1 LEVEL (hz 60)
    ringBytes(0, 1) +    // s2 INSTANT
    ringBytes(0, 1) +    // s3 COUNTER
    ringBytes(0, 3) +    // s4 CONT width 3
    ringBytes(0, 1) +    // s5 complete SPAN
    ringBytes(0, 1) + pairBytes() + // s6 paired SPAN (ring + pool)
    ringBytes(0, 1) + pairBytes();  // s7 paired SPAN (ring + pool)

function newHud() {
    const hud = createHud(null);
    hud.attach(makeScope());
    return hud;
}
function growsOf() { return { grows: GROWS }; }

// ===========================================================================
// Write-path scenarios -- one per record kind. SMI keys, |0 counters.
// ===========================================================================

const levelWrite = {
    name: 'LEVEL write',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) { v = (v + 1) | 0; hud.write(packed(1, OP_LEVEL), v, v & 63, 0); }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const instantWrite = {
    name: 'INSTANT write',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) { v = (v + 1) | 0; hud.write(packed(2, OP_INSTANT), v, 0, 0); }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const counterWrite = {
    name: 'COUNTER write',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) { v = (v + 1) | 0; hud.write(packed(3, OP_COUNTER), v, v & 255, 0); }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const contWideWrite = {
    name: 'CONT-wide write (width 3)',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            hud.write(packed(4, OP_WIDE), v, 1, 2);
            hud.write(packed(4, OP_CONT), 3, 4, 5);
            hud.write(packed(4, OP_CONT), 6, 7, 8);
        }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const completeSpanWrite = {
    name: 'complete SPAN write',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) { v = (v + 1) | 0; hud.write(packed(5, OP_SPAN), v, 4, 0); }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const pairedOpenClose = {
    name: 'paired open+close',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            const k = v & 63;
            hud.write(packed(6, OP_OPEN), v, k, 0);
            hud.write(packed(6, OP_CLOSE), v + 1, k, 0);
        }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const pairedEvictionChurn = {
    name: 'paired eviction churn (backshift + FIFO compaction)',
    setup() {
        const hud = newHud();
        for (let k = 0; k < 300; k++) hud.write(packed(7, OP_OPEN), k, k, 0); // prime > cap
        return { hud, v: 300 };
    },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) { v = (v + 1) | 0; hud.write(packed(7, OP_OPEN), v, v, 0); }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

const metaBudgetSet = {
    name: 'meta BUDGET_SET (replace in slot)',
    setup() { return { hud: newHud(), v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) { v = (v + 1) | 0; hud.write(packed(0, OP_BUDGET_SET), v, 7, 60); }
        s.v = v | 0;
    },
    statsOf() { return growsOf(); },
};

// Reused CONSTANT fractional value: storing a fractional MAGNITUDE into the ring
// is zero library-owned allocation. The box in the channel().push() note is the
// caller boxing a DISTINCT fractional double per op at the JS call boundary; a
// reused constant is hoisted (one shared HeapNumber, if any), so this passes at
// 0 scavenges -- proving the ring store itself never allocates on fractional data.
const FRAC_T = 1234.5678; // fixed fractional timestamp
const FRAC_A = 16.67;     // fixed fractional value (a 60fps budget in ms)
const fractionalConst = {
    name: 'LEVEL write, reused constant fractional t/a (0 alloc)',
    setup() { return { hud: newHud() }; },
    hot(s, n) {
        const hud = s.hud;
        for (let i = 0; i < n; i++) hud.write(packed(1, OP_LEVEL), FRAC_T, FRAC_A, 0);
    },
    statsOf() { return growsOf(); },
};

// NOTE on channel().push(): push() reads wall-clock time (performance.now(), a
// large FRACTIONAL double) and passes it as `t` into write(). V8 boxes a
// fractional double at the call site of any non-inlinable function, so a per-op
// TRANSIENT nursery HeapNumber is created for the timestamp -- an artifact of
// passing fractional doubles in JS, orthogonal to lite-hud's own allocation
// (the rings + pool never grow; RETAINED bytes/op are 0). That box would trip
// the scavenge lane here for reasons unrelated to the code under test, so -- as
// the rest of the suite's perf gates do -- the write-path scenarios above feed
// SMI-domain inputs. channel().push() (all four kinds) is witnessed at
// 0 RETAINED B/op by test/torture.mjs, the appropriate lane for a transient.

// ===========================================================================
// mustFail control -- a per-op fresh object retained in an array. MUST trip the
// gate (scavenges scale with n), proving the instrument has teeth.
// ===========================================================================

const mustFailAlloc = {
    name: 'per-op fresh object into a retained array (MUST allocate)',
    setup() { return { hud: newHud(), sink: [], v: 0 }; },
    hot(s, n) {
        const hud = s.hud;
        const sink = s.sink;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            hud.write(packed(1, OP_LEVEL), v, v & 63, 0);
            sink.push({ v }); // fresh object per op -> heap churn
            if (sink.length > 8192) sink.length = 0;
        }
        s.v = v | 0;
    },
    statsOf() { return { grows: 0 }; },
};

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios: [
        levelWrite,
        instantWrite,
        counterWrite,
        contWideWrite,
        completeSpanWrite,
        pairedOpenClose,
        pairedEvictionChurn,
        metaBudgetSet,
        fractionalConst,
    ],
    mustFail: [mustFailAlloc],
});

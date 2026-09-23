// @zakkster/lite-hud 2.2.0
// SPP-native zero-GC canvas overlay. Channels from scope registry, trigger
// cursors from gate verdicts and budget lines, legend with per-channel
// visibility toggle. Drop-in stats.js replacement via hud.channel().
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '2.2.0';

// ---------------------------------------------------------------------------
// SPP v1 protocol constants -- inlined, never imported
// ---------------------------------------------------------------------------

const META_STREAM = 0;
const OP_CONT = 0x0F01;
const OP_EPOCH = 0x0F00;
const OP_VERDICT = 0x0F40;
const OP_BUDGET_SET = 0x0F41;

const KIND_LEVEL = 0;
const KIND_INSTANT = 1;
const KIND_SPAN = 2;
const KIND_COUNTER = 3;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function pow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function nowMs() {
    return (typeof performance !== 'undefined') ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// Paired-span open pool -- inline integer-keyed open-addressing map.
// Design-parity with the CuckooMap idiom (no dep). Replaces the JS Map that
// allocated an entry per open + an iterator per eviction on the WRITE path.
// Float64Array correlId keys + t_open, Uint8Array occupancy (id 0 legal),
// linear probe + backshift delete, slots = pow2 >= 2*cap (load <= 0.5), and a
// Float64Array FIFO (key + seq) for O(1) oldest-first eviction with lazy skip
// of closed/reinserted entries. All functions are module-scope (0-alloc, no
// closure captured per op); the arrays are allocated once at attach (cold).
// ---------------------------------------------------------------------------

// Scratch view: hash the lo/hi 32-bit lanes of an f64 key (allocated once).
const _keyF64 = new Float64Array(1);
const _keyU32 = new Uint32Array(_keyF64.buffer);

function hashKey(k) {
    _keyF64[0] = k;
    let h = (_keyU32[0] ^ _keyU32[1]) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

function initPairedPool(ch) {
    const slots = pow2(ch.cap * 2);
    ch.poolSlots = slots;
    ch.poolMask = slots - 1;
    ch.poolKeys = new Float64Array(slots);
    ch.poolTOpen = new Float64Array(slots);
    ch.poolOcc = new Uint8Array(slots);
    ch.poolSeq = new Float64Array(slots);
    ch.poolSize = 0;
    ch.poolNextSeq = 1;
    ch.fifoCap = slots;
    ch.fifoMask = slots - 1;
    ch.fifoKey = new Float64Array(slots);
    ch.fifoSeq = new Float64Array(slots);
    ch.fifoHead = 0;
    ch.fifoCount = 0;
}

// Exact-compare probe. Returns the slot index or -1.
function poolFind(ch, k) {
    const mask = ch.poolMask, occ = ch.poolOcc, keys = ch.poolKeys;
    let i = hashKey(k) & mask;
    while (occ[i]) {
        if (keys[i] === k) return i;
        i = (i + 1) & mask;
    }
    return -1;
}

// Insert a NEW key (caller guarantees k is absent and poolSize < cap).
function poolInsert(ch, k, t) {
    const mask = ch.poolMask, occ = ch.poolOcc;
    let i = hashKey(k) & mask;
    while (occ[i]) i = (i + 1) & mask;
    ch.poolKeys[i] = k;
    ch.poolTOpen[i] = t;
    occ[i] = 1;
    const seq = ch.poolNextSeq;
    ch.poolNextSeq = seq + 1;
    ch.poolSeq[i] = seq;
    ch.poolSize++;
    fifoPush(ch, k, seq);
}

// Backshift delete (Knuth Algorithm R) -- keeps probe chains contiguous.
function poolDelete(ch, i) {
    const mask = ch.poolMask;
    const keys = ch.poolKeys, occ = ch.poolOcc, tOpen = ch.poolTOpen, pseq = ch.poolSeq;
    let j = i;
    while (true) {
        occ[i] = 0;
        while (true) {
            j = (j + 1) & mask;
            if (!occ[j]) { ch.poolSize--; return; }
            const home = hashKey(keys[j]) & mask;
            // Keep scanning while the entry at j must stay (its home is cyclically
            // in (i, j]); break to move it into the hole at i otherwise.
            const inGap = (i <= j) ? (i < home && home <= j) : (i < home || home <= j);
            if (!inGap) break;
        }
        keys[i] = keys[j];
        tOpen[i] = tOpen[j];
        pseq[i] = pseq[j];
        occ[i] = 1;
        i = j;
    }
}

function fifoPush(ch, k, seq) {
    if (ch.fifoCount === ch.fifoCap) fifoCompact(ch);
    const p = (ch.fifoHead + ch.fifoCount) & ch.fifoMask;
    ch.fifoKey[p] = k;
    ch.fifoSeq[p] = seq;
    ch.fifoCount++;
}

// In-place ring compaction: drop FIFO entries whose (key, seq) no longer matches
// a live pool slot. Only fires when the ring is full; slots >= 2*cap guarantees
// at least cap stale entries to reclaim, so it stays bounded + amortized O(1)
// and allocates nothing. Writes trail reads (w <= r), so no unread slot is
// clobbered.
function fifoCompact(ch) {
    const mask = ch.fifoMask, head = ch.fifoHead, count = ch.fifoCount;
    const fk = ch.fifoKey, fs = ch.fifoSeq;
    let w = 0;
    for (let r = 0; r < count; r++) {
        const rp = (head + r) & mask;
        const k = fk[rp];
        const sq = fs[rp];
        const slot = poolFind(ch, k);
        if (slot >= 0 && ch.poolSeq[slot] === sq) {
            const wp = (head + w) & mask;
            fk[wp] = k;
            fs[wp] = sq;
            w++;
        }
    }
    ch.fifoCount = w;
}

// Evict the oldest still-open entry (FIFO order, lazily skipping stale entries).
// Same observable behavior as today's Map.keys().next(). Returns true on evict.
function poolEvictOldest(ch) {
    const mask = ch.fifoMask;
    while (ch.fifoCount > 0) {
        const hp = ch.fifoHead;
        const k = ch.fifoKey[hp];
        const sq = ch.fifoSeq[hp];
        ch.fifoHead = (ch.fifoHead + 1) & mask;
        ch.fifoCount--;
        const slot = poolFind(ch, k);
        if (slot >= 0 && ch.poolSeq[slot] === sq) {
            poolDelete(ch, slot);
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// DDSketch quantile analytics (M2) -- optional PEER via dependency injection.
// The HUD never imports lite-sketch; a consumer injects a `() => DDSketch`
// factory (createHud stats.quantiles, or a per-channel hud.channel override).
// On the hot path the HUD pre-validates the value (peer no-throw law: reject
// exactly what DDSketch.add would reject) and calls add() -- 0 B/op; on render
// (cold) it merges the two window sketches into a scratch and reads quantile().
// ---------------------------------------------------------------------------

const HUD_PREFIX = '@zakkster/lite-hud: ';

// Cold: wire a channel for quantile analytics. The factory must return a
// DDSketch-like sketch exposing the ZERO-BOX `addFrom(buf, i)` entry point (the
// HUD's hot path never uses `add(value)` -- a fractional argument boxes) plus the
// N1 getters (`strict`, `minIndexable`, `maxIndexable`). Fail closed on a missing
// method, a strict-range sketch, or non-finite indexable bounds (null is not
// zero). Allocates the A/B rotating window pair, the render scratch, and the
// length-1 value buffer -- ALL allocation is here (attach/channel time); the write
// path never allocates.
function enableSketch(ch, factory, halfMs) {
    const s = factory();
    if (!s || typeof s.addFrom !== 'function' || typeof s.quantile !== 'function' ||
        typeof s.merge !== 'function' || typeof s.clear !== 'function') {
        throw new Error(HUD_PREFIX + 'stats.quantiles factory must return a ' +
            'DDSketch-like sketch with addFrom/quantile/merge/clear, got ' +
            (s === null ? 'null' : typeof s));
    }
    // Require an EXPLICIT non-strict sketch: a strict fixed-range sketch throws on
    // out-of-range values, and a missing/undefined `strict` getter is an unverified
    // state -- both fail closed (the HUD needs a collapsing sketch that folds
    // out-of-range values instead of throwing).
    if (s.strict !== false) {
        throw new Error(HUD_PREFIX + 'stats.quantiles factory must return a ' +
            'non-strict (collapsing) DDSketch with strict === false; got strict === ' +
            String(s.strict) + ' (a strict-range sketch throws on out-of-range values; ' +
            'drop the `range` option).');
    }
    // Indexable bounds drive the hot-path pre-check. Fail closed if the getters
    // are missing or non-finite (an unverified bound is not a usable bound).
    const lo = s.minIndexable, hi = s.maxIndexable;
    if (typeof lo !== 'number' || typeof hi !== 'number' || lo !== lo || hi !== hi ||
        lo === Infinity || lo === -Infinity || hi === Infinity || hi === -Infinity ||
        !(lo < hi)) {
        throw new Error(HUD_PREFIX + 'stats.quantiles factory sketch has invalid ' +
            'indexable bounds (minIndexable/maxIndexable must be finite with ' +
            'min < max), got ' + String(lo) + ' .. ' + String(hi));
    }
    ch.lo = lo;                 // EXCLUSIVE low floor: add accepts lo < v <= hi
    ch.hi = hi;                 // INCLUSIVE high ceiling
    ch.qA = s;                  // reuse the validated instance as window sketch A
    ch.qB = factory();
    ch.qScratch = factory();
    ch.qBuf = new Float64Array(1);
    ch.q = ch.qA;
    ch.qHalf = halfMs;
    ch.qRotAt = 0;
}

// Window rotation by record time (fires at most once per windowSec/2, not per
// record): retire the stale (inactive) sketch, clear it, make it active. A gap
// wider than one half clears BOTH so no stale mass survives. clear() is 0-alloc.
function qRotate(ch, t) {
    let other = ch.q === ch.qA ? ch.qB : ch.qA;
    other.clear();
    ch.q = other;
    ch.qRotAt += ch.qHalf;
    if (t >= ch.qRotAt) {
        other = ch.q === ch.qA ? ch.qB : ch.qA;
        other.clear();
        ch.q = other;
        ch.qRotAt = t + ch.qHalf;
    }
}

// NOTE: the hot analytics step is INLINED at the two write() call sites (the
// paired-close arm and the width=1 tail) rather than a helper, so neither the
// fractional value nor the record time `t` ever crosses an extra JS call boundary
// as an argument (which V8 boxes when the call is not inlined). The value is
// written into ch.qBuf in write()'s own frame and read back UNBOXED; the peer is
// fed through the zero-box addFrom(buf, 0). Only qRotate (cold, fires at most once
// per windowSec/2) takes `t` as an argument, and its rare box is amortized to ~0.
// The pre-check rejects exactly what addFrom rejects (NaN / negative / +-Infinity,
// and v>0 outside the accepted band `lo < v <= hi`); v === 0 is legal (-0 -> 0).

// Cold: compact quantile tile formatter (render only, never a hot path).
function qFmt(v) {
    if (v !== v) return '--';
    if (v === 0) return '0';
    const a = v < 0 ? -v : v;
    if (a >= 1000) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    if (a >= 0.001) return v.toFixed(3);
    return v.toExponential(1);
}

// ---------------------------------------------------------------------------
// Ring helpers -- hot path, zero-alloc
// ---------------------------------------------------------------------------

// Ring capacity: sized to cover windowSec at the channel's declared hz,
// or 256 records for non-LEVEL kinds.
function ringCap(hz, winSec) {
    return hz && hz > 0 ? pow2(Math.ceil(hz * winSec) + 1) : 256;
}

// Channel ring stores 3*width f64 slots per record: [t, a, b] for width=1,
// [t, a, b, c0, c1, c2] for width=2, plus [d0, d1, d2] for width=3.
// Capacity is power-of-2; head advances in record units and wraps via mask.
function makeChannel(idx, sid, name, unit, hz, kind, width, winSec) {
    const w = width > 0 ? width : 1;
    const stride = 3 * w;
    const cap = ringCap(hz, winSec);
    return {
        idx,
        sid,
        name,
        unit: unit || '',
        hz: hz || null,
        kind: kind !== undefined ? kind : KIND_LEVEL,
        width: w,
        stride,
        ring: new Float64Array(cap * stride),
        cap,
        mask: cap - 1,
        head: 0,
        count: 0,
        visible: true,
        // Paired span: open op and close op route to the same channel. The
        // inline open pool (below) holds (correlId -> t_open) until close
        // arrives. Allocated at attach (cold) via initPairedPool.
        paired: false,
        openOpLow: -1,
        closeOpLow: -1,
        poolSlots: 0,
        poolMask: 0,
        poolKeys: null,
        poolTOpen: null,
        poolOcc: null,
        poolSeq: null,
        poolSize: 0,
        poolNextSeq: 1,
        fifoCap: 0,
        fifoMask: 0,
        fifoKey: null,
        fifoSeq: null,
        fifoHead: 0,
        fifoCount: 0,
        // DI budget threshold lines (cold, at attach): [{threshold, label}]
        budgets: [],
        // Meta BUDGET_SET slot: preallocated; a repeat for this channel REPLACES
        // the threshold (never appends -> no per-record object, no retention).
        metaBudgetActive: false,
        metaBudgetThreshold: 0,
        metaBudgetLabel: '',
        // DDSketch quantile analytics (M2). Set by enableSketch (cold) when a
        // factory is injected -- for a SPAN channel (always) or an opted-in
        // LEVEL channel; null on every other channel (monomorphic shape, so the
        // hot `ch.q !== null` gate is a stable shape check). qAdd (hot) reads
        // q/lo/hi/qRotAt; render + inspect (cold) merge qA+qB into qScratch.
        q: null,
        qA: null,
        qB: null,
        qScratch: null,
        qBuf: null,
        qHalf: 0,
        qRotAt: 0,
        qDrops: 0,
        lo: 0,
        hi: 0,
        // Precomputed hit zones for legend click detection (set in render)
        hitY0: 0,
        hitY1: 0,
    };
}

// Write a width=1 record directly to the ring.
function ringWrite(ch, t, a, b) {
    const base = (ch.head * ch.stride) | 0;
    ch.ring[base] = t;
    ch.ring[base + 1] = a;
    ch.ring[base + 2] = b;
    ch.head = (ch.head + 1) & ch.mask;
    ch.count++;
}

// Flush a completed CONT sequence from the pending slots buffer.
function ringWriteWide(ch, slots) {
    const base = (ch.head * ch.stride) | 0;
    const end = ch.stride < slots.length ? ch.stride : slots.length;
    for (let i = 0; i < end; i++) ch.ring[base + i] = slots[i];
    ch.head = (ch.head + 1) & ch.mask;
    ch.count++;
}

// Cold-path read for inspect() and render(). Returns a plain Array copy.
function ringRead(ch, pos) {
    const total = ch.count < ch.cap ? ch.count : ch.cap;
    const tail = ch.count >= ch.cap ? ch.head : 0;
    const physIdx = (tail + pos) & ch.mask;
    const base = physIdx * ch.stride;
    const out = new Array(ch.stride);
    for (let i = 0; i < ch.stride; i++) out[i] = ch.ring[base + i];
    return out;
}

function ringLen(ch) {
    return ch.count < ch.cap ? ch.count : ch.cap;
}

// ---------------------------------------------------------------------------
// Render constants
// ---------------------------------------------------------------------------

const C_BG = '#060e06';
const C_GRID = '#0d1a0d';
const C_TRACE = '#39ff14';
const C_GLOW = 'rgba(57,255,20,0.15)';
const C_SPAN = 'rgba(57,255,20,0.25)';
const C_SPAN_OPE = 'rgba(57,255,20,0.10)';
const C_BUDGET = 'rgba(255,170,0,0.65)';
const C_TEXT = '#8fcc8f';
const C_DIM = '#3d6e3d';
const C_INACTIVE = '#141e14';
const C_VPASS = '#39ff14';
const C_VFAIL = '#ff3939';
const C_VRECAP = '#ffaa00';

const HUD_W = 290;
const ROW_H = 48;
const PAD = 8;
const LBL_W = 72;
const VCAP = 64;

// ---------------------------------------------------------------------------
// createHud
// ---------------------------------------------------------------------------

export function createHud(mountEl, opts) {
    const o = opts || {};
    const winSec = o.windowSec || 5;
    const hotkey = o.hotkey !== undefined ? o.hotkey : '`';
    const pos = o.position || 'top-right';
    const zIdx = o.zIndex || 9999;

    // -- Fail-closed option validation (before any DOM work) --------------------
    // viewport: a Viewport CLASS (the HUD creates the canvas), not an instance.
    const viewportClass = o.viewport;
    if (viewportClass !== undefined && typeof viewportClass !== 'function') {
        throw new Error(
            '@zakkster/lite-hud: viewport must be a Viewport class (a constructor ' +
            'function), got ' + typeof viewportClass);
    }
    // maxDpr: a finite number >= 1, or Infinity (no cap). NaN / < 1 fail closed.
    const _maxDpr = o.maxDpr === undefined ? Infinity : o.maxDpr;
    if (!(_maxDpr === Infinity ||
          (typeof _maxDpr === 'number' && Number.isFinite(_maxDpr) && _maxDpr >= 1))) {
        throw new Error(
            '@zakkster/lite-hud: maxDpr must be a finite number >= 1 or Infinity, got ' +
            String(o.maxDpr));
    }
    // stats: an optional analytics-factory bag (M2 uses stats.quantiles, a
    // `() => DDSketch` factory). Validated typeof-first, fail closed. The HUD
    // never imports lite-sketch; it only calls the injected instance's methods.
    const _stats = o.stats;
    if (_stats !== undefined && (_stats === null || typeof _stats !== 'object')) {
        throw new Error(HUD_PREFIX + 'stats must be an object, got ' +
            (_stats === null ? 'null' : typeof _stats));
    }
    const _qFactory = (_stats && _stats.quantiles !== undefined) ? _stats.quantiles : null;
    if (_qFactory !== null && typeof _qFactory !== 'function') {
        throw new Error(HUD_PREFIX + 'stats.quantiles must be a () => DDSketch ' +
            'factory function, got ' + typeof _qFactory);
    }
    const _qHalfMs = winSec * 1000 / 2;

    // -- State ------------------------------------------------------------------
    const channels = [];
    // lut: sparse Array[sid] -> Array[opLow] -> { chIdx, role }
    const lut = [];
    // pendingCont: sparse Array[sid] -> { chIdx, expected, count, slots }
    const pendingCont = [];
    // Meta state
    let epoch = null;
    let sppVersion = null;
    // Verdict ring: stride=3 [t, result, budgetInternId]
    const verdictRing = new Float64Array(VCAP * 3);
    let verdictHead = 0;
    let verdictCount = 0;
    // Scope reference (for label lookup on BUDGET_SET)
    let _scope = null;
    // Stable sink reference for addSink / removeSink
    let _self = null;
    // Drop counter
    let drops = 0;
    // Synthetic stream id counter: start above realistic scope stream range
    let synthId = 0x8000;
    // Overlay visibility
    let _visible = true;
    // Canvas refs
    let canvas = null;
    // Closure-held 2D context. render() takes a per-frame LOCAL snapshot of this
    // (`const ctx = _ctx`) before drawing, so a reentrant destroy() invoked from
    // inside a draw call (which nulls _ctx mid-frame) lets the current frame finish
    // harmlessly on the detached context instead of throwing on a null.
    let _ctx = null;
    let dpr = 1;
    // Injected viewport instance + its HUD-owned wrapper div (peer render path)
    let vp = null;
    let wrapper = null;

    // -- LUT helpers ------------------------------------------------------------

    function registerOp(sid, opLow, chIdx, role) {
        if (!lut[sid]) lut[sid] = [];
        const low = opLow & 0xFF;
        if (lut[sid][low] !== undefined) {
            throw new Error(
                '@zakkster/lite-hud: opcode low-byte collision on stream ' +
                sid + ' at 0x' + low.toString(16).padStart(2, '0') +
                ' -- SPP requires opcode low bytes to be unique per stream.'
            );
        }
        lut[sid][low] = {chIdx, role: role || 'only'};
    }

    // needSlots = 3 * maxWidth across the stream's CONT-chained ops.
    // Grows the buffer if a later op on the same stream needs more slots.
    function allocPending(sid, needSlots) {
        const cur = pendingCont[sid];
        if (!cur) {
            pendingCont[sid] = {
                chIdx: -1, expected: 0, count: 0,
                slots: new Float64Array(needSlots),
            };
        } else if (cur.slots.length < needSlots) {
            cur.slots = new Float64Array(needSlots);
        }
    }

    // -- write() -- hot path, SPP sink ------------------------------------------

    function write(packed, t, a, b) {
        // Decode: both streamId and opcode are u16, fit exactly in f64.
        // Using arithmetic to avoid signed-Int32 traps from bitwise ops.
        const sid = (packed / 65536) | 0;
        const op = (packed - sid * 65536) | 0;

        // CONT rides probe stream ids (never meta stream, never a channel op)
        if (op === OP_CONT) {
            const pc = pendingCont[sid];
            if (!pc || pc.count === 0) {
                drops++;
                return;
            }
            const off = pc.count * 3;
            pc.slots[off] = t;
            pc.slots[off + 1] = a;
            pc.slots[off + 2] = b;
            pc.count++;
            if (pc.count === pc.expected) {
                const ch = channels[pc.chIdx];
                if (ch) ringWriteWide(ch, pc.slots);
                pc.count = 0;
            }
            return;
        }

        // Meta stream -- handled on a cold helper, off the hot body.
        if (sid === META_STREAM) {
            metaWrite(op, t, a, b);
            return;
        }

        // Route to channel via LUT
        const streamEntry = lut[sid];
        if (!streamEntry) {
            drops++;
            return;
        }
        const opLow = op & 0xFF;
        const entry = streamEntry[opLow];
        if (!entry) {
            drops++;
            return;
        }

        const ch = channels[entry.chIdx];
        if (!ch) {
            drops++;
            return;
        }

        // Paired span -- inline open-addressing pool, zero-alloc open/close.
        if (ch.paired) {
            if (entry.role === 'open') {
                let k = a;
                if (k !== k) { drops++; return; }   // NaN correlId on open -> drop
                if (k === 0) k = 0;                  // normalize -0 to +0
                // Bound growth: evict oldest still-open entry, count as a drop
                // (matches today's Map.keys().next() eviction on a full pool).
                if (ch.poolSize >= ch.cap) { poolEvictOldest(ch); drops++; }
                const slot = poolFind(ch, k);
                if (slot >= 0) {
                    ch.poolTOpen[slot] = t; // re-open: overwrite t_open, position kept
                } else {
                    poolInsert(ch, k, t);
                }
            } else if (entry.role === 'close') {
                let k = a;
                if (k === 0) k = 0;                  // normalize -0 to +0
                const slot = poolFind(ch, k);
                if (slot >= 0) {
                    const tOpen = ch.poolTOpen[slot];
                    poolDelete(ch, slot);
                    ringWrite(ch, tOpen, t, k); // [t_open, t_close, correlId]
                    // Inlined analytics: store the (fractional) duration into the
                    // channel scratch in THIS frame (no argument box), read it back
                    // unboxed, pre-check, then feed the peer via zero-box addFrom.
                    if (ch.q !== null) {
                        const buf = ch.qBuf;
                        buf[0] = t - tOpen;
                        const qv = buf[0];
                        if (qv !== qv || qv < 0 || qv === Infinity ||
                            (qv > 0 && (qv <= ch.lo || qv > ch.hi))) {
                            ch.qDrops++;
                        } else {
                            if (t >= ch.qRotAt) qRotate(ch, t);
                            ch.q.addFrom(buf, 0);
                        }
                    }
                }
                // close without matching open: silently skip (open may have been evicted)
            }
            return;
        }

        // CONT-chained primary record
        if (ch.width > 1) {
            const pc = pendingCont[sid];
            if (!pc) {
                drops++;
                return;
            }
            pc.chIdx = entry.chIdx;
            pc.expected = ch.width;
            pc.slots[0] = t;
            pc.slots[1] = a;
            pc.slots[2] = b;
            pc.count = 1;
            return;
        }

        // Standard width=1 record
        ringWrite(ch, t, a, b);
        // Inlined analytics: complete SPAN duration (a) always, or an opted-in
        // LEVEL value (a). INSTANT / COUNTER keep ch.q === null (no-op). `a` is the
        // write() argument; store it into the scratch in this frame and feed the
        // peer via zero-box addFrom (no extra argument box).
        if (ch.q !== null) {
            const buf = ch.qBuf;
            buf[0] = a;
            const qv = buf[0];
            if (qv !== qv || qv < 0 || qv === Infinity ||
                (qv > 0 && (qv <= ch.lo || qv > ch.hi))) {
                ch.qDrops++;
            } else {
                if (t >= ch.qRotAt) qRotate(ch, t);
                ch.q.addFrom(buf, 0);
            }
        }
    }

    // -- metaWrite() -- cold meta-stream handler, off the write() hot body -------

    function metaWrite(op, t, a, b) {
        if (op === OP_EPOCH) {
            epoch = t;
            sppVersion = a;
        } else if (op === OP_VERDICT) {
            const vb = (verdictHead * 3) | 0;
            verdictRing[vb] = t;
            verdictRing[vb + 1] = b; // 0 pass / 1 fail / 3 recapture
            verdictRing[vb + 2] = a; // interned budget id
            verdictHead = (verdictHead + 1) & (VCAP - 1);
            verdictCount++;
        } else if (op === OP_BUDGET_SET) {
            // a = interned channel name id, b = threshold value. A repeat for a
            // channel REPLACES its meta budget in a preallocated slot -- no object
            // is allocated per record, no unbounded append.
            if (_scope) {
                const lbl = _scope.label(a | 0);
                if (lbl) {
                    for (let ci = 0; ci < channels.length; ci++) {
                        if (channels[ci].name === lbl) {
                            channels[ci].metaBudgetActive = true;
                            channels[ci].metaBudgetThreshold = b;
                            channels[ci].metaBudgetLabel = lbl;
                            break;
                        }
                    }
                }
            }
        }
    }

    // -- attach() ---------------------------------------------------------------

    function attach(scope, attachOpts) {
        _scope = scope;
        const ao = attachOpts || {};

        const streams = scope.streams();
        for (let si = 0; si < streams.length; si++) {
            const sd = streams[si];
            if (!sd || !Array.isArray(sd.ops)) continue;

            // Collect ops by type
            const pairedOps = [];
            const singleOps = [];
            for (let oi = 0; oi < sd.ops.length; oi++) {
                const op = sd.ops[oi];
                if (op.paired && op.kind === KIND_SPAN) pairedOps.push(op);
                else singleOps.push(op);
            }

            // One channel per single op
            for (let oi = 0; oi < singleOps.length; oi++) {
                const op = singleOps[oi];
                const hz = op.kind === KIND_LEVEL ? (sd.hz || null) : null;
                const w = op.width > 1 ? op.width : 1;
                const ch = makeChannel(
                    channels.length, sd.id,
                    op.name || sd.name || ('s' + sd.id + 'op' + oi),
                    sd.unit, hz, op.kind, w, winSec
                );
                channels.push(ch);
                registerOp(sd.id, op.code & 0xFF, ch.idx, 'only');
                if (w > 1) allocPending(sd.id, 3 * w);
                // Quantile analytics (cold): a complete SPAN is sketched whenever
                // a factory is injected; a LEVEL channel only when the op opts in
                // (op.quantiles: true -> the default factory, or its own factory).
                if (op.kind === KIND_SPAN && _qFactory) {
                    enableSketch(ch, _qFactory, _qHalfMs);
                } else if (op.kind === KIND_LEVEL && op.quantiles) {
                    const f = typeof op.quantiles === 'function' ? op.quantiles : _qFactory;
                    if (f) enableSketch(ch, f, _qHalfMs);
                }
            }

            // Paired SPAN: consecutive pairs (protocol ordering: open first, close second)
            for (let pi = 0; pi + 1 < pairedOps.length; pi += 2) {
                const openOp = pairedOps[pi];
                const closeOp = pairedOps[pi + 1];
                const ch = makeChannel(
                    channels.length, sd.id,
                    openOp.name || sd.name || ('s' + sd.id + 'span'),
                    sd.unit, null, KIND_SPAN, 1, winSec
                );
                ch.paired = true;
                ch.openOpLow = openOp.code & 0xFF;
                ch.closeOpLow = closeOp.code & 0xFF;
                initPairedPool(ch);
                channels.push(ch);
                registerOp(sd.id, ch.openOpLow, ch.idx, 'open');
                registerOp(sd.id, ch.closeOpLow, ch.idx, 'close');
                // Paired SPAN durations are sketched whenever a factory is injected.
                if (_qFactory) enableSketch(ch, _qFactory, _qHalfMs);
            }
        }

        // DI budgets: attach by channel name
        if (Array.isArray(ao.budgets)) {
            for (let bi = 0; bi < ao.budgets.length; bi++) {
                const bd = ao.budgets[bi];
                for (let ci = 0; ci < channels.length; ci++) {
                    if (channels[ci].name === bd.channel) {
                        channels[ci].budgets.push({
                            threshold: bd.threshold,
                            label: bd.label || bd.channel,
                        });
                        break;
                    }
                }
            }
        }

        if (typeof scope.addSink === 'function') scope.addSink(_self);
    }

    // -- channel() -- manual channel, D4 polyfill -------------------------------

    function channel(desc) {
        const kind = desc.kind !== undefined ? desc.kind : KIND_LEVEL;
        // Per-channel quantile override: a `() => DDSketch` factory (opt IN; LEVEL
        // or SPAN), or false (opt OUT). Undefined inherits the createHud default,
        // which auto-enables SPAN only -- LEVEL analytics are always opt-in.
        const qOverride = desc.quantiles;
        if (qOverride !== undefined && qOverride !== false &&
            typeof qOverride !== 'function') {
            throw new Error(HUD_PREFIX + 'channel quantiles must be a factory ' +
                'function or false, got ' + typeof qOverride);
        }
        const sid = synthId++;
        const opLow = 0x00;
        const ch = makeChannel(
            channels.length, sid,
            desc.name || ('ch' + channels.length),
            desc.unit, desc.hz, kind, 1, winSec
        );
        channels.push(ch);
        if (!lut[sid]) lut[sid] = [];
        lut[sid][opLow] = {chIdx: ch.idx, role: 'only'};

        // Resolve + enable analytics (cold). An explicit factory works on SPAN or
        // LEVEL; a factory on INSTANT / COUNTER is a misuse -> fail closed.
        let fac = null;
        if (typeof qOverride === 'function') fac = qOverride;
        else if (qOverride === undefined && kind === KIND_SPAN) fac = _qFactory;
        if (fac) {
            if (kind !== KIND_SPAN && kind !== KIND_LEVEL) {
                throw new Error(HUD_PREFIX + 'quantiles apply only to SPAN or ' +
                    'LEVEL channels, not kind ' + kind);
            }
            enableSketch(ch, fac, _qHalfMs);
        }

        // Arithmetic packed -- avoids signed-Int32 overflow for sid >= 0x8000.
        const packed = sid * 65536 + opLow;

        return {
            push(value) {
                // Synthesize SPP record and inject directly into demux.
                // One rendering truth: no separate ring or draw path.
                const now = nowMs();
                if (kind === KIND_SPAN) {
                    // D5: a = duration ms, t = start = now - duration
                    const dur = value || 0;
                    write(packed, now - dur, dur, 0);
                } else {
                    write(packed, now, kind === KIND_INSTANT ? 0 : (value || 0), 0);
                }
            },
        };
    }

    // -- stats() and inspect() --------------------------------------------------

    function stats() {
        let totalBudgets = 0;
        let quantileDrops = 0;
        const channelStats = new Array(channels.length);
        for (let ci = 0; ci < channels.length; ci++) {
            totalBudgets += channels[ci].budgets.length +
                (channels[ci].metaBudgetActive ? 1 : 0);
            quantileDrops += channels[ci].qDrops;
            channelStats[ci] = {name: channels[ci].name, count: channels[ci].count, head: channels[ci].head};
        }
        return {
            drops,
            channels: channels.length,
            epoch,
            verdicts: verdictCount < VCAP ? verdictCount : VCAP,
            budgets: totalBudgets,
            // Sum of per-channel values rejected by the analytics pre-check (never
            // reached DDSketch.add). Separate from `drops` (demux rejections);
            // always 0 with no factory injected.
            quantileDrops,
            channelStats,
        };
    }

    // Debug: last record for a named channel. Cold path; allocates.
    function inspect(name) {
        let ch = null;
        for (let ci = 0; ci < channels.length; ci++) {
            if (channels[ci].name === name) {
                ch = channels[ci];
                break;
            }
        }
        if (!ch || ch.count === 0) return null;
        const rec = ringRead(ch, ringLen(ch) - 1);
        const out = {count: ch.count, last: {t: rec[0], a: rec[1], b: rec[2]}};
        // Windowed quantile readout for a sketched channel (cold: merge qA+qB into
        // the scratch, then walk). Present only when analytics is on; an empty
        // window reports n:0 with NaN quantiles ("--" on the overlay, never 0).
        if (ch.q !== null) {
            const s = ch.qScratch;
            s.clear();
            s.merge(ch.qA);
            s.merge(ch.qB);
            out.quantiles = s.count === 0
                ? {p50: NaN, p90: NaN, p99: NaN, p999: NaN, n: 0}
                : {
                    p50: s.quantile(0.5), p90: s.quantile(0.9),
                    p99: s.quantile(0.99), p999: s.quantile(0.999), n: s.count,
                };
        }
        return out;
    }

    // -- Canvas overlay ---------------------------------------------------------

    // Total overlay height in CSS px for the current channel count.
    function totalHeight() {
        const chn = channels.length || 1;
        return PAD + chn * (ROW_H + PAD) + 14 + PAD;
    }

    // [verticalEdge, horizontalEdge] CSS properties for the configured corner.
    function posEdges() {
        const POS = {
            'top-right': ['top', 'right'],
            'top-left': ['top', 'left'],
            'bottom-right': ['bottom', 'right'],
            'bottom-left': ['bottom', 'left'],
        };
        return POS[pos] || ['top', 'right'];
    }

    function setupCanvas() {
        if (!mountEl || typeof document === 'undefined') return;
        const prev = document.getElementById('__lite_hud__');
        if (prev) prev.remove();
        const prevW = document.getElementById('__lite_hud_wrap__');
        if (prevW) prevW.remove();

        canvas = document.createElement('canvas');
        canvas.id = '__lite_hud__';
        const parent = mountEl.appendChild ? mountEl : document.body;
        const [v, h] = posEdges();

        if (viewportClass) {
            // HUD-owned wrapper: it carries positioning + the HUD's own size, so
            // the injected Viewport measures the HUD (not the page) and the canvas
            // fills it. Positioning styles live on the wrapper, never the canvas.
            wrapper = document.createElement('div');
            wrapper.id = '__lite_hud_wrap__';
            Object.assign(wrapper.style, {
                position: 'fixed',
                zIndex: String(zIdx),
                width: HUD_W + 'px',
                height: totalHeight() + 'px',
                pointerEvents: 'none',
            });
            wrapper.style[v] = PAD + 'px';
            wrapper.style[h] = PAD + 'px';
            Object.assign(canvas.style, {
                display: 'block',
                width: '100%',
                height: '100%',
                imageRendering: 'pixelated',
                cursor: 'pointer',
                pointerEvents: 'auto',
            });
            wrapper.appendChild(canvas);
            // The wrapper must be live in the host DOM before the Viewport is
            // constructed (it measures the wrapper). If the injected constructor
            // throws, fail CLOSED: detach the wrapper, drop any partial viewport,
            // reset state, and rethrow the original error -- nothing may be left
            // attached to the caller's mount when createHud() throws.
            parent.appendChild(wrapper);
            try {
                vp = new viewportClass({
                    canvas,
                    maxDpr: _maxDpr,
                    onResize: onVpResize,
                });
                _ctx = vp.ctx;
                dpr = vp.dpr;
            } catch (err) {
                if (vp && typeof vp.destroy === 'function') {
                    try { vp.destroy(); } catch (_) { /* ignore secondary error */ }
                }
                wrapper.remove();
                wrapper = null;
                vp = null;
                canvas = null;
                _ctx = null;
                throw err;
            }
            // Only after the fallible construction succeeds do we attach the
            // pointer listener, so a throw above leaks no listener either.
            canvas.addEventListener('pointerdown', onCanvasPointer);
        } else {
            Object.assign(canvas.style, {
                position: 'fixed',
                zIndex: String(zIdx),
                imageRendering: 'pixelated',
                cursor: 'pointer',
                fontSmoothing: 'none',
            });
            canvas.style[v] = PAD + 'px';
            canvas.style[h] = PAD + 'px';
            resize();
            canvas.addEventListener('pointerdown', onCanvasPointer);
            parent.appendChild(canvas);
        }

        if (hotkey) document.addEventListener('keydown', onKey);
    }

    // Viewport onResize callback: pick up the new dpr/ctx and redraw. render()
    // no-ops until ctx is wired (the constructor's initial resize fires early).
    function onVpResize() {
        if (vp) { dpr = vp.dpr; _ctx = vp.ctx; }
        render();
    }

    // Fallback (no viewport) DPR-aware sizing. Reset the transform to identity
    // BEFORE scaling so repeated resizes never compound (scale(2)*scale(2)).
    function resize() {
        if (!canvas) return;
        const raw = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
        dpr = Math.min(raw, _maxDpr);
        const tot = totalHeight();
        canvas.width = HUD_W * dpr;
        canvas.height = tot * dpr;
        canvas.style.width = HUD_W + 'px';
        canvas.style.height = tot + 'px';
        _ctx = canvas.getContext('2d');
        if (_ctx) {
            _ctx.setTransform(1, 0, 0, 1, 0, 0);
            _ctx.scale(dpr, dpr);
        }
    }

    // -- render() -- cold path, caller-throttled --------------------------------

    function render() {
        if (!canvas || _ctx === null || !_visible) return;

        const now = nowMs();
        const tMin = now - winSec * 1000;
        const tMax = now;
        const W = HUD_W;
        const cw = W - LBL_W - PAD * 2;

        // Lazy height resize if channels were added since the last render. With a
        // viewport, grow the wrapper and resize synchronously (its RO/RAF path is
        // async); otherwise re-size the canvas directly.
        const neededH = totalHeight();
        if (vp) {
            const curH = wrapper ? (parseFloat(wrapper.style.height) || 0) : 0;
            if (curH < neededH) {
                if (wrapper) wrapper.style.height = neededH + 'px';
                vp.resize();
            }
        } else {
            if (canvas.height / dpr < neededH) resize();
        }
        const H = canvas.height / dpr;

        // Per-frame LOCAL snapshot of the context. Everything below (and the nested
        // render closures) draws through `ctx`, never the closure `_ctx`. resize() /
        // vp.resize() above may reassign _ctx; after this point a reentrant
        // destroy() -- e.g. from a patched ctx.fillText -- nulls _ctx but not this
        // local, so the frame finishes harmlessly on the detached context and the
        // next render() bails at the guard. (canvas / vp / wrapper are read only in
        // the resize block above, before any draw call, so they need no snapshot.)
        const ctx = _ctx;
        if (ctx === null) return;

        // Background
        ctx.fillStyle = C_BG;
        ctx.fillRect(0, 0, W, H);

        // CRT grid lines
        ctx.strokeStyle = C_GRID;
        ctx.lineWidth = 0.5;
        const gStep = cw / 5;
        for (let gx = 0; gx <= 5; gx++) {
            const x = LBL_W + PAD + gx * gStep;
            ctx.beginPath();
            ctx.moveTo(x, PAD);
            ctx.lineTo(x, H - 14 - PAD);
            ctx.stroke();
        }
        const gRowH = ROW_H + PAD;
        for (let ci = 0; ci < channels.length; ci++) {
            const ry = PAD + ci * gRowH + ROW_H / 2;
            ctx.beginPath();
            ctx.moveTo(LBL_W + PAD, ry);
            ctx.lineTo(W - PAD, ry);
            ctx.stroke();
        }

        function xOf(t) {
            return LBL_W + PAD + ((t - tMin) / (tMax - tMin)) * cw;
        }

        // Merge the two rotating window sketches into the render scratch (cold,
        // 0-alloc merge/clear) and return it. Caller checks scratch.count.
        function qWindow(ch) {
            const s = ch.qScratch;
            s.clear();
            s.merge(ch.qA);
            s.merge(ch.qB);
            return s;
        }

        // Compact p50/p90/p99/p99.9 tile line at the row foot. Empty window shows
        // "--" (never 0). Cold path (render is caller-throttled).
        function drawQTiles(s, rowY) {
            ctx.font = '7px monospace';
            ctx.textAlign = 'right';
            if (s.count === 0) {
                ctx.fillStyle = C_DIM;
                ctx.fillText('p50 -- p90 -- p99 -- p99.9 --', W - PAD, rowY + ROW_H - 3);
            } else {
                ctx.fillStyle = C_TEXT;
                ctx.fillText(
                    'p50 ' + qFmt(s.quantile(0.5)) + ' p90 ' + qFmt(s.quantile(0.9)) +
                    ' p99 ' + qFmt(s.quantile(0.99)) + ' p99.9 ' + qFmt(s.quantile(0.999)),
                    W - PAD, rowY + ROW_H - 3);
            }
            ctx.textAlign = 'left';
        }

        for (let ci = 0; ci < channels.length; ci++) {
            const ch = channels[ci];
            const rowY = PAD + ci * (ROW_H + PAD);
            const midY = rowY + ROW_H / 2;

            ch.hitY0 = rowY;
            ch.hitY1 = rowY + ROW_H;

            // Row fill
            ctx.fillStyle = ch.visible ? '#0a1a0a' : C_INACTIVE;
            ctx.fillRect(LBL_W, rowY, cw + PAD, ROW_H);

            // Label
            ctx.textAlign = 'left';
            ctx.fillStyle = ch.visible ? C_TEXT : C_DIM;
            ctx.font = 'bold 9px monospace';
            ctx.fillText(ch.name.length > 9 ? ch.name.slice(0, 9) : ch.name, 3, midY - 4);
            ctx.font = '7px monospace';
            ctx.fillStyle = C_DIM;
            if (ch.unit) ctx.fillText(ch.unit, 3, midY + 7);

            if (!ch.visible) continue;

            const n = ringLen(ch);

            ctx.save();
            ctx.beginPath();
            ctx.rect(LBL_W + PAD, rowY + 1, cw, ROW_H - 2);
            ctx.clip();

            if (ch.kind === KIND_LEVEL || ch.kind === KIND_COUNTER) {
                if (n === 0) {
                    ctx.restore();
                    continue;
                }
                const tail = ch.count >= ch.cap ? ch.head : 0;

                // Compute window min/max (include budget lines in range)
                let mn = Infinity, mx = -Infinity;
                for (let i = 0; i < n; i++) {
                    const v = ch.ring[((tail + i) & ch.mask) * ch.stride + 1];
                    if (v < mn) mn = v;
                    if (v > mx) mx = v;
                }
                for (let bi = 0; bi < ch.budgets.length; bi++) {
                    const bv = ch.budgets[bi].threshold;
                    if (bv < mn) mn = bv;
                    if (bv > mx) mx = bv;
                }
                if (ch.metaBudgetActive) {
                    const bv = ch.metaBudgetThreshold;
                    if (bv < mn) mn = bv;
                    if (bv > mx) mx = bv;
                }
                const range = mx === mn ? 1 : mx - mn;

                function yOf(v) {
                    return rowY + ROW_H - 2 - ((v - mn) / range) * (ROW_H - 6);
                }

                function drawBudgetLine(threshold, label) {
                    const by = yOf(threshold);
                    ctx.strokeStyle = C_BUDGET;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(LBL_W + PAD, by);
                    ctx.lineTo(W - PAD, by);
                    ctx.stroke();
                    ctx.fillStyle = C_BUDGET;
                    ctx.font = '7px monospace';
                    ctx.fillText(label || '', LBL_W + PAD + 2, by - 2);
                }

                // Budget threshold lines (DI budgets + the meta BUDGET_SET slot)
                ctx.setLineDash([3, 3]);
                for (let bi = 0; bi < ch.budgets.length; bi++) {
                    drawBudgetLine(ch.budgets[bi].threshold, ch.budgets[bi].label);
                }
                if (ch.metaBudgetActive) {
                    drawBudgetLine(ch.metaBudgetThreshold, ch.metaBudgetLabel);
                }
                ctx.setLineDash([]);

                // Shaded p50-p99 band behind the trace (opted-in LEVEL only).
                let qs = null;
                if (ch.q !== null) {
                    qs = qWindow(ch);
                    if (qs.count > 0) {
                        const yA = yOf(qs.quantile(0.5));
                        const yB = yOf(qs.quantile(0.99));
                        const top = yA < yB ? yA : yB;
                        const h = (yA > yB ? yA - yB : yB - yA) || 1;
                        ctx.fillStyle = C_SPAN_OPE;
                        ctx.fillRect(LBL_W + PAD, top, cw, h);
                    }
                }

                const drawPath = (isStep) => {
                    let first = true;
                    let prevY = 0;
                    for (let i = 0; i < n; i++) {
                        const physIdx = (tail + i) & ch.mask;
                        const base = physIdx * ch.stride;
                        const x = xOf(ch.ring[base]);
                        const y = yOf(ch.ring[base + 1]);
                        if (first) {
                            ctx.moveTo(x, y);
                            first = false;
                        } else if (isStep) {
                            ctx.lineTo(x, prevY);
                            ctx.lineTo(x, y);
                        } else {
                            ctx.lineTo(x, y);
                        }
                        prevY = y;
                    }
                };

                const isStep = ch.kind === KIND_COUNTER;

                // Glow pass
                ctx.strokeStyle = C_GLOW;
                ctx.lineWidth = 5;
                ctx.beginPath();
                drawPath(isStep);
                ctx.stroke();

                // Sharp pass
                ctx.strokeStyle = C_TRACE;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                drawPath(isStep);
                ctx.stroke();

                // Latest value readout
                const lastPhys = ((ch.head - 1 + ch.cap) & ch.mask);
                const lastVal = ch.ring[lastPhys * ch.stride + 1];
                ctx.fillStyle = C_TRACE;
                ctx.font = 'bold 9px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(lastVal.toFixed(1), W - PAD, midY + 4);
                ctx.textAlign = 'left';

                // Percentile tiles (opted-in LEVEL). qs was merged for the band.
                if (qs !== null) drawQTiles(qs, rowY);

            } else if (ch.kind === KIND_INSTANT) {
                const tail = ch.count >= ch.cap ? ch.head : 0;
                for (let i = 0; i < n; i++) {
                    const x = xOf(ch.ring[((tail + i) & ch.mask) * ch.stride]);
                    if (x < LBL_W + PAD || x > W - PAD) continue;
                    ctx.strokeStyle = C_GLOW;
                    ctx.lineWidth = 5;
                    ctx.beginPath();
                    ctx.moveTo(x, rowY + 4);
                    ctx.lineTo(x, rowY + ROW_H - 4);
                    ctx.stroke();
                    ctx.strokeStyle = C_TRACE;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(x, rowY + 6);
                    ctx.lineTo(x, rowY + ROW_H - 6);
                    ctx.stroke();
                }
                ctx.fillStyle = C_TEXT;
                ctx.font = '8px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(n + ' evt', W - PAD, midY + 4);
                ctx.textAlign = 'left';

            } else if (ch.kind === KIND_SPAN) {
                const tail = ch.count >= ch.cap ? ch.head : 0;
                for (let i = 0; i < n; i++) {
                    const physIdx = (tail + i) & ch.mask;
                    const base = physIdx * ch.stride;
                    let tS, tE;
                    if (ch.paired) {
                        tS = ch.ring[base];      // t_open
                        tE = ch.ring[base + 1];  // t_close
                    } else {
                        tS = ch.ring[base];                 // t_start (D5)
                        tE = tS + ch.ring[base + 1];        // t_start + duration
                    }
                    const x0 = Math.max(xOf(tS), LBL_W + PAD);
                    const x1 = Math.min(xOf(tE), W - PAD);
                    if (x1 <= x0) continue;
                    ctx.fillStyle = C_SPAN;
                    ctx.fillRect(x0, rowY + 6, x1 - x0, ROW_H - 12);
                    ctx.strokeStyle = C_TRACE;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x0, rowY + 6, x1 - x0, ROW_H - 12);
                }
                // Open (unclosed) spans render to the window right edge. Cold
                // path: scan the pool slots directly (no iterator allocation).
                if (ch.paired && ch.poolOcc) {
                    for (let si = 0; si < ch.poolSlots; si++) {
                        if (!ch.poolOcc[si]) continue;
                        const x0 = Math.max(xOf(ch.poolTOpen[si]), LBL_W + PAD);
                        if (x0 >= W - PAD) continue;
                        ctx.fillStyle = C_SPAN_OPE;
                        ctx.fillRect(x0, rowY + 6, W - PAD - x0, ROW_H - 12);
                    }
                }
                // Percentile tiles for a sketched SPAN channel (duration p50..p99.9).
                if (ch.q !== null) drawQTiles(qWindow(ch), rowY);
            }

            ctx.restore();
        }

        // Verdict cursors (on top, across full channel area)
        const vTotal = verdictCount < VCAP ? verdictCount : VCAP;
        const vTail = verdictCount >= VCAP ? verdictHead : 0;
        for (let vi = 0; vi < vTotal; vi++) {
            const physIdx = (vTail + vi) & (VCAP - 1);
            const vb = physIdx * 3;
            const vt = verdictRing[vb];
            const vr = verdictRing[vb + 1] | 0;
            const x = xOf(vt);
            if (x < LBL_W + PAD || x > W - PAD) continue;
            ctx.strokeStyle = vr === 0 ? C_VPASS : vr === 1 ? C_VFAIL : C_VRECAP;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x, PAD);
            ctx.lineTo(x, PAD + channels.length * (ROW_H + PAD));
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Footer
        const fy = PAD + channels.length * (ROW_H + PAD) + 6;
        ctx.fillStyle = C_DIM;
        ctx.font = '7px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(
            'SPP v' + (sppVersion !== null ? (sppVersion | 0) : '?') +
            ' | lite-hud v' + VERSION +
            ' | ch:' + channels.length,
            3, fy + 6
        );
    }

    // -- Legend interaction -----------------------------------------------------

    function onCanvasPointer(e) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (cx > LBL_W) return; // only label column toggles visibility
        for (let ci = 0; ci < channels.length; ci++) {
            const ch = channels[ci];
            if (cy >= ch.hitY0 && cy <= ch.hitY1) {
                ch.visible = !ch.visible;
                return;
            }
        }
    }

    function onKey(e) {
        if (e.key !== hotkey) return;
        // Don't hijack the key when the user is typing.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.isComposing) return;
        _visible ? hide() : show();
    }

    // -- Overlay chrome ---------------------------------------------------------

    function show() {
        _visible = true;
        const el = wrapper || canvas;
        if (el) el.style.display = '';
    }

    function hide() {
        _visible = false;
        const el = wrapper || canvas;
        if (el) el.style.display = 'none';
    }

    function destroy() {
        if (canvas) {
            canvas.removeEventListener('pointerdown', onCanvasPointer);
            if (vp) { vp.destroy(); vp = null; }
            if (wrapper) { wrapper.remove(); wrapper = null; }
            else canvas.remove();
            canvas = null;
            _ctx = null;
        }
        if (hotkey && typeof document !== 'undefined') {
            document.removeEventListener('keydown', onKey);
        }
        if (_scope && typeof _scope.removeSink === 'function') {
            _scope.removeSink(_self);
        }
    }

    // -- Assemble and init ------------------------------------------------------

    _self = {write};
    setupCanvas();

    return {
        // SPP duck-typed sink
        write,
        // Scope integration
        attach,
        // Manual channel (D4 polyfill)
        channel,
        // Inspection
        stats,
        inspect,
        // Render
        render,
        // Overlay chrome
        show,
        hide,
        destroy,
        get visible() {
            return _visible;
        },
    };
}

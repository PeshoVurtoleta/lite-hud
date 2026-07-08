// @zakkster/lite-hud 2.0.0
// SPP-native zero-GC canvas overlay. Channels from scope registry, trigger
// cursors from gate verdicts and budget lines, legend with per-channel
// visibility toggle. Drop-in stats.js replacement via hud.channel().
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '2.0.0';

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
        // Paired span: open op and close op route to the same channel.
        // openPool holds (correlId -> t_open) until close arrives.
        paired: false,
        openOpLow: -1,
        closeOpLow: -1,
        openPool: null,
        // Budget threshold lines: [{threshold, label}]
        budgets: [],
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
    let ctx = null;
    let dpr = 1;

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

        // Meta stream
        if (sid === META_STREAM) {
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
                // a = interned channel name id, b = threshold value
                if (_scope) {
                    const lbl = _scope.label(a | 0);
                    if (lbl) {
                        for (let ci = 0; ci < channels.length; ci++) {
                            if (channels[ci].name === lbl) {
                                channels[ci].budgets.push({threshold: b, label: lbl});
                                break;
                            }
                        }
                    }
                }
            }
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

        // Paired span
        if (ch.paired) {
            if (entry.role === 'open') {
                if (ch.openPool.size >= ch.cap) {
                    // Evict one to prevent unbounded growth; count as drop.
                    ch.openPool.delete(ch.openPool.keys().next().value);
                    drops++;
                }
                ch.openPool.set(a, t);
            } else if (entry.role === 'close') {
                const tOpen = ch.openPool.get(a);
                if (tOpen !== undefined) {
                    ch.openPool.delete(a);
                    ringWrite(ch, tOpen, t, a); // [t_open, t_close, correlId]
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
                ch.openPool = new Map();
                channels.push(ch);
                registerOp(sd.id, ch.openOpLow, ch.idx, 'open');
                registerOp(sd.id, ch.closeOpLow, ch.idx, 'close');
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
        const channelStats = new Array(channels.length);
        for (let ci = 0; ci < channels.length; ci++) {
            totalBudgets += channels[ci].budgets.length;
            channelStats[ci] = {name: channels[ci].name, count: channels[ci].count, head: channels[ci].head};
        }
        return {
            drops,
            channels: channels.length,
            epoch,
            verdicts: verdictCount < VCAP ? verdictCount : VCAP,
            budgets: totalBudgets,
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
        return {count: ch.count, last: {t: rec[0], a: rec[1], b: rec[2]}};
    }

    // -- Canvas overlay ---------------------------------------------------------

    function setupCanvas() {
        if (!mountEl || typeof document === 'undefined') return;
        const prev = document.getElementById('__lite_hud__');
        if (prev) prev.remove();

        canvas = document.createElement('canvas');
        canvas.id = '__lite_hud__';
        Object.assign(canvas.style, {
            position: 'fixed',
            zIndex: String(zIdx),
            imageRendering: 'pixelated',
            cursor: 'pointer',
            fontSmoothing: 'none',
        });
        const POS = {
            'top-right': ['top', 'right'],
            'top-left': ['top', 'left'],
            'bottom-right': ['bottom', 'right'],
            'bottom-left': ['bottom', 'left'],
        };
        const [v, h] = POS[pos] || ['top', 'right'];
        canvas.style[v] = PAD + 'px';
        canvas.style[h] = PAD + 'px';

        resize();
        canvas.addEventListener('pointerdown', onCanvasPointer);
        const parent = mountEl.appendChild ? mountEl : document.body;
        parent.appendChild(canvas);

        if (hotkey) document.addEventListener('keydown', onKey);
    }

    function resize() {
        if (!canvas) return;
        dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
        const ch = channels.length || 1;
        const tot = PAD + ch * (ROW_H + PAD) + 14 + PAD;
        canvas.width = HUD_W * dpr;
        canvas.height = tot * dpr;
        canvas.style.width = HUD_W + 'px';
        canvas.style.height = tot + 'px';
        ctx = canvas.getContext('2d');
        if (ctx) ctx.scale(dpr, dpr);
    }

    // -- render() -- cold path, caller-throttled --------------------------------

    function render() {
        if (!canvas || !ctx || !_visible) return;

        const now = nowMs();
        const tMin = now - winSec * 1000;
        const tMax = now;
        const W = HUD_W;
        const cw = W - LBL_W - PAD * 2;
        const H = canvas.height / dpr;

        // Lazy height resize if channels added since last render
        const neededH = PAD + channels.length * (ROW_H + PAD) + 14 + PAD;
        if (H < neededH) resize();

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
                const range = mx === mn ? 1 : mx - mn;

                function yOf(v) {
                    return rowY + ROW_H - 2 - ((v - mn) / range) * (ROW_H - 6);
                }

                // Budget threshold lines
                ctx.setLineDash([3, 3]);
                for (let bi = 0; bi < ch.budgets.length; bi++) {
                    const by = yOf(ch.budgets[bi].threshold);
                    ctx.strokeStyle = C_BUDGET;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(LBL_W + PAD, by);
                    ctx.lineTo(W - PAD, by);
                    ctx.stroke();
                    ctx.fillStyle = C_BUDGET;
                    ctx.font = '7px monospace';
                    ctx.fillText(ch.budgets[bi].label || '', LBL_W + PAD + 2, by - 2);
                }
                ctx.setLineDash([]);

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
                // Open (unclosed) spans render to the window right edge
                if (ch.paired && ch.openPool) {
                    for (const [, tOpen] of ch.openPool) {
                        const x0 = Math.max(xOf(tOpen), LBL_W + PAD);
                        if (x0 >= W - PAD) continue;
                        ctx.fillStyle = C_SPAN_OPE;
                        ctx.fillRect(x0, rowY + 6, W - PAD - x0, ROW_H - 12);
                    }
                }
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
        if (canvas) canvas.style.display = '';
    }

    function hide() {
        _visible = false;
        if (canvas) canvas.style.display = 'none';
    }

    function destroy() {
        if (canvas) {
            canvas.removeEventListener('pointerdown', onCanvasPointer);
            canvas.remove();
            canvas = null;
            ctx = null;
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

/**
 * @zakkster/lite-hud -- torture gate.
 *
 *     node --expose-gc test/torture.mjs
 *
 * The load-bearing witness for the "Zero-GC Hot path" badge. Two jobs, kept
 * separate (torture-harness skill):
 *   - @zakkster/lite-leak         -- retention: does a HUD (its rings + the
 *                                    paired-span open pool) outlive its owner?
 *                                    tracker.size() -> 0 is the proof.
 *   - @zakkster/lite-gc-profiler  -- budget: does the write path allocate, and
 *                                    does V8 collect where it must not? 0 B/op
 *                                    per record kind + maxMajor 0 is the gate.
 *
 * Headless (createHud(null, ...)) -- no DOM, the state layer only. Covers every
 * write() record kind (LEVEL / INSTANT / COUNTER / CONT-wide / complete SPAN /
 * paired open+close / paired pool eviction churn / meta EPOCH+VERDICT+BUDGET_SET)
 * and every hud.channel().push() kind.
 *
 * Two complementary lanes catch the two old holes:
 *   - measureAllocs (RETAINED B/op) catches BUDGET_SET, which appended a fresh
 *     {threshold,label} object per record -> unbounded retained growth. It does
 *     NOT catch the old paired-span Map: its set/delete/eviction churn was
 *     TRANSIENT (freed before the snapshot; measureAllocs reports ~0 B/op there).
 *   - a GcProfiler scavenge lane (phase 2b) drives a long paired open+close +
 *     eviction-churn loop with SMI-domain keys/timestamps and asserts minor
 *     (scavenge) count == 0 -- THIS is what catches the old Map (its per-op
 *     entry/iterator churn scales scavenges with n). SMI-domain inputs keep V8's
 *     fractional-double caller-boxing out of the lane.
 * M1 makes both lanes pass at 0.
 *
 * CONTROL: LITE_HUD_TORTURE_BREAK=1 arms a deliberately-allocating step; the gate
 * MUST then reject the window and the process MUST exit non-zero (proof the gate
 * has teeth). Driven by test/controls.mjs.
 *
 * ENTRY CONTRACT: --expose-gc is mandatory; the devDeps are imported AFTER the
 * guard so a fresh clone that skipped `npm install` fails with a remedy.
 */

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak', '@zakkster/lite-sketch']) {
        try {
            await import(pkg);
        } catch {
            process.stderr.write(
                'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
            process.exit(2);
        }
    }

    const { GcProfiler, checkNoGc, measureAllocs } =
        await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { DDSketch } = await import('@zakkster/lite-sketch');
    const { createHud } = await import('../Hud.js');

    // The injected quantile factory (optional peer). analytics-ON lanes assert
    // the write path stays 0 B/op with DDSketch.add wired into write().
    const mkSketch = () => new DDSketch(0.01);
    const qStats = { stats: { quantiles: mkSketch } };

    const BREAK = process.env.LITE_HUD_TORTURE_BREAK === '1';
    const CYCLES = 4096;     // retention churn
    const ITERS = 100000;    // per-op measureAllocs iterations
    const BATCHES = 8;
    const HOT = 400000;      // GcProfiler steady-state ops

    // Packed SPP field: (sid << 16 | op) via arithmetic (matches Hud decode).
    const packed = (sid, op) => sid * 65536 + op;

    // Opcodes for the fixture streams.
    const OP_LEVEL = 0x0100;
    const OP_INSTANT = 0x0200;
    const OP_COUNTER = 0x0300;
    const OP_WIDE = 0x0400;   // width 3 CONT-chained
    const OP_CONT = 0x0F01;
    const OP_SPAN = 0x0500;   // complete (non-paired) SPAN
    const OP_OPEN = 0x0600;   // paired open
    const OP_CLOSE = 0x0601;  // paired close
    const OP_EPOCH = 0x0F00;
    const OP_VERDICT = 0x0F40;
    const OP_BUDGET_SET = 0x0F41;

    // A duck-typed scope: full record-kind coverage + a label() for BUDGET_SET.
    function makeScope() {
        const labels = new Map([[7, 'lvl']]); // BUDGET_SET target -> the LEVEL channel
        return {
            streams() {
                return [
                    { id: 1, name: 'lvl', hz: 60, ops: [{ code: OP_LEVEL, name: 'lvl', kind: 0, width: 1, quantiles: true }] },
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

    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-hud',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    // No kernels: a headless HUD owns only its own typed arrays (rings + the
    // paired open pool) -- no timer, listener, observer, or DOM node when
    // mountEl is null. Being collected is the DESIRED outcome; the retention
    // proof is finalization itself (tracker.size() -> 0).

    // ---- phase 1: retention torture ---------------------------------------
    // The churn lives in its own function so the last `hud` register is torn
    // down before we gc. The cleanup closes over NOTHING (held-value contract).
    function fillTracker() {
        const noop = () => {};
        for (let i = 0; i < CYCLES; i++) {
            const hud = createHud(null);
            hud.attach(makeScope());
            hud.write(packed(1, OP_LEVEL), i, i & 63, 0);
            hud.write(packed(2, OP_INSTANT), i, 0, 0);
            hud.write(packed(3, OP_COUNTER), i, i & 255, 0);
            hud.write(packed(4, OP_WIDE), i, 1, 2);
            hud.write(packed(4, OP_CONT), 3, 4, 5);
            hud.write(packed(4, OP_CONT), 6, 7, 8);
            hud.write(packed(5, OP_SPAN), i, 4, 0);
            hud.write(packed(6, OP_OPEN), i, i & 7, 0);
            hud.write(packed(6, OP_CLOSE), i + 1, i & 7, 0);
            hud.write(packed(0, OP_EPOCH), i, 1, 0);
            hud.write(packed(0, OP_VERDICT), i, 0, i & 1);
            hud.write(packed(0, OP_BUDGET_SET), i, 7, 60);
            const ch = hud.channel({ name: 'm', kind: 0 });
            ch.push(i & 15);
            tracker.track(hud, noop, 'hud', { audit: true });

            // analytics-ON: a second HUD with injected sketches (SPAN always +
            // LEVEL opt-in). Its A/B window sketches + scratch are owned by the
            // channels, owned by the HUD -> released with it (size() -> 0).
            const hq = createHud(null, qStats);
            hq.attach(makeScope());
            hq.write(packed(1, OP_LEVEL), i, i & 63, 0);   // opted-in LEVEL sketch
            hq.write(packed(5, OP_SPAN), i, 4, 0);          // complete SPAN sketch
            hq.write(packed(6, OP_OPEN), i, i & 7, 0);
            hq.write(packed(6, OP_CLOSE), i + 1, i & 7, 0); // paired SPAN sketch
            tracker.track(hq, noop, 'hudq', { audit: true });
        }
        return tracker.size();
    }

    const trackedMid = fillTracker();
    const trackedOk = trackedMid > 0;

    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 25));
        live = tracker.size();
    }
    const findings = tracker.audit();

    // ---- phase 2: per-op allocation on the write path (0 B/op) -------------
    // One HUD per surface, reused; the step is driven inside the measured loop.
    const results = [];
    function gate(name, step) {
        const res = measureAllocs(step, { iterations: ITERS, batches: BATCHES });
        const raw = res.bytesPerCall === null ? 0 : res.bytesPerCall;
        const bytes = Math.max(0, Math.round(raw));
        results.push({ name, bytes, ok: bytes === 0 });
    }

    // LEVEL single
    const hudL = createHud(null); hudL.attach(makeScope());
    let lv = 0;
    gate('LEVEL write', () => { lv = (lv + 1) | 0; hudL.write(packed(1, OP_LEVEL), lv, lv & 63, 0); });

    // INSTANT single
    const hudI = createHud(null); hudI.attach(makeScope());
    let iv = 0;
    gate('INSTANT write', () => { iv = (iv + 1) | 0; hudI.write(packed(2, OP_INSTANT), iv, 0, 0); });

    // COUNTER single
    const hudC = createHud(null); hudC.attach(makeScope());
    let cv = 0;
    gate('COUNTER write', () => { cv = (cv + 1) | 0; hudC.write(packed(3, OP_COUNTER), cv, cv & 255, 0); });

    // CONT-chained wide (width 3): primary + 2 CONT per record
    const hudW = createHud(null); hudW.attach(makeScope());
    let wv = 0;
    gate('CONT-wide write', () => {
        wv = (wv + 1) | 0;
        hudW.write(packed(4, OP_WIDE), wv, 1, 2);
        hudW.write(packed(4, OP_CONT), 3, 4, 5);
        hudW.write(packed(4, OP_CONT), 6, 7, 8);
    });

    // Complete (non-paired) SPAN
    const hudS = createHud(null); hudS.attach(makeScope());
    let sv = 0;
    gate('complete SPAN write', () => { sv = (sv + 1) | 0; hudS.write(packed(5, OP_SPAN), sv, 4, 0); });

    // Paired open+close balanced: pool oscillates, ring record on each close
    const hudP = createHud(null); hudP.attach(makeScope());
    let pv = 0;
    gate('paired open+close', () => {
        pv = (pv + 1) | 0;
        const k = pv & 63;
        hudP.write(packed(6, OP_OPEN), pv, k, 0);
        hudP.write(packed(6, OP_CLOSE), pv + 1, k, 0);
    });

    // Paired pool eviction churn: prime the pool to capacity, then open a fresh
    // distinct key every step -> every op evicts the oldest (poolEvictOldest +
    // backshift delete + the FIFO lazy skip / in-place compaction). This is the
    // path the old openPool Map allocated on.
    const hudE = createHud(null); hudE.attach(makeScope());
    for (let k = 0; k < 300; k++) hudE.write(packed(7, OP_OPEN), k, k, 0); // > cap (256)
    let ev = 300;
    gate('paired eviction churn', () => { ev = (ev + 1) | 0; hudE.write(packed(7, OP_OPEN), ev, ev, 0); });

    // Meta records: EPOCH + VERDICT + BUDGET_SET (BUDGET_SET replaces in a slot)
    const hudM = createHud(null); hudM.attach(makeScope());
    let mv = 0;
    gate('meta EPOCH/VERDICT/BUDGET_SET', () => {
        mv = (mv + 1) | 0;
        hudM.write(packed(0, OP_EPOCH), mv, 1, 0);
        hudM.write(packed(0, OP_VERDICT), mv, 0, mv & 1);
        hudM.write(packed(0, OP_BUDGET_SET), mv, 7, 60);
    });

    // channel().push() -- every kind through the manual polyfill
    const hudPush = createHud(null);
    const chLevel = hudPush.channel({ name: 'pl', kind: 0 });
    const chInst = hudPush.channel({ name: 'pi', kind: 1 });
    const chSpan = hudPush.channel({ name: 'ps', kind: 2 });
    const chCtr = hudPush.channel({ name: 'pc', kind: 3 });
    let uv = 0;
    gate('channel().push() all kinds', () => {
        uv = (uv + 1) | 0;
        chLevel.push(uv & 63);
        chInst.push();
        chSpan.push(uv & 15);
        chCtr.push(uv & 255);
    });

    // ---- phase 2a: analytics-ON write path, FRACTIONAL inputs (0 RETAINED) -----
    // Fractional values are the realistic case; the zero-box addFrom(buf, i) path
    // stores the value into the channel's Float64Array in write()'s frame and the
    // peer reads it UNBOXED, so no HeapNumber is RETAINED. (The scavenge-scaling
    // delta on fractional inputs is gated in test/perf/AnalyticsBox.test.mjs.)
    let qfrac = 0;
    const nextFrac = () => { qfrac = (qfrac + 1) | 0; return 1 + (qfrac % 9973) * 0.001; };

    const hudQL = createHud(null, qStats); hudQL.attach(makeScope());
    let qlt = 0;
    gate('analytics LEVEL write (fractional)', () => { qlt = (qlt + 1) | 0; hudQL.write(packed(1, OP_LEVEL), qlt + 0.5, nextFrac(), 0); });

    const hudQS = createHud(null, qStats); hudQS.attach(makeScope());
    let qst = 0;
    gate('analytics complete SPAN write (fractional)', () => { qst = (qst + 1) | 0; hudQS.write(packed(5, OP_SPAN), qst + 0.5, nextFrac(), 0); });

    const hudQP = createHud(null, qStats); hudQP.attach(makeScope());
    let qpt = 0;
    gate('analytics paired open+close (fractional)', () => {
        qpt = (qpt + 1) | 0;
        const k = qpt & 63;
        const t = qpt + 0.5;
        hudQP.write(packed(6, OP_OPEN), t, k, 0);
        hudQP.write(packed(6, OP_CLOSE), t + nextFrac(), k, 0); // fractional duration
    });

    // channel().push() into a sketched SPAN/LEVEL (RETAINED lane; push reads
    // wall-clock time, a transient box on the scavenge lane -- gated here).
    const hudQPush = createHud(null, qStats);
    const chQSpan = hudQPush.channel({ name: 'qs', kind: 2 });               // SPAN inherits default
    const chQLvl = hudQPush.channel({ name: 'ql', kind: 0, quantiles: mkSketch }); // LEVEL opt-in
    gate('analytics channel().push() (fractional)', () => {
        chQSpan.push(nextFrac());
        chQLvl.push(nextFrac());
    });

    // CONTROL: an allocating step that MUST trip the gate when armed.
    if (BREAK) {
        const sink = [];
        let bv = 0;
        gate('CONTROL allocating step', () => {
            bv = (bv + 1) | 0;
            sink.push({ v: bv }); // fresh object retained per op -> real allocation
            if (sink.length > 4096) sink.length = 0;
        });

        // CONTROL (analytics break): an injected factory whose addFrom() closes
        // over a per-op sink (the HUD's hot path calls addFrom, not add) -> the
        // analytics write path allocates. It carries the N1 getters so
        // enableSketch accepts it. It MUST trip the gate.
        const asink = [];
        const badFactory = () => {
            const d = new DDSketch(0.01);
            return {
                addFrom(buf, i) { asink.push({ v: buf[i] }); if (asink.length > 4096) asink.length = 0; return d.addFrom(buf, i); },
                quantile(q) { return d.quantile(q); },
                merge(o) { return d; },
                clear() { return d.clear(); },
                get strict() { return d.strict; },
                get minIndexable() { return d.minIndexable; },
                get maxIndexable() { return d.maxIndexable; },
                get count() { return d.count; },
            };
        };
        const hudBad = createHud(null, { stats: { quantiles: badFactory } });
        hudBad.attach(makeScope());
        let abv = 0;
        gate('CONTROL analytics per-add closure', () => {
            abv = (abv + 1) | 0;
            hudBad.write(packed(5, OP_SPAN), abv, (abv & 63) + 1, 0); // addFrom() allocates
        });
    }

    // ---- phase 2b: paired-span SCAVENGE lane (catches a Map-like open pool) --
    // The retained lane above cannot see the old openPool Map: its per-op entry +
    // eviction-iterator churn is TRANSIENT (freed before any heap snapshot). A
    // scavenge counter can: transient young-gen allocation scales minor GCs with
    // n. Drive a long paired open+close + eviction-churn loop with SMI-domain
    // keys AND SMI-domain timestamps (so V8's fractional-double caller-boxing
    // never pollutes this lane), then assert minor == 0. The old Map fails here;
    // the inline pool passes at 0. (Verified out-of-process against HEAD:Hud.js.)
    const hudSc = createHud(null); hudSc.attach(makeScope());
    for (let k = 0; k < 300; k++) hudSc.write(packed(7, OP_OPEN), k, k, 0); // prime > cap
    // Warm the write path so TurboFan has settled before the measured window.
    for (let i = 0; i < 50000; i++) {
        hudSc.write(packed(6, OP_OPEN), i & 63, i & 63, 0);
        hudSc.write(packed(6, OP_CLOSE), (i & 63) + 1, i & 63, 0);
        hudSc.write(packed(7, OP_OPEN), 100000 + i, 100000 + i, 0);
    }
    const gcSc = new GcProfiler().start();
    let sck = 100000 + 50000;
    for (let i = 0; i < HOT; i++) {
        const k = i & 63;
        hudSc.write(packed(6, OP_OPEN), i, k, 0);       // paired open (SMI t + key)
        hudSc.write(packed(6, OP_CLOSE), i + 1, k, 0);  // paired close -> ring record
        sck = (sck + 1) | 0;
        hudSc.write(packed(7, OP_OPEN), sck, sck, 0);   // eviction churn (SMI t + key)
        if ((i & 8191) === 0) gcSc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await new Promise((r) => setTimeout(r, 50));
    const sSc = gcSc.summary();
    gcSc.stop();
    const pairedMinor = sSc.gc.minor;
    const pairedScavengeOk = pairedMinor === 0;

    // ---- phase 2c: analytics-ON SCAVENGE lane (DDSketch.add wired in) --------
    // Drive LEVEL (opted-in) + complete SPAN + paired open/close through the
    // analytics write path with SMI-domain inputs and assert minor == 0: the
    // pre-check + O(1) rotate + DDSketch.add must not churn the young generation.
    // clear() at each windowSec/2 rotation is 0-alloc (record time = the SMI i).
    const hudQsc = createHud(null, qStats); hudQsc.attach(makeScope());
    for (let i = 0; i < 50000; i++) {
        hudQsc.write(packed(1, OP_LEVEL), i, i & 63, 0);
        hudQsc.write(packed(5, OP_SPAN), i, (i & 63) + 1, 0);
        hudQsc.write(packed(6, OP_OPEN), i & 63, i & 63, 0);
        hudQsc.write(packed(6, OP_CLOSE), (i & 63) + 3, i & 63, 0);
    }
    const gcQ = new GcProfiler().start();
    for (let i = 0; i < HOT; i++) {
        const k = i & 63;
        hudQsc.write(packed(1, OP_LEVEL), i, k, 0);            // LEVEL sketch add
        hudQsc.write(packed(5, OP_SPAN), i, k + 1, 0);          // complete SPAN add
        hudQsc.write(packed(6, OP_OPEN), i, k, 0);
        hudQsc.write(packed(6, OP_CLOSE), i + 3, k, 0);         // paired SPAN add
        if ((i & 8191) === 0) gcQ.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await new Promise((r) => setTimeout(r, 50));
    const sQ = gcQ.summary();
    gcQ.stop();
    const analyticsMinor = sQ.gc.minor;
    const analyticsScavengeOk = analyticsMinor === 0;

    // ---- phase 3: GC budget over a combined steady-state hot loop ----------
    const gc = new GcProfiler().start();
    const hud = createHud(null); hud.attach(makeScope());
    for (let k = 0; k < 300; k++) hud.write(packed(7, OP_OPEN), k, k, 0); // prime eviction pool
    let hk = 300;
    for (let i = 0; i < HOT; i++) {
        hud.write(packed(1, OP_LEVEL), i, i & 63, 0);
        hud.write(packed(2, OP_INSTANT), i, 0, 0);
        hud.write(packed(3, OP_COUNTER), i, i & 255, 0);
        hud.write(packed(4, OP_WIDE), i, 1, 2);
        hud.write(packed(4, OP_CONT), 3, 4, 5);
        hud.write(packed(4, OP_CONT), 6, 7, 8);
        hud.write(packed(5, OP_SPAN), i, 4, 0);
        hud.write(packed(6, OP_OPEN), i, i & 63, 0);
        hud.write(packed(6, OP_CLOSE), i + 1, i & 63, 0);
        hk = (hk + 1) | 0;
        hud.write(packed(7, OP_OPEN), hk, hk, 0);       // eviction churn
        hud.write(packed(0, OP_BUDGET_SET), i, 7, 60);  // meta replace
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await new Promise((r) => setTimeout(r, 50));
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();

    // ---- phase 4: arrayBuffers flat over fill/clear cycles -----------------
    // The rings + pool are fixed typed arrays allocated once at attach; a single
    // reused HUD driven through repeated fill cycles (each wrapping the rings and
    // churning the eviction pool) reuses them byte-for-byte, allocating no new
    // backing buffers. arrayBuffers delta across the cycles must be <= 0.
    const hAb = createHud(null); hAb.attach(makeScope());
    for (let k = 0; k < 300; k++) hAb.write(packed(7, OP_OPEN), k, k, 0); // prime pool
    // analytics-ON hud too: its A/B window sketches + scratch are fixed typed
    // arrays allocated at attach; repeated fill cycles reuse them byte-for-byte.
    const hAbQ = createHud(null, qStats); hAbQ.attach(makeScope());
    globalThis.gc();
    const abBefore = process.memoryUsage().arrayBuffers;
    let abk = 1000;
    for (let cyc = 0; cyc < 64; cyc++) {
        for (let i = 0; i < 4096; i++) {
            hAb.write(packed(1, OP_LEVEL), i, i & 63, 0);      // wraps the ring
            hAb.write(packed(6, OP_OPEN), i, i & 63, 0);
            hAb.write(packed(6, OP_CLOSE), i + 1, i & 63, 0);
            abk = (abk + 1) | 0;
            hAb.write(packed(7, OP_OPEN), abk, abk, 0);        // eviction churn
            hAbQ.write(packed(1, OP_LEVEL), i, i & 63, 0);     // analytics LEVEL add
            hAbQ.write(packed(5, OP_SPAN), i, (i & 63) + 1, 0); // analytics SPAN add
        }
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----------------------------------------------
    let allocOk = true;
    let allocFindings = 0;
    for (const r of results) {
        if (r.name.indexOf('CONTROL') === 0) {
            // The control must ALLOCATE; a 0 here means the gate is decorative.
            if (r.ok) { allocOk = false; }
        } else {
            if (!r.ok) { allocOk = false; allocFindings++; }
        }
    }
    // With the control armed, the run MUST fail overall.
    const gatesOk = report.ok && trackedOk && live === 0 &&
        findings.length === 0 && allocOk && abOk && pairedScavengeOk &&
        analyticsScavengeOk;
    const ok = BREAK ? false : gatesOk;

    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=' + warns.length +
        ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' maxMs=' + s.gc.maxMs.toFixed(2) +
        ' | alloc=' + (allocFindings === 0 ? '0' : allocFindings + ' nonzero') + ' B/op' +
        ' | paired-scavenge=' + pairedMinor +
        ' | analytics-scavenge=' + analyticsMinor +
        ' | abGrowth=' + abDelta + ' | ' + (ok ? 'ok' : 'FAIL'));

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: tracker held ' + trackedMid + ' HUDs (expected > 0)');
        for (const v of report.violations) {
            console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        for (const r of results) {
            if (r.name.indexOf('CONTROL') === 0) {
                if (r.ok) console.error('  control DID NOT allocate (' + r.bytes + ' B/op) -- the gate is decorative');
                else console.error('  control tripped as designed: ' + r.bytes + ' B/op (' + r.name + ')');
            } else if (!r.ok) {
                console.error('  alloc ' + r.bytes + ' B/op (' + r.name + ')');
            }
        }
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        if (!pairedScavengeOk) console.error('  paired-span scavenges ' + pairedMinor + ' > 0 (a Map-like open pool churns the young gen)');
        if (!analyticsScavengeOk) console.error('  analytics scavenges ' + analyticsMinor + ' > 0 (the analytics write path churns the young gen)');
        process.exitCode = 1;
    }
}

main();

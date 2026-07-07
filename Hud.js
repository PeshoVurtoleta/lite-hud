// @zakkster/lite-hud 1.0.0
// Single-canvas zero-GC perf overlay. Preallocated ring-buffer tracks,
// composable sink API for any profiler, oscilloscope phosphor-green
// aesthetic, hotkey toggle. stats.js replacement that allocates nothing
// per frame.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Ring-buffer track -- the zero-GC primitive
// ---------------------------------------------------------------------------

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function createTrackState(name, opts) {
    const cap = pow2(opts.samples || 128);
    return {
        name: name,
        buf: new Float64Array(cap),
        mask: cap - 1,
        head: 0,
        count: 0,
        // display
        label: opts.label || name,
        unit: opts.unit !== undefined ? opts.unit : '',
        lo: opts.lo !== undefined ? opts.lo : null,
        hi: opts.hi !== undefined ? opts.hi : null,
        warnBelow: opts.warnBelow === true,
        color: opts.color || null,
        // pre-cached render strings (set during createHud)
        colorNorm: '',
        colorWarn: '',
        colorGood: '',
        // stats (computed during render, not per push)
        last: 0,
        min: 0,
        max: 0,
        avg: 0
    };
}

// ---------------------------------------------------------------------------
// Default palette -- oscilloscope phosphor-green, amber warn, cyan accent
// ---------------------------------------------------------------------------

// hex first, oklch second (browsers that ignore oklch fall back to hex)
const PALETTE = [
    ['#7df7c8', 'oklch(0.90 0.15 168)'],
    ['#4ecdc4', 'oklch(0.80 0.12 190)'],
    ['#bb86fc', 'oklch(0.73 0.17 300)'],
    ['#f7c87d', 'oklch(0.87 0.12 80)'],
    ['#87ceeb', 'oklch(0.83 0.09 230)'],
    ['#ff9f7f', 'oklch(0.78 0.14 40)']
];
const WARN_COLOR_HEX = '#ffb454';
const WARN_COLOR = 'oklch(0.82 0.15 68)';
const GOOD_COLOR_HEX = '#7df7c8';
const GOOD_COLOR = 'oklch(0.90 0.15 168)';
const BG_HEX = '#05100a';
const PANEL_HEX = '#0a1a10';
const GRID_HEX = '#1f6f4529';
const INK_DIM_HEX = '#3f9c78';
const INK_FAINT_HEX = '#2a6f56';

// Reusable dash patterns -- avoid Array allocation on every setLineDash call.
// The dash values scale with DPR, so we mutate the array's contents rather
// than allocate a new one; setLineDash reads the values immediately.
const DASH_PATTERN = [0, 0];
const EMPTY_DASH = [];

// ---------------------------------------------------------------------------
// createHud -- the public API
// ---------------------------------------------------------------------------

/**
 * Create a performance HUD overlay.
 *
 * @param {HTMLCanvasElement|null} canvas
 *   Canvas to render into. If null, one is created and appended to
 *   document.body with fixed positioning.
 * @param {object} [options]
 * @param {number} [options.width=280]
 * @param {number} [options.height]       Auto-computed from track count.
 * @param {string} [options.position='top-left']
 *   Corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'.
 * @param {string} [options.hotkey='`']   Key to toggle visibility.
 * @param {number} [options.zIndex=100000]
 * @param {boolean} [options.visible=true]
 * @returns {Hud}
 */
export function createHud(canvas, options) {
    const opts = options || {};
    const width = opts.width || 280;
    const position = opts.position || 'top-left';
    const hotkey = opts.hotkey || '`';
    const zIndex = opts.zIndex !== undefined ? opts.zIndex : 100000;

    const tracks = [];
    let visible = opts.visible !== false;
    let ownedCanvas = false;
    let el = canvas;
    let ctx = null;
    let dpr = 1;
    let CW = 1, CH = 1;
    let trackH = 0;
    const HEADER_H = 16;
    const TRACK_PAD = 4;
    const GRAPH_H = 32;

    // Cached font strings (rebuilt only on resize). Skipping the per-render
    // `(N * dpr) + 'px ui-monospace, monospace'` concat is one string alloc
    // saved per track per render.
    let fontLarge = '10px ui-monospace, monospace';
    let fontSmall = '8px ui-monospace, monospace';

    // Keyboard listener ref for cleanup
    let keyHandler = null;

    // matchMedia DPR watcher: when the user drags the browser window between
    // monitors with different pixel densities, `devicePixelRatio` changes and
    // the canvas becomes stretched/blurry unless we resize. The listener has
    // to be re-armed against the new DPR each time (matchMedia queries are
    // fixed to the value at construction).
    let dprMql = null;
    let dprChangeHandler = null;

    function ensureCanvas() {
        if (el) return;
        el = document.createElement('canvas');
        el.style.position = 'fixed';
        el.style.zIndex = String(zIndex);
        el.style.pointerEvents = 'none';
        setPosition();
        document.body.appendChild(el);
        ownedCanvas = true;
        watchDpr();
    }

    function setPosition() {
        if (!el) return;
        el.style.top = ''; el.style.bottom = '';
        el.style.left = ''; el.style.right = '';
        if (position.includes('top')) el.style.top = '8px';
        else el.style.bottom = '8px';
        if (position.includes('right')) el.style.right = '8px';
        else el.style.left = '8px';
    }

    function resize() {
        if (!el) return;
        dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
        trackH = HEADER_H + GRAPH_H + TRACK_PAD;
        const totalH = opts.height || Math.max(40, tracks.length * trackH + TRACK_PAD);
        el.style.width = width + 'px';
        el.style.height = totalH + 'px';
        el.width = Math.round(width * dpr);
        el.height = Math.round(totalH * dpr);
        CW = el.width;
        CH = el.height;
        ctx = el.getContext('2d');
        // Cache font strings so we don't concat on every render.
        fontLarge = (10 * dpr) + 'px ui-monospace, monospace';
        fontSmall = (8 * dpr) + 'px ui-monospace, monospace';
    }

    function installHotkey() {
        if (typeof document === 'undefined') return;
        keyHandler = function (ev) {
            if (ev.key === hotkey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                visible = !visible;
                if (el) el.style.display = visible ? '' : 'none';
            }
        };
        document.addEventListener('keydown', keyHandler);
    }

    function watchDpr() {
        if (typeof matchMedia === 'undefined' || typeof devicePixelRatio === 'undefined') return;
        // Tear down previous listener (each query is fixed to one DPR value).
        if (dprMql && dprChangeHandler) {
            dprMql.removeEventListener('change', dprChangeHandler);
        }
        dprMql = matchMedia('(resolution: ' + devicePixelRatio + 'dppx)');
        dprChangeHandler = function () {
            resize();
            watchDpr();  // re-arm against the new DPR
        };
        dprMql.addEventListener('change', dprChangeHandler);
    }

    // -----------------------------------------------------------------------
    // Track factory
    // -----------------------------------------------------------------------

    /**
     * Register a named track. Returns a track handle with a zero-GC
     * `push(value)` method.
     *
     * @param {string} name
     * @param {object} [trackOpts]
     * @param {string} [trackOpts.label]       Display label.
     * @param {string} [trackOpts.unit]        Unit suffix (e.g. 'ms', 'fps').
     * @param {number} [trackOpts.lo]          Low threshold.
     * @param {number} [trackOpts.hi]          High threshold.
     * @param {boolean} [trackOpts.warnBelow]  If true, warn when BELOW lo
     *   (e.g. fps drops). Default: warn when ABOVE hi.
     * @param {string} [trackOpts.color]       Override color (hex or oklch).
     * @param {number} [trackOpts.samples=128] Ring buffer size.
     * @returns {TrackHandle}
     */
    function track(name, trackOpts) {
        const tOpts = trackOpts || {};
        const st = createTrackState(name, tOpts);

        // Assign palette color if none given
        const ci = tracks.length % PALETTE.length;
        if (!st.color) {
            st.colorNorm = PALETTE[ci][1];
        } else {
            st.colorNorm = st.color;
        }
        st.colorWarn = WARN_COLOR;
        st.colorGood = GOOD_COLOR;

        tracks.push(st);

        // Resize to accommodate new track
        if (el) resize();

        // The handle: push is the ONLY hot-path method.
        // A single typed-array write + bitmask index. Zero allocation.
        const buf = st.buf;
        const mask = st.mask;

        const handle = {
            push: function (value) {
                // Guard against Infinity/-Infinity/NaN: a single Infinity would
                // lock st.max to Infinity, collapsing every bar's height to zero
                // until it dropped out of the ring buffer. NaN would poison the
                // computeStats sum. Silent drop is the right default; non-finite
                // values in a data series are always a caller bug and corrupting
                // the display of good data to preserve the bad signal is the
                // wrong tradeoff.
                if (!Number.isFinite(value)) return;
                buf[st.head & mask] = value;
                st.head++;
                if (st.count < (mask + 1)) st.count++;
                st.last = value;
            },
            peek: function () { return st.last; },
            get name() { return st.name; },
            get count() { return st.count; }
        };
        return handle;
    }

    // -----------------------------------------------------------------------
    // Render -- cold path, called at 10-15Hz
    // -----------------------------------------------------------------------

    function computeStats(st) {
        if (st.count === 0) return;
        const cap = st.mask + 1;
        let min = Infinity, max = -Infinity, sum = 0;
        for (let k = 0; k < st.count; k++) {
            const idx = (st.head - st.count + k + cap) & st.mask;
            const v = st.buf[idx];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
        }
        st.min = min; st.max = max; st.avg = sum / st.count;
    }

    function render() {
        if (!visible) return;
        if (!el) { ensureCanvas(); resize(); }
        if (!ctx) { ctx = el.getContext('2d'); }

        // Background
        ctx.clearRect(0, 0, CW, CH);
        ctx.fillStyle = PANEL_HEX;
        ctx.globalAlpha = 0.88;
        ctx.fillRect(0, 0, CW, CH);
        ctx.globalAlpha = 1.0;

        // Border
        ctx.strokeStyle = GRID_HEX;
        ctx.lineWidth = dpr;
        ctx.strokeRect(0.5, 0.5, CW - 1, CH - 1);

        const pad = TRACK_PAD * dpr;
        const headerH = HEADER_H * dpr;
        const graphH = GRAPH_H * dpr;
        const tH = headerH + graphH + pad;
        const dashSize = 3 * dpr;

        for (let ti = 0; ti < tracks.length; ti++) {
            const st = tracks[ti];
            computeStats(st);

            const yBase = pad + ti * tH;
            const graphY = yBase + headerH;
            const graphW = CW - pad * 2;

            // ---- header: label (left) + value (right, threshold-colored) ----
            ctx.font = fontLarge;
            ctx.textBaseline = 'top';

            let valColor = st.colorNorm;
            if (st.warnBelow && st.lo !== null && st.last < st.lo) {
                valColor = st.colorWarn;
            } else if (!st.warnBelow && st.hi !== null && st.last > st.hi) {
                valColor = st.colorWarn;
            } else if (st.warnBelow && st.lo !== null && st.last >= st.lo) {
                valColor = st.colorGood;
            } else if (!st.warnBelow && st.hi !== null && st.last <= st.hi) {
                valColor = st.colorGood;
            }

            // Label (left, default textAlign='start')
            ctx.textAlign = 'left';
            ctx.fillStyle = INK_DIM_HEX;
            ctx.fillText(st.label, pad, yBase);

            // Value (right-aligned; avoids measureText allocation)
            ctx.textAlign = 'right';
            ctx.fillStyle = valColor;
            ctx.fillText(
                st.unit ? formatVal(st.last) + ' ' + st.unit : formatVal(st.last),
                CW - pad, yBase
            );
            ctx.textAlign = 'left';

            // Min/avg/max (small, below label)
            if (st.count > 1) {
                ctx.font = fontSmall;
                ctx.fillStyle = INK_FAINT_HEX;
                ctx.fillText(
                    formatVal(st.min) + ' / ' + formatVal(st.avg) + ' / ' + formatVal(st.max),
                    pad, yBase + 11 * dpr
                );
            }

            // ---- graph background ----
            ctx.fillStyle = BG_HEX;
            ctx.fillRect(pad, graphY, graphW, graphH);

            // ---- threshold lines (reuse DASH_PATTERN; no per-call array alloc) ----
            if ((st.hi !== null || (st.lo !== null && st.warnBelow)) && st.max > 0) {
                DASH_PATTERN[0] = dashSize;
                DASH_PATTERN[1] = dashSize;
                ctx.strokeStyle = WARN_COLOR;
                ctx.lineWidth = dpr;
                ctx.setLineDash(DASH_PATTERN);
                if (st.hi !== null) {
                    const thY = graphY + graphH - (st.hi / st.max) * graphH;
                    if (thY > graphY && thY < graphY + graphH) {
                        ctx.beginPath();
                        ctx.moveTo(pad, thY);
                        ctx.lineTo(pad + graphW, thY);
                        ctx.stroke();
                    }
                }
                if (st.lo !== null && st.warnBelow) {
                    const thY = graphY + graphH - (st.lo / st.max) * graphH;
                    if (thY > graphY && thY < graphY + graphH) {
                        ctx.beginPath();
                        ctx.moveTo(pad, thY);
                        ctx.lineTo(pad + graphW, thY);
                        ctx.stroke();
                    }
                }
                ctx.setLineDash(EMPTY_DASH);
            }

            // ---- bars ----
            if (st.count > 0) {
                const cap = st.mask + 1;
                const barW = graphW / cap;
                const range = st.max > 0 ? st.max : 1;

                for (let k = 0; k < st.count; k++) {
                    const idx = (st.head - st.count + k + cap) & st.mask;
                    const v = st.buf[idx];
                    const h = (v / range) * graphH;
                    const x = pad + k * barW;

                    // Color: warn if over hi (or under lo when warnBelow)
                    let warn = false;
                    if (st.warnBelow && st.lo !== null && v < st.lo) warn = true;
                    else if (!st.warnBelow && st.hi !== null && v > st.hi) warn = true;

                    ctx.fillStyle = warn ? st.colorWarn : st.colorNorm;
                    ctx.globalAlpha = 0.8;
                    ctx.fillRect(x, graphY + graphH - h, Math.max(1, barW - dpr), h);
                }
                ctx.globalAlpha = 1.0;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Destroy
    // -----------------------------------------------------------------------

    function destroy() {
        if (keyHandler && typeof document !== 'undefined') {
            document.removeEventListener('keydown', keyHandler);
            keyHandler = null;
        }
        if (dprMql && dprChangeHandler) {
            dprMql.removeEventListener('change', dprChangeHandler);
            dprMql = null;
            dprChangeHandler = null;
        }
        if (ownedCanvas && el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
        el = null; ctx = null;
        tracks.length = 0;
    }

    // -----------------------------------------------------------------------
    // Public surface
    // -----------------------------------------------------------------------

    // Install the hotkey immediately so it works even when the HUD starts
    // invisible (otherwise the keydown listener would never be attached, and
    // the user couldn't toggle the HUD on via keyboard).
    installHotkey();

    return {
        track: track,
        render: render,
        resize: resize,
        destroy: destroy,
        get visible() { return visible; },
        set visible(v) {
            visible = v;
            if (el) el.style.display = v ? '' : 'none';
        },
        get trackCount() { return tracks.length; },
        get canvas() { return el; }
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVal(v) {
    if (v !== v) return '--';  // NaN
    if (v === 0) return '0';
    if (Math.abs(v) >= 1000) return Math.round(v).toString();
    if (Math.abs(v) >= 10) return v.toFixed(1);
    if (Math.abs(v) >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

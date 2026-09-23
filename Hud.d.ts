// @zakkster/lite-hud 2.2.0
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export declare const VERSION: string;

// ---------------------------------------------------------------------------
// SPP protocol surface (duck-typed, no runtime import of lite-scope)
// ---------------------------------------------------------------------------

export interface SppSink {
  write(packed: number, t: number, a: number, b: number): void;
}

export interface StreamOpDescriptor {
  code: number;
  name?: string;
  /** 0 = LEVEL | 1 = INSTANT | 2 = SPAN | 3 = COUNTER */
  kind?: 0 | 1 | 2 | 3;
  /** CONT chain depth + 1. Defaults to 1. */
  width?: number;
  /** True for open and close ops of a paired span channel. */
  paired?: boolean;
  /**
   * LEVEL opt-in for quantile analytics (M2). `true` uses the createHud default
   * `stats.quantiles` factory; a factory uses that instance. Ignored on non-LEVEL
   * ops (SPAN is auto-sketched when a factory is injected; INSTANT/COUNTER never).
   */
  quantiles?: boolean | QuantileFactory;
}

export interface StreamDescriptor {
  /** Dense id assigned by scope.register(). */
  id: number;
  name?: string;
  unit?: string;
  hz?: number;
  ops: StreamOpDescriptor[];
}

export interface HudScope {
  streams(): StreamDescriptor[];
  /** Reverse intern lookup: internId -> channel name string. */
  label(internId: number): string | null;
  /**
   * Registers the HUD as a live sink. Optional -- if omitted, the HUD is
   * still populated by direct hud.write() calls.
   */
  addSink?(sink: SppSink): void;
  removeSink?(sink: SppSink): void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PushHandle {
  /**
   * Synthesize an SPP record and inject it directly into the HUD's demux.
   *
   * - KIND_LEVEL / KIND_COUNTER: push(value) -> t=now, a=value
   * - KIND_INSTANT:              push()       -> t=now, a=0
   * - KIND_SPAN (complete):      push(durationMs) -> t=now-dur, a=dur (D5 layout)
   */
  push(value?: number): void;
}

export interface ChannelDescriptor {
  name?: string;
  unit?: string;
  /** Declared sample rate. Controls ring capacity (hz * windowSec records). */
  hz?: number;
  /** 0 = LEVEL | 1 = INSTANT | 2 = SPAN (complete) | 3 = COUNTER. Defaults to 0. */
  kind?: 0 | 1 | 2 | 3;
  /**
   * Per-channel quantile-analytics override (M2). A `() => DDSketch` factory opts
   * this channel IN (SPAN or LEVEL only; a factory on INSTANT/COUNTER throws);
   * `false` opts it OUT even when a createHud default is set. Undefined inherits
   * the default, which auto-enables SPAN only (LEVEL analytics are opt-in).
   */
  quantiles?: QuantileFactory | false;
}

export interface BudgetDescriptor {
  /** Matches channel by exact name string. */
  channel: string;
  threshold: number;
  label?: string;
}

export interface AttachOptions {
  /**
   * Inline budget thresholds applied at attach time.
   * Also transported via BUDGET_SET (0x0F41) meta records at run time.
   */
  budgets?: BudgetDescriptor[];
}

export interface ChannelStats {
  name: string;
  count: number;
  head: number;
}

export interface HudStats {
  drops: number;
  channels: number;
  epoch: number | null;
  verdicts: number;
  budgets: number;
  /**
   * Sum of per-channel values rejected by the analytics pre-check (never reached
   * the injected sketch's add()). Separate from `drops` (demux rejections);
   * always 0 when no quantile factory is injected.
   */
  quantileDrops: number;
  channelStats: ChannelStats[];
}

/** Windowed quantile readout for a sketched channel (empty window -> n:0, NaN). */
export interface QuantileReadout {
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  /** Values summarised in the current merged window (0 = empty). */
  n: number;
}

export interface InspectResult {
  /** Total records written (may exceed ring capacity). */
  count: number;
  /** Slots of the most recent ring record. */
  last: { t: number; a: number; b: number };
  /** Present only for a channel with quantile analytics enabled. */
  quantiles?: QuantileReadout;
}

export type HudPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/**
 * A `@zakkster/lite-viewport`-style Viewport CLASS (a constructor). The HUD owns
 * the canvas and passes `{ canvas, maxDpr, onResize }`; it reads `.ctx` / `.dpr`
 * and calls `.resize()` / `.destroy()`.
 */
export interface ViewportInstance {
  ctx: CanvasRenderingContext2D;
  dpr: number;
  resize(): void;
  destroy(): void;
}
export interface ViewportOptions {
  canvas: HTMLCanvasElement;
  maxDpr?: number;
  onResize?: (width: number, height: number, dpr: number) => void;
}
export type ViewportClass = new (opts: ViewportOptions) => ViewportInstance;

/**
 * A `@zakkster/lite-sketch` >= 1.1.0 DDSketch instance (duck-typed; the HUD never
 * imports lite-sketch). The hot path calls the ZERO-BOX `addFrom(buf, i)` (a
 * fractional value passed as an `add(value)` argument would box); render/inspect
 * call `clear`/`merge`/`quantile` and read `count`. Validation uses the getters:
 * `strict` (a strict-range sketch is rejected fail-closed) and the accepted band
 * `minIndexable` (EXCLUSIVE floor) .. `maxIndexable` (INCLUSIVE ceiling).
 */
export interface QuantileSketch {
  /** Zero-box hot entry: add the value at buf[i] (read unboxed inside the peer). */
  addFrom(buf: Float64Array, i: number): unknown;
  quantile(q: number): number;
  merge(other: QuantileSketch): unknown;
  clear(): unknown;
  /** True for a strict fixed-range sketch (rejected by the HUD, fail-closed). */
  readonly strict: boolean;
  /** Smallest x > 0 that add accepts (EXCLUSIVE floor). */
  readonly minIndexable: number;
  /** Largest x that add accepts (INCLUSIVE ceiling). */
  readonly maxIndexable: number;
  readonly count: number;
}
/** A factory returning a fresh collapsing DDSketch (a strict-range one throws). */
export type QuantileFactory = () => QuantileSketch;

/** Injected analytics factories (M2 uses `quantiles`; more land in later milestones). */
export interface HudStatsOptions {
  /** `() => DDSketch` for per-channel p50/p90/p99/p99.9 readouts + a p50-p99 band. */
  quantiles?: QuantileFactory;
}

export interface HudOptions {
  position?: HudPosition;
  /**
   * Optional analytics factories (M2: `stats.quantiles`, a `() => DDSketch`
   * factory). Injected, never imported; validated typeof-first, fail-closed. A
   * SPAN channel is auto-sketched; LEVEL is opt-in (per-channel or op override).
   */
  stats?: HudStatsOptions;
  /** Key that toggles overlay visibility. Default: '`'. Set '' to disable. */
  hotkey?: string;
  zIndex?: number;
  /** Width of the scrolling time window in seconds. Default: 5. */
  windowSec?: number;
  /**
   * Optional DPR-aware renderer: a Viewport CLASS (constructor function). When
   * given, the HUD creates a sized wrapper `<div>` + canvas, constructs
   * `new viewport({ canvas, maxDpr, onResize })`, and renders through its
   * `ctx` / `dpr`. Omitted -> the inline DPR fallback path. Must be a function;
   * anything else throws (`@zakkster/lite-hud:` prefix), fail-closed.
   */
  viewport?: ViewportClass;
  /**
   * Cap devicePixelRatio for the backing store (a 3x phone triples fill-rate
   * for no visible gain). A finite number >= 1, or Infinity (no cap; default).
   * Applies to both the injected viewport and the inline fallback. Anything
   * else throws (`@zakkster/lite-hud:` prefix), fail-closed.
   */
  maxDpr?: number;
}

export interface Hud extends SppSink {
  // Scope integration
  attach(scope: HudScope, opts?: AttachOptions): void;

  // Manual channel (D4 polyfill -- no scope required)
  channel(desc: ChannelDescriptor): PushHandle;

  // Inspection
  stats(): HudStats;
  /**
   * Returns the most recent record for a named channel, or null if the
   * channel does not exist or has received no data.
   * Cold path; allocates. Not for use on frame-loop hot paths.
   */
  inspect(name: string): InspectResult | null;

  // Rendering
  /** Draw all visible channels onto the overlay canvas. Call at ~10-15 Hz. */
  render(): void;

  // Overlay chrome
  show(): void;
  hide(): void;
  destroy(): void;
  readonly visible: boolean;
}

/**
 * Create an SPP-native HUD overlay.
 *
 * @param mountEl  DOM element to append the canvas to, or null (headless /
 *                 test mode -- all DOM/canvas ops are skipped).
 * @param opts     Optional configuration.
 */
export function createHud(mountEl: HTMLElement | null, opts?: HudOptions): Hud;

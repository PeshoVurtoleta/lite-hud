// @zakkster/lite-hud 2.0.0
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
  channelStats: ChannelStats[];
}

export interface InspectResult {
  /** Total records written (may exceed ring capacity). */
  count: number;
  /** Slots of the most recent ring record. */
  last: { t: number; a: number; b: number };
}

export type HudPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export interface HudOptions {
  position?: HudPosition;
  /** Key that toggles overlay visibility. Default: '`'. Set '' to disable. */
  hotkey?: string;
  zIndex?: number;
  /** Width of the scrolling time window in seconds. Default: 5. */
  windowSec?: number;
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

export declare const VERSION: string;

export interface TrackOptions {
    /** Display label. Defaults to the track name. */
    label?: string;
    /** Unit suffix shown after the current value (e.g. 'ms', 'fps'). */
    unit?: string;
    /** Low threshold. Used with warnBelow for FPS-style metrics. */
    lo?: number;
    /** High threshold. Values above this are rendered in warn color. */
    hi?: number;
    /** If true, warn when value drops BELOW lo (e.g. FPS). Default: warn above hi. */
    warnBelow?: boolean;
    /** Override color (hex or oklch string). */
    color?: string;
    /** Ring buffer size (rounded up to power of two). Default 128. */
    samples?: number;
}

export interface TrackHandle {
    /**
     * Push a new sample value. This is the HOT PATH -- a single
     * typed-array write plus a bitmask index. Zero allocation.
     */
    push(value: number): void;
    /** Return the most recently pushed value. */
    peek(): number;
    /** Track name. */
    readonly name: string;
    /** Number of samples in the ring buffer (caps at capacity). */
    readonly count: number;
}

export interface HudOptions {
    /** Canvas width in CSS pixels. Default 280. */
    width?: number;
    /** Canvas height in CSS pixels. Auto-computed from track count if omitted. */
    height?: number;
    /** Corner position. Default 'top-left'. */
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    /** Keyboard key to toggle visibility. Default '`'. */
    hotkey?: string;
    /** CSS z-index. Default 100000. */
    zIndex?: number;
    /** Initial visibility. Default true. */
    visible?: boolean;
}

export interface Hud {
    /**
     * Register a named track. Returns a handle with a zero-GC push method.
     */
    track(name: string, options?: TrackOptions): TrackHandle;
    /**
     * Render all tracks to the canvas. Call at 10-15Hz (cold path).
     */
    render(): void;
    /**
     * Recompute canvas size for the current `devicePixelRatio`. Called
     * automatically on track registration and when the browser's DPR
     * changes (window dragged between monitors). Call manually if you
     * change the container or need to force a resize.
     */
    resize(): void;
    /** Remove the canvas, keyboard listener, and clear tracks. */
    destroy(): void;
    /** Current visibility state. */
    visible: boolean;
    /** Number of registered tracks. */
    readonly trackCount: number;
    /** The canvas element (null before first render if auto-created). */
    readonly canvas: HTMLCanvasElement | null;
}

/**
 * Create a performance HUD overlay.
 *
 * @param canvas  Canvas to render into. If null, one is created and appended
 *                to document.body with fixed positioning.
 * @param options  HUD configuration.
 */
export function createHud(canvas: HTMLCanvasElement | null, options?: HudOptions): Hud;

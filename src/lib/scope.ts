// Pure oscilloscope helpers for the EEG ACTIVITY trace — no DOM, no I/O.
//
// The old drawRaw plotted one lineTo vertex per sample over a per-frame peak
// auto-gain, so at 2000 SPS ~8000 vertices overplotted into a solid band and the
// gain always stretched the loudest sample to ~87 % of half-height — in-band noise
// filled the screen no matter how quiet the signal truly was. These helpers give
// the renderer proper scope semantics: min/max decimation, a robust autoset, and a
// fast-attack/slow-release envelope for AUTO vertical mode.

/** Horizontal SWEEP options in seconds; the header prints sweep/8 as s/div. */
export const SWEEP_SEC = [1, 2, 4, 8, 10] as const;
export type SweepSec = (typeof SWEEP_SEC)[number];

/** Vertical µV/DIV rungs, low→high. AUTOSET snaps the trace to one of these. */
export const UV_PER_DIV = [2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
export type UvPerDiv = (typeof UV_PER_DIV)[number];

/** The raw-trace graticule has 4 rows, so the trace spans +/-2 divisions from centre. */
export const V_DIVS = 4;

export interface Column {
	min: number;
	max: number;
}

/**
 * Reduce `data` to exactly `cols` [min,max] pairs, one per pixel column.
 * At 2000 SPS a 4 s window is 8000 samples in ~560 px; drawing one lineTo per
 * sample overplots into a solid band. Drawing the per-column min/max as a vertical
 * segment preserves transients at any decimation ratio.
 * When data.length <= cols, returns data.length columns with min === max (the caller
 * then draws a polyline instead of segments).
 */
export function minMaxDecimate(data: ArrayLike<number>, cols: number): Column[] {
	const n = data.length;
	if (cols <= 0 || n === 0) return [];

	// Fewer samples than columns: nothing to decimate, hand back one point per
	// sample so the renderer can draw a polyline (min === max marks the degenerate case).
	if (n <= cols) {
		const out: Column[] = new Array(n);
		for (let i = 0; i < n; i++) {
			const v = data[i];
			out[i] = { min: v, max: v };
		}
		return out;
	}

	const out: Column[] = new Array(cols);
	for (let c = 0; c < cols; c++) out[c] = { min: Infinity, max: -Infinity };
	// floor(i*cols/n) assigns every sample to exactly one column; because the span
	// n/cols >= 1 when n > cols, each column receives at least one sample, so no
	// column is left at its ±Infinity sentinel.
	for (let i = 0; i < n; i++) {
		const c = Math.floor((i * cols) / n);
		const col = out[c];
		const v = data[i];
		if (v < col.min) col.min = v;
		if (v > col.max) col.max = v;
	}
	return out;
}

/** p-th percentile (0..1) of |v|. Robust peak: a lone spike must not set the gain. */
export function percentileAbs(data: ArrayLike<number>, p: number): number {
	const n = data.length;
	if (n === 0) return 0;
	const abs = new Array<number>(n);
	for (let i = 0; i < n; i++) abs[i] = Math.abs(data[i]);
	abs.sort((a, b) => a - b);
	const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
	return abs[idx];
}

/** Smallest UV_PER_DIV rung whose +/-(V_DIVS/2) divisions contain the 99.5th-pct |v|. */
export function autosetUvPerDiv(data: ArrayLike<number>): UvPerDiv {
	// 99.5th percentile, not the max: a single motion/blink spike must not blow the
	// gain out to 1000 µV/div and flatten the real signal.
	const peak = percentileAbs(data, 0.995);
	const halfSpan = V_DIVS / 2;
	for (const rung of UV_PER_DIV) {
		if (rung * halfSpan >= peak) return rung;
	}
	// Nothing on the ladder contains it (peak > 2000 µV): clamp to the largest rung.
	return UV_PER_DIV[UV_PER_DIV.length - 1];
}

/**
 * Fast-attack / slow-release envelope for AUTO vertical mode. Returns the new envelope.
 * The old code took the instantaneous per-frame peak, so one spike collapsed the trace
 * and in-band noise always filled the screen.
 */
export function autoEnvelope(prev: number, peak: number, attack = 0.5, release = 0.02): number {
	// A NaN/Infinity peak (e.g. an empty frame or a divide-by-zero upstream) must not
	// poison the retained envelope — hold the last good value instead.
	if (!Number.isFinite(peak)) return prev;
	// Rise fast toward a louder peak, decay slowly away from it, so a transient no
	// longer collapses the trace and a quiet signal is allowed to stay small.
	const coef = peak > prev ? attack : release;
	return prev + (peak - prev) * coef;
}

// Focus estimation from a raw EEG sample stream.
//
// The score is the **engagement index** of Pope, Bogart & Bartolome (1995),
// "Biocybernetic system evaluates indices of operator engagement in automated task",
// Biological Psychology 40(1-2):187-195 (PMID 7647180):
//
//     E = beta / (alpha + theta)
//
// Pope compared four candidate indices under closed-loop feedback and this one tracked
// task engagement best. It is the ratio neurofocus.dev is built on.
//
// E is an unbounded positive ratio, so it cannot be shown as 0-100 directly. We map it
// through a logistic in log-ratio against a **per-user baseline** E0 measured once at the
// start of a session:
//
//     score = 100 / (1 + (E0/E)^k)
//
// which is exactly 50 when E == E0, 66.7 at 2x baseline (k=1), and is monotone and bounded.
// The baseline is FROZEN after calibration, never rolling — a rolling baseline would drag
// the score back to 50 forever and erase the very drift we want to see.

import * as dsp from './dsp';
import type { BandName } from './dsp';

export interface FocusMetrics {
	/** Raw Pope engagement index, beta/(alpha+theta). Unbounded, > 0. */
	engagement: number;
	/**
	 * 0..100. 50 == this user's own calibration baseline; it is NOT comparable between
	 * people or between sessions with different baselines. Meaningless while `calibrating`.
	 */
	focus: number;
	/** 0..100 alpha share of theta+alpha+beta. A relaxation cue, NOT `100 - focus`. */
	calm: number;
	/** Blinks seen since the last reset. */
	blinks: number;
	/** Band powers of the current window (µV²/Hz, integrated). */
	bands: Record<BandName, number>;
	/** Dominant frequency in 6–14 Hz, or null before the window fills. */
	alphaPeak: number | null;
	/** Broadband RMS of the band-passed signal (µV). */
	rmsUv: number;
	/** False when the trace is essentially flat — electrode off, or nothing connected. */
	signalOk: boolean;
	/** True while the analysis window is still filling; nothing is meaningful yet. */
	warmingUp: boolean;
	/** True until the baseline E0 has been established. `focus` is not usable yet. */
	calibrating: boolean;
	/** Seconds of good signal still needed before calibration completes. */
	calibrationLeftSec: number;
	/** The frozen baseline engagement, once known. */
	baseline: number | null;
}

export interface FocusEngineOptions {
	/** Mains frequency for the notch: 60 in the Americas, 50 most elsewhere. */
	line?: number;
	/** Seconds of history the band powers are computed over. */
	windowSec?: number;
	/** Smoothing on the score. 0 = none, 0.9 = very sluggish. */
	smoothing?: number;
	/** Seconds of good signal used to establish the baseline E0. */
	calibrationSec?: number;
	/** Logistic steepness. Larger = more of the 0-100 range used for the same ratio swing. */
	k?: number;
	/**
	 * Skip calibration and use this as E0. For tests, and for restoring a saved per-user
	 * baseline so a returning player doesn't recalibrate.
	 */
	baselineEngagement?: number;
	/** A blink must exceed both this many baseline RMS and `blinkFloorUv`. */
	blinkK?: number;
	blinkFloorUv?: number;
	onBlink?: () => void;
}

const EMPTY_BANDS: Record<BandName, number> = {
	delta: 0,
	theta: 0,
	alpha: 0,
	beta: 0,
	gamma: 0
};

/** Guard against alpha+theta -> 0 (a detached electrode) making E explode. */
const DENOM_FLOOR = 1e-9;

/**
 * Streaming engagement-index estimator.
 *
 * Two independent filter chains run over the same samples, because the bands that carry
 * blinks and the bands that carry rhythms are opposites:
 *
 * - **analysis chain, 1–45 Hz + mains notch** — feeds Welch → band powers → engagement.
 * - **blink chain, 0.5–6 Hz + mains notch** — the eye-movement (EOG) band. This is the
 *   recipe the firmware's own `live_alpha_monitor.py --blink` uses, and it is by far the
 *   most reliable proof that the electrodes are actually on a head.
 *
 * ## What this number is worth
 *
 * This is ONE ear/forehead-referenced channel. Beta (13–30 Hz) overlaps jaw, temporalis and
 * neck EMG, so clenching your teeth raises "focus" exactly like concentrating does. A single
 * channel cannot separate them. Treat the score as a within-session, within-user relative
 * signal. It is not a measurement of anyone's cognition, and it is not comparable across
 * people. `signalOk` and `calibrating` exist so the UI can refuse to show a number it has
 * not earned — use them.
 */
export class FocusEngine {
	private readonly fs: number;
	private readonly opts: Required<Omit<FocusEngineOptions, 'onBlink' | 'baselineEngagement'>> &
		Pick<FocusEngineOptions, 'onBlink' | 'baselineEngagement'>;

	private analysis: dsp.FilterChain;
	private blinkChain: dsp.FilterChain;

	/** Band-passed µV history, capped at `windowSec`. */
	private buf: number[] = [];
	private cap: number;
	private nperseg: number;

	private emaSq = 0; // slow baseline power for the adaptive blink threshold
	private refractory = 0;
	private readonly refractorySamples: number;

	private scoreEma = 0;
	private scorePrimed = false;
	private calmEma = 0;
	private sinceUpdate = 0;
	private readonly updateEvery: number;
	private seen = 0;

	/** Engagement samples collected during calibration, median-reduced into `baseline`. */
	private calSamples: number[] = [];
	private baseline: number | null = null;
	private readonly calNeeded: number;

	private metrics: FocusMetrics;

	constructor(fs: number, options: FocusEngineOptions = {}) {
		this.fs = fs;
		this.opts = {
			line: options.line ?? 60,
			windowSec: options.windowSec ?? 3,
			smoothing: options.smoothing ?? 0.72,
			calibrationSec: options.calibrationSec ?? 20,
			k: options.k ?? 1.5,
			blinkK: options.blinkK ?? 4.0,
			blinkFloorUv: options.blinkFloorUv ?? 8,
			baselineEngagement: options.baselineEngagement,
			onBlink: options.onBlink
		};
		this.analysis = dsp.makeChain(fs, { lo: 1, hi: 45, line: this.opts.line });
		this.blinkChain = dsp.makeChain(fs, { lo: 0.5, hi: 6, line: this.opts.line });
		this.cap = Math.max(64, Math.round(fs * this.opts.windowSec));
		// Enough resolution to separate alpha (8–13) from beta (13–30) at any of our rates.
		this.nperseg = Math.min(dsp.nextPow2(Math.round(fs * 1.4)), dsp.nextPow2(this.cap) / 2);
		this.refractorySamples = Math.round(0.3 * fs);
		this.updateEvery = Math.max(1, Math.round(fs / 8)); // recompute bands ~8x/sec
		// Engagement is recomputed at `updateEvery`, so the calibration budget is in updates.
		this.calNeeded = Math.max(1, Math.round(this.opts.calibrationSec * 8));
		if (this.opts.baselineEngagement !== undefined) this.baseline = this.opts.baselineEngagement;
		this.metrics = this.blankMetrics();
	}

	private blankMetrics(): FocusMetrics {
		return {
			engagement: 0,
			focus: 0,
			calm: 0,
			blinks: 0,
			bands: { ...EMPTY_BANDS },
			alphaPeak: null,
			rmsUv: 0,
			signalOk: false,
			warmingUp: true,
			calibrating: this.baseline === null,
			calibrationLeftSec: this.baseline === null ? this.opts.calibrationSec : 0,
			baseline: this.baseline
		};
	}

	/** Feed one sample, already converted to µV. */
	push(uv: number): void {
		const y = this.analysis.step(uv);
		this.buf.push(y);
		if (this.buf.length > this.cap) this.buf.shift();
		this.seen++;

		const b = this.blinkChain.step(uv);
		// Slow baseline, so an occasional blink barely moves its own threshold.
		this.emaSq = this.emaSq * 0.9975 + b * b * 0.0025;
		const baselineRms = Math.sqrt(this.emaSq);
		if (this.refractory > 0) {
			this.refractory--;
		} else if (
			this.seen > this.fs && // let the baseline settle before arming
			Math.abs(b) > Math.max(this.opts.blinkFloorUv, this.opts.blinkK * baselineRms)
		) {
			this.metrics.blinks++;
			this.refractory = this.refractorySamples;
			this.opts.onBlink?.();
		}

		if (++this.sinceUpdate >= this.updateEvery) {
			this.sinceUpdate = 0;
			this.recompute();
		}
	}

	/** Feed a batch of raw ADC counts, converting with the given profile. */
	pushCounts(counts: number[], scale: dsp.ScaleSettings): void {
		for (const c of counts) this.push(dsp.countsToUv(c, scale));
	}

	read(): FocusMetrics {
		return this.metrics;
	}

	/** The band-passed trace, for drawing. */
	trace(n: number): number[] {
		return this.buf.slice(-Math.min(n, this.buf.length));
	}

	/** Restart, optionally keeping a known baseline so the user needn't recalibrate. */
	reset(keepBaseline = false): void {
		this.analysis.reset();
		this.blinkChain.reset();
		this.buf.length = 0;
		this.emaSq = 0;
		this.refractory = 0;
		this.scoreEma = 0;
		this.scorePrimed = false;
		this.calmEma = 0;
		this.sinceUpdate = 0;
		this.seen = 0;
		this.calSamples = [];
		if (!keepBaseline) this.baseline = this.opts.baselineEngagement ?? null;
		this.metrics = this.blankMetrics();
	}

	/** Map an engagement ratio onto 0..100 against the frozen baseline. */
	private scoreFor(e: number, e0: number): number {
		if (e <= 0) return 0;
		if (e0 <= 0) return 50;
		// 100 / (1 + (e0/e)^k) — a logistic in log(e/e0), so 50 exactly at baseline.
		return 100 / (1 + Math.pow(e0 / e, this.opts.k));
	}

	private recompute(): void {
		// welch() rounds nperseg up to a power of two and needs that many samples.
		if (this.buf.length < dsp.nextPow2(this.nperseg)) return;
		const seg = Float64Array.from(this.buf);
		const { freqs, psd } = dsp.welch(seg, this.fs, this.nperseg, 0.75);
		const bands = dsp.bandPowers(freqs, psd);

		let sq = 0;
		for (const v of this.buf) sq += v * v;
		const rmsUv = Math.sqrt(sq / this.buf.length);
		// Below ~1.5 µV RMS after a 1–45 Hz band-pass there is no biosignal at all, only
		// the ADC's own noise floor.
		const signalOk = rmsUv > 1.5;

		// The Pope engagement index.
		const engagement = bands.beta / Math.max(DENOM_FLOOR, bands.alpha + bands.theta);

		// Calm keeps the bounded share form: it is a relaxation cue, not 100 - focus.
		const active = bands.theta + bands.alpha + bands.beta;
		const k = this.opts.smoothing;
		if (active > 1e-12) this.calmEma = this.calmEma * k + (bands.alpha / active) * (1 - k);

		// Only trust engagement while the electrode is actually reading a biosignal. With a
		// detached electrode alpha+theta collapse to the noise floor and E explodes, which
		// would otherwise read as perfect concentration.
		if (signalOk) {
			if (this.baseline === null) {
				this.calSamples.push(engagement);
				if (this.calSamples.length >= this.calNeeded) {
					// Median, not mean: robust to the blink and movement spikes that always
					// contaminate the first seconds of a session.
					const sorted = [...this.calSamples].sort((a, b) => a - b);
					const mid = sorted.length >> 1;
					this.baseline = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
				}
			} else {
				const s = this.scoreFor(engagement, this.baseline);
				// Prime on the first real reading so the score doesn't crawl up from 0.
				this.scoreEma = this.scorePrimed ? this.scoreEma * k + s * (1 - k) : s;
				this.scorePrimed = true;
			}
		}

		const calibrating = this.baseline === null;
		this.metrics = {
			engagement,
			focus: calibrating ? 0 : this.scoreEma,
			calm: Math.min(100, this.calmEma * 160),
			blinks: this.metrics.blinks,
			bands,
			alphaPeak: dsp.peakFreq(freqs, psd, 6, 14),
			rmsUv,
			signalOk,
			warmingUp: false,
			calibrating,
			calibrationLeftSec: calibrating
				? Math.max(0, (this.calNeeded - this.calSamples.length) / 8)
				: 0,
			baseline: this.baseline
		};
	}
}

/**
 * Score at or above this counts as "in flow". 50 is the user's own baseline, so 60 means
 * "meaningfully above your own resting engagement", not an absolute standard.
 */
export const FLOW_THRESHOLD = 60;

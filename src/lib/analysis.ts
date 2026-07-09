// Post-session analysis: was this player focused, and did losing focus precede their deaths?
//
// The headline claim ("your focus was X points lower in the seconds before you died") is easy
// to compute and easy to get wrong. Everything below exists to keep it honest.
//
// ## The traps, and what we do about each
//
// 1. **The focus estimate lags.** A 3 s Welch window plus smoothing means the number at time
//    t reflects brain state around t-2 s. A window that ends at the death instant is really
//    reading the moments after it. So every pre-death window ends LAG_SEC before the death.
//
// 2. **The death itself contaminates the signal.** Frustration, a jaw clench, a hand jerk —
//    all put power in beta (13-30 Hz overlaps temporalis EMG). Post-death samples must never
//    enter a "before" window.
//
// 3. **Deaths cluster, and this is the one that kills naive implementations.** In an
//    auto-runner that restarts from the beginning, deaths land ~2-4 s apart. A 4 s window
//    reaching back from death `i` routinely CONTAINS death `i-1` and its aftermath. A
//    per-death lag guard does nothing about that: it only shields the current death. We mask
//    a guard interval after EVERY death, globally, and discard any pre-death window that
//    overlaps another death's mask. Windows that survive are the only ones we use.
//
// 4. **Autocorrelation.** Focus is sampled at 4 Hz over a 3 s analysis window, so adjacent
//    samples share ~90% of their data. A per-sample t-test over them manufactures
//    significance from nothing. The null distribution is therefore built by resampling whole
//    windows (block permutation), not samples.
//
// 5. **Forking paths.** The window length, the lag, and the mask are FIXED constants below.
//    They are not tuned per session, and no alternative is tried and then reported.
//
// 6. **Confounding.** A hard section of the level both causes deaths and depresses measured
//    focus (disengagement, or EMG). Deaths also recur at the same spot. So even a clean,
//    significant result is a within-session temporal association, never evidence of cause.
//    `verdictText()` says so, every time.

import { FLOW_THRESHOLD } from './focus';
import { mulberry32 } from './game';

/** Pre-registered constants. Changing these per session would be p-hacking. */
export const PRE_WINDOW_SEC = 4; // length of the "before the death" window
export const LAG_SEC = 2.5; // window ends this long before the death (estimator lag)
export const DEATH_MASK_SEC = 2.5; // samples this long after ANY death are contaminated
export const MIN_CLEAN_DEATHS = 3; // fewer than this and we refuse to run the test
const PERMUTATIONS = 2000;
/** Fixed so the same session always yields the same p-value. */
const PERMUTATION_SEED = 0x5eed;

export interface FocusSample {
	/** Seconds since session start. */
	t: number;
	focus: number;
	calm: number;
	/** Whether the electrode was reading a biosignal at this instant. */
	signalOk: boolean;
	/** Whether the score was still calibrating (focus not yet meaningful). */
	calibrating: boolean;
}

export type Verdict = 'insufficient' | 'no-association' | 'association';

export interface DeathAnalysis {
	verdict: Verdict;
	/** Deaths recorded in the session. */
	deaths: number;
	/** Deaths whose pre-death window was clean enough to use. */
	cleanWindows: number;
	/** Mean focus across the clean pre-death windows. */
	preDeathMean: number;
	/** Mean focus across all usable samples outside any death's neighbourhood. */
	baselineMean: number;
	/** preDeathMean - baselineMean. Negative means focus sagged before deaths. */
	delta: number;
	/** Two-sided p from a block-permutation test, or null when not run. */
	p: number | null;
}

export interface SessionReport {
	durationSec: number;
	/** Usable focus samples (signal present, calibration finished). */
	usableSamples: number;
	meanFocus: number;
	peakFocus: number;
	meanCalm: number;
	/** Share of usable time at or above FLOW_THRESHOLD. */
	timeInFlowPct: number;
	/** Longest unbroken run at or above FLOW_THRESHOLD, in seconds. */
	longestFlowSec: number;
	/**
	 * Least-squares slope of focus against time, in points per minute. Negative is the
	 * classic vigilance decrement — fading over a long session.
	 */
	focusTrendPerMin: number;
	/**
	 * Share of the session whose focus could not be used — electrode off OR still
	 * calibrating. Not the same as "signal lost": a clean electrode still contributes
	 * unusable samples during the baseline window.
	 */
	unusablePct: number;
	deaths: DeathAnalysis;
	/** Game stats, passed through. */
	attempts: number;
	bestProgressPct: number;
	blinks: number;
}

const usable = (s: FocusSample): boolean => s.signalOk && !s.calibrating;

function mean(xs: number[]): number {
	if (!xs.length) return 0;
	let a = 0;
	for (const x of xs) a += x;
	return a / xs.length;
}

/** Mean focus of every usable sample in [a, b). Null when the window has no usable data. */
function windowMean(samples: FocusSample[], a: number, b: number): number | null {
	const xs: number[] = [];
	for (const s of samples) {
		if (s.t >= a && s.t < b && usable(s)) xs.push(s.focus);
	}
	// Demand most of the window: a couple of stray samples is not a measurement.
	// At 4 Hz a 4 s window holds ~16 samples.
	return xs.length >= 6 ? mean(xs) : null;
}

/** True if any death other than `exclude` sits close enough to poison [a, b). */
function contaminated(deathTimes: number[], a: number, b: number, exclude: number): boolean {
	for (const d of deathTimes) {
		if (d === exclude) continue;
		// A death at d poisons [d, d + DEATH_MASK_SEC] (its aftermath) and is itself an event
		// inside the window if d falls in [a, b).
		if (d + DEATH_MASK_SEC > a && d < b) return true;
	}
	return false;
}

/** Is `t` within any death's neighbourhood — either its pre-window or its aftermath mask? */
function periDeath(deathTimes: number[], t: number): boolean {
	for (const d of deathTimes) {
		if (t >= d - LAG_SEC - PRE_WINDOW_SEC && t <= d + DEATH_MASK_SEC) return true;
	}
	return false;
}

/**
 * Compare focus in the clean pre-death windows against a peri-death-excluded baseline.
 *
 * The baseline deliberately excludes every death's neighbourhood. Including it would put
 * the pre-death samples on both sides of the comparison and dilute the contrast toward zero.
 *
 * The null distribution resamples whole windows of the same length from the clean baseline
 * region, so it inherits the same autocorrelation as the real windows. p is the fraction of
 * null deltas at least as extreme (in absolute value) as the observed one.
 */
export function analyzeDeaths(samples: FocusSample[], deathTimes: number[]): DeathAnalysis {
	const empty: DeathAnalysis = {
		verdict: 'insufficient',
		deaths: deathTimes.length,
		cleanWindows: 0,
		preDeathMean: 0,
		baselineMean: 0,
		delta: 0,
		p: null
	};
	if (!samples.length) return empty;

	// 1. Clean pre-death windows.
	const preMeans: number[] = [];
	for (const d of deathTimes) {
		const b = d - LAG_SEC;
		const a = b - PRE_WINDOW_SEC;
		if (a < 0) continue; // window runs off the start of the session
		if (contaminated(deathTimes, a, b, d)) continue;
		const m = windowMean(samples, a, b);
		if (m !== null) preMeans.push(m);
	}

	// 2. Baseline from everything outside any death's neighbourhood.
	const baselineSamples = samples.filter((s) => usable(s) && !periDeath(deathTimes, s.t));
	const baselineMean = mean(baselineSamples.map((s) => s.focus));

	if (preMeans.length < MIN_CLEAN_DEATHS || baselineSamples.length < 20) {
		return { ...empty, cleanWindows: preMeans.length, baselineMean };
	}

	const preDeathMean = mean(preMeans);
	const delta = preDeathMean - baselineMean;

	// 3. Block-permutation null: draw `n` random windows from the clean region.
	const tMin = baselineSamples[0].t;
	const tMax = baselineSamples[baselineSamples.length - 1].t;
	const span = tMax - tMin - PRE_WINDOW_SEC;
	let p: number | null = null;
	if (span > PRE_WINDOW_SEC) {
		const rnd = mulberry32(PERMUTATION_SEED);
		const n = preMeans.length;
		let atLeastAsExtreme = 0;
		let draws = 0;
		for (let iter = 0; iter < PERMUTATIONS; iter++) {
			const ms: number[] = [];
			// Bounded attempts so a session with few clean stretches cannot spin forever.
			for (let tries = 0; ms.length < n && tries < 40; tries++) {
				const a = tMin + rnd() * span;
				const b = a + PRE_WINDOW_SEC;
				if (contaminated(deathTimes, a, b, NaN)) continue;
				const m = windowMean(baselineSamples, a, b);
				if (m !== null) ms.push(m);
			}
			if (ms.length < n) continue;
			draws++;
			if (Math.abs(mean(ms) - baselineMean) >= Math.abs(delta)) atLeastAsExtreme++;
		}
		// Add-one smoothing: p is never exactly 0 from a finite permutation set.
		if (draws >= 200) p = (atLeastAsExtreme + 1) / (draws + 1);
	}

	const verdict: Verdict =
		p === null ? 'insufficient' : p < 0.05 ? 'association' : 'no-association';
	return {
		verdict,
		deaths: deathTimes.length,
		cleanWindows: preMeans.length,
		preDeathMean,
		baselineMean,
		delta,
		p
	};
}

/** Least-squares slope of focus vs time, converted to points per minute. */
function trendPerMin(samples: FocusSample[]): number {
	const pts = samples.filter(usable);
	const n = pts.length;
	if (n < 8) return 0;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (const s of pts) {
		sx += s.t;
		sy += s.focus;
		sxx += s.t * s.t;
		sxy += s.t * s.focus;
	}
	const den = n * sxx - sx * sx;
	if (Math.abs(den) < 1e-9) return 0;
	return ((n * sxy - sx * sy) / den) * 60;
}

/** Longest unbroken run at or above FLOW_THRESHOLD, in seconds. */
function longestFlow(samples: FocusSample[]): number {
	let best = 0;
	let runStart: number | null = null;
	for (const s of samples) {
		const inFlow = usable(s) && s.focus >= FLOW_THRESHOLD;
		if (inFlow && runStart === null) runStart = s.t;
		if (!inFlow && runStart !== null) {
			best = Math.max(best, s.t - runStart);
			runStart = null;
		}
	}
	if (runStart !== null && samples.length) {
		best = Math.max(best, samples[samples.length - 1].t - runStart);
	}
	return best;
}

export function analyzeSession(input: {
	samples: FocusSample[];
	deathTimes: number[];
	attempts: number;
	bestProgress: number;
	blinks: number;
}): SessionReport {
	const { samples } = input;
	const use = samples.filter(usable);
	const durationSec = samples.length ? samples[samples.length - 1].t : 0;
	const focuses = use.map((s) => s.focus);

	return {
		durationSec,
		usableSamples: use.length,
		meanFocus: mean(focuses),
		peakFocus: focuses.length ? Math.max(...focuses) : 0,
		meanCalm: mean(use.map((s) => s.calm)),
		timeInFlowPct: use.length
			? (use.filter((s) => s.focus >= FLOW_THRESHOLD).length / use.length) * 100
			: 0,
		longestFlowSec: longestFlow(samples),
		focusTrendPerMin: trendPerMin(samples),
		unusablePct: samples.length ? ((samples.length - use.length) / samples.length) * 100 : 0,
		deaths: analyzeDeaths(samples, input.deathTimes),
		attempts: input.attempts,
		bestProgressPct: input.bestProgress * 100,
		blinks: input.blinks
	};
}

/**
 * The sentence we are willing to print. Every branch stops short of causation, because a
 * within-session association between two autocorrelated series — one of which (difficulty)
 * plausibly drives both — cannot establish it.
 */
export function verdictText(d: DeathAnalysis): string {
	if (d.deaths === 0) return 'No deaths this session — nothing to compare focus against.';
	if (d.verdict === 'insufficient') {
		if (d.cleanWindows < MIN_CLEAN_DEATHS) {
			return (
				`Not enough clean deaths to test (${d.cleanWindows} of ${d.deaths} usable; need ` +
				`${MIN_CLEAN_DEATHS}). Deaths that follow too soon after another death are excluded, ` +
				'because the previous crash contaminates the window before this one.'
			);
		}
		return 'Not enough clean signal outside your deaths to form a baseline. Play a bit longer.';
	}
	const dir = d.delta < 0 ? 'lower' : 'higher';
	const mag = Math.abs(d.delta).toFixed(1);
	const p = d.p!.toFixed(3);
	if (d.verdict === 'association') {
		return (
			`In this session your focus ran ${mag} points ${dir} in the ${PRE_WINDOW_SEC} s before a ` +
			`death than the rest of the time (${d.preDeathMean.toFixed(1)} vs ` +
			`${d.baselineMean.toFixed(1)}, n=${d.cleanWindows}, p=${p}). That is a within-session ` +
			'association, not proof that losing focus caused the crashes — a hard stretch of the ' +
			'level can lower focus and kill you independently.'
		);
	}
	return (
		`No clear link between focus dips and deaths this session ` +
		`(${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} points, n=${d.cleanWindows}, p=${p}). ` +
		'Play more to tell.'
	);
}

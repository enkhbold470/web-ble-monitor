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
// 4. **Autocorrelation, and the clustering that comes with it.** Focus is sampled at 4 Hz
//    over a 3 s analysis window, so adjacent samples share ~90% of their data; a per-sample
//    t-test over them manufactures significance from nothing. But resampling whole windows
//    uniformly is *also* wrong, and wrong in the dangerous direction: the real windows are
//    clustered while uniform ones are not, so the null comes out too narrow. The null instead
//    **circularly rotates the whole death pattern** and rebuilds the statistic with the same
//    rule, preserving clustering, spacing and autocorrelation. See `analyzeDeaths`.
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
/** A window must cover at least this fraction of its nominal span to be a measurement. */
const MIN_WINDOW_COVERAGE = 0.7;
const MIN_WINDOW_SAMPLES = 6;
/** Below this many valid permutations we decline to quote a p-value. */
const MIN_DRAWS = 200;

function mean(xs: number[]): number {
	if (!xs.length) return 0;
	let a = 0;
	for (const x of xs) a += x;
	return a / xs.length;
}

/**
 * Usable samples only, with prefix sums, so a window mean or a masked baseline is a couple
 * of binary searches rather than a scan. The permutation loop runs this thousands of times.
 */
class UsableTrack {
	readonly t: number[] = [];
	readonly f: number[] = [];
	/** prefix[i] = sum of f[0..i-1] */
	private readonly prefix: number[] = [0];

	constructor(samples: FocusSample[]) {
		for (const s of samples) {
			if (!usable(s)) continue;
			this.t.push(s.t);
			this.f.push(s.focus);
			this.prefix.push(this.prefix[this.prefix.length - 1] + s.focus);
		}
	}

	get length(): number {
		return this.t.length;
	}

	/** First index with t[i] >= x. */
	private lowerBound(x: number): number {
		let lo = 0;
		let hi = this.t.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.t[mid] < x) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	sumCount(a: number, b: number): { sum: number; count: number; lo: number; hi: number } {
		const lo = this.lowerBound(a);
		const hi = this.lowerBound(b);
		return { sum: this.prefix[hi] - this.prefix[lo], count: hi - lo, lo, hi };
	}

	/**
	 * Mean focus over [a, b), or null when the window is not actually covered — too few
	 * samples, or the samples present only span a sliver of it because a signal dropout or a
	 * peri-death excision punched a hole through the middle. Accepting those would let the
	 * null draw "windows" the observed side could never produce.
	 */
	windowMean(a: number, b: number): number | null {
		const { sum, count, lo, hi } = this.sumCount(a, b);
		if (count < MIN_WINDOW_SAMPLES) return null;
		const span = this.t[hi - 1] - this.t[lo];
		if (span < MIN_WINDOW_COVERAGE * (b - a)) return null;
		return sum / count;
	}

	/** Mean over every usable sample NOT inside one of the (sorted, merged) intervals. */
	meanOutside(intervals: [number, number][]): { mean: number; count: number } {
		let sum = this.prefix[this.prefix.length - 1];
		let count = this.t.length;
		for (const [a, b] of intervals) {
			const r = this.sumCount(a, b);
			sum -= r.sum;
			count -= r.count;
		}
		return { mean: count > 0 ? sum / count : 0, count };
	}
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

/** Merged neighbourhood of every death: its pre-window plus its aftermath mask. */
function periDeathIntervals(deathTimes: number[]): [number, number][] {
	const raw: [number, number][] = deathTimes
		.map((d): [number, number] => [d - LAG_SEC - PRE_WINDOW_SEC, d + DEATH_MASK_SEC])
		.sort((x, y) => x[0] - y[0]);
	const out: [number, number][] = [];
	for (const iv of raw) {
		const last = out[out.length - 1];
		if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
		else out.push([...iv]);
	}
	return out;
}

interface Statistic {
	preMeans: number[];
	baselineMean: number;
	baselineCount: number;
	delta: number;
}

/**
 * The whole statistic, from one set of death times. Used for BOTH the observed value and
 * every permutation, so the null cannot be built by a different rule than the thing it is
 * supposed to be a null for.
 */
function statisticFor(track: UsableTrack, deathSet: number[], tEnd: number): Statistic {
	const preMeans: number[] = [];
	for (const d of deathSet) {
		const b = d - LAG_SEC;
		const a = b - PRE_WINDOW_SEC;
		if (a < 0 || b > tEnd) continue; // window runs off an end of the session
		if (contaminated(deathSet, a, b, d)) continue;
		const m = track.windowMean(a, b);
		if (m !== null) preMeans.push(m);
	}
	const { mean: baselineMean, count: baselineCount } = track.meanOutside(
		periDeathIntervals(deathSet)
	);
	return {
		preMeans,
		baselineMean,
		baselineCount,
		delta: preMeans.length ? mean(preMeans) - baselineMean : 0
	};
}

/**
 * Compare focus in the clean pre-death windows against a peri-death-excluded baseline.
 *
 * The baseline excludes every death's neighbourhood. Including it would put the pre-death
 * samples on both sides of the comparison and dilute the contrast toward zero.
 *
 * ## Why the null rotates the deaths instead of sampling windows at random
 *
 * The obvious null — scatter `n` windows uniformly across the session — is **wrong here, and
 * wrong in the anti-conservative direction.** Real deaths cluster (an auto-runner restarts
 * you into the same hard stretch), so the observed windows sit inside one short epoch and
 * their means are strongly correlated: averaging `n` of them barely reduces variance. Uniform
 * null windows are spread over the whole session, so their average *does* shrink by ~sqrt(n),
 * and it hugs the global baseline far more tightly than a clustered draw ever would. Focus is
 * also nonstationary (this module measures the drift itself, `focusTrendPerMin`), so a
 * clustered set of windows carries a local-epoch offset that the uniform null can never
 * reproduce. The null ends up too narrow, the observed delta clears it too easily, and p comes
 * out too small. Simulated on synthetic AR(1)+drift focus with deaths generated INDEPENDENTLY
 * of it, that construction fired "association" on ~27% of sessions at a nominal 5%.
 *
 * So instead we **circularly rotate the entire death pattern** by a random offset and rebuild
 * the statistic with the identical rule (`statisticFor`). Rotation preserves the spacing and
 * clustering of the deaths, preserves the window construction, and preserves the
 * autocorrelation of the focus track — it only breaks the alignment between deaths and focus,
 * which is exactly the null hypothesis. A draw is kept only when it yields the same number of
 * clean windows as the observed statistic, so like is compared with like.
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
	if (!samples.length || !deathTimes.length) return empty;

	const track = new UsableTrack(samples);
	const tEnd = samples[samples.length - 1].t;
	const observed = statisticFor(track, deathTimes, tEnd);
	const n = observed.preMeans.length;

	if (n < MIN_CLEAN_DEATHS || observed.baselineCount < 20) {
		return { ...empty, cleanWindows: n, baselineMean: observed.baselineMean };
	}

	const preDeathMean = mean(observed.preMeans);
	const delta = observed.delta;

	// Rotation null. Same rule, same geometry, only the alignment is destroyed.
	let p: number | null = null;
	if (tEnd > 2 * (PRE_WINDOW_SEC + LAG_SEC)) {
		const rnd = mulberry32(PERMUTATION_SEED);
		let atLeastAsExtreme = 0;
		let draws = 0;
		for (let iter = 0; iter < PERMUTATIONS && draws < PERMUTATIONS; iter++) {
			const shift = rnd() * tEnd;
			const rotated = deathTimes.map((d) => (d + shift) % tEnd);
			const s = statisticFor(track, rotated, tEnd);
			// Compare like with like: a rotation that loses windows off the session edge, or
			// that leaves too little baseline, is not a valid replicate of this session.
			if (s.preMeans.length !== n || s.baselineCount < 20) continue;
			draws++;
			if (Math.abs(s.delta) >= Math.abs(delta)) atLeastAsExtreme++;
		}
		// Add-one smoothing: p is never exactly 0 from a finite permutation set.
		if (draws >= MIN_DRAWS) p = (atLeastAsExtreme + 1) / (draws + 1);
	}

	const verdict: Verdict =
		p === null ? 'insufficient' : p < 0.05 ? 'association' : 'no-association';
	return {
		verdict,
		deaths: deathTimes.length,
		cleanWindows: n,
		preDeathMean,
		baselineMean: observed.baselineMean,
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
			`In this session your focus ran ${mag} points ${dir} during the ${PRE_WINDOW_SEC} s ` +
			`window ending ${LAG_SEC} s before each death than the rest of the time ` +
			`(${d.preDeathMean.toFixed(1)} vs ${d.baselineMean.toFixed(1)}, n=${d.cleanWindows}, ` +
			`p=${p}). That is a within-session association from ${d.cleanWindows} windows, not ` +
			'proof that losing focus caused the crashes — a hard stretch of the level can lower ' +
			'focus and kill you independently.'
		);
	}
	return (
		`No clear link between focus dips and deaths this session ` +
		`(${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} points, n=${d.cleanWindows}, p=${p}). ` +
		'Play more to tell.'
	);
}

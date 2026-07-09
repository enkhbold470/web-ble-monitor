import { describe, expect, it } from 'vitest';
import {
	DEATH_MASK_SEC,
	LAG_SEC,
	MIN_CLEAN_DEATHS,
	PRE_WINDOW_SEC,
	analyzeDeaths,
	analyzeSession,
	verdictText,
	type FocusSample
} from './analysis';

const RATE = 4; // focus is recorded at 4 Hz

/**
 * Build a focus track: `focus(t)` sampled at 4 Hz for `sec` seconds.
 * Deterministic — no RNG, so a p-value here is reproducible.
 */
function track(sec: number, focus: (t: number) => number, calm = 20): FocusSample[] {
	const out: FocusSample[] = [];
	for (let i = 0; i < sec * RATE; i++) {
		const t = i / RATE;
		out.push({ t, focus: focus(t), calm, signalOk: true, calibrating: false });
	}
	return out;
}

/** Focus that dips to `dip` inside every clean pre-death window, else `base`. */
function dipBefore(deaths: number[], base: number, dip: number) {
	return (t: number) => {
		for (const d of deaths) {
			if (t >= d - LAG_SEC - PRE_WINDOW_SEC && t < d - LAG_SEC) return dip;
		}
		return base;
	};
}

describe('analyzeDeaths — contamination guards', () => {
	it('rejects pre-death windows that contain a previous death', () => {
		// Deaths 3 s apart — the clustering an auto-runner produces. The 4 s window ending
		// 2.5 s before death i spans [i-6.5, i-2.5), which swallows death i-1 at i-3 and its
		// aftermath. Only the FIRST death has no predecessor, so exactly one window survives
		// — and one is below MIN_CLEAN_DEATHS, so we refuse to report a statistic at all.
		const deaths = [20, 23, 26, 29, 32];
		const r = analyzeDeaths(
			track(60, () => 50),
			deaths
		);
		expect(r.deaths).toBe(5);
		expect(r.cleanWindows).toBe(1);
		expect(r.verdict).toBe('insufficient');
		expect(r.p).toBeNull();
		expect(verdictText(r)).toMatch(/contaminates the window/i);
	});

	it('the same deaths, spaced out, are all usable — clustering is what disqualifies them', () => {
		const clustered = analyzeDeaths(
			track(200, () => 50),
			[20, 23, 26, 29, 32]
		);
		const spaced = analyzeDeaths(
			track(200, () => 50),
			[20, 60, 100, 140, 180]
		);
		expect(clustered.cleanWindows).toBe(1);
		expect(spaced.cleanWindows).toBe(5);
	});

	it('accepts well-separated deaths', () => {
		const deaths = [20, 40, 60, 80];
		const s = track(100, () => 50);
		const r = analyzeDeaths(s, deaths);
		expect(r.cleanWindows).toBe(4);
	});

	it('a death whose window would run off the start of the session is dropped', () => {
		// window is [d - 6.5, d - 2.5); at d = 5 that starts at -1.5.
		const r = analyzeDeaths(
			track(60, () => 50),
			[5, 30, 55]
		);
		expect(r.cleanWindows).toBe(2);
	});

	it('the post-death mask excludes the aftermath of every death, not just the current one', () => {
		// Death at 30 sits DEATH_MASK_SEC after death at 27.6, so 27.6's aftermath bleeds
		// into 30's window [23.5, 27.5). 23.5 < 27.6 < 27.5 is false, but the mask
		// [27.6, 30.1] does not overlap [23.5, 27.5) either — so 30 IS clean here.
		expect(DEATH_MASK_SEC).toBe(2.5);
		const clean = analyzeDeaths(
			track(80, () => 50),
			[12, 30, 50, 70]
		);
		expect(clean.cleanWindows).toBe(4);
		// But move a death to 26 and it lands squarely inside 30's window.
		const dirty = analyzeDeaths(
			track(80, () => 50),
			[12, 26, 30, 50, 70]
		);
		expect(dirty.cleanWindows).toBeLessThan(5);
	});

	it('refuses to test with fewer than MIN_CLEAN_DEATHS clean windows', () => {
		const r = analyzeDeaths(
			track(60, () => 50),
			[20, 45]
		);
		expect(r.cleanWindows).toBe(2);
		expect(MIN_CLEAN_DEATHS).toBe(3);
		expect(r.verdict).toBe('insufficient');
		expect(r.p).toBeNull();
		expect(verdictText(r)).toMatch(/not enough clean deaths/i);
	});

	it('reports no deaths honestly', () => {
		const r = analyzeDeaths(
			track(60, () => 50),
			[]
		);
		expect(r.verdict).toBe('insufficient');
		expect(verdictText(r)).toMatch(/no deaths/i);
	});
});

describe('analyzeDeaths — the statistic', () => {
	const deaths = [20, 40, 60, 80, 100];

	it('finds an association when focus really does sag before deaths', () => {
		const s = track(120, dipBefore(deaths, 60, 25));
		const r = analyzeDeaths(s, deaths);
		expect(r.cleanWindows).toBe(5);
		expect(r.preDeathMean).toBeCloseTo(25, 0);
		expect(r.baselineMean).toBeCloseTo(60, 0);
		expect(r.delta).toBeLessThan(-30);
		expect(r.p).not.toBeNull();
		expect(r.p!).toBeLessThan(0.05);
		expect(r.verdict).toBe('association');
	});

	it('finds nothing when focus is flat — no false positive', () => {
		const r = analyzeDeaths(
			track(120, () => 55),
			deaths
		);
		expect(r.verdict).toBe('no-association');
		expect(Math.abs(r.delta)).toBeLessThan(1);
		expect(r.p!).toBeGreaterThan(0.05);
	});

	it('excludes peri-death samples from the baseline, so the dip is not diluted', () => {
		const s = track(120, dipBefore(deaths, 60, 25));
		const r = analyzeDeaths(s, deaths);
		// A naive baseline over ALL samples would be pulled below 60 by the dips.
		expect(r.baselineMean).toBeGreaterThan(59);
	});

	it('is reproducible — the same session yields the same p-value every run', () => {
		const s = track(120, dipBefore(deaths, 60, 40));
		const a = analyzeDeaths(s, deaths);
		const b = analyzeDeaths(s, deaths);
		expect(a.p).toBe(b.p);
		expect(a.delta).toBe(b.delta);
	});

	it('never reports p exactly 0 from a finite permutation set', () => {
		const r = analyzeDeaths(track(120, dipBefore(deaths, 80, 5)), deaths);
		expect(r.p!).toBeGreaterThan(0);
	});

	it('ignores samples with no signal or still calibrating', () => {
		const s = track(120, dipBefore(deaths, 60, 25)).map((x) =>
			x.t < 10 ? { ...x, calibrating: true } : x
		);
		const r = analyzeDeaths(s, deaths);
		expect(r.verdict).toBe('association');
	});
});

describe('verdictText — what we are willing to claim', () => {
	const deaths = [20, 40, 60, 80, 100];

	it('never claims causation, even on a significant result', () => {
		const r = analyzeDeaths(track(120, dipBefore(deaths, 60, 25)), deaths);
		const text = verdictText(r);
		expect(r.verdict).toBe('association');
		expect(text).toMatch(/within-session association/i);
		expect(text).toMatch(/not proof that losing focus caused/i);
		expect(text).not.toMatch(/\bpredicts?\b/i);
		expect(text.toLowerCase()).not.toContain('because you lost focus');
	});

	it('reports n and p on every tested verdict', () => {
		for (const f of [dipBefore(deaths, 60, 25), () => 55]) {
			const text = verdictText(analyzeDeaths(track(120, f), deaths));
			expect(text).toMatch(/n=\d+/);
			expect(text).toMatch(/p=[01]\.\d+/);
		}
	});
});

describe('analyzeSession', () => {
	const deaths = [20, 40, 60, 80, 100];

	it('summarises focus, flow and signal quality', () => {
		const s = track(120, (t) => (t < 60 ? 70 : 40));
		const r = analyzeSession({
			samples: s,
			deathTimes: deaths,
			attempts: 6,
			bestProgress: 0.42,
			blinks: 9
		});
		expect(r.durationSec).toBeCloseTo(119.75, 1);
		expect(r.meanFocus).toBeCloseTo(55, 0);
		expect(r.peakFocus).toBe(70);
		expect(r.timeInFlowPct).toBeCloseTo(50, 0); // half the session at >= 60
		expect(r.longestFlowSec).toBeCloseTo(60, 0);
		expect(r.attempts).toBe(6);
		expect(r.bestProgressPct).toBeCloseTo(42, 5);
		expect(r.blinks).toBe(9);
		expect(r.unusablePct).toBe(0);
	});

	it('detects a vigilance decrement as a negative focus trend', () => {
		const fading = track(120, (t) => 80 - t / 2); // 80 -> 20 over two minutes
		const r = analyzeSession({
			samples: fading,
			deathTimes: [],
			attempts: 1,
			bestProgress: 1,
			blinks: 0
		});
		expect(r.focusTrendPerMin).toBeCloseTo(-30, 0); // -0.5 pts/s = -30 pts/min
	});

	it('counts unusable samples as unusable, not as low focus', () => {
		const s = track(60, () => 70).map((x) => (x.t > 30 ? { ...x, signalOk: false } : x));
		const r = analyzeSession({
			samples: s,
			deathTimes: [],
			attempts: 1,
			bestProgress: 0.1,
			blinks: 0
		});
		expect(r.unusablePct).toBeCloseTo(50, 0);
		expect(r.meanFocus).toBeCloseTo(70, 0); // the usable half, undiluted by zeros
	});

	it('survives an empty session', () => {
		const r = analyzeSession({
			samples: [],
			deathTimes: [],
			attempts: 1,
			bestProgress: 0,
			blinks: 0
		});
		expect(r.meanFocus).toBe(0);
		expect(r.durationSec).toBe(0);
		expect(r.deaths.verdict).toBe('insufficient');
	});
});

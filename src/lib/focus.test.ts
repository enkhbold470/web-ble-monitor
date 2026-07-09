import { describe, expect, it } from 'vitest';
import { FLOW_THRESHOLD, FocusEngine } from './focus';

const FS = 175; // firmware v4's real ADS1220 rate

/** Feed `sec` seconds of a sum of sinusoids, sample by sample, in µV. */
function feed(engine: FocusEngine, parts: [freq: number, amp: number][], sec: number): void {
	const n = Math.round(FS * sec);
	for (let i = 0; i < n; i++) {
		let v = 0;
		for (const [f, a] of parts) v += a * Math.sin((2 * Math.PI * f * i) / FS);
		engine.push(v);
	}
}

/** An engine with calibration skipped, so `focus` is meaningful immediately. */
const calibrated = (baseline: number, opts = {}) =>
	new FocusEngine(FS, { line: 60, baselineEngagement: baseline, ...opts });

describe('FocusEngine — Pope engagement index, beta/(alpha+theta)', () => {
	it('computes engagement as beta / (alpha + theta) from the band powers', () => {
		const e = calibrated(1);
		feed(
			e,
			[
				[20, 20], // beta
				[10, 20], // alpha
				[6, 20] // theta
			],
			5
		);
		const m = e.read();
		const expected = m.bands.beta / (m.bands.alpha + m.bands.theta);
		expect(m.engagement).toBeCloseTo(expected, 6);
		// Equal amplitudes in all three bands => beta is outnumbered two to one.
		expect(m.engagement).toBeLessThan(1);
	});

	it('a beta-dominant signal yields engagement far above a baseline of 1', () => {
		const e = calibrated(1);
		feed(e, [[20, 30]], 5);
		expect(e.read().engagement).toBeGreaterThan(5);
		expect(e.read().focus).toBeGreaterThan(80);
	});

	it('an alpha-dominant signal yields engagement far below a baseline of 1', () => {
		const e = calibrated(1);
		feed(e, [[10, 30]], 5);
		expect(e.read().engagement).toBeLessThan(0.2);
		expect(e.read().focus).toBeLessThan(20);
	});

	it('scores exactly 50 when engagement sits at the baseline', () => {
		const e = calibrated(1);
		// Find the engagement of a mix, then rebuild with that as the baseline.
		feed(
			e,
			[
				[20, 20],
				[10, 20],
				[6, 20]
			],
			5
		);
		const atBaseline = calibrated(e.read().engagement);
		feed(
			atBaseline,
			[
				[20, 20],
				[10, 20],
				[6, 20]
			],
			5
		);
		expect(atBaseline.read().focus).toBeCloseTo(50, 0);
	});

	it('is monotone in engagement — more beta never lowers the score', () => {
		const scores = [5, 15, 25, 35].map((betaAmp) => {
			const e = calibrated(1);
			feed(
				e,
				[
					[20, betaAmp],
					[10, 20],
					[6, 10]
				],
				5
			);
			return e.read().focus;
		});
		for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThan(scores[i - 1]);
	});

	it('finds the alpha peak', () => {
		const e = calibrated(1);
		feed(e, [[10, 30]], 5);
		expect(e.read().alphaPeak).toBeGreaterThan(8);
		expect(e.read().alphaPeak).toBeLessThan(12);
	});

	it('notches mains out of the band powers', () => {
		const e = calibrated(1);
		feed(
			e,
			[
				[10, 20],
				[60, 60]
			],
			5
		); // a mains line 3x the alpha amplitude
		const b = e.read().bands;
		expect(b.alpha).toBeGreaterThan(b.gamma);
	});
});

describe('FocusEngine — calibration', () => {
	it('withholds a score until the baseline is established', () => {
		const e = new FocusEngine(FS, { line: 60, calibrationSec: 2 });
		feed(e, [[20, 30]], 1.8);
		expect(e.read().calibrating).toBe(true);
		expect(e.read().focus).toBe(0); // never show a number we have not earned
		expect(e.read().baseline).toBeNull();
	});

	it('establishes the baseline after enough good signal, then scores ~50 at it', () => {
		const e = new FocusEngine(FS, { line: 60, calibrationSec: 2 });
		feed(
			e,
			[
				[20, 20],
				[10, 20],
				[6, 20]
			],
			6
		);
		const m = e.read();
		expect(m.calibrating).toBe(false);
		expect(m.baseline).toBeGreaterThan(0);
		expect(m.calibrationLeftSec).toBe(0);
		// The signal never changed, so the live engagement sits at its own baseline.
		expect(m.focus).toBeGreaterThan(35);
		expect(m.focus).toBeLessThan(65);
	});

	it('does not calibrate on a dead electrode — a flat line must never become a baseline', () => {
		const e = new FocusEngine(FS, { line: 60, calibrationSec: 1 });
		feed(e, [[10, 0]], 6); // pure zeros
		const m = e.read();
		expect(m.signalOk).toBe(false);
		expect(m.calibrating).toBe(true);
		expect(m.baseline).toBeNull();
	});

	it('freezes the baseline rather than tracking it, so drift stays visible', () => {
		const e = new FocusEngine(FS, { line: 60, calibrationSec: 2 });
		feed(
			e,
			[
				[10, 25],
				[6, 15]
			],
			6
		); // calm baseline: little beta
		const b0 = e.read().baseline;
		expect(b0).not.toBeNull();
		feed(e, [[20, 30]], 8); // now concentrate, hard, for a long time
		expect(e.read().baseline).toBe(b0); // unchanged
		expect(e.read().focus).toBeGreaterThan(80); // and the score stayed high
	});

	it('reset(true) keeps a hard-won baseline; reset() discards it', () => {
		const e = new FocusEngine(FS, { line: 60, calibrationSec: 1 });
		feed(
			e,
			[
				[20, 20],
				[10, 20],
				[6, 20]
			],
			5
		);
		const b = e.read().baseline;
		expect(b).not.toBeNull();
		e.reset(true);
		expect(e.read().baseline).toBe(b);
		expect(e.read().calibrating).toBe(false);
		e.reset();
		expect(e.read().baseline).toBeNull();
		expect(e.read().calibrating).toBe(true);
	});
});

describe('FocusEngine — signal integrity', () => {
	it('a detached electrode must not read as perfect concentration', () => {
		// alpha+theta -> 0 makes E explode. Guard is signalOk, which the UI must honour.
		const e = calibrated(1);
		feed(e, [[10, 0]], 5);
		expect(e.read().signalOk).toBe(false);
	});

	it('reports signal for a real trace', () => {
		const e = calibrated(1);
		feed(e, [[10, 30]], 5);
		expect(e.read().signalOk).toBe(true);
	});

	it('a lost electrode freezes the score instead of spiking it to 100', () => {
		// This is the dangerous failure: with no signal, alpha+theta collapse to the noise
		// floor and E = beta/(alpha+theta) explodes. Without the signalOk gate, pulling the
		// headset off would read as flawless concentration.
		const e = calibrated(1);
		feed(e, [[10, 30]], 5); // alpha-dominant: a low score
		expect(e.read().focus).toBeLessThan(20);

		feed(e, [[10, 0]], 6); // electrode falls off; the filters ring down, then the gate shuts
		const lost = e.read();
		expect(lost.signalOk).toBe(false);
		expect(lost.focus).toBeLessThan(20); // emphatically not 100

		feed(e, [[10, 0]], 4); // more silence changes nothing: the score is frozen
		expect(e.read().focus).toBeCloseTo(lost.focus, 10);
	});

	it('stays in warm-up until the analysis window fills', () => {
		const e = calibrated(1);
		feed(e, [[10, 30]], 0.5);
		expect(e.read().warmingUp).toBe(true);
	});

	it('calm is baseline-free while focus is baseline-relative — they are not complements', () => {
		const signal: [number, number][] = [
			[20, 20],
			[10, 20],
			[6, 20]
		];
		const low = calibrated(0.2);
		const high = calibrated(5);
		feed(low, signal, 5);
		feed(high, signal, 5);
		// Same samples, different personal baselines => different focus...
		expect(low.read().focus).toBeGreaterThan(high.read().focus + 30);
		// ...but calm is computed from the band shares alone, so it is identical.
		expect(low.read().calm).toBeCloseTo(high.read().calm, 6);
	});
});

describe('FocusEngine — blinks', () => {
	it('does not fire on a clean rhythmic signal', () => {
		const e = calibrated(1);
		feed(e, [[10, 30]], 6);
		expect(e.read().blinks).toBe(0);
	});

	it('detects a large slow deflection', () => {
		let fired = 0;
		const e = calibrated(1, { onBlink: () => fired++ });
		feed(e, [[10, 8]], 3); // settle the baseline first
		const n = Math.round(FS * 0.25); // a 2 Hz, 250 µV half-cycle: a real blink's shape
		for (let i = 0; i < n; i++) e.push(250 * Math.sin((Math.PI * i) / n));
		feed(e, [[10, 8]], 1);
		expect(fired).toBeGreaterThanOrEqual(1);
		expect(e.read().blinks).toBe(fired);
	});
});

describe('constants', () => {
	it('FLOW_THRESHOLD sits above the 50-point personal baseline', () => {
		expect(FLOW_THRESHOLD).toBeGreaterThan(50);
	});
});

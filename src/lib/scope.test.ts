import { describe, it, expect } from 'vitest';
import {
	minMaxDecimate,
	percentileAbs,
	autosetUvPerDiv,
	autoEnvelope,
	UV_PER_DIV,
	V_DIVS
} from './scope';

describe('minMaxDecimate', () => {
	it('produces exactly `cols` columns when n > cols', () => {
		const data = Array.from({ length: 8000 }, (_, i) => Math.sin(i));
		expect(minMaxDecimate(data, 560)).toHaveLength(560);
	});

	it('preserves a transient spike in whichever column it lands', () => {
		const data = new Array(100).fill(1);
		data[50] = 999; // one-sample spike (a blink); must survive decimation
		const cols = minMaxDecimate(data, 10);
		expect(Math.max(...cols.map((c) => c.max))).toBe(999);
	});

	it('degrades to one column per sample (min === max) when n < cols', () => {
		const cols = minMaxDecimate([3, -7, 4], 100);
		expect(cols).toHaveLength(3);
		expect(cols).toEqual([
			{ min: 3, max: 3 },
			{ min: -7, max: -7 },
			{ min: 4, max: 4 }
		]);
	});

	it('yields n single-sample columns when n === cols', () => {
		const data = [0, 1, 2, 3, 4, 5, 6, 7];
		const cols = minMaxDecimate(data, 8);
		expect(cols).toHaveLength(8);
		for (let i = 0; i < data.length; i++) {
			expect(cols[i]).toEqual({ min: data[i], max: data[i] });
		}
	});

	it('returns [] for empty data or cols <= 0', () => {
		expect(minMaxDecimate([], 10)).toEqual([]);
		expect(minMaxDecimate([1, 2, 3], 0)).toEqual([]);
		expect(minMaxDecimate([1, 2, 3], -5)).toEqual([]);
	});

	it('assigns every sample: union of columns spans the global min & max', () => {
		const data = Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.37) * 50 - 3);
		const globalMin = Math.min(...data);
		const globalMax = Math.max(...data);
		const cols = minMaxDecimate(data, 128);
		expect(Math.min(...cols.map((c) => c.min))).toBe(globalMin);
		expect(Math.max(...cols.map((c) => c.max))).toBe(globalMax);
	});
});

describe('percentileAbs', () => {
	it('ignores a lone spike at p=0.995 over 1000 samples', () => {
		const data = new Array(1000).fill(1);
		data[0] = 9999; // outlier past the 99.5th percentile
		expect(percentileAbs(data, 0.995)).toBe(1);
	});

	it('returns the true max |v| at p=1.0', () => {
		expect(percentileAbs([1, -50, 3], 1)).toBe(50);
	});

	it('takes the absolute value of negatives', () => {
		expect(percentileAbs([-100, 5, -2], 1)).toBe(100);
	});

	it('returns 0 for empty data', () => {
		expect(percentileAbs([], 0.995)).toBe(0);
	});
});

describe('autosetUvPerDiv', () => {
	it('picks 5 when the signal peaks at 9 µV (5*2 = 10 >= 9)', () => {
		const data = new Array(1000).fill(9);
		data[0] = 9999; // a spike must not drag the rung upward
		expect(autosetUvPerDiv(data)).toBe(5);
	});

	it('picks 10 when the signal peaks at 11 µV (5*2 = 10 < 11)', () => {
		expect(autosetUvPerDiv(new Array(1000).fill(11))).toBe(10);
	});

	it('clamps to the largest rung (1000) beyond 2000 µV', () => {
		expect(autosetUvPerDiv(new Array(1000).fill(5000))).toBe(1000);
	});

	it('returns the smallest rung (2) for flat/zero data', () => {
		expect(autosetUvPerDiv(new Array(1000).fill(0))).toBe(UV_PER_DIV[0]);
		expect(UV_PER_DIV[0]).toBe(2);
	});

	it('respects the +/-(V_DIVS/2) division span', () => {
		expect(V_DIVS).toBe(4);
	});
});

describe('autoEnvelope', () => {
	it('rises quickly on a step up (attack)', () => {
		expect(autoEnvelope(0, 100)).toBeCloseTo(50, 6);
		expect(autoEnvelope(50, 100)).toBeCloseTo(75, 6);
	});

	it('decays slowly on a step down (release)', () => {
		expect(autoEnvelope(100, 0)).toBeCloseTo(98, 6);
	});

	it('is monotone toward the target and rises faster than it falls', () => {
		let up = 0;
		for (let i = 0; i < 5; i++) {
			const next = autoEnvelope(up, 100);
			expect(next).toBeGreaterThan(up);
			expect(next).toBeLessThanOrEqual(100);
			up = next;
		}
		let down = 100;
		for (let i = 0; i < 5; i++) {
			const next = autoEnvelope(down, 0);
			expect(next).toBeLessThan(down);
			expect(next).toBeGreaterThanOrEqual(0);
			down = next;
		}
		// after one frame, the rise has covered far more ground than the fall
		expect(autoEnvelope(0, 100)).toBeGreaterThan(100 - autoEnvelope(100, 0));
	});

	it('returns prev on a NaN or Infinity peak', () => {
		expect(autoEnvelope(42, NaN)).toBe(42);
		expect(autoEnvelope(42, Infinity)).toBe(42);
		expect(autoEnvelope(42, -Infinity)).toBe(42);
	});
});

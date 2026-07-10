import { describe, expect, it } from 'vitest';
import { BergerProtocol, bergerFeasibility, type BergerOptions } from './berger';

// The state machine is sample-clocked, so every test drives it by pushing an exact
// count of samples — there is no wall clock to mock and the same push count always
// lands on the same phase boundary.

/** A 10 Hz alpha-band sine in µV, indexed per epoch so open and closed epochs of the
 *  same amplitude produce bit-identical sample sequences (=> an exactly known ratio). */
const alphaEpoch = (fs: number, amp: number) => (i: number) =>
	amp * Math.sin((2 * Math.PI * 10 * i) / fs);

/** Continuous sine generator for boundary tests where per-epoch phase does not matter. */
function sineGen(fs: number, freq: number, amp: number): () => number {
	let i = 0;
	return () => amp * Math.sin((2 * Math.PI * freq * i++) / fs);
}

function pushN(p: BergerProtocol, n: number, gen: () => number): void {
	for (let i = 0; i < n; i++) p.push(gen());
}

/** Deterministic PRNG — never Math.random, so noisy tests stay reproducible. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

interface EpochFns {
	open: (i: number) => number;
	closed: (i: number) => number;
}

/** Run a whole protocol from ready to done, feeding each block's open/closed epoch. */
function runProtocol(p: BergerProtocol, fs: number, opts: BergerOptions, blocks: EpochFns[]): void {
	p.start();
	const readyN = Math.round((opts.readySec ?? 3) * fs);
	const epochN = Math.round((opts.epochSec ?? 20) * fs);
	for (let i = 0; i < readyN; i++) p.push(0);
	for (const b of blocks) {
		for (let i = 0; i < epochN; i++) p.push(b.open(i));
		for (let i = 0; i < epochN; i++) p.push(b.closed(i));
	}
}

/** Small, fast timings that keep the sample counts (and the tests) tiny. */
const FAST: BergerOptions = {
	epochSec: 2,
	settleSec: 0.5,
	subEpochSec: 0.5,
	readySec: 1,
	blocks: 2
};
const THREE: BergerOptions = {
	epochSec: 2,
	settleSec: 0.5,
	subEpochSec: 0.5,
	readySec: 0.5,
	blocks: 3
};

describe('bergerFeasibility', () => {
	it('is false at 20 SPS and true at 45 SPS and above across the rate ladder', () => {
		const ladder = [20, 45, 90, 175, 330, 600, 1000, 2000];
		expect(bergerFeasibility(20).ok).toBe(false);
		for (const fs of ladder.filter((r) => r >= 45)) {
			expect(bergerFeasibility(fs).ok, `${fs} SPS should be feasible`).toBe(true);
		}
	});

	it('names the alpha band and the rate in the reason, with an en-dash', () => {
		const { ok, reason } = bergerFeasibility(20);
		expect(ok).toBe(false);
		expect(reason).toBe('alpha (8–13 Hz) needs > 27 SPS; at 20 SPS the passband stops at 9.8 Hz');
	});

	it('has a null reason when feasible', () => {
		expect(bergerFeasibility(175).reason).toBeNull();
	});

	it('exposes the construction rate as a readonly `feasible` on the protocol', () => {
		expect(new BergerProtocol(20).feasible.ok).toBe(false);
		expect(new BergerProtocol(175).feasible.ok).toBe(true);
	});
});

describe('BergerProtocol — phase timeline', () => {
	it('lands every transition on the exact sample boundary', () => {
		const fs = 100;
		const p = new BergerProtocol(fs, FAST);
		const g = sineGen(fs, 10, 15);
		p.start();
		expect(p.state().phase).toBe('ready');

		pushN(p, 99, g); // readySamples = 100
		expect(p.state().phase).toBe('ready');
		pushN(p, 1, g);
		let s = p.state();
		expect(s.phase).toBe('open');
		expect(s.block).toBe(0);
		expect(s.condition).toBe('open');

		pushN(p, 199, g); // epochSamples = 200
		expect(p.state().phase).toBe('open');
		pushN(p, 1, g);
		s = p.state();
		expect(s.phase).toBe('closed');
		expect(s.condition).toBe('closed');
		expect(s.block).toBe(0);

		pushN(p, 200, g); // block rollover
		s = p.state();
		expect(s.phase).toBe('open');
		expect(s.block).toBe(1);

		pushN(p, 200, g);
		expect(p.state().phase).toBe('closed');

		pushN(p, 199, g);
		expect(p.state().phase).toBe('closed');
		pushN(p, 1, g);
		s = p.state();
		expect(s.phase).toBe('done');
		expect(s.result).not.toBeNull();
	});

	it('fires onPhaseChange exactly once per transition, in order', () => {
		const fs = 100;
		const seen: [string, string | null][] = [];
		const p = new BergerProtocol(fs, {
			...FAST,
			onPhaseChange: (ph, cond) => seen.push([ph, cond])
		});
		runProtocol(p, fs, FAST, [
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 20) },
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 20) }
		]);
		expect(seen).toEqual([
			['ready', null],
			['open', 'open'],
			['closed', 'closed'],
			['open', 'open'],
			['closed', 'closed'],
			['done', null]
		]);
	});

	it('counts secondsLeft down within a phase and is 0 when idle or done', () => {
		const fs = 100;
		const p = new BergerProtocol(fs, {
			epochSec: 2,
			settleSec: 0.5,
			subEpochSec: 0.5,
			readySec: 3,
			blocks: 1
		});
		expect(p.state().phase).toBe('idle');
		expect(p.state().secondsLeft).toBe(0);

		p.start();
		expect(p.state().secondsLeft).toBe(3); // readySamples = 300
		pushN(p, 100, () => 0);
		expect(p.state().secondsLeft).toBe(2);
		pushN(p, 100, () => 0);
		expect(p.state().secondsLeft).toBe(1);
		pushN(p, 100, () => 0); // rolls into the open epoch
		expect(p.state().phase).toBe('open');
		expect(p.state().secondsLeft).toBe(2); // epochSamples = 200
	});

	it('start() resets counters and result from any phase', () => {
		const fs = 100;
		const p = new BergerProtocol(fs, FAST);
		runProtocol(p, fs, FAST, [
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 60) },
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 60) }
		]);
		expect(p.state().phase).toBe('done');
		expect(p.state().result).not.toBeNull();

		p.start();
		const s = p.state();
		expect(s.phase).toBe('ready');
		expect(s.accepted).toBe(0);
		expect(s.rejected).toBe(0);
		expect(s.result).toBeNull();
	});
});

describe('BergerProtocol — epoch analysis', () => {
	const fs = 100;
	const ONE: BergerOptions = {
		epochSec: 2,
		settleSec: 0.5,
		subEpochSec: 0.5,
		readySec: 0.5,
		blocks: 1
	};

	it('discards the settle window, so a huge DC offset there causes no rejection', () => {
		const p = new BergerProtocol(fs, ONE);
		const settleN = 50; // 0.5 s * 100 SPS
		runProtocol(p, fs, ONE, [
			{
				// A 5000 µV DC step lives entirely in the discarded settle window.
				open: (i) => (i < settleN ? 5000 : 20 * Math.sin((2 * Math.PI * 10 * i) / fs)),
				closed: (i) => 20 * Math.sin((2 * Math.PI * 10 * i) / fs)
			}
		]);
		const r = p.state().result!;
		expect(r.rejectedEpochs).toBe(0);
		expect(r.perBlock[0].open!).toBeGreaterThan(0);
		// Post-settle samples are identical to the closed epoch => alpha is unaffected.
		expect(r.perBlock[0].ratio!).toBeCloseTo(1, 6);
	});

	it('rejects a sub-epoch whose peak-to-peak exceeds artifactUv', () => {
		const p = new BergerProtocol(fs, ONE);
		runProtocol(p, fs, ONE, [
			{ open: alphaEpoch(fs, 100), closed: alphaEpoch(fs, 20) } // 100 µV amp => 200 p2p > 150
		]);
		const r = p.state().result!;
		expect(r.rejectedEpochs).toBe(3); // three sub-epochs in the open epoch
		expect(r.acceptedEpochs).toBe(3); // three in the clean closed epoch
		expect(r.perBlock[0].open).toBeNull();
		expect(r.perBlock[0].ratio).toBeNull();
	});

	it('rejects a sub-epoch below the RMS biosignal floor', () => {
		const p = new BergerProtocol(fs, ONE);
		runProtocol(p, fs, ONE, [
			{ open: alphaEpoch(fs, 0.5), closed: alphaEpoch(fs, 20) } // rms ~0.35 µV < 1.5
		]);
		const r = p.state().result!;
		expect(r.rejectedEpochs).toBe(3);
		expect(r.perBlock[0].open).toBeNull();
	});

	it('invalidates an epoch when fewer than half its sub-epochs are accepted', () => {
		const p = new BergerProtocol(fs, ONE);
		runProtocol(p, fs, ONE, [
			{
				// sub-epoch 0 clean; sub-epochs 1 and 2 are artifacts => 1 of 3 accepted.
				open: (i) => {
					if (i < 50) return 0;
					const sub = Math.floor((i - 50) / 50);
					return (sub === 0 ? 20 : 200) * Math.sin((2 * Math.PI * 10 * i) / fs);
				},
				closed: alphaEpoch(fs, 20)
			}
		]);
		const r = p.state().result!;
		expect(r.perBlock[0].open).toBeNull();
		expect(r.perBlock[0].ratio).toBeNull();
		expect(r.verdict).toBe('inconclusive');
	});

	it('analyses a 90-sample sub-epoch at 45 SPS without hitting the all-zero PSD return', () => {
		// welch() returns an all-zero PSD when x.length < nextPow2(nperseg). subN = 90, so
		// nperseg must resolve to 64 (freqs length 64/2+1 = 33), not 128.
		const fs45 = 45;
		const opts: BergerOptions = {
			epochSec: 4,
			settleSec: 0,
			subEpochSec: 2,
			readySec: 1,
			blocks: 1
		};
		const p = new BergerProtocol(fs45, opts);
		runProtocol(p, fs45, opts, [{ open: alphaEpoch(fs45, 20), closed: alphaEpoch(fs45, 20) }]);
		const r = p.state().result!;
		expect(r.perBlock[0].open!).toBeGreaterThan(0);
		expect(r.perBlock[0].closed!).toBeGreaterThan(0);

		const sp = p.spectra();
		expect(sp.open).not.toBeNull();
		expect(sp.open!.freqs.length).toBe(33); // proves nperseg = 64, not 128
		expect(Math.max(...sp.open!.psd)).toBeGreaterThan(0);
	});

	it('spectra is null for a condition with no accepted sub-epochs yet', () => {
		const p = new BergerProtocol(100, FAST);
		p.start();
		expect(p.spectra().open).toBeNull();
		expect(p.spectra().closed).toBeNull();
	});
});

describe('BergerProtocol — ratio and verdict', () => {
	const fs = 100;

	it('passes when every block shows a consistent closed > open alpha rise', () => {
		const p = new BergerProtocol(fs, THREE);
		runProtocol(p, fs, THREE, [
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 60) }, // 3x amp => 9x power
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 60) },
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 60) }
		]);
		const r = p.state().result!;
		expect(r.verdict).toBe('pass');
		expect(r.ratio!).toBeCloseTo(9, 4);
		for (const b of r.perBlock) expect(b.ratio!).toBeGreaterThan(1);
	});

	it('passes despite added noise (deterministic LCG)', () => {
		const rng = lcg(0x1234abcd);
		const noise = () => (rng() * 2 - 1) * 3;
		const noisy = (amp: number) => (i: number) =>
			amp * Math.sin((2 * Math.PI * 10 * i) / fs) + noise();
		const p = new BergerProtocol(fs, THREE);
		runProtocol(p, fs, THREE, [
			{ open: noisy(20), closed: noisy(60) },
			{ open: noisy(20), closed: noisy(60) },
			{ open: noisy(20), closed: noisy(60) }
		]);
		const r = p.state().result!;
		expect(r.verdict).toBe('pass');
		expect(r.ratio!).toBeGreaterThan(1.2);
	});

	it('fails when open and closed alpha are equal (ratio exactly 1.0)', () => {
		const p = new BergerProtocol(fs, THREE);
		runProtocol(p, fs, THREE, [
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 20) },
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 20) },
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 20) }
		]);
		const r = p.state().result!;
		// Identical epochs => ratio is exactly 1.0; the rule needs median > 1.0 for 'weak',
		// so 1.0 falls through to 'fail'.
		expect(r.ratio!).toBeCloseTo(1, 6);
		expect(r.verdict).toBe('fail');
	});

	it('is inconclusive when fewer than half the blocks are valid', () => {
		const p = new BergerProtocol(fs, THREE);
		runProtocol(p, fs, THREE, [
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 60) }, // valid, ratio 9
			{ open: alphaEpoch(fs, 200), closed: alphaEpoch(fs, 60) }, // open all-artifact => invalid
			{ open: alphaEpoch(fs, 20), closed: alphaEpoch(fs, 200) } // closed all-artifact => invalid
		]);
		const r = p.state().result!;
		expect(r.perBlock[1].ratio).toBeNull();
		expect(r.perBlock[2].ratio).toBeNull();
		expect(r.verdict).toBe('inconclusive');
		expect(r.ratio!).toBeCloseTo(9, 4); // median of the single valid ratio
	});
});

describe('BergerProtocol — abort', () => {
	const fs = 100;

	function drivenTo(target: 'ready' | 'open' | 'closed'): BergerProtocol {
		const p = new BergerProtocol(fs, FAST);
		const g = sineGen(fs, 10, 15);
		p.start();
		if (target === 'open') pushN(p, 100 + 10, g); // past ready
		if (target === 'closed') pushN(p, 100 + 200 + 10, g); // past ready + open
		expect(p.state().phase).toBe(target);
		return p;
	}

	for (const target of ['ready', 'open', 'closed'] as const) {
		it(`from ${target} leaves phase 'aborted', a null result, and makes push a no-op`, () => {
			const p = drivenTo(target);
			p.abort();
			expect(p.state().phase).toBe('aborted');
			expect(p.state().result).toBeNull();

			const before = p.state();
			pushN(p, 500, sineGen(fs, 10, 15));
			const after = p.state();
			expect(after.phase).toBe('aborted');
			expect(after.accepted).toBe(before.accepted);
			expect(after.rejected).toBe(before.rejected);
		});
	}
});

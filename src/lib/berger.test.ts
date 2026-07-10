import { beforeEach, describe, expect, it } from 'vitest';
import { BergerProtocol, bergerFeasibility, type BergerOptions, type BergerPhase } from './berger';

// The protocol is WALL-CLOCK driven, not sample-clocked: the subject follows a countdown in
// real seconds, and a stalled/lumpy sample stream must not stretch or freeze the schedule.
// Every timing test therefore injects a fake monotonic clock and advances it explicitly.

let t = 0;
const now = () => t;
/** Advance the injected clock by `ms` and let the protocol cross any boundaries it now spans. */
const advanceMs = (p: BergerProtocol, ms: number) => {
	t += ms;
	p.tick();
};

beforeEach(() => {
	t = 0;
});

/** A 10 Hz alpha-band sine in µV. A 10 Hz sine at 100 SPS has a 10-sample period, so any
 *  50-sample window is exactly 5 whole cycles — every sub-epoch of the same amplitude is
 *  bit-identical and its alpha power is an exactly known function of the amplitude. */
const sine10 = (fs: number, amp: number) => (i: number) =>
	amp * Math.sin((2 * Math.PI * 10 * i) / fs);

/** Deterministic PRNG — never Math.random, so noisy tests stay reproducible. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Push `n` samples of `gen(index)` at the current clock (buffering is by count, not time). */
function pushSamples(p: BergerProtocol, n: number, gen: (i: number) => number): void {
	for (let i = 0; i < n; i++) p.push(gen(i));
}

interface EpochFns {
	open: (i: number) => number;
	closed: (i: number) => number;
	/** Samples to push per epoch. Default fills exactly `subsPerEpoch` sub-epochs. */
	samplesPerEpoch?: number;
}

/**
 * Drive a whole protocol from ready to done on the WALL CLOCK. For each epoch we advance
 * the clock past the settle window, push the requested number of samples (all at one instant,
 * which is fine because sub-epoch buffering counts samples), then advance to the epoch's end
 * so the boundary fires. The number of pushed samples — not the epoch duration — decides how
 * many sub-epochs form, which is the whole point of decoupling the two clocks.
 */
function runProtocol(
	p: BergerProtocol,
	fs: number,
	opts: Required<Pick<BergerOptions, 'epochSec' | 'settleSec' | 'subEpochSec' | 'readySec'>>,
	blocks: EpochFns[]
): void {
	const epochMs = opts.epochSec * 1000;
	const settleMs = opts.settleSec * 1000;
	const readyMs = opts.readySec * 1000;
	const subSamples = Math.round(opts.subEpochSec * fs);
	const analysableMs = epochMs - settleMs;
	const subsPerEpoch = Math.max(1, Math.floor(analysableMs / (opts.subEpochSec * 1000)));

	p.start();
	// Cross the ready window.
	advanceMs(p, readyMs);
	for (const b of blocks) {
		for (const gen of [b.open, b.closed]) {
			const nSamples = b.samplesPerEpoch ?? subsPerEpoch * subSamples;
			// Move just past the settle window, then deliver the samples.
			advanceMs(p, settleMs);
			pushSamples(p, nSamples, gen);
			// Advance to the exact end of this epoch, firing the boundary.
			advanceMs(p, epochMs - settleMs);
		}
	}
}

/** Small, fast timings that keep the sample counts (and the tests) tiny. */
const FAST = {
	epochSec: 2,
	settleSec: 0.5,
	subEpochSec: 0.5,
	readySec: 1,
	blocks: 2
} as const;
const THREE = {
	epochSec: 2,
	settleSec: 0.5,
	subEpochSec: 0.5,
	readySec: 0.5,
	blocks: 3
} as const;
const ONE = {
	epochSec: 2,
	settleSec: 0.5,
	subEpochSec: 0.5,
	readySec: 0.5,
	blocks: 1
} as const;

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

describe('BergerProtocol — wall-clock phase timeline', () => {
	const fs = 100;

	it('lands every transition on the exact wall-clock boundary', () => {
		const p = new BergerProtocol(fs, { ...FAST, now });
		p.start();
		expect(p.state().phase).toBe('ready');

		advanceMs(p, 999); // readySec = 1 s
		expect(p.state().phase).toBe('ready');
		advanceMs(p, 1);
		let s = p.state();
		expect(s.phase).toBe('open');
		expect(s.block).toBe(0);
		expect(s.condition).toBe('open');

		advanceMs(p, 1999); // epochSec = 2 s
		expect(p.state().phase).toBe('open');
		advanceMs(p, 1);
		s = p.state();
		expect(s.phase).toBe('closed');
		expect(s.condition).toBe('closed');
		expect(s.block).toBe(0);

		advanceMs(p, 2000); // block rollover: block 0 closed -> block 1 open
		s = p.state();
		expect(s.phase).toBe('open');
		expect(s.block).toBe(1);

		advanceMs(p, 2000); // block 1 open -> closed
		expect(p.state().phase).toBe('closed');

		advanceMs(p, 1999);
		expect(p.state().phase).toBe('closed');
		advanceMs(p, 1);
		s = p.state();
		expect(s.phase).toBe('done');
		expect(s.result).not.toBeNull();
	});

	it('fires onPhaseChange exactly once per transition, in order', () => {
		const seen: [BergerPhase, string | null][] = [];
		const p = new BergerProtocol(fs, {
			...FAST,
			now,
			onPhaseChange: (ph, cond) => seen.push([ph, cond])
		});
		runProtocol(p, fs, FAST, [
			{ open: sine10(fs, 20), closed: sine10(fs, 20) },
			{ open: sine10(fs, 20), closed: sine10(fs, 20) }
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

	it('reaches done on the clock ALONE with ZERO samples pushed (no frozen countdown)', () => {
		// The regression: a sample-clocked machine with a stopped stream never leaves ready.
		// Here we only ever advance the wall clock; not a single sample is fed.
		const p = new BergerProtocol(fs, { ...FAST, now });
		p.start();
		const total = FAST.readySec + FAST.blocks * 2 * FAST.epochSec; // seconds
		advanceMs(p, total * 1000 + 1);
		const s = p.state();
		expect(s.phase).toBe('done');
		expect(s.result).not.toBeNull();
		// Nothing was ever accepted, so no block ratio exists and the verdict is inconclusive.
		expect(s.result!.acceptedEpochs).toBe(0);
		expect(s.result!.verdict).toBe('inconclusive');
		expect(s.result!.perBlock.every((b) => b.ratio === null)).toBe(true);
	});

	it('does not stretch when samples arrive slowly (half the expected count per epoch)', () => {
		// Deliver only half the sub-epochs' worth of samples per epoch, but keep the wall clock
		// running normally. The protocol must still finish exactly on schedule.
		const subSamples = Math.round(FAST.subEpochSec * fs); // 50
		const half = subSamples * 2; // 2 sub-epochs where a full epoch would fit ~3
		const p = new BergerProtocol(fs, { ...FAST, now });
		runProtocol(p, fs, FAST, [
			{ open: sine10(fs, 20), closed: sine10(fs, 20), samplesPerEpoch: half },
			{ open: sine10(fs, 20), closed: sine10(fs, 20), samplesPerEpoch: half }
		]);
		expect(p.state().phase).toBe('done');
		// The elapsed wall time is exactly the scheduled length.
		expect(t).toBe((FAST.readySec + FAST.blocks * 2 * FAST.epochSec) * 1000);
	});

	it('crosses several boundaries in one tick (a whole block jump) firing each once', () => {
		const seen: [BergerPhase, string | null][] = [];
		const p = new BergerProtocol(fs, {
			...FAST,
			now,
			onPhaseChange: (ph, cond) => seen.push([ph, cond])
		});
		p.start();
		advanceMs(p, FAST.readySec * 1000); // -> block 0 open
		expect(p.state().phase).toBe('open');
		expect(p.state().block).toBe(0);

		// Jump a full block (open + closed of block 0) in a single tick. A backgrounded tab does
		// exactly this. Both boundaries must fire once, in order, landing us in block 1 open.
		advanceMs(p, 2 * FAST.epochSec * 1000);
		const s = p.state();
		expect(s.phase).toBe('open');
		expect(s.block).toBe(1);
		expect(seen).toEqual([
			['ready', null],
			['open', 'open'], // block 0 open
			['closed', 'closed'], // block 0 closed
			['open', 'open'] // block 1 open
		]);
	});

	it('counts secondsLeft down on the clock and is 0 when idle or done', () => {
		const p = new BergerProtocol(fs, {
			epochSec: 2,
			settleSec: 0.5,
			subEpochSec: 0.5,
			readySec: 3,
			blocks: 1,
			now
		});
		expect(p.state().phase).toBe('idle');
		expect(p.state().secondsLeft).toBe(0);

		p.start();
		expect(p.state().secondsLeft).toBe(3); // readySec = 3
		advanceMs(p, 1000);
		expect(p.state().secondsLeft).toBe(2);
		advanceMs(p, 1000);
		expect(p.state().secondsLeft).toBe(1);
		advanceMs(p, 1000); // rolls into the open epoch
		expect(p.state().phase).toBe('open');
		expect(p.state().secondsLeft).toBe(2); // epochSec = 2

		// Run out the whole protocol; done reports 0.
		advanceMs(p, 2 * 2000);
		expect(p.state().phase).toBe('done');
		expect(p.state().secondsLeft).toBe(0);
	});

	it('start() resets counters and result from any phase', () => {
		const p = new BergerProtocol(fs, { ...FAST, now });
		runProtocol(p, fs, FAST, [
			{ open: sine10(fs, 20), closed: sine10(fs, 60) },
			{ open: sine10(fs, 20), closed: sine10(fs, 60) }
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

	it('excludes samples pushed inside the settle window', () => {
		// A huge DC step delivered DURING the settle window must never reach a sub-epoch, so it
		// causes no rejection; the post-settle samples are a clean sine identical to the closed
		// epoch, giving a ratio of exactly 1.
		const p = new BergerProtocol(fs, { ...ONE, now });
		const subSamples = Math.round(ONE.subEpochSec * fs); // 50
		p.start();
		advanceMs(p, ONE.readySec * 1000); // -> open

		// Still inside the settle window (elapsed < settleMs): a 5000 µV rail should be dropped.
		expect(p.state().phase).toBe('open');
		pushSamples(p, subSamples, () => 5000);

		// Past settle: deliver 3 clean sub-epochs.
		advanceMs(p, ONE.settleSec * 1000);
		pushSamples(p, subSamples * 3, sine10(fs, 20));
		advanceMs(p, (ONE.epochSec - ONE.settleSec) * 1000); // close the open epoch

		// Closed epoch, identical clean sine.
		advanceMs(p, ONE.settleSec * 1000);
		pushSamples(p, subSamples * 3, sine10(fs, 20));
		advanceMs(p, (ONE.epochSec - ONE.settleSec) * 1000); // -> done

		const r = p.state().result!;
		expect(r.rejectedEpochs).toBe(0); // the DC rail never became a sub-epoch
		expect(r.perBlock[0].open!).toBeGreaterThan(0);
		expect(r.perBlock[0].ratio!).toBeCloseTo(1, 6);
	});

	it('rejects a sub-epoch whose peak-to-peak exceeds artifactUv', () => {
		const p = new BergerProtocol(fs, { ...ONE, now });
		runProtocol(p, fs, ONE, [
			{ open: sine10(fs, 100), closed: sine10(fs, 20) } // 100 µV amp => 200 p2p > 150
		]);
		const r = p.state().result!;
		expect(r.rejectedEpochs).toBe(3); // three sub-epochs in the open epoch
		expect(r.acceptedEpochs).toBe(3); // three in the clean closed epoch
		expect(r.perBlock[0].open).toBeNull();
		expect(r.perBlock[0].ratio).toBeNull();
	});

	it('rejects a sub-epoch below the RMS biosignal floor', () => {
		const p = new BergerProtocol(fs, { ...ONE, now });
		runProtocol(p, fs, ONE, [
			{ open: sine10(fs, 0.5), closed: sine10(fs, 20) } // rms ~0.35 µV < 1.5
		]);
		const r = p.state().result!;
		expect(r.rejectedEpochs).toBe(3);
		expect(r.perBlock[0].open).toBeNull();
	});

	it('invalidates an epoch when fewer than half its sub-epochs are accepted', () => {
		const fsN = 100;
		const subSamples = Math.round(ONE.subEpochSec * fsN); // 50
		const p = new BergerProtocol(fsN, { ...ONE, now });
		p.start();
		advanceMs(p, ONE.readySec * 1000); // -> open
		advanceMs(p, ONE.settleSec * 1000); // past settle
		// sub-epoch 0 clean, sub-epochs 1 & 2 artifacts => 1 of 3 accepted => epoch invalid.
		pushSamples(p, subSamples, sine10(fsN, 20));
		pushSamples(p, subSamples, sine10(fsN, 200));
		pushSamples(p, subSamples, sine10(fsN, 200));
		advanceMs(p, (ONE.epochSec - ONE.settleSec) * 1000); // close open
		// A clean closed epoch, so the ONLY reason a ratio is missing is the invalid open epoch.
		advanceMs(p, ONE.settleSec * 1000);
		pushSamples(p, subSamples * 3, sine10(fsN, 20));
		advanceMs(p, (ONE.epochSec - ONE.settleSec) * 1000); // -> done

		const r = p.state().result!;
		expect(r.perBlock[0].open).toBeNull();
		expect(r.perBlock[0].ratio).toBeNull();
		expect(r.verdict).toBe('inconclusive');
	});

	it('analyses a 90-sample sub-epoch at 45 SPS without hitting the all-zero PSD return', () => {
		// welch() returns an all-zero PSD when x.length < nextPow2(nperseg). subN = 90, so
		// nperseg must resolve to 64 (freqs length 64/2+1 = 33), not 128.
		const fs45 = 45;
		const opts = {
			epochSec: 4,
			settleSec: 0,
			subEpochSec: 2,
			readySec: 1
		} as const;
		const p = new BergerProtocol(fs45, { ...opts, blocks: 1, now });
		runProtocol(p, fs45, opts, [{ open: sine10(fs45, 20), closed: sine10(fs45, 20) }]);
		const r = p.state().result!;
		expect(r.perBlock[0].open!).toBeGreaterThan(0);
		expect(r.perBlock[0].closed!).toBeGreaterThan(0);

		const sp = p.spectra();
		expect(sp.open).not.toBeNull();
		expect(sp.open!.freqs.length).toBe(33); // proves nperseg = 64, not 128
		expect(Math.max(...sp.open!.psd)).toBeGreaterThan(0); // alpha power for a 10 Hz sine > 0
	});

	it('spectra is null for a condition with no accepted sub-epochs yet', () => {
		const p = new BergerProtocol(100, { ...FAST, now });
		p.start();
		expect(p.spectra().open).toBeNull();
		expect(p.spectra().closed).toBeNull();
	});
});

describe('BergerProtocol — ratio and verdict', () => {
	const fs = 100;

	it('passes when every block shows a consistent closed > open alpha rise', () => {
		const p = new BergerProtocol(fs, { ...THREE, now });
		runProtocol(p, fs, THREE, [
			{ open: sine10(fs, 20), closed: sine10(fs, 60) }, // 3x amp => 9x power
			{ open: sine10(fs, 20), closed: sine10(fs, 60) },
			{ open: sine10(fs, 20), closed: sine10(fs, 60) }
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
		const p = new BergerProtocol(fs, { ...THREE, now });
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
		const p = new BergerProtocol(fs, { ...THREE, now });
		runProtocol(p, fs, THREE, [
			{ open: sine10(fs, 20), closed: sine10(fs, 20) },
			{ open: sine10(fs, 20), closed: sine10(fs, 20) },
			{ open: sine10(fs, 20), closed: sine10(fs, 20) }
		]);
		const r = p.state().result!;
		// Identical epochs => ratio exactly 1.0; 'weak' needs median > 1.0, so 1.0 => 'fail'.
		expect(r.ratio!).toBeCloseTo(1, 6);
		expect(r.verdict).toBe('fail');
	});

	it('is inconclusive when fewer than half the blocks are valid', () => {
		const p = new BergerProtocol(fs, { ...THREE, now });
		runProtocol(p, fs, THREE, [
			{ open: sine10(fs, 20), closed: sine10(fs, 60) }, // valid, ratio 9
			{ open: sine10(fs, 200), closed: sine10(fs, 60) }, // open all-artifact => invalid
			{ open: sine10(fs, 20), closed: sine10(fs, 200) } // closed all-artifact => invalid
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
		const p = new BergerProtocol(fs, { ...FAST, now });
		p.start();
		if (target === 'open') advanceMs(p, FAST.readySec * 1000 + 100); // past ready
		if (target === 'closed') advanceMs(p, (FAST.readySec + FAST.epochSec) * 1000 + 100); // past open
		expect(p.state().phase).toBe(target);
		return p;
	}

	for (const target of ['ready', 'open', 'closed'] as const) {
		it(`from ${target} leaves phase 'aborted', a null result, and makes push/tick a no-op`, () => {
			const p = drivenTo(target);
			p.abort();
			expect(p.state().phase).toBe('aborted');
			expect(p.state().result).toBeNull();

			const before = p.state();
			advanceMs(p, 10_000); // tick well past where 'done' would have been
			pushSamples(p, 500, sine10(fs, 15));
			const after = p.state();
			expect(after.phase).toBe('aborted');
			expect(after.result).toBeNull();
			expect(after.accepted).toBe(before.accepted);
			expect(after.rejected).toBe(before.rejected);
		});
	}
});

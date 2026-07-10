// Guided Berger test — a wall-clock-driven, deterministic state machine, no DOM.
//
// Hans Berger (1929) named the alpha rhythm after the first letter he saw appear: a
// ~10 Hz posterior oscillation that DESYNCHRONISES (shrinks) with the eyes open and
// SYNCHRONISES (grows) with the eyes closed. That eyes-open/eyes-closed swing is the
// oldest, most repeatable result in human EEG, so it is the honest way to prove this
// device is reading brain rhythm at all rather than noise.
//
// But the textbook 2–5x occipital ratio does NOT apply here. The generator is occipital
// and this is a single **around-ear** dry channel (an earpad electrode, physically beside
// the ear, not on the forehead or above the eyes) sitting far from that generator, so the
// alpha it sees is heavily attenuated and a modest rise is all we can honestly expect.
// Hard-coding "1.5x = pass"
// would be inventing a threshold the physics does not support. Instead the verdict is by
// CROSS-BLOCK CONSISTENCY: a real Berger effect repeats across every open/closed block,
// where a fluke or an artifact does not. We ask "did closed beat open in every block?",
// not "did it beat some magic number?".
//
// One more honesty caveat baked into the design: closing the eyes also relaxes the
// facial and jaw muscles, which lowers broadband EMG power. On one channel that muscle
// relaxation can masquerade as an alpha rise. Averaging over the 8–13 Hz band (not
// broadband) and rejecting artifact/near-flat sub-epochs limits it, but cannot erase it.
//
// WHY THE CLOCK IS WALL-TIME, NOT SAMPLE-TIME. The subject follows the protocol with
// their eyes and a countdown — they live in wall-clock seconds. Phase transitions must
// therefore be driven by ELAPSED TIME (`tick()` off a rAF loop), never by a sample count.
// A sample count is the wrong clock domain the moment the stream is anything but perfect:
// the synthetic demo pushes fewer than `fs` samples/second and a 123 s protocol used to
// take >157 s; real BLE drops packets, stretching every epoch; and a stopped stream
// delivers ZERO samples, freezing the countdown forever. Only the DSP stays sample-based
// (Welch needs real samples at `fs`): samples fill a sub-epoch buffer whose length is a
// count, and the wall clock decides which epoch that buffer belongs to.

import { bandPowers, nextPow2, welch, type Psd } from './dsp';

export type BergerPhase = 'idle' | 'ready' | 'open' | 'closed' | 'done' | 'aborted';
export type BergerVerdict = 'pass' | 'weak' | 'fail' | 'inconclusive';

export interface BergerOptions {
	blocks?: number; // default 3
	epochSec?: number; // default 20
	settleSec?: number; // default 2   (discarded at the start of every epoch)
	subEpochSec?: number; // default 2
	readySec?: number; // default 3
	artifactUv?: number; // default 150 (peak-to-peak reject)
	rmsFloorUv?: number; // default 1.5 (below this there is no biosignal)
	onPhaseChange?: (phase: BergerPhase, condition: 'open' | 'closed' | null) => void;
	/** Monotonic milliseconds. Injected so the protocol is deterministic under test. */
	now?: () => number;
}

/** Alpha only reaches 13 Hz, so the Berger test is valid at rates where the focus score is not. */
export function bergerFeasibility(fs: number): { ok: boolean; reason: string | null } {
	// 0.49 is exactly the clamp dsp.makeChain applies to the analysis low-pass, so this
	// gate matches the passband that actually runs rather than the ideal Nyquist.
	const passband = 0.49 * fs;
	if (passband >= 13) return { ok: true, reason: null };
	const minSps = Math.ceil(13 / 0.49);
	return {
		ok: false,
		reason: `alpha (8–13 Hz) needs > ${minSps} SPS; at ${fs} SPS the passband stops at ${passband.toFixed(1)} Hz`
	};
}

export interface BergerBlock {
	block: number; // 1-based block number, for display
	open: number | null;
	closed: number | null;
	ratio: number | null;
}

export interface BergerResult {
	ratio: number | null; // median of the valid per-block ratios
	perBlock: BergerBlock[];
	verdict: BergerVerdict;
	// Cumulative accepted / rejected *sub-epochs* over the whole run (the analysis unit),
	// not 20 s epochs — this is what the rejected-epoch counter in the UI reflects.
	acceptedEpochs: number;
	rejectedEpochs: number;
}

export interface BergerState {
	phase: BergerPhase;
	block: number; // 0-based, current block
	blocks: number;
	condition: 'open' | 'closed' | null;
	secondsLeft: number; // in the current phase, rounded up
	accepted: number;
	rejected: number;
	result: BergerResult | null;
}

/** Sub-epochs shorter than this cannot resolve the 8–13 Hz band and are dropped. */
const MIN_NPERSEG = 32;

function mean(xs: number[]): number {
	if (xs.length === 0) return 0;
	let acc = 0;
	for (const x of xs) acc += x;
	return acc / xs.length;
}

/** Median of a list, or null when empty; even counts average the two middle values. */
function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class BergerProtocol {
	readonly feasible: { ok: boolean; reason: string | null };

	private readonly fs: number;
	private readonly blocks: number;
	private readonly artifactUv: number;
	private readonly rmsFloorUv: number;
	private readonly onPhaseChange?: (
		phase: BergerPhase,
		condition: 'open' | 'closed' | null
	) => void;
	private readonly now: () => number;

	// Phase durations in MILLISECONDS (the protocol clock). Only subSamples is a count,
	// because the DSP needs a fixed number of samples at fs, not a duration.
	private readonly readyMs: number;
	private readonly epochMs: number;
	private readonly settleMs: number;
	private readonly subSamples: number;

	private phase: BergerPhase = 'idle';
	private block = 0;
	private condition: 'open' | 'closed' | null = null;

	// Wall-clock anchors, all absolute ms from `now()`. t0 is set at start(); every phase
	// boundary is derived from t0 + the fixed schedule, so late/lumpy ticks still land epochs
	// on their exact wall-clock instants.
	private t0 = 0;
	private epochStartMs = 0; // start of the current open/closed epoch (== t0 during ready)
	private phaseEndMs = 0; // instant the current phase ends

	// Current sub-epoch accumulator and the accepted-alpha list for the current epoch.
	private subBuf: number[] = [];
	private epochSubAlphas: number[] = [];
	private epochTotal = 0; // sub-epochs seen in the current epoch (accepted + rejected)

	private totalAccepted = 0; // cumulative, for the live counter and the result
	private totalRejected = 0;

	private blockData: { openAlpha: number | null; closedAlpha: number | null }[] = [];

	// Element-wise PSD sums for the open-vs-closed compare plot.
	private openPsdSum: Float64Array | null = null;
	private openPsdCount = 0;
	private closedPsdSum: Float64Array | null = null;
	private closedPsdCount = 0;
	private psdFreqs: Float64Array | null = null; // shared axis; nperseg is constant per run

	private result: BergerResult | null = null;

	constructor(fs: number, options: BergerOptions = {}) {
		this.fs = fs;
		this.feasible = bergerFeasibility(fs);
		this.blocks = options.blocks ?? 3;
		this.artifactUv = options.artifactUv ?? 150;
		this.rmsFloorUv = options.rmsFloorUv ?? 1.5;
		this.onPhaseChange = options.onPhaseChange;
		this.now =
			options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
		this.readyMs = (options.readySec ?? 3) * 1000;
		this.epochMs = (options.epochSec ?? 20) * 1000;
		this.settleMs = (options.settleSec ?? 2) * 1000;
		this.subSamples = Math.round((options.subEpochSec ?? 2) * fs);
	}

	/** Reset every counter and enter `ready`, whatever phase we were in. */
	start(): void {
		this.block = 0;
		this.condition = null;
		this.subBuf = [];
		this.epochSubAlphas = [];
		this.epochTotal = 0;
		this.totalAccepted = 0;
		this.totalRejected = 0;
		this.blockData = Array.from({ length: this.blocks }, () => ({
			openAlpha: null,
			closedAlpha: null
		}));
		this.openPsdSum = null;
		this.openPsdCount = 0;
		this.closedPsdSum = null;
		this.closedPsdCount = 0;
		this.psdFreqs = null;
		this.result = null;
		this.t0 = this.now();
		this.epochStartMs = this.t0;
		this.phaseEndMs = this.t0 + this.readyMs;
		this.setPhase('ready', null);
		this.advance(); // collapse a zero-length ready phase straight into the first epoch
	}

	/** Stop immediately from any phase; the result stays null (nothing was completed). */
	abort(): void {
		this.result = null;
		this.setPhase('aborted', null);
	}

	/**
	 * Advance phases from the wall clock. Call from a rAF loop so the countdown keeps
	 * running even when no samples arrive (stream stopped, board disconnected).
	 */
	tick(): void {
		if (this.phase === 'ready' || this.phase === 'open' || this.phase === 'closed') this.advance();
	}

	/** Feed one BAND-PASSED sample in µV (the caller's 1–45 Hz + notch chain output). */
	push(uv: number): void {
		// Advance transitions off the wall clock FIRST, so an epoch boundary that falls in
		// the middle of a batch is honoured before this sample is filed against a phase.
		this.tick();
		if (this.phase !== 'open' && this.phase !== 'closed') return;
		// The first settleMs of each epoch is the transition/eye-movement/settling window and
		// is discarded before any sub-epoch accumulates.
		if (this.now() - this.epochStartMs >= this.settleMs) {
			this.subBuf.push(uv);
			if (this.subBuf.length >= this.subSamples) {
				this.processSubEpoch(this.subBuf);
				this.subBuf = [];
			}
		}
		// idle / ready / done / aborted: no sample is buffered, so a late sample can never
		// disturb a finished run and none accumulates before the first epoch opens.
	}

	state(): BergerState {
		return {
			phase: this.phase,
			block: this.block,
			blocks: this.blocks,
			condition: this.condition,
			secondsLeft: this.secondsLeft(),
			accepted: this.totalAccepted,
			rejected: this.totalRejected,
			result: this.result
		};
	}

	/** Averaged open/closed PSDs for the compare plot, once at least one epoch of each is valid. */
	spectra(): { open: Psd | null; closed: Psd | null } {
		return {
			open: this.averagePsd(this.openPsdSum, this.openPsdCount),
			closed: this.averagePsd(this.closedPsdSum, this.closedPsdCount)
		};
	}

	// ---- internals ----

	private setPhase(phase: BergerPhase, condition: 'open' | 'closed' | null): void {
		this.phase = phase;
		this.condition = condition;
		this.onPhaseChange?.(phase, condition);
	}

	private enterEpoch(block: number, condition: 'open' | 'closed'): void {
		this.block = block;
		// Boundaries come from the fixed schedule off t0, never from "when we noticed": ready,
		// then for each block an open epoch followed by a closed epoch, all of length epochMs.
		const base = this.t0 + this.readyMs + block * 2 * this.epochMs;
		this.epochStartMs = condition === 'open' ? base : base + this.epochMs;
		this.phaseEndMs = this.epochStartMs + this.epochMs;
		this.subBuf = []; // any trailing partial sub-epoch of the previous phase is dropped here
		this.epochSubAlphas = [];
		this.epochTotal = 0;
		this.setPhase(condition, condition);
	}

	/**
	 * Advance through every phase whose window has already closed by `now()`. The loop (rather
	 * than a single step) both collapses a zero-length phase and lets one tick cross MULTIPLE
	 * boundaries — a backgrounded tab can jump seconds — firing onPhaseChange once per boundary,
	 * in chronological order, and finalizing each epoch exactly once as its window closes.
	 */
	private advance(): void {
		for (;;) {
			const t = this.now();
			if (this.phase === 'ready') {
				if (t < this.phaseEndMs) return;
				this.enterEpoch(0, 'open');
			} else if (this.phase === 'open') {
				if (t < this.phaseEndMs) return;
				this.finalizeEpoch();
				this.enterEpoch(this.block, 'closed');
			} else if (this.phase === 'closed') {
				if (t < this.phaseEndMs) return;
				this.finalizeEpoch();
				if (this.block < this.blocks - 1) this.enterEpoch(this.block + 1, 'open');
				else return this.finish();
			} else {
				return;
			}
		}
	}

	private processSubEpoch(buf: number[]): void {
		this.epochTotal++;
		let min = Infinity;
		let max = -Infinity;
		let sq = 0;
		for (const v of buf) {
			if (v < min) min = v;
			if (v > max) max = v;
			sq += v * v;
		}
		const p2p = max - min;
		const rms = Math.sqrt(sq / buf.length);
		// A large p2p is an artifact (blink, movement, pop); a tiny RMS is a detached
		// electrode reading its own noise floor. Neither is analysable EEG.
		if (p2p > this.artifactUv || rms < this.rmsFloorUv) {
			this.totalRejected++;
			return;
		}
		if (this.subSamples < MIN_NPERSEG) {
			this.totalRejected++;
			return;
		}

		const nperseg = this.chooseNperseg(this.subSamples);
		const { freqs, psd } = welch(Float64Array.from(buf), this.fs, nperseg, 0.5);
		this.epochSubAlphas.push(bandPowers(freqs, psd).alpha);
		this.totalAccepted++;

		if (!this.psdFreqs) this.psdFreqs = freqs;
		if (this.condition === 'closed') {
			if (!this.closedPsdSum) this.closedPsdSum = new Float64Array(psd.length);
			for (let k = 0; k < psd.length; k++) this.closedPsdSum[k] += psd[k];
			this.closedPsdCount++;
		} else {
			if (!this.openPsdSum) this.openPsdSum = new Float64Array(psd.length);
			for (let k = 0; k < psd.length; k++) this.openPsdSum[k] += psd[k];
			this.openPsdCount++;
		}
	}

	/**
	 * Largest power of two <= subN, starting from ~1 s of samples and floored at 32. Staying
	 * <= subN is what keeps welch() out of its all-zero `x.length < nextPow2(nperseg)` return.
	 */
	private chooseNperseg(subN: number): number {
		let nperseg = nextPow2(Math.round(this.fs));
		while (nperseg > subN) nperseg >>= 1;
		return Math.max(MIN_NPERSEG, nperseg);
	}

	private finalizeEpoch(): void {
		const accepted = this.epochSubAlphas.length;
		// Fewer than half the sub-epochs accepted means the epoch was too contaminated to
		// trust; its alpha is null so the block ratio cannot be computed from it.
		const valid = this.epochTotal > 0 && accepted * 2 >= this.epochTotal;
		const alpha = valid ? mean(this.epochSubAlphas) : null;
		const bd = this.blockData[this.block];
		if (this.condition === 'closed') bd.closedAlpha = alpha;
		else bd.openAlpha = alpha;
	}

	private finish(): void {
		// result MUST be set before the phase flips to 'done' — a consumer reads
		// state().result synchronously inside the onPhaseChange('done') callback.
		this.result = this.buildResult();
		this.setPhase('done', null);
	}

	private buildResult(): BergerResult {
		const perBlock: BergerBlock[] = this.blockData.map((bd, i) => {
			const { openAlpha: open, closedAlpha: closed } = bd;
			const ratio = open !== null && closed !== null && open > 0 ? closed / open : null;
			return { block: i + 1, open, closed, ratio };
		});
		const ratios = perBlock.map((b) => b.ratio).filter((r): r is number => r !== null);
		const ratio = median(ratios);
		const validBlocks = ratios.length;

		let verdict: BergerVerdict;
		if (validBlocks < Math.ceil(this.blocks / 2)) verdict = 'inconclusive';
		else if (ratios.every((r) => r > 1.0) && ratio !== null && ratio >= 1.2) verdict = 'pass';
		else if (ratio !== null && ratio > 1.0) verdict = 'weak';
		else verdict = 'fail';

		return {
			ratio,
			perBlock,
			verdict,
			acceptedEpochs: this.totalAccepted,
			rejectedEpochs: this.totalRejected
		};
	}

	private averagePsd(sum: Float64Array | null, count: number): Psd | null {
		if (!sum || count === 0 || !this.psdFreqs) return null;
		const psd = new Float64Array(sum.length);
		for (let k = 0; k < sum.length; k++) psd[k] = sum[k] / count;
		return { freqs: this.psdFreqs, psd };
	}

	private secondsLeft(): number {
		if (this.phase !== 'ready' && this.phase !== 'open' && this.phase !== 'closed') return 0;
		return Math.max(0, Math.ceil((this.phaseEndMs - this.now()) / 1000));
	}
}

// BERGER·1 EEG controller — ported from the NeuroFocus design canvas.
//
// Drives the canvases/readouts in +page.svelte by id; one ingest path feeds
// BLE / file / demo into the shared DSP (./dsp). Corrections vs. the design:
//   - real firmware BLE UUIDs (the design used the Bluetooth base-UUID suffix)
//   - adcBits 24 for the ADS1220 (the design hard-coded 12)

import * as dsp from './dsp';
import type { FilterChain, Psd } from './dsp';
import { ADC_PROFILES, type AdcProfile } from './adc';
import { BergerProtocol, bergerFeasibility, type BergerState } from './berger';
import {
	SWEEP_SEC,
	UV_PER_DIV,
	V_DIVS,
	autoEnvelope,
	autosetUvPerDiv,
	minMaxDecimate,
	type SweepSec,
	type UvPerDiv
} from './scope';
import {
	BLE_CMD,
	BLE_DATA,
	BLE_SERVICE,
	NeuroLink,
	V2_SAMPLE_RATE,
	V4_SAMPLE_RATE,
	describeDiag,
	type DiagReport
} from './ble';

const GREEK: Record<dsp.BandName, string> = {
	delta: 'δ',
	theta: 'θ',
	alpha: 'α',
	beta: 'β',
	gamma: 'γ'
};

// Re-exported for the /ez and /demo routes, which were importing them from here.
export { ADC_PROFILES, BLE_SERVICE, BLE_DATA, BLE_CMD };
export type { AdcProfile };

/**
 * Nominal ADC rate per board revision. The DSP must use the board's TRUE rate, never a
 * measured samples/elapsed rate — BLE drops make the measured rate sag, which compresses
 * the whole frequency axis (a real 60 Hz mains line slides toward ~48 Hz).
 */
export const BLE_SAMPLE_RATE: Record<AdcProfile, number> = {
	v4: V4_SAMPLE_RATE,
	v2: V2_SAMPLE_RATE
};

/** Live state of the EEG scope's horizontal/vertical controls, for the Svelte header row. */
export interface ScopeState {
	sweepSec: SweepSec;
	uvPerDiv: UvPerDiv | 'auto';
	/** The gain actually in force this frame — equals `uvPerDiv` unless it is 'auto'. */
	effectiveUvPerDiv: number;
	hold: boolean;
	secPerDiv: number;
}

export { SWEEP_SEC, UV_PER_DIV };

export class NeuroFocus {
	private adcProfile: AdcProfile = 'v4';
	private settings: dsp.ScaleSettings = { ...ADC_PROFILES.v4 };
	private demoAlpha = 18;

	private fs = 600;
	private filt: number[] = [];
	private filtCap = 0;
	private specCols: Float64Array[] = [];
	private specCap = 360;
	private nfftSpec = 256;
	private hop = 0;
	private hopAcc = 0;
	private sampleWin: number[] = [];
	private psd: Psd | null = null;
	private spsCount = 0;
	private spsT = 0;
	private ovf = 0;
	private lastPsd = 0;
	private welchN = 1024;
	// Welch averaging: a longer history + high overlap gives many averaged segments, which
	// is what makes the PSD smooth and pins the alpha peak at its true ~10 Hz. The old
	// 4 s / 0.5-overlap window yielded only ~3 segments -> jagged spectrum and the peak
	// jittering up to ~12 Hz. 10 s @ 0.75 overlap -> ~20 segments.
	private psdWindowS = 10;
	private welchOverlap = 0.75;
	private chain: FilterChain | null = null;

	private raf = 0;
	private demoTimer: ReturnType<typeof setInterval> | null = null;
	private demoData: number[] = [];
	private demoIdx = 0;
	private link: NeuroLink | null = null;

	// ---------- scope controls (EEG ACTIVITY) ----------
	// The old trace drew one lineTo per sample over a fixed 4 s window and re-derived the
	// vertical gain from the visible peak every frame. At 2000 SPS that overplots ~8000
	// vertices into ~560 px, and the gain always stretched noise to fill the screen.
	private sweepSec: SweepSec = 4;
	/** 'auto' keeps auto-ranging, but through a fast-attack/slow-release envelope. */
	private uvPerDiv: UvPerDiv | 'auto' = 'auto';
	private autoEnv = 1;
	private hold = false;
	private holdBuf: number[] = [];
	private onScope: ((s: ScopeState) => void) | null = null;

	// ---------- guided Berger test ----------
	private berger: BergerProtocol | null = null;
	private onBerger: ((s: BergerState | null) => void) | null = null;
	private beep: AudioContext | null = null;

	// ---------- lifecycle ----------
	mount(): void {
		this.spsT = performance.now();
		this.setFs(600);
		this.start();
		this.startDemo();
		if (!('bluetooth' in navigator)) {
			const b = this.el('nf-banner');
			if (b) {
				b.style.display = 'block';
				b.textContent =
					'⚠ Web Bluetooth unavailable in this frame — open BERGER-1 standalone in Chrome / Edge to LINK a live device. TEST SIGNAL and LOAD FILE work everywhere.';
			}
		}
	}

	destroy(): void {
		void this.stopAll();
		cancelAnimationFrame(this.raf);
	}

	// ---------- helpers ----------
	private el(id: string): HTMLElement | null {
		return document.getElementById(id);
	}

	private setText(id: string, text: string): void {
		const e = this.el(id);
		if (e) e.textContent = text;
	}

	private setFs(fs: number): void {
		const changed = fs !== this.fs;
		this.fs = fs;
		// Hold enough filtered history for the Welch window (+ headroom) so the PSD can
		// average many segments instead of the ~3 a 4 s buffer allowed.
		this.filtCap = Math.round(fs * (this.psdWindowS + 2));
		this.hop = Math.round(fs * 0.18);
		this.chain = dsp.makeChain(fs, { lo: 1, hi: 45, line: this.settings.line });
		this.welchN = dsp.nextPow2(Math.min(Math.round(fs * 2), 1024));
		// ~1 s of samples per STFT column. Pinned at 256 this gave 7.8 Hz bins at 2000 SPS
		// (alpha and theta collapsing into one or two) and a 12.8 s column at 20 SPS.
		this.nfftSpec = Math.max(128, Math.min(1024, dsp.nextPow2(Math.round(fs))));
		this.setText('nf-fs', String(Math.round(fs)));
		// Every buffer below holds samples filtered at the OLD rate and binned at the old
		// nfft. Reading them at the new fs slides every frequency by the rate ratio, so the
		// PSD would stay corrupt for a whole psdWindowS. Drop them, and abandon any Berger
		// run in flight — its epochs were sample-clocked against the old rate.
		if (changed) {
			this.reset();
			if (this.berger) {
				this.berger = null;
				this.emitBerger();
				this.msg(`rate changed to ${Math.round(fs)} SPS — alpha test cancelled`);
			}
		}
	}

	// ---------- ADC scaling profile (v2 12-bit unipolar vs v4 24-bit bipolar) ----------
	// Swaps the counts->µV ScaleSettings and rebuilds the filter chain. Only affects the
	// counts sources (ESP32 BLE); the µV sources (file/demo) bypass countsToUv.
	setAdcProfile(p: AdcProfile): void {
		this.adcProfile = p;
		this.settings = { ...ADC_PROFILES[p] };
		this.setFs(this.fs); // rebuild makeChain with settings.line
		// setFs only flushes on a rate change, but the counts→µV scale just moved under the
		// buffered samples (v2 vs v4 differ by ~4096x), so the history is meaningless now.
		this.reset();
		this.msg(
			p === 'v2'
				? 'ADC profile · V2 · ESP32-C3 12-bit unipolar'
				: 'ADC profile · V4 · ADS1220 24-bit bipolar'
		);
	}

	getAdcProfile(): AdcProfile {
		return this.adcProfile;
	}

	private setMode(name: string, color: string): void {
		const m = this.el('nf-mode');
		if (m) {
			m.textContent = name;
			m.style.color = color === '#2a3329' ? '#7fae8c' : color;
		}
		const d = this.el('nf-dot');
		if (!d) return;
		d.style.background = color;
		d.style.boxShadow =
			name === 'idle'
				? '0 0 0 1px rgba(0,0,0,.5)'
				: `0 0 9px 1px ${color},0 0 0 1px rgba(0,0,0,.4)`;
		d.style.animation = name === 'idle' ? 'none' : 'nf-pulse 1.6s infinite';
	}

	private reset(): void {
		this.filt = [];
		this.specCols = [];
		this.sampleWin = [];
		this.hopAcc = 0;
		this.chain?.reset();
		this.psd = null;
		this.holdBuf = [];
		this.autoEnv = 1;
		this.ovf = 0;
	}

	private msg(t: string): void {
		this.setText('nf-msg', t);
	}

	// ---------- core ingest (shared by BLE / file / demo) ----------
	private ingest(value: number, isUv: boolean): void {
		if (!this.chain) return;
		const uv = isUv ? value : dsp.countsToUv(value, this.settings);
		const y = this.chain.step(uv);
		this.filt.push(y);
		if (this.filt.length > this.filtCap) this.filt.shift();
		this.sampleWin.push(y);
		if (this.sampleWin.length > this.nfftSpec) this.sampleWin.shift();
		if (++this.hopAcc >= this.hop && this.sampleWin.length >= this.nfftSpec) {
			this.hopAcc = 0;
			const col = dsp.stftColumn(this.sampleWin.slice(-this.nfftSpec), this.fs, this.nfftSpec);
			this.specCols.push(col);
			if (this.specCols.length > this.specCap) this.specCols.shift();
		}
		// The Berger protocol is sample-clocked, so it must see the band-passed stream here
		// rather than sniff a buffer on a timer.
		this.berger?.push(y);
		this.spsCount++;
	}

	private ingestMany(arr: number[], isUv: boolean): void {
		for (let i = 0; i < arr.length; i++) this.ingest(arr[i], isUv);
	}

	// ---------- render loop ----------
	private start(): void {
		const loop = (): void => {
			this.raf = requestAnimationFrame(loop);
			this.sizeAll();
			this.drawRaw();
			this.drawSpec();
			const now = performance.now();
			if (now - this.spsT > 500) {
				this.setText('nf-sps', String(Math.round((this.spsCount * 1000) / (now - this.spsT))));
				// Dropped BLE notifications, counted host-side from the frame seq gaps. The
				// firmware's own ring drops silently at 1000/2000 SPS, so this is the only
				// place a saturated link becomes visible.
				if (this.link) this.ovf = this.link.stats.dropped;
				this.setText('nf-ovf', String(this.ovf));
				this.spsCount = 0;
				this.spsT = now;
				// The AUTO gain moves every frame; republish it at the readout cadence rather
				// than re-rendering the header 60x/s.
				if (this.uvPerDiv === 'auto') this.emitScope();
			}
			if (this.berger) this.emitBerger();
			if (now - this.lastPsd > 450 && this.filt.length > this.welchN) {
				this.lastPsd = now;
				const seg = this.filt.slice(
					-Math.min(this.filt.length, Math.round(this.fs * this.psdWindowS))
				);
				this.psd = dsp.welch(Float64Array.from(seg), this.fs, this.welchN, this.welchOverlap);
				this.drawPsd();
				this.drawBands();
				const pk = dsp.peakFreq(this.psd.freqs, this.psd.psd, 7, 13);
				this.setText('nf-peak', pk ? pk.toFixed(1) : '00.0');
			}
		};
		this.raf = requestAnimationFrame(loop);
	}

	// ---------- canvas sizing ----------
	private sizeAll(): void {
		for (const id of ['nf-raw', 'nf-psd', 'nf-band', 'nf-spec']) {
			const c = this.el(id) as HTMLCanvasElement | null;
			if (!c) continue;
			const w = c.clientWidth,
				h = c.clientHeight,
				dpr = window.devicePixelRatio || 1;
			if (w && h && (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr))) {
				c.width = Math.round(w * dpr);
				c.height = Math.round(h * dpr);
			}
		}
	}

	private ctx(id: string): { x: CanvasRenderingContext2D; w: number; h: number } | null {
		const c = this.el(id) as HTMLCanvasElement | null;
		if (!c || !c.width) return null;
		const x = c.getContext('2d');
		if (!x) return null;
		const dpr = window.devicePixelRatio || 1;
		x.setTransform(dpr, 0, 0, dpr, 0, 0);
		return { x, w: c.clientWidth, h: c.clientHeight };
	}

	// ---------- scope controls ----------
	/** µV per vertical division actually in force this frame. */
	private gain(data: ArrayLike<number>): number {
		if (this.uvPerDiv !== 'auto') return this.uvPerDiv;
		let peak = 1;
		for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
		this.autoEnv = autoEnvelope(this.autoEnv, peak);
		// Spread the envelope over the half-screen (V_DIVS/2 divisions), with 15% headroom.
		return (this.autoEnv * 1.15) / (V_DIVS / 2);
	}

	private emitScope(): void {
		const eff =
			this.uvPerDiv === 'auto'
				? Math.max(0.01, (this.autoEnv * 1.15) / (V_DIVS / 2))
				: this.uvPerDiv;
		this.onScope?.({
			sweepSec: this.sweepSec,
			uvPerDiv: this.uvPerDiv,
			effectiveUvPerDiv: eff,
			hold: this.hold,
			secPerDiv: this.sweepSec / 8
		});
	}

	onScopeChange(cb: (s: ScopeState) => void): void {
		this.onScope = cb;
		this.emitScope();
	}

	setSweep(sec: SweepSec): void {
		this.sweepSec = sec;
		this.emitScope();
	}

	setUvPerDiv(v: UvPerDiv | 'auto'): void {
		this.uvPerDiv = v;
		this.emitScope();
	}

	setHold(on: boolean): void {
		this.hold = on;
		// Freeze against a snapshot so the trace stays put while samples keep arriving.
		this.holdBuf = on ? this.visibleWindow() : [];
		this.emitScope();
	}

	/** One shot: fit the 99.5th-percentile amplitude and return to a 4 s sweep. */
	autoset(): void {
		const data = this.visibleWindow();
		if (data.length >= 2) this.uvPerDiv = autosetUvPerDiv(data);
		this.sweepSec = 4;
		this.emitScope();
		this.msg(`autoset · ${this.sweepSec / 8} s/div · ${this.uvPerDiv} µV/div`);
	}

	private visibleWindow(): number[] {
		const n = Math.min(this.filt.length, Math.round(this.fs * this.sweepSec));
		return this.filt.slice(-Math.max(0, n));
	}

	// ---------- green phosphor: raw trace ----------
	private drawRaw(): void {
		const g = this.ctx('nf-raw');
		if (!g) return;
		const { x, w, h } = g;
		x.clearRect(0, 0, w, h);
		x.strokeStyle = 'rgba(90,200,120,.11)';
		x.lineWidth = 1;
		for (let i = 1; i < V_DIVS; i++) {
			const y = (h * i) / V_DIVS;
			x.beginPath();
			x.moveTo(0, y);
			x.lineTo(w, y);
			x.stroke();
		}
		for (let i = 1; i < 8; i++) {
			const xx = (w * i) / 8;
			x.beginPath();
			x.moveTo(xx, 0);
			x.lineTo(xx, h);
			x.stroke();
		}
		x.strokeStyle = 'rgba(90,200,120,.22)';
		x.beginPath();
		x.moveTo(0, h / 2);
		x.lineTo(w, h / 2);
		x.stroke();

		const data = this.hold ? this.holdBuf : this.visibleWindow();
		if (data.length < 2) return;
		const uvDiv = this.gain(data);
		const half = h / 2 - 2;
		// v maps to (V_DIVS/2) divisions of deflection at full scale.
		const Y = (v: number): number =>
			h / 2 - Math.max(-1, Math.min(1, v / (uvDiv * (V_DIVS / 2)))) * half;

		x.save();
		x.shadowColor = 'rgba(102,240,138,.6)';
		x.shadowBlur = 7;
		x.strokeStyle = '#86ffa6';
		x.lineWidth = 1.4;
		x.beginPath();
		const cols = Math.max(1, Math.round(w));
		if (data.length <= cols) {
			// Fewer samples than pixels — a plain polyline reads better than stubs.
			for (let i = 0; i < data.length; i++) {
				const px = (i / (data.length - 1)) * w;
				const py = Y(data[i]);
				if (i) x.lineTo(px, py);
				else x.moveTo(px, py);
			}
		} else {
			// One vertical [min,max] segment per pixel column. Overplotting 8000 vertices
			// into 560 px is what made 2000 SPS look like a solid noise band.
			const reduced = minMaxDecimate(data, cols);
			for (let c = 0; c < reduced.length; c++) {
				const px = (c / Math.max(1, reduced.length - 1)) * w;
				x.moveTo(px, Y(reduced[c].max));
				x.lineTo(px, Y(reduced[c].min));
			}
		}
		x.stroke();
		x.restore();

		x.fillStyle = 'rgba(134,255,166,.55)';
		x.font = "10px 'Space Mono',monospace";
		const full = uvDiv * (V_DIVS / 2);
		x.fillText('+' + full.toFixed(full < 10 ? 1 : 0) + 'µV', 5, 12);
		x.fillText('-' + full.toFixed(full < 10 ? 1 : 0), 5, h - 5);
		if (this.hold) {
			x.fillStyle = 'rgba(255,179,58,.9)';
			x.font = "600 10px 'Space Mono',monospace";
			x.fillText('HOLD', w - 40, 12);
		}
	}

	// ---------- amber phosphor: Welch PSD ----------
	private drawPsd(): void {
		const g = this.ctx('nf-psd');
		if (!g || !this.psd) return;
		const { x, w, h } = g;
		const pad = { l: 32, r: 8, t: 8, b: 16 };
		x.clearRect(0, 0, w, h);
		const { freqs, psd } = this.psd;
		const fmax = 45;
		let lo = Infinity,
			hi = -Infinity;
		for (let k = 0; k < freqs.length; k++)
			if (freqs[k] <= fmax) {
				const v = Math.log10(psd[k] + 1e-6);
				lo = Math.min(lo, v);
				hi = Math.max(hi, v);
			}
		if (!isFinite(lo)) return;
		if (hi - lo < 1) hi = lo + 1;
		const X = (f: number): number => pad.l + (f / fmax) * (w - pad.l - pad.r);
		const Y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
		x.fillStyle = 'rgba(255,179,58,.10)';
		x.fillRect(X(8), pad.t, X(13) - X(8), h - pad.t - pad.b);
		x.strokeStyle = 'rgba(255,170,60,.12)';
		x.fillStyle = 'rgba(255,190,110,.5)';
		x.font = "9px 'Space Mono',monospace";
		x.lineWidth = 1;
		for (const f of [0, 10, 20, 30, 40]) {
			x.beginPath();
			x.moveTo(X(f), pad.t);
			x.lineTo(X(f), h - pad.b);
			x.stroke();
			x.fillText(String(f), X(f) - 4, h - 4);
		}
		x.fillText('Hz', w - 16, h - 4);
		x.save();
		x.shadowColor = 'rgba(255,179,58,.55)';
		x.shadowBlur = 6;
		x.strokeStyle = '#ffc861';
		x.lineWidth = 1.6;
		x.beginPath();
		let st = false;
		for (let k = 0; k < freqs.length; k++)
			if (freqs[k] <= fmax) {
				const px = X(freqs[k]),
					py = Y(Math.log10(psd[k] + 1e-6));
				st ? x.lineTo(px, py) : x.moveTo(px, py);
				st = true;
			}
		x.stroke();
		x.restore();
		x.fillStyle = 'rgba(255,190,110,.6)';
		x.font = '600 11px system-ui,sans-serif';
		x.fillText('α', X(10.4) - 3, pad.t + 11);
	}

	// ---------- amber phosphor: segmented LED band meter ----------
	private drawBands(): void {
		const g = this.ctx('nf-band');
		if (!g || !this.psd) return;
		const { x, w, h } = g;
		x.clearRect(0, 0, w, h);
		const bp = dsp.bandPowers(this.psd.freqs, this.psd.psd);
		const defs = dsp.BAND_DEFS;
		let mx = 1e-9;
		for (const [n] of defs) mx = Math.max(mx, bp[n]);
		const pad = { l: 6, r: 6, t: 8, b: 22 },
			segs = 16,
			gap = 2;
		const colW = (w - pad.l - pad.r) / defs.length,
			areaH = h - pad.t - pad.b;
		const segH = (areaH - (segs - 1) * gap) / segs;
		defs.forEach(([n, a, b2], i) => {
			const frac = bp[n] / mx,
				cx = pad.l + i * colW,
				barW = Math.min(colW * 0.5, 26),
				bx = cx + (colW - barW) / 2;
			const lit = Math.round(frac * segs);
			for (let s = 0; s < segs; s++) {
				const sy = pad.t + areaH - (s + 1) * (segH + gap) + gap,
					f = s / segs,
					on = s < lit;
				const col = !on
					? 'rgba(255,170,60,.10)'
					: f < 0.62
						? '#ffb33a'
						: f < 0.85
							? '#ff7a2a'
							: '#ff3a3a';
				x.fillStyle = col;
				if (on) {
					x.save();
					x.shadowColor = col;
					x.shadowBlur = 6;
				}
				x.fillRect(bx, sy, barW, segH);
				if (on) x.restore();
			}
			x.textAlign = 'center';
			x.fillStyle = n === 'alpha' ? 'rgba(255,210,140,.95)' : 'rgba(255,190,110,.8)';
			x.font = '600 14px system-ui,sans-serif';
			x.fillText(GREEK[n], cx + colW / 2, h - 9);
			x.fillStyle = 'rgba(255,190,110,.4)';
			x.font = "8px 'Space Mono',monospace";
			x.fillText(a + '–' + b2, cx + colW / 2, h - 1);
		});
		x.textAlign = 'left';
	}

	// ---------- green phosphor: spectrogram waterfall ----------
	private drawSpec(): void {
		const g = this.ctx('nf-spec');
		if (!g) return;
		const { x, w, h } = g;
		x.clearRect(0, 0, w, h);
		const cols = this.specCols;
		if (!cols.length) return;
		const fs = this.fs,
			nb = this.nfftSpec / 2;
		// Above 0.49*fs the analysis chain has already rolled off; painting those bins would
		// render pure garbage as signal at the low rungs (Nyquist is 10 Hz at 20 SPS).
		const fmax = Math.min(45, 0.49 * fs);
		const kmax = Math.max(1, Math.min(nb, Math.round(fmax / (fs / this.nfftSpec))));
		const cw = Math.max(1.2, w / Math.max(cols.length, 60));
		const start = Math.max(0, cols.length - Math.ceil(w / cw));
		let lo = Infinity,
			hi = -Infinity;
		for (let ci = start; ci < cols.length; ci++)
			for (let k = 1; k <= kmax; k++) {
				const v = cols[ci][k];
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		if (!isFinite(lo)) return;
		lo += (hi - lo) * 0.15;
		if (hi - lo < 4) hi = lo + 4;
		for (let ci = start; ci < cols.length; ci++) {
			const col = cols[ci];
			const px = w - (cols.length - ci) * cw;
			for (let k = 0; k <= kmax; k++) {
				const py = h - (k / kmax) * h;
				const pyTop = h - ((k + 1) / kmax) * h;
				x.fillStyle = this.colormap((col[k] - lo) / (hi - lo));
				x.fillRect(px, pyTop, cw + 0.6, py - pyTop + 0.6);
			}
		}
		x.fillStyle = 'rgba(150,240,170,.6)';
		x.font = "9px 'Space Mono',monospace";
		for (const f of [10, 20, 30, 40]) {
			if (f >= fmax) continue; // never label a frequency this rate cannot represent
			const py = h - (f / fmax) * h;
			x.fillText(String(f), 3, py - 1);
		}
	}

	private colormap(t: number): string {
		t = Math.max(0, Math.min(1, t));
		const s = [
			[3, 8, 5],
			[6, 30, 16],
			[16, 80, 40],
			[40, 150, 72],
			[110, 225, 120],
			[205, 255, 195]
		];
		const f = t * (s.length - 1),
			i = Math.floor(f),
			fr = f - i;
		const a = s[i],
			b = s[Math.min(i + 1, s.length - 1)];
		return `rgb(${(a[0] + (b[0] - a[0]) * fr) | 0},${(a[1] + (b[1] - a[1]) * fr) | 0},${(a[2] + (b[2] - a[2]) * fr) | 0})`;
	}

	// ---------- sources ----------
	/**
	 * Link an ESP32 NeuroFocus board over Web Bluetooth.
	 *
	 * `version` picks the sample rate and the counts→µV profile, and the two must agree
	 * with the board you actually plugged in — a v4 board read with the v2 profile renders
	 * µV ~4096x wrong and flattens the CH1 trace.
	 */
	async connectBLE(version: AdcProfile = 'v4'): Promise<void> {
		if (!NeuroLink.supported) {
			this.msg('Web Bluetooth not available — open BERGER-1 standalone in Chrome / Edge.');
			return;
		}
		await this.link?.disconnect();
		this.link = new NeuroLink({
			onSamples: (counts) => this.ingestMany(counts, false),
			onState: (state, detail) => {
				if (state === 'live') this.setMode('live · ble', '#5fe886');
				else if (state === 'reconnecting') this.setMode('re-link', '#e8a23a');
				else if (state === 'idle' || state === 'error') this.setMode('idle', '#2a3329');
				this.msg(detail);
			},
			onDiag: (d) => this.msg('DIAG ' + (d.verdict ?? '') + ' — ' + describeDiag(d)),
			onStatusText: (line) => this.msg('device: ' + line),
			// The board's sample rate is runtime-selectable ('~' command). Every INFO line —
			// on connect AND after any rate change — carries the live sps, so we re-tune the
			// whole DSP chain here. This is the single point that keeps fs honest.
			onInfo: (info) => {
				if (info.sps && Math.abs(info.sps - this.fs) > 0.5) {
					this.setFs(info.sps);
					this.msg(`device rate → ${info.sps} SPS (batch ${info.batch ?? '?'})`);
				}
			}
		});
		this.stopDemo();
		this.reset();
		// Provisional fs until the board's INFO arrives (connect() sends 'i'); onInfo corrects it.
		this.setFs(BLE_SAMPLE_RATE[version]);
		this.setAdcProfile(version);
		try {
			await this.link.connect();
		} catch (e) {
			this.link = null;
			this.msg('BLE: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	/** `b` / `s` / `v` / `d` — the firmware's OpenBCI-style command set. */
	async deviceStart(): Promise<void> {
		await this.runCommand(() => this.link!.start(), 'streaming');
	}

	async deviceStop(): Promise<void> {
		await this.runCommand(() => this.link!.stop(), 'stream stopped (still linked)');
	}

	async deviceReset(): Promise<void> {
		await this.runCommand(async () => {
			this.msg('resetting ADS1220…');
			await this.link!.reset();
			this.reset();
		}, 'reset complete — streaming');
	}

	/** Runtime ADS1220 rate change via `~`. The board re-emits INFO, which re-tunes our fs. */
	async deviceSetRate(sps: number): Promise<void> {
		if (!this.link?.connected) {
			this.msg('link a device first');
			return;
		}
		try {
			const info = await this.link.setSampleRate(sps);
			this.msg(
				info?.sps ? `rate → ${info.sps} SPS (batch ${info.batch ?? '?'})` : 'rate command sent'
			);
		} catch (e) {
			this.msg('rate change failed: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	async deviceDiag(): Promise<DiagReport | null> {
		if (!this.link?.connected) {
			this.msg('link a device first');
			return null;
		}
		this.msg('running on-device diagnostic (~1.5 s, stream pauses)…');
		try {
			const rep = await this.link.diag();
			this.msg('DIAG ' + (rep.verdict ?? rep.error ?? '') + ' — ' + describeDiag(rep));
			return rep;
		} catch (e) {
			this.msg('DIAG: ' + (e instanceof Error ? e.message : String(e)));
			return null;
		}
	}

	private async runCommand(op: () => Promise<void>, okMsg: string): Promise<void> {
		if (!this.link?.connected) {
			this.msg('link a device first');
			return;
		}
		try {
			await op();
			this.msg(okMsg);
		} catch (e) {
			this.msg('command failed: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	openFile(): void {
		(this.el('nf-file') as HTMLInputElement | null)?.click();
	}

	async onFile(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const f = input.files && input.files[0];
		if (!f) return;
		try {
			const cap = dsp.parseCapture(await f.text());
			this.stopDemo();
			this.reset();
			this.setFs(cap.fs);
			this.ingestMany(cap.samples, cap.unit === 'uV');
			this.setMode('file · ' + f.name.slice(0, 18), '#5aa9ff');
			this.msg('loaded ' + cap.samples.length + ' samples @ ' + Math.round(cap.fs) + ' Hz');
			this.lastPsd = 0;
		} catch (err) {
			this.msg('file error: ' + (err instanceof Error ? err.message : String(err)));
		}
		input.value = '';
	}

	startDemo(): void {
		this.stopDemo();
		const cap = dsp.generateSynthetic({
			fs: 600,
			dur: 12,
			alphaAmp: this.demoAlpha,
			label: 'eyes-closed'
		});
		this.reset();
		this.setFs(600);
		this.ingestMany(cap.samples, true);
		this.demoData = cap.samples;
		this.demoIdx = 0;
		this.setMode('test · synthetic', '#5fe886');
		this.msg('synthetic α-rhythm test signal · 600 Hz · eyes-closed model');
		this.demoTimer = setInterval(() => {
			for (let k = 0; k < 12; k++) {
				this.ingest(this.demoData[this.demoIdx % this.demoData.length], true);
				this.demoIdx++;
			}
		}, 20);
	}

	private stopDemo(): void {
		if (this.demoTimer) {
			clearInterval(this.demoTimer);
			this.demoTimer = null;
		}
	}

	async stopAll(): Promise<void> {
		this.stopDemo();
		// NeuroLink stops the stream and drops GATT; leaving the link up would keep the
		// board's single central slot occupied.
		await this.link?.disconnect();
		this.link = null;
		this.berger = null;
		this.emitBerger();
		this.ovf = 0;
		this.setMode('idle', '#2a3329');
		this.msg('halted');
	}

	// ---------- guided Berger test (eyes open / closed) ----------
	// The old version snapshotted the trailing 10 s the instant you clicked, with no timing
	// cue, no artifact rejection and no averaging — a single blink decided the ratio, and
	// the readout sat at a hardcoded 0.00 until both sides had been captured.
	onBergerChange(cb: (s: BergerState | null) => void): void {
		this.onBerger = cb;
		this.emitBerger();
	}

	private emitBerger(): void {
		this.onBerger?.(this.berger ? this.berger.state() : null);
	}

	/** A short cue at every phase change, so the subject never has to watch the screen. */
	private tone(freq: number, ms = 150): void {
		try {
			this.beep ??= new AudioContext();
			if (this.beep.state === 'suspended') void this.beep.resume();
			const t = this.beep.currentTime;
			const osc = this.beep.createOscillator();
			const gain = this.beep.createGain();
			osc.type = 'sine';
			osc.frequency.value = freq;
			osc.connect(gain).connect(this.beep.destination);
			gain.gain.setValueAtTime(0.07, t);
			gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
			osc.start(t);
			osc.stop(t + ms / 1000);
		} catch {
			/* audio is a nicety — never let it break the measurement */
		}
	}

	bergerStart(): void {
		const feas = bergerFeasibility(this.fs);
		if (!feas.ok) {
			this.msg('alpha test unavailable: ' + feas.reason);
			return;
		}
		this.setText('nf-ratio', '—');
		this.setText('nf-verdict', '');
		this.berger = new BergerProtocol(this.fs, {
			onPhaseChange: (phase, condition) => {
				if (phase === 'open') this.tone(660);
				else if (phase === 'closed') this.tone(440);
				else if (phase === 'done') this.tone(880, 260);
				if (condition) this.msg(`alpha test · eyes ${condition}`);
				if (phase === 'done') this.finishBerger();
				this.emitBerger();
			}
		});
		this.berger.start();
		this.msg('alpha test · get ready — sit still, breathe normally');
		this.emitBerger();
	}

	bergerAbort(): void {
		if (!this.berger) return;
		this.berger.abort();
		this.emitBerger();
		this.berger = null;
		this.msg('alpha test aborted');
		this.emitBerger();
	}

	private finishBerger(): void {
		const res = this.berger?.state().result;
		if (!res) return;
		this.setText('nf-ratio', res.ratio === null ? '—' : res.ratio.toFixed(2));
		this.setText('nf-verdict', res.verdict.toUpperCase());
		this.drawCmp();
		const total = res.acceptedEpochs + res.rejectedEpochs;
		this.msg(
			`alpha test ${res.verdict} · C/O ${res.ratio === null ? 'n/a' : res.ratio.toFixed(2)}× · ` +
				`${res.acceptedEpochs}/${total} epochs kept · around-ear sites see a weaker Berger effect than occipital`
		);
	}

	/** Overlay the averaged eyes-open and eyes-closed spectra, 0–30 Hz. */
	private drawCmp(): void {
		const c = this.el('nf-cmp') as HTMLCanvasElement | null;
		if (!c) return;
		const x = c.getContext('2d');
		if (!x) return;
		const w = c.width,
			h = c.height;
		x.clearRect(0, 0, w, h);
		const spec = this.berger?.spectra();
		if (!spec) return;
		const series: [Psd | null, string][] = [
			[spec.open, '#5aa9ff'],
			[spec.closed, '#ffae5a']
		];
		let lo = Infinity,
			hi = -Infinity;
		for (const [s] of series) {
			if (!s) continue;
			for (let i = 0; i < s.freqs.length; i++)
				if (s.freqs[i] <= 30) {
					const v = Math.log10(s.psd[i] + 1e-6);
					lo = Math.min(lo, v);
					hi = Math.max(hi, v);
				}
		}
		if (!isFinite(lo)) return;
		if (hi - lo < 1) hi = lo + 1;
		// Shade the 8–13 Hz alpha band the test actually integrates.
		x.fillStyle = 'rgba(127,233,216,.10)';
		x.fillRect((8 / 30) * w, 0, (5 / 30) * w, h);
		for (const [s, col] of series) {
			if (!s) continue;
			x.save();
			x.shadowColor = col;
			x.shadowBlur = 4;
			x.strokeStyle = col;
			x.lineWidth = 1.3;
			x.beginPath();
			let started = false;
			for (let i = 0; i < s.freqs.length; i++)
				if (s.freqs[i] <= 30) {
					const px = (s.freqs[i] / 30) * w;
					const py = (1 - (Math.log10(s.psd[i] + 1e-6) - lo) / (hi - lo)) * (h - 4) + 2;
					if (started) x.lineTo(px, py);
					else x.moveTo(px, py);
					started = true;
				}
			x.stroke();
			x.restore();
		}
	}
}

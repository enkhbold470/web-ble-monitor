// BERGER·1 EEG controller — ported from the NeuroFocus design canvas.
//
// Drives the canvases/readouts in +page.svelte by id; one ingest path feeds
// BLE / file / demo into the shared DSP (./dsp). Corrections vs. the design:
//   - real firmware BLE UUIDs (the design used the Bluetooth base-UUID suffix)
//   - adcBits 24 for the ADS1220 (the design hard-coded 12)

import * as dsp from './dsp';
import type { FilterChain, Psd } from './dsp';
import { ThinkGearParser } from './thinkgear';
import { ADC_PROFILES, type AdcProfile } from './adc';
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

// Web Bluetooth isn't in the default DOM lib; keep these loosely typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Ble = any;

interface CmpEntry {
	freqs: Float64Array;
	psd: Float64Array;
	alpha: number;
}

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

export class NeuroFocus {
	private adcProfile: AdcProfile = 'v4';
	private settings: dsp.ScaleSettings = { ...ADC_PROFILES.v4 };
	private demoAlpha = 18;

	private fs = 600;
	private unit: 'counts' | 'uV' = 'uV';
	private filt: number[] = [];
	private filtCap = 0;
	private specCols: Float64Array[] = [];
	private specCap = 360;
	private nfftSpec = 256;
	private hop = 0;
	private hopAcc = 0;
	private sampleWin: number[] = [];
	private psd: Psd | null = null;
	private cmp: { open: CmpEntry | null; closed: CmpEntry | null } = { open: null, closed: null };
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

	// NeuroSky MindWave: the headset's Bluetooth-serial link streams raw EEG (512 Hz)
	// continuously with no enable command — so the browser reads it directly over the
	// Web Serial API (no ThinkGear Connector, no bridge). Needs the one-time NeuroSky
	// driver so the headset shows up as a serial port (/dev/cu.MindWaveMobile-*).
	private nsPort: Ble = null;
	private nsReader: Ble = null;
	private nsAbort = false;
	private readonly NS_BAUD = 57600;

	// NeuroSky raw ThinkGear unit -> µV (~0.51 µV/unit; the value NF-ios uses).
	// Uncalibrated, but the eyes-open/closed alpha ratio is relative so unaffected.
	private readonly NEUROSKY_UV = 0.51;

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
		this.fs = fs;
		// Hold enough filtered history for the Welch window (+ headroom) so the PSD can
		// average many segments instead of the ~3 a 4 s buffer allowed.
		this.filtCap = Math.round(fs * (this.psdWindowS + 2));
		this.hop = Math.round(fs * 0.18);
		this.chain = dsp.makeChain(fs, { lo: 1, hi: 45, line: this.settings.line });
		this.welchN = dsp.nextPow2(Math.min(Math.round(fs * 2), 1024));
		this.setText('nf-fs', String(Math.round(fs)));
	}

	// ---------- ADC scaling profile (v2 12-bit unipolar vs v4 24-bit bipolar) ----------
	// Swaps the counts->µV ScaleSettings and rebuilds the filter chain. Only affects the
	// counts sources (ESP32 BLE); the µV sources (file/NeuroSky/demo) bypass countsToUv.
	setAdcProfile(p: AdcProfile): void {
		this.adcProfile = p;
		this.settings = { ...ADC_PROFILES[p] };
		this.setFs(this.fs); // rebuild makeChain with settings.line
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
				this.setText('nf-ovf', String(this.ovf));
				this.spsCount = 0;
				this.spsT = now;
			}
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

	// ---------- green phosphor: raw trace ----------
	private drawRaw(): void {
		const g = this.ctx('nf-raw');
		if (!g) return;
		const { x, w, h } = g;
		x.clearRect(0, 0, w, h);
		x.strokeStyle = 'rgba(90,200,120,.11)';
		x.lineWidth = 1;
		for (let i = 1; i < 4; i++) {
			const y = (h * i) / 4;
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
		const n = Math.min(this.filt.length, Math.round(this.fs * 4));
		if (n < 2) return;
		const data = this.filt.slice(-n);
		let mx = 1;
		for (const v of data) mx = Math.max(mx, Math.abs(v));
		mx *= 1.15;
		x.save();
		x.shadowColor = 'rgba(102,240,138,.6)';
		x.shadowBlur = 7;
		x.strokeStyle = '#86ffa6';
		x.lineWidth = 1.4;
		x.beginPath();
		for (let i = 0; i < n; i++) {
			const px = (i / (n - 1)) * w,
				py = h / 2 - (data[i] / mx) * (h / 2 - 4);
			i ? x.lineTo(px, py) : x.moveTo(px, py);
		}
		x.stroke();
		x.restore();
		x.fillStyle = 'rgba(134,255,166,.55)';
		x.font = "10px 'Space Mono',monospace";
		x.fillText('+' + mx.toFixed(0) + 'µV', 5, 12);
		x.fillText('-' + mx.toFixed(0), 5, h - 5);
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
		const fmax = 45,
			fs = this.fs,
			nb = this.nfftSpec / 2;
		const kmax = Math.min(nb, Math.round(fmax / (fs / this.nfftSpec)));
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
			onStatusText: (line) => this.msg('device: ' + line)
		});
		this.stopDemo();
		this.reset();
		this.setFs(BLE_SAMPLE_RATE[version]);
		this.unit = 'counts';
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

	// ---------- NeuroSky MindWave (Web Serial / ThinkGear, all in-browser) ----------
	// The MindWave streams raw EEG continuously over its Bluetooth-serial link, so
	// we read it straight from the browser — no ThinkGear Connector, no bridge.
	// Pick the headset's serial port (it appears as /dev/cu.MindWaveMobile-* once
	// the one-time NeuroSky driver is installed and the headset is paired).
	async connectNeuroSky(): Promise<void> {
		const nav = navigator as Navigator & { serial?: Ble };
		if (!nav.serial) {
			const b = this.el('nf-banner');
			if (b) {
				b.style.display = 'block';
				b.textContent =
					'⚠ Web Serial unavailable — NeuroSky needs Chrome / Edge on desktop (open BERGER-1 standalone, not in a frame).';
			}
			this.msg('Web Serial not available — use Chrome / Edge on desktop.');
			return;
		}
		// Release any port we already hold — re-clicking NeuroSky must not collide
		// with our own open handle (that self-inflicts "Failed to open / busy").
		this.nsAbort = true;
		try {
			if (this.nsReader) await this.nsReader.cancel();
		} catch {
			/* ignore */
		}
		try {
			if (this.nsPort) await this.nsPort.close();
		} catch {
			/* ignore */
		}
		this.nsReader = this.nsPort = null;
		this.nsAbort = false;
		let port: Ble;
		try {
			this.msg('select the MindWave serial port (MindWaveMobile)…');
			port = await nav.serial.requestPort();
		} catch {
			this.msg('NeuroSky: no port selected');
			return;
		}
		// Opening a paired Bluetooth-serial port only works while the headset is
		// actively connected. The first open() often just wakes the RFCOMM link,
		// so retry a few times before giving up.
		const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
		let lastErr: unknown = null;
		for (let attempt = 1; attempt <= 4; attempt++) {
			try {
				await port.open({ baudRate: this.NS_BAUD });
				lastErr = null;
				break;
			} catch (e) {
				lastErr = e;
				this.msg(`opening MindWave… waking Bluetooth link (try ${attempt}/4)`);
				await sleep(800);
			}
		}
		if (lastErr) {
			this.neuroSkyOpenFailed(lastErr);
			return;
		}
		this.nsPort = port;
		this.nsAbort = false;
		this.stopDemo();
		this.reset();
		this.setFs(512);
		this.unit = 'uV';
		const banner = this.el('nf-banner');
		if (banner) banner.style.display = 'none';
		this.setMode('live · neurosky', '#5fe886');
		this.msg('NeuroSky MindWave linked — streaming raw EEG @ 512 Hz');
		void this.readMindWave();
	}

	private neuroSkyOpenFailed(e: unknown): void {
		const m = e instanceof Error ? e.message : String(e);
		this.setMode('idle', '#2a3329');
		this.msg('NeuroSky: ' + m);
		const b = this.el('nf-banner');
		if (b) {
			b.style.display = 'block';
			// "Failed to open" almost always means the port is busy (held by another
			// browser/tab/process) or the headset is paired-but-not-connected.
			b.innerHTML =
				'⚠ Couldn’t open the MindWave port. Most likely it’s <b>held by another browser or tab</b> — ' +
				'close every other BERGER tab and <b>fully quit other browsers</b> (Dia, Chrome, Arc, Edge), then click NeuroSky again. ' +
				'Otherwise the headset is <b>paired but not connected</b>: turn it ON and confirm macOS Bluetooth shows <b>“Connected”</b> (solid LED). ' +
				'If two “MindWaveMobile” ports are listed, pick the other one.';
		}
	}

	private async readMindWave(): Promise<void> {
		const parser = new ThinkGearParser();
		try {
			while (this.nsPort && this.nsPort.readable && !this.nsAbort) {
				this.nsReader = this.nsPort.readable.getReader();
				try {
					for (;;) {
						const { value, done } = await this.nsReader.read();
						if (done || this.nsAbort) break;
						if (!value) continue;
						const r = parser.push(value as Uint8Array);
						for (const s of r.raw) this.ingest(s * this.NEUROSKY_UV, true);
						if (r.poorSignal !== undefined && r.poorSignal >= 200)
							this.msg('MindWave: no contact — sit still and adjust the headset / ear clip');
					}
				} finally {
					this.nsReader.releaseLock();
					this.nsReader = null;
				}
			}
		} catch (e) {
			if (!this.nsAbort)
				this.msg('NeuroSky stream error: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	// ---------- Emotiv (Cortex API) — not yet implemented ----------
	connectEmotiv(): void {
		this.msg('Emotiv (Cortex API) — coming soon · raw EEG needs an Emotiv license.');
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
			this.unit = cap.unit;
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
		this.unit = 'uV';
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
		this.nsAbort = true;
		// NeuroLink stops the stream and drops GATT; leaving the link up would keep the
		// board's single central slot occupied.
		await this.link?.disconnect();
		this.link = null;
		try {
			if (this.nsReader) await this.nsReader.cancel();
			if (this.nsPort) await this.nsPort.close();
		} catch {
			/* ignore teardown errors */
		}
		this.nsReader = this.nsPort = null;
		this.setMode('idle', '#2a3329');
		this.msg('halted');
	}

	// ---------- eyes-open / closed compare ----------
	private capture(which: 'open' | 'closed'): void {
		if (this.filt.length < this.welchN) {
			this.msg('not enough data captured yet');
			return;
		}
		const seg = Float64Array.from(
			this.filt.slice(-Math.min(this.filt.length, Math.round(this.fs * this.psdWindowS)))
		);
		const { freqs, psd } = dsp.welch(seg, this.fs, this.welchN, this.welchOverlap);
		this.cmp[which] = { freqs, psd, alpha: dsp.bandPowers(freqs, psd).alpha };
		this.msg('captured eyes-' + which + ' spectrum');
		this.drawCmp();
		if (this.cmp.open && this.cmp.closed) {
			const r = this.cmp.closed.alpha / (this.cmp.open.alpha || 1e-9);
			this.setText('nf-ratio', r.toFixed(2));
		}
	}

	captureOpen(): void {
		this.capture('open');
	}

	captureClosed(): void {
		this.capture('closed');
	}

	private drawCmp(): void {
		const c = this.el('nf-cmp') as HTMLCanvasElement | null;
		if (!c) return;
		const x = c.getContext('2d');
		if (!x) return;
		const w = c.width,
			h = c.height;
		x.clearRect(0, 0, w, h);
		const series: [keyof typeof this.cmp, string][] = [
			['open', '#5aa9ff'],
			['closed', '#ffae5a']
		];
		let lo = Infinity,
			hi = -Infinity;
		for (const [k] of series) {
			const s = this.cmp[k];
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
		x.fillStyle = 'rgba(127,233,216,.10)';
		x.fillRect((8 / 30) * w, 0, (5 / 30) * w, h);
		for (const [k, col] of series) {
			const s = this.cmp[k];
			if (!s) continue;
			x.save();
			x.shadowColor = col;
			x.shadowBlur = 4;
			x.strokeStyle = col;
			x.lineWidth = 1.3;
			x.beginPath();
			let st = false;
			for (let i = 0; i < s.freqs.length; i++)
				if (s.freqs[i] <= 30) {
					const px = (s.freqs[i] / 30) * w,
						py = (1 - (Math.log10(s.psd[i] + 1e-6) - lo) / (hi - lo)) * (h - 4) + 2;
					st ? x.lineTo(px, py) : x.moveTo(px, py);
					st = true;
				}
			x.stroke();
			x.restore();
		}
	}
}

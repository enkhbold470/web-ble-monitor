// BERGER·1 EEG controller — ported from the NeuroFocus design canvas.
//
// Drives the canvases/readouts in +page.svelte by id; one ingest path feeds
// BLE / file / demo into the shared DSP (./dsp). Corrections vs. the design:
//   - real firmware BLE UUIDs (the design used the Bluetooth base-UUID suffix)
//   - adcBits 24 for the ADS1220 (the design hard-coded 12)

import * as dsp from './dsp';
import type { FilterChain, Psd } from './dsp';

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

export class NeuroFocus {
	private readonly SERVICE = '0338ff7c-6251-4029-a5d5-24e4fa856c8d';
	private readonly DATA = 'ad615f2b-cc93-4155-9e4d-f5f32cb9a2d7';
	private readonly CMD = 'b5e3d1c9-8a2f-4e7b-9c6d-1a3f5e7b9c2d';
	private settings: dsp.ScaleSettings = { adcBits: 24, vref: 3.3, gain: 100, line: 60 };
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
	private chain: FilterChain | null = null;

	private raf = 0;
	private demoTimer: ReturnType<typeof setInterval> | null = null;
	private demoData: number[] = [];
	private demoIdx = 0;
	private dev: Ble = null;
	private dataChar: Ble = null;
	private cmdChar: Ble = null;

	// NeuroSky reaches the browser through the local bridge (bridge/neurosky-bridge.ts):
	// ThinkGear Connector → WebSocket. A browser can't get MindWave raw EEG directly.
	private nsSocket: WebSocket | null = null;
	private readonly NS_BRIDGE_URL = 'ws://localhost:8127';

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
		this.filtCap = Math.round(fs * 6);
		this.hop = Math.round(fs * 0.18);
		this.chain = dsp.makeChain(fs, { lo: 1, hi: 45, line: this.settings.line });
		this.welchN = dsp.nextPow2(Math.min(Math.round(fs * 2), 1024));
		this.setText('nf-fs', String(Math.round(fs)));
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
				const seg = this.filt.slice(-Math.min(this.filt.length, Math.round(this.fs * 4)));
				this.psd = dsp.welch(Float64Array.from(seg), this.fs, this.welchN, 0.5);
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
	async connectBLE(): Promise<void> {
		const nav = navigator as Navigator & { bluetooth?: Ble };
		if (!nav.bluetooth) {
			this.msg('Web Bluetooth not available — open BERGER-1 standalone in Chrome / Edge.');
			return;
		}
		try {
			this.msg('requesting device…');
			const dev: Ble = await nav.bluetooth.requestDevice({
				filters: [{ services: [this.SERVICE] }],
				optionalServices: [this.SERVICE]
			});
			this.dev = dev;
			dev.addEventListener('gattserverdisconnected', () => {
				this.setMode('idle', '#2a3329');
				this.msg('device disconnected');
			});
			const server: Ble = await dev.gatt.connect();
			const svc: Ble = await server.getPrimaryService(this.SERVICE);
			this.dataChar = await svc.getCharacteristic(this.DATA);
			this.cmdChar = await svc.getCharacteristic(this.CMD);
			this.stopDemo();
			this.reset();
			this.setFs(this.fs);
			this.unit = 'counts';
			await this.dataChar.startNotifications();
			this.dataChar.addEventListener('characteristicvaluechanged', (e: Event) => this.onBle(e));
			await this.cmdChar.writeValue(new TextEncoder().encode('b'));
			this.setMode('live · ble', '#5fe886');
			this.msg('linked to ' + (dev.name || 'device') + ' — streaming');
		} catch (e) {
			this.msg('BLE: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	private onBle(e: Event): void {
		const target = e.target as { value?: DataView };
		if (!target.value) return;
		const vals = dsp.parseFrame(new TextDecoder().decode(target.value));
		if (!vals.length) this.ovf++;
		this.ingestMany(vals, false);
	}

	// ---------- NeuroSky MindWave (local bridge → WebSocket) ----------
	// The browser can't read MindWave raw EEG directly, so it talks to the local
	// bridge (run `bun run bridge` for a headset via ThinkGear Connector, or
	// `bun run bridge:mock` for synthetic data). Raw arrives as ThinkGear units.
	connectNeuroSky(): void {
		if (this.nsSocket) {
			try {
				this.nsSocket.close();
			} catch {
				/* ignore */
			}
			this.nsSocket = null;
		}
		this.msg('connecting to NeuroSky bridge at ' + this.NS_BRIDGE_URL + ' …');
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.NS_BRIDGE_URL);
		} catch (e) {
			this.msg('NeuroSky bridge error: ' + (e instanceof Error ? e.message : String(e)));
			return;
		}
		this.nsSocket = ws;
		ws.onopen = () => {
			this.stopDemo();
			this.reset();
			this.setFs(512);
			this.unit = 'uV';
			this.setMode('live · neurosky', '#5fe886');
			this.msg('NeuroSky bridge connected — streaming 512 Hz');
		};
		ws.onmessage = (ev: MessageEvent) => this.onBridge(ev);
		ws.onerror = () => {
			this.msg(
				'NeuroSky bridge not reachable — run `bun run bridge:mock` (or `bun run bridge` with ThinkGear Connector).'
			);
		};
		ws.onclose = () => {
			if (this.nsSocket === ws) {
				this.nsSocket = null;
				this.setMode('idle', '#2a3329');
			}
		};
	}

	private onBridge(ev: MessageEvent): void {
		let msg: { raw?: number[]; poorSignal?: number };
		try {
			msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as {
				raw?: number[];
				poorSignal?: number;
			};
		} catch {
			return;
		}
		if (Array.isArray(msg.raw)) for (const s of msg.raw) this.ingest(s * this.NEUROSKY_UV, true);
		if (msg.poorSignal !== undefined && msg.poorSignal >= 200)
			this.msg('MindWave: no contact — adjust the headset');
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
		if (this.nsSocket) {
			try {
				this.nsSocket.close();
			} catch {
				/* ignore */
			}
			this.nsSocket = null;
		}
		try {
			if (this.cmdChar) await this.cmdChar.writeValue(new TextEncoder().encode('s'));
			if (this.dataChar) await this.dataChar.stopNotifications();
			if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect();
		} catch {
			/* ignore teardown errors */
		}
		this.dataChar = this.cmdChar = this.dev = null;
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
			this.filt.slice(-Math.min(this.filt.length, Math.round(this.fs * 4)))
		);
		const { freqs, psd } = dsp.welch(seg, this.fs, this.welchN, 0.5);
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

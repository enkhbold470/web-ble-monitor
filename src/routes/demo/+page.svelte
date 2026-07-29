<script lang="ts">
	// NEUROFOCUS · DEMO — "catch tilt before it costs you the round."
	//
	// LEFT   DASH, a deterministic Geometry-Dash-style runner. You play it with SPACE.
	//        The EEG never touches it.
	// RIGHT  the live Pope engagement index (beta/(alpha+theta)) measured passively while
	//        you play, plus every firmware command.
	// END    a session report asking whether your focus sagged before you died — computed
	//        with the contamination guards in $lib/analysis, and worded to match.
	//
	// Practice mode synthesises EEG through the identical DSP path so the demo works with
	// no hardware. Its focus stream is causally BLIND to deaths, so the analysis cannot
	// manufacture a result; everything it shows is labelled synthetic.
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { ADC_PROFILES } from '$lib/adc';
	import {
		NeuroLink,
		RATE_LADDER,
		V4_SAMPLE_RATE,
		describeDiag,
		type DiagReport,
		type LinkState
	} from '$lib/ble';
	import { FLOW_THRESHOLD, FocusEngine, focusFeasibility } from '$lib/focus';
	import { analyzeSession, verdictText, type FocusSample, type SessionReport } from '$lib/analysis';
	import {
		CUBE,
		LEVEL_LEN,
		advance,
		generateLevel,
		initialState,
		progress,
		type GameState,
		type Obstacle
	} from '$lib/game';
	import { BAND_DEFS } from '$lib/dsp';

	const DEFAULT_MAINS = 60;
	const SCALE = ADC_PROFILES.v4;
	/** Fallback only. A v4.1 board reports its true rate via the `i` command on connect. */
	const FALLBACK_FS = V4_SAMPLE_RATE;
	/** Focus is recorded at 4 Hz — enough to draw and to analyse, cheap to store. */
	const SAMPLE_HZ = 4;
	/** Level seed. Fixed, so every player and every attempt faces the same obstacles. */
	const LEVEL_SEED = 20260709;
	/** How long a queued jump stays buffered before it is dropped (no autojump). */
	const JUMP_BUFFER_MS = 110;

	type Source = 'none' | 'headset' | 'practice';

	// ---------- reactive UI ----------
	let source = $state<Source>('none');
	let linkState = $state<LinkState>('idle');
	let statusMsg = $state('Link a headset, or start practice mode.');
	let deviceName = $state('');
	let fwVersion = $state('');
	let mains = $state<50 | 60>(DEFAULT_MAINS);
	let fs = $state(FALLBACK_FS);

	let focus = $state(0);
	let calm = $state(0);
	let engagement = $state(0);
	let blinks = $state(0);
	let alphaPeak = $state<number | null>(null);
	let signalOk = $state(false);
	let calibrating = $state(true);
	let calLeft = $state(0);
	let rmsUv = $state(0);
	// Third gate beside signalOk/calibrating: at 20/45/90 SPS the score is not physically
	// measurable, so the UI must refuse to print one.
	let fsOk = $state(true);
	let fsReason = $state<string | null>(null);

	let sps = $state(0);
	let dropped = $state(0);
	let totalSamples = $state(0);

	let playing = $state(false);
	let sessionSec = $state(0);
	// Attempt / progress / best live on `game` and are drawn straight onto the canvas HUD;
	// only the death count needs to reach the DOM.
	let deaths = $state(0);
	let finished = $state(false);

	let report = $state<SessionReport | null>(null);
	let diagReport = $state<DiagReport | null>(null);
	let diagBusy = $state(false);
	let cmdBusy = $state(false);

	let gameCanvas: HTMLCanvasElement | null = $state(null);
	let traceCanvas: HTMLCanvasElement | null = $state(null);
	let bandCanvas: HTMLCanvasElement | null = $state(null);
	let timelineCanvas: HTMLCanvasElement | null = $state(null);

	const linked = $derived(linkState === 'live');
	const canCommand = $derived(source === 'headset' && linked && !cmdBusy && !diagBusy);
	// The requested rate shown in the picker. The board is still the authority: every applied
	// change comes back as INFO, and onInfo re-syncs this.
	let rateSel = $state(V4_SAMPLE_RATE);
	// Below 175 SPS the engagement index is not measurable (beta above the passband) or is
	// contaminated (60 Hz mains folds into beta). Label those rungs rather than hide them —
	// they are still useful for raw-signal debugging.
	const rateLabel = (sps: number): string =>
		`${sps} SPS${focusFeasibility(sps, mains).ok ? '' : ' · no focus'}`;
	const dropPct = $derived(
		totalSamples + dropped > 0 ? (dropped / (totalSamples + dropped)) * 100 : 0
	);
	const synthetic = $derived(source === 'practice');
	/** Never show a score we have not earned. */
	const focusShown = $derived(!calibrating && signalOk && fsOk);

	// ---------- non-reactive ----------
	let engine = new FocusEngine(FALLBACK_FS, { line: DEFAULT_MAINS });
	let link: NeuroLink | null = null;
	let raf = 0;
	let lastMs = 0;
	let physCarry = 0;

	let level: Obstacle[] = generateLevel(LEVEL_SEED);
	let game: GameState = initialState();
	let jumpQueuedAt = -1;

	let synthTimer: ReturnType<typeof setInterval> | null = null;
	let synthT = 0;
	let synthCarry = 0;
	let synthCount = 0;
	let synthSpsAt = 0;
	let synthDrift = 0;

	let sessionT0 = 0;
	let lastSampleAt = 0;
	let focusSamples: FocusSample[] = [];
	let deathTimes: number[] = [];
	/** Engine blinks are cumulative; the report wants this session's, so snapshot the offset. */
	let blinksAtSessionStart = 0;

	// ---------- sources ----------
	async function useHeadset() {
		await teardownSource();
		if (!NeuroLink.supported) {
			statusMsg = 'Web Bluetooth needs Chrome or Edge on desktop / Android.';
			linkState = 'error';
			return;
		}
		link = new NeuroLink({
			onSamples: (counts) => engine.pushCounts(counts.map(c => typeof c === 'number' ? c : c[0]), SCALE),
			onState: (s, detail) => {
				linkState = s;
				statusMsg = detail;
			},
			onDiag: (d) => (diagReport = d),
			onInfo: (i) => {
				// The board is the authority on its own sample rate. Rebuild the DSP around it
				// rather than trusting a compiled-in constant.
				fwVersion = i.fw ?? '';
				if (i.sps && i.sps !== fs) {
					fs = i.sps;
					rateSel = i.sps; // follow the board, even if another client moved it
					rebuildEngine();
					statusMsg = `Board reports ${i.sps} SPS — DSP reconfigured.`;
				}
			},
			onStatusText: (line) => (statusMsg = line)
		});
		source = 'headset';
		rebuildEngine();
		try {
			await link.connect();
			deviceName = link.deviceName;
			if (!link.deviceInfo) {
				statusMsg = `Connected. Board did not report its rate (firmware < v4.1) — assuming ${fs} SPS.`;
			}
		} catch (e) {
			statusMsg = e instanceof Error ? e.message : String(e);
			linkState = 'error';
			link = null;
			source = 'none';
		}
	}

	async function usePractice() {
		await teardownSource();
		source = 'practice';
		linkState = 'live';
		deviceName = 'synthetic';
		fwVersion = '';
		fs = FALLBACK_FS;
		rebuildEngine();
		statusMsg = 'Practice mode — synthetic EEG. The focus trace is not a reading of any brain.';
		synthT = 0;
		synthCarry = 0;
		synthCount = 0;
		synthDrift = 0;
		synthSpsAt = performance.now();
		synthTimer = setInterval(pumpSynthetic, 20);
	}

	async function teardownSource() {
		endSession();
		if (synthTimer) {
			clearInterval(synthTimer);
			synthTimer = null;
		}
		await link?.disconnect();
		link = null;
		source = 'none';
		linkState = 'idle';
		deviceName = '';
		fwVersion = '';
		sps = 0;
	}

	async function stopSource() {
		await teardownSource();
		statusMsg = 'Stopped.';
	}

	/**
	 * Rebuild the DSP chain (rate or notch changed, or the board was reset).
	 *
	 * `keepBaseline` carries the calibration across. A `v` reset re-inits the ADC but does not
	 * change the person wearing it, so forcing another 20 s of calibration mid-session would
	 * be pure friction. A rate or notch change DOES move the band powers, so the old baseline
	 * engagement is no longer comparable and must be discarded.
	 */
	function rebuildEngine(keepBaseline = false) {
		const baseline = keepBaseline ? (engine.read().baseline ?? undefined) : undefined;
		engine = new FocusEngine(fs, { line: mains, baselineEngagement: baseline });
		blinks = 0;
		blinksAtSessionStart = 0;
		totalSamples = 0;
		dropped = 0;
		diagReport = null;
	}

	function setMains(f: 50 | 60) {
		if (mains === f) return;
		mains = f;
		rebuildEngine(); // the notch is baked into the chain, so the baseline no longer applies
	}

	// ---------- synthetic EEG (practice) ----------
	function pumpSynthetic() {
		// A slow random-ish drift plus a very slow LFO. It is deliberately INDEPENDENT of the
		// game: nothing here knows about obstacles, jumps or deaths. If the analysis finds an
		// association in practice mode, that is a false positive by construction — which is
		// exactly what the permutation test should (usually) refuse to report.
		synthDrift +=
			(Math.sin(synthT * 0.11) * 0.6 + (Math.random() - 0.5) * 0.35 - synthDrift) * 0.02;
		const engage = 0.55 + 0.35 * synthDrift; // 0..1-ish
		const betaAmp = 5 + 18 * Math.max(0, engage);
		const alphaAmp = 20 - 12 * Math.max(0, engage);

		const want = fs * 0.02 + synthCarry;
		const n = Math.floor(want);
		synthCarry = want - n;
		for (let i = 0; i < n; i++) {
			const t = synthT + i / fs;
			const beta = betaAmp * Math.sin(2 * Math.PI * 20 * t + 1.1);
			const alpha = alphaAmp * Math.sin(2 * Math.PI * 10 * t);
			const theta = 7 * Math.sin(2 * Math.PI * 6 * t + 0.4);
			const noise = 3.5 * (Math.random() * 2 - 1);
			const drift = 12 * Math.sin(2 * Math.PI * 0.15 * t);
			const line = 4 * Math.sin(2 * Math.PI * mains * t);
			engine.push(beta + alpha + theta + noise + drift + line);
		}
		synthT += n / fs;
		synthCount += n;
		const now = performance.now();
		if (now - synthSpsAt >= 1000) {
			sps = Math.round((synthCount * 1000) / (now - synthSpsAt));
			synthCount = 0;
			synthSpsAt = now;
		}
	}

	// ---------- firmware commands ----------
	async function runCommand(label: string, op: () => Promise<void>) {
		if (!link?.connected) return;
		cmdBusy = true;
		try {
			await op();
			statusMsg = label;
		} catch (e) {
			statusMsg = `${label} failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			cmdBusy = false;
		}
	}

	const cmdStart = () => runCommand('Streaming (b).', () => link!.start());
	const cmdStop = () => runCommand('Stream stopped (s) — still linked.', () => link!.stop());
	const cmdReset = () =>
		runCommand('ADS1220 re-initialised (v), streaming again.', async () => {
			await link!.reset();
			rebuildEngine(true); // same head, same baseline — don't force a recalibration
		});
	const cmdInfo = () =>
		runCommand('Asked the board to describe itself (i).', async () => {
			const i = await link!.info();
			if (!i) statusMsg = 'No INFO reply — firmware older than v4.1.';
		});

	/**
	 * Runtime ADS1220 rate change (`~<idx>`). The board re-emits INFO on every applied change,
	 * so `onInfo` — not this function — is what actually re-tunes the DSP. Requires firmware
	 * that understands `~`; older boards silently ignore it and INFO comes back unchanged.
	 */
	const cmdRate = (sps: number) =>
		runCommand(`Sample rate → ${sps} SPS (~).`, async () => {
			const i = await link!.setSampleRate(sps);
			if (!i)
				statusMsg = `Rate command sent; board did not report back — firmware may predate '~'.`;
		});

	async function cmdDiag() {
		if (!link?.connected) return;
		diagBusy = true;
		diagReport = null;
		statusMsg = 'Running on-device diagnostic (d) — the stream pauses ~1.2 s…';
		try {
			diagReport = await link.diag();
			statusMsg = `DIAG ${diagReport.verdict ?? diagReport.error ?? ''}`;
		} catch (e) {
			statusMsg = e instanceof Error ? e.message : String(e);
		} finally {
			diagBusy = false;
		}
	}

	// ---------- session ----------
	function startSession() {
		if (source === 'none') {
			statusMsg = 'Link a headset (or start practice mode) first.';
			return;
		}
		report = null;
		focusSamples = [];
		deathTimes = [];
		level = generateLevel(LEVEL_SEED);
		game = initialState();
		physCarry = 0;
		jumpQueuedAt = -1;
		sessionT0 = performance.now();
		lastSampleAt = 0;
		sessionSec = 0;
		deaths = 0;
		finished = false;
		blinksAtSessionStart = engine.read().blinks;
		playing = true;
	}

	function endSession() {
		if (!playing) return;
		playing = false;
		report = analyzeSession({
			samples: focusSamples,
			deathTimes,
			attempts: game.attempt,
			bestProgress: game.bestProgress,
			// Blinks accrued during THIS session, not since the engine was built.
			blinks: Math.max(0, engine.read().blinks - blinksAtSessionStart)
		});
		drawTimeline();
	}

	function queueJump() {
		if (!playing) return;
		jumpQueuedAt = performance.now();
	}

	// ---------- drawing ----------
	function fit(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
		const ctx = c.getContext('2d');
		if (!ctx) return null;
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(1, Math.round(c.clientWidth * dpr));
		const h = Math.max(1, Math.round(c.clientHeight * dpr));
		if (c.width !== w || c.height !== h) {
			c.width = w;
			c.height = h;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		return ctx;
	}

	function drawGame() {
		const c = gameCanvas;
		if (!c) return;
		const ctx = fit(c);
		if (!ctx) return;
		const w = c.clientWidth;
		const h = c.clientHeight;
		if (!w || !h) return;

		const floor = h - 56; // screen y of world y = 0
		const camX = game.x - w * 0.28; // cube sits 28% across

		ctx.clearRect(0, 0, w, h);
		const sky = ctx.createLinearGradient(0, 0, 0, h);
		sky.addColorStop(0, '#101a2e');
		sky.addColorStop(1, '#070a12');
		ctx.fillStyle = sky;
		ctx.fillRect(0, 0, w, h);

		// parallax grid
		ctx.strokeStyle = 'rgba(90,140,200,.08)';
		ctx.lineWidth = 1;
		const gx = ((-camX * 0.4) % 60) + 60;
		for (let x = gx % 60; x < w; x += 60) {
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, floor);
			ctx.stroke();
		}

		// floor
		ctx.fillStyle = '#0a1524';
		ctx.fillRect(0, floor, w, h - floor);
		ctx.strokeStyle = '#4cc9f0';
		ctx.globalAlpha = 0.7;
		ctx.beginPath();
		ctx.moveTo(0, floor);
		ctx.lineTo(w, floor);
		ctx.stroke();
		ctx.globalAlpha = 1;

		// obstacles
		for (const o of level) {
			const sx = o.x - camX;
			if (sx < -120 || sx > w + 120) continue;
			if (o.kind === 'spike') {
				ctx.fillStyle = '#ff5a7a';
				ctx.beginPath();
				ctx.moveTo(sx, floor - o.y);
				ctx.lineTo(sx + o.w / 2, floor - o.y - o.h);
				ctx.lineTo(sx + o.w, floor - o.y);
				ctx.closePath();
				ctx.fill();
			} else {
				ctx.fillStyle = '#27405e';
				ctx.fillRect(sx, floor - o.y - o.h, o.w, o.h);
				ctx.fillStyle = '#4cc9f0';
				ctx.fillRect(sx, floor - o.y - o.h, o.w, 3);
			}
		}

		// finish line
		const fx = LEVEL_LEN - camX;
		if (fx < w + 40) {
			ctx.fillStyle = '#5fe886';
			ctx.fillRect(fx, 0, 4, floor);
		}

		// cube
		const cx = w * 0.28;
		const cy = floor - game.y - CUBE;
		ctx.save();
		ctx.translate(cx + CUBE / 2, cy + CUBE / 2);
		ctx.rotate(game.rot);
		ctx.globalAlpha = game.respawnIn > 0 ? 0.25 : 1;
		ctx.shadowColor = '#4cc9f0';
		ctx.shadowBlur = 14;
		ctx.fillStyle = '#7fe3ff';
		ctx.fillRect(-CUBE / 2, -CUBE / 2, CUBE, CUBE);
		ctx.restore();

		// HUD
		ctx.fillStyle = '#e8eef6';
		ctx.font = '700 20px ui-monospace, monospace';
		ctx.fillText(`${(progress(game) * 100).toFixed(0)}%`, 14, 30);
		ctx.font = '11px ui-monospace, monospace';
		ctx.fillStyle = '#8a9ab0';
		ctx.fillText(`ATTEMPT ${game.attempt}   BEST ${(game.bestProgress * 100).toFixed(0)}%`, 14, 48);

		// The passive focus overlay: the product's whole point. It never touches the game.
		if (focusShown) {
			const bw = 150;
			const bx = w - bw - 14;
			ctx.fillStyle = 'rgba(0,0,0,.35)';
			ctx.fillRect(bx, 16, bw, 20);
			ctx.fillStyle = focus >= FLOW_THRESHOLD ? '#ffd166' : '#4cc9f0';
			ctx.fillRect(bx, 16, (bw * focus) / 100, 20);
			ctx.strokeStyle = 'rgba(255,255,255,.25)';
			ctx.strokeRect(bx, 16, bw, 20);
			ctx.fillStyle = '#0a0d14';
			ctx.font = '700 12px ui-monospace, monospace';
			ctx.fillText(`FOCUS ${focus.toFixed(0)}`, bx + 8, 31);
		} else {
			ctx.fillStyle = '#8a9ab0';
			ctx.font = '11px ui-monospace, monospace';
			ctx.textAlign = 'right';
			ctx.fillText(calibrating ? `calibrating… ${calLeft.toFixed(0)}s` : 'no signal', w - 14, 30);
			ctx.textAlign = 'left';
		}

		if (!playing) {
			ctx.fillStyle = 'rgba(7,10,18,.78)';
			ctx.fillRect(0, 0, w, h);
			if (report) return; // the report panel covers this
			ctx.textAlign = 'center';
			ctx.fillStyle = '#e8eef6';
			ctx.font = '700 26px system-ui, sans-serif';
			ctx.fillText('DASH', w / 2, h / 2 - 14);
			ctx.fillStyle = '#8a9ab0';
			ctx.font = '13px system-ui, sans-serif';
			ctx.fillText(
				source === 'none'
					? 'Link a headset or start practice mode'
					: 'SPACE / click to jump · your focus is measured, not used',
				w / 2,
				h / 2 + 14
			);
			ctx.textAlign = 'left';
		}
	}

	function drawTrace() {
		const c = traceCanvas;
		if (!c) return;
		const ctx = fit(c);
		if (!ctx) return;
		const w = c.clientWidth;
		const h = c.clientHeight;
		ctx.clearRect(0, 0, w, h);
		const data = engine.trace(Math.round(fs * 3));
		if (data.length < 2) return;
		let mx = 1;
		for (const v of data) mx = Math.max(mx, Math.abs(v));
		mx *= 1.15;
		ctx.strokeStyle = signalOk ? '#5fe886' : '#4a5566';
		ctx.lineWidth = 1.4;
		ctx.beginPath();
		for (let i = 0; i < data.length; i++) {
			const x = (i / (data.length - 1)) * w;
			const y = h / 2 - (data[i] / mx) * (h / 2 - 2);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}

	function drawBands() {
		const c = bandCanvas;
		if (!c) return;
		const ctx = fit(c);
		if (!ctx) return;
		const w = c.clientWidth;
		const h = c.clientHeight;
		ctx.clearRect(0, 0, w, h);
		const bands = engine.read().bands;
		const colors = ['#5a6bff', '#9b5aff', '#ffd166', '#ff8f4c', '#ff5a7a'];
		let mx = 1e-12;
		for (const [name] of BAND_DEFS) mx = Math.max(mx, bands[name]);
		const bw = w / BAND_DEFS.length;
		BAND_DEFS.forEach(([name], i) => {
			const bh = Math.max(2, (bands[name] / mx) * (h - 18));
			ctx.fillStyle = colors[i];
			ctx.fillRect(i * bw + bw * 0.2, h - 14 - bh, bw * 0.6, bh);
			ctx.fillStyle = '#7c8ca0';
			ctx.font = '9px ui-monospace, monospace';
			ctx.textAlign = 'center';
			ctx.fillText(name[0].toUpperCase(), i * bw + bw / 2, h - 3);
			ctx.textAlign = 'left';
		});
	}

	/** Focus over the session, with every death marked. The picture behind the claim. */
	function drawTimeline() {
		const c = timelineCanvas;
		if (!c) return;
		const ctx = fit(c);
		if (!ctx) return;
		const w = c.clientWidth;
		const h = c.clientHeight;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = '#0c111a';
		ctx.fillRect(0, 0, w, h);
		if (focusSamples.length < 2) return;

		const PAD = 3;
		const tMax = Math.max(1, focusSamples[focusSamples.length - 1].t);
		const yFor = (v: number) => PAD + (1 - v / 100) * (h - 2 * PAD);
		const xFor = (t: number) => (t / tMax) * w;

		ctx.strokeStyle = 'rgba(255,209,102,.25)';
		ctx.setLineDash([4, 5]);
		ctx.beginPath();
		ctx.moveTo(0, yFor(FLOW_THRESHOLD));
		ctx.lineTo(w, yFor(FLOW_THRESHOLD));
		ctx.stroke();
		ctx.setLineDash([]);

		// deaths first, so the trace draws over them
		ctx.strokeStyle = 'rgba(255,90,122,.65)';
		ctx.lineWidth = 1;
		for (const d of deathTimes) {
			const x = xFor(d);
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, h);
			ctx.stroke();
		}

		// only draw the usable stretches; gaps are honest
		ctx.strokeStyle = '#ffd166';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		let pen = false;
		for (const s of focusSamples) {
			if (!s.signalOk || s.calibrating) {
				pen = false;
				continue;
			}
			const x = xFor(s.t);
			const y = yFor(s.focus);
			if (!pen) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
			pen = true;
		}
		ctx.stroke();
	}

	// ---------- main loop ----------
	function loop(now: number) {
		raf = requestAnimationFrame(loop);
		const dt = lastMs ? Math.min(0.25, (now - lastMs) / 1000) : 0;
		lastMs = now;

		const m = engine.read();
		focus = m.focus;
		calm = m.calm;
		engagement = m.engagement;
		blinks = m.blinks;
		alphaPeak = m.alphaPeak;
		signalOk = m.signalOk;
		calibrating = m.calibrating;
		calLeft = m.calibrationLeftSec;
		rmsUv = m.rmsUv;
		fsOk = m.fsOk;
		fsReason = m.fsReason;
		if (link) {
			sps = link.stats.sps;
			dropped = link.stats.dropped;
			totalSamples = link.stats.samples;
		}

		if (playing) {
			sessionSec = (now - sessionT0) / 1000;
			const jumpQueued = jumpQueuedAt > 0 && now - jumpQueuedAt < JUMP_BUFFER_MS;
			const r = advance(game, level, dt + physCarry, jumpQueued);
			physCarry = r.carry;
			if (r.consumedJump || (jumpQueuedAt > 0 && now - jumpQueuedAt >= JUMP_BUFFER_MS)) {
				jumpQueuedAt = -1;
			}
			// Death timestamps come from the game's own clock, so they line up exactly with
			// the focus samples' `t` — both are seconds since the session started.
			for (const d of r.deathTimes) deathTimes.push(d);

			deaths = game.deaths;

			if (now - lastSampleAt >= 1000 / SAMPLE_HZ) {
				lastSampleAt = now;
				focusSamples.push({
					t: game.t, // the game's clock, not wall time — they must not drift apart
					focus: m.focus,
					calm: m.calm,
					signalOk: m.signalOk,
					calibrating: m.calibrating
				});
			}

			if (game.finished && !finished) {
				finished = true;
				endSession();
			}
			drawTimeline();
		}

		drawGame();
		drawTrace();
		drawBands();
	}

	// ---------- input ----------
	function onKeyDown(e: KeyboardEvent) {
		if (e.code !== 'Space' && e.code !== 'ArrowUp' && e.code !== 'KeyW') return;
		if (playing) e.preventDefault();
		// The OS fires keydown repeatedly while a key is held. Honouring those would turn a
		// held key into an autojump, which the fixed-timestep jump model deliberately is not.
		if (e.repeat) return;
		queueJump();
	}

	onMount(() => {
		raf = requestAnimationFrame(loop);
		window.addEventListener('keydown', onKeyDown);
	});

	onDestroy(() => {
		if (!browser) return;
		cancelAnimationFrame(raf);
		window.removeEventListener('keydown', onKeyDown);
		if (synthTimer) clearInterval(synthTimer);
		void link?.disconnect();
	});
</script>

<svelte:head><title>NeuroFocus · Demo</title></svelte:head>

<main>
	<header>
		<div class="brand">
			<span>NEURO<b>FOCUS</b></span>
			<span class="tag">catch tilt before it costs you the round</span>
		</div>

		<div class="sources">
			<button class="btn primary" onclick={useHeadset} disabled={linkState === 'connecting'}>
				{linkState === 'connecting' ? 'Connecting…' : '∿ Link headset'}
			</button>
			<button class="btn" onclick={usePractice}>▶ Practice mode</button>
			<button class="btn ghost" onclick={stopSource} disabled={source === 'none'}>■ Stop</button>
		</div>

		<div class="right">
			<div class="mains" role="group" aria-label="Mains frequency">
				<button class:on={mains === 50} onclick={() => setMains(50)}>50 Hz</button>
				<button class:on={mains === 60} onclick={() => setMains(60)}>60 Hz</button>
			</div>
			<span class="led" data-state={linkState}></span>
			<span class="state">{deviceName || linkState}{fwVersion ? ` · ${fwVersion}` : ''}</span>
			<nav>
				<a href={resolve('/ez')}>ez →</a>
				<a href={resolve('/')}>full →</a>
			</nav>
		</div>
	</header>

	<p class="status" class:err={linkState === 'error'}>{statusMsg}</p>

	<div class="deck">
		<!-- LEFT: the game -->
		<section class="pane game">
			<div class="pane-head">
				<h2>DASH · seed {LEVEL_SEED}</h2>
				<div class="session">
					<span class="timer">{sessionSec.toFixed(1)}s · {deaths} deaths</span>
					{#if playing}
						<button class="btn small danger" onclick={endSession}>End session</button>
					{:else}
						<button class="btn small primary" onclick={startSession} disabled={source === 'none'}>
							Start session
						</button>
					{/if}
				</div>
			</div>

			<div class="canvas-wrap">
				<canvas bind:this={gameCanvas} onmousedown={queueJump}></canvas>

				{#if report}
					<div class="report">
						<h3>Session report</h3>
						{#if synthetic}
							<p class="synthetic-warn">
								Practice mode — the focus trace is <b>synthetic</b> and was generated without any knowledge
								of your deaths. These numbers demonstrate the pipeline; they are not a reading of anyone's
								brain.
							</p>
						{/if}

						<p class="headline" data-verdict={report.deaths.verdict}>
							{verdictText(report.deaths)}
						</p>

						<div class="grid">
							<div><b>{report.meanFocus.toFixed(0)}</b><span>mean focus</span></div>
							<div><b>{report.peakFocus.toFixed(0)}</b><span>peak focus</span></div>
							<div><b>{report.timeInFlowPct.toFixed(0)}%</b><span>time in flow</span></div>
							<div><b>{report.longestFlowSec.toFixed(0)}s</b><span>longest streak</span></div>
							<div>
								<b class:bad={report.focusTrendPerMin < -3}>
									{report.focusTrendPerMin > 0 ? '+' : ''}{report.focusTrendPerMin.toFixed(1)}
								</b><span>focus / min</span>
							</div>
							<div><b>{report.deaths.deaths}</b><span>deaths</span></div>
							<div><b>{report.attempts}</b><span>attempts</span></div>
							<div><b>{report.bestProgressPct.toFixed(0)}%</b><span>best progress</span></div>
							<div><b>{report.durationSec.toFixed(0)}s</b><span>duration</span></div>
							<div><b>{report.blinks}</b><span>blinks</span></div>
							<div><b>{report.unusablePct.toFixed(0)}%</b><span>unusable</span></div>
							<div><b>{fs}</b><span>Hz sample rate</span></div>
						</div>

						{#if report.focusTrendPerMin < -3}
							<p class="note">
								Your focus fell {Math.abs(report.focusTrendPerMin).toFixed(1)} points per minute across
								the session — the classic vigilance decrement.
							</p>
						{/if}

						<div class="actions">
							<button class="btn primary" onclick={startSession}>Run it again</button>
							<button class="btn ghost" onclick={() => (report = null)}>Dismiss</button>
						</div>
					</div>
				{/if}
			</div>

			<p class="hint">
				<kbd>SPACE</kbd> or click to jump. The level is seeded, so every attempt and every player
				meets the same obstacles. <b>Focus never controls the cube</b> — it is only measured.
			</p>
		</section>

		<!-- RIGHT: the monitor -->
		<section class="pane monitor">
			<div class="pane-head"><h2>PASSIVE FOCUS MONITOR</h2></div>

			<div class="meters">
				<div class="meter">
					<div class="meter-top">
						<span>FOCUS · β/(α+θ)</span>
						{#if focusShown}
							<b class:flow={focus >= FLOW_THRESHOLD}>{focus.toFixed(0)}</b>
						{:else}
							<b class="muted">{calibrating ? `cal ${calLeft.toFixed(0)}s` : '—'}</b>
						{/if}
					</div>
					<div class="bar">
						<i class="fill focus" style="width:{focusShown ? focus : 0}%"></i>
					</div>
				</div>
				<div class="meter">
					<div class="meter-top"><span>CALM · α share</span><b>{calm.toFixed(0)}</b></div>
					<div class="bar"><i class="fill calm" style="width:{calm}%"></i></div>
				</div>
			</div>

			<div class="chips">
				<span class="chip" class:ok={signalOk} class:warn={!signalOk && source !== 'none'}>
					{signalOk ? 'signal ✓' : 'no signal'}
				</span>
				{#if calibrating && source !== 'none'}
					<span class="chip warn">calibrating {calLeft.toFixed(0)}s</span>
				{/if}
				<span class="chip">{engagement.toFixed(2)} <i>raw E</i></span>
				<span class="chip">{sps} <i>Hz meas</i></span>
				<span class="chip">{fs} <i>Hz nominal</i></span>
				{#if source === 'headset'}
					<span class="chip" class:warn={dropPct > 2}>{dropPct.toFixed(1)}% <i>drops</i></span>
				{/if}
				<span class="chip">{alphaPeak ? alphaPeak.toFixed(1) : '—'} <i>Hz α peak</i></span>
				<span class="chip">{blinks} <i>blinks</i></span>
				<span class="chip">{rmsUv.toFixed(1)} <i>µV rms</i></span>
			</div>

			<div class="viz">
				<div class="viz-cell">
					<span class="viz-label">BAND-PASSED EEG · 1–45 Hz · 3 s</span>
					<canvas bind:this={traceCanvas}></canvas>
				</div>
				<div class="viz-cell">
					<span class="viz-label">BAND POWER</span>
					<canvas bind:this={bandCanvas}></canvas>
				</div>
				<div class="viz-cell wide">
					<span class="viz-label">FOCUS THIS SESSION · red = death</span>
					<canvas bind:this={timelineCanvas}></canvas>
				</div>
			</div>

			<div class="commands">
				<span class="cmd-label">DEVICE COMMANDS</span>
				<div class="cmd-row">
					<button class="btn small" onclick={cmdStart} disabled={!canCommand}
						>▶ Start <kbd>b</kbd></button
					>
					<button class="btn small" onclick={cmdStop} disabled={!canCommand}
						>⏸ Stop <kbd>s</kbd></button
					>
					<button class="btn small" onclick={cmdReset} disabled={!canCommand}
						>↺ Reset <kbd>v</kbd></button
					>
					<button class="btn small" onclick={cmdInfo} disabled={!canCommand}
						>ⓘ Info <kbd>i</kbd></button
					>
					<button class="btn small" onclick={cmdDiag} disabled={!canCommand}>
						{diagBusy ? 'Running…' : '⚕ Diagnose'}{#if !diagBusy}&nbsp;<kbd>d</kbd>{/if}
					</button>
					<label class="rate">
						<span>RATE</span>
						<select
							aria-label="Sample rate"
							bind:value={rateSel}
							onchange={() => cmdRate(rateSel)}
							disabled={!canCommand}
							title="~ — set the ADS1220 output rate. The board reports the applied rate back via INFO and the DSP re-tunes."
						>
							{#each RATE_LADDER as r (r)}
								<option value={r}>{rateLabel(r)}</option>
							{/each}
						</select>
						<kbd>~</kbd>
					</label>
				</div>
				{#if !fsOk && fsReason}
					<p class="rate-warn">Focus unavailable at {fs} SPS — {fsReason}.</p>
				{/if}
				{#if diagReport}
					<div class="diag" data-verdict={diagReport.verdict ?? 'ERR'}>
						<b>{diagReport.error ? 'ERROR' : diagReport.verdict}</b>
						<p>{describeDiag(diagReport)}</p>
						{#if !diagReport.error}
							<code>
								rms {diagReport.rmsUv?.toFixed(1)} µV · 50 Hz {diagReport.mains50Uv?.toFixed(1)} · 60
								Hz {diagReport.mains60Uv?.toFixed(1)} · α {diagReport.alphaUv?.toFixed(1)}
							</code>
							<small
								>Firmware reports ADC-referred µV (AFE_GAIN=1), ~100× the electrode-referred values
								shown above.</small
							>
						{/if}
					</div>
				{:else if source === 'headset'}
					<p class="diag-hint">Run <b>Diagnose</b> to check electrode contact before a session.</p>
				{:else}
					<p class="diag-hint">
						Device commands need a linked headset. Single ear-referenced channel: beta overlaps jaw
						EMG, so a clenched jaw reads like concentration.
					</p>
				{/if}
			</div>
		</section>
	</div>
</main>

<style>
	:global(body) {
		margin: 0;
	}
	main {
		min-height: 100dvh;
		box-sizing: border-box;
		padding: 14px 18px 18px;
		background: radial-gradient(120% 110% at 50% -10%, #131a26, #0a0d14 70%);
		color: #e8eef6;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			sans-serif;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	header {
		display: flex;
		align-items: center;
		gap: 18px;
		flex-wrap: wrap;
	}
	.brand {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
	}
	.brand span {
		font-weight: 600;
		letter-spacing: 2px;
		color: #9fb2c6;
	}
	.brand b {
		color: #4cc9f0;
	}
	.tag {
		font-size: 10px !important;
		letter-spacing: 1.6px !important;
		color: #55617a !important;
		font-weight: 500 !important;
		text-transform: uppercase;
	}
	.sources {
		display: flex;
		gap: 8px;
	}
	.right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.mains {
		display: flex;
		border: 1px solid #26313f;
		border-radius: 7px;
		overflow: hidden;
	}
	.mains button {
		background: transparent;
		border: 0;
		color: #6b7c90;
		font: inherit;
		font-size: 11px;
		padding: 5px 9px;
		cursor: pointer;
	}
	.mains button.on {
		background: #26313f;
		color: #e8eef6;
	}
	.led {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #2a3329;
	}
	.led[data-state='live'] {
		background: #5fe886;
		box-shadow: 0 0 8px #5fe886;
	}
	.led[data-state='connecting'],
	.led[data-state='requesting'],
	.led[data-state='reconnecting'] {
		background: #e8a23a;
		box-shadow: 0 0 8px #e8a23a;
		animation: pulse 1s infinite;
	}
	.led[data-state='error'] {
		background: #ff6b6b;
		box-shadow: 0 0 8px #ff6b6b;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	.state {
		font-size: 12px;
		color: #8a9ab0;
	}
	nav {
		display: flex;
		gap: 12px;
	}
	nav a {
		color: #6b7c90;
		text-decoration: none;
		font-size: 13px;
	}
	.status {
		margin: 0;
		font-size: 12.5px;
		color: #7c8ca0;
		min-height: 1.2em;
	}
	.status.err {
		color: #ff8a8a;
	}

	.btn {
		background: #17202e;
		border: 1px solid #26313f;
		color: #cdd8e6;
		border-radius: 8px;
		padding: 8px 13px;
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.btn:hover:not(:disabled) {
		border-color: #3a4757;
	}
	.btn:disabled {
		opacity: 0.42;
		cursor: default;
	}
	.btn.primary {
		background: #4cc9f0;
		border-color: #4cc9f0;
		color: #04121a;
		font-weight: 600;
	}
	.btn.danger {
		background: #3a1f26;
		border-color: #5c2b35;
		color: #ffb3b3;
	}
	.btn.ghost {
		background: transparent;
	}
	.btn.small {
		padding: 6px 10px;
		font-size: 12px;
	}
	kbd {
		font-family: ui-monospace, monospace;
		font-size: 10px;
		background: rgba(255, 255, 255, 0.08);
		border-radius: 3px;
		padding: 1px 4px;
	}

	.deck {
		flex: 1;
		display: grid;
		grid-template-columns: 1.35fr 1fr;
		gap: 14px;
		min-height: 0;
	}
	@media (max-width: 1080px) {
		.deck {
			grid-template-columns: 1fr;
		}
	}
	.pane {
		background: #0e131c;
		border: 1px solid #1c2532;
		border-radius: 14px;
		padding: 12px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-height: 0;
	}
	.pane-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.pane-head h2 {
		margin: 0;
		font-size: 11px;
		letter-spacing: 2.5px;
		color: #6b7c90;
		font-weight: 600;
	}
	.session {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.timer {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: #8a9ab0;
	}
	.canvas-wrap {
		position: relative;
		flex: 1;
		min-height: 360px;
		border-radius: 10px;
		overflow: hidden;
	}
	.canvas-wrap canvas {
		width: 100%;
		height: 100%;
		display: block;
		cursor: pointer;
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: #61708a;
	}

	.report {
		position: absolute;
		inset: 0;
		background: rgba(8, 11, 18, 0.96);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 18px 22px;
		box-sizing: border-box;
		overflow: auto;
	}
	.report h3 {
		margin: 0;
		font-size: 12px;
		letter-spacing: 2px;
		color: #6b7c90;
		font-weight: 600;
		text-transform: uppercase;
	}
	.headline {
		margin: 0;
		max-width: 62ch;
		text-align: center;
		font-size: 13.5px;
		line-height: 1.6;
		color: #cdd8e6;
		border-left: 3px solid #3a4757;
		padding-left: 12px;
	}
	.headline[data-verdict='association'] {
		border-left-color: #ffd166;
	}
	.headline[data-verdict='no-association'] {
		border-left-color: #5fe886;
	}
	.synthetic-warn {
		margin: 0;
		max-width: 62ch;
		text-align: center;
		font-size: 11.5px;
		line-height: 1.5;
		color: #e8a23a;
		background: rgba(232, 162, 58, 0.08);
		border-radius: 6px;
		padding: 7px 10px;
	}
	.report .grid {
		display: grid;
		grid-template-columns: repeat(6, minmax(64px, 1fr));
		gap: 10px 12px;
		margin: 4px 0;
	}
	.report .grid div {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.report .grid b {
		font-size: 18px;
	}
	.report .grid b.bad {
		color: #ff8a8a;
	}
	.report .grid span {
		font-size: 9px;
		letter-spacing: 0.6px;
		color: #6b7c90;
		text-transform: uppercase;
		text-align: center;
	}
	.note {
		margin: 0;
		font-size: 11.5px;
		color: #8a9ab0;
		max-width: 60ch;
		text-align: center;
	}
	.actions {
		display: flex;
		gap: 10px;
		margin-top: 4px;
	}

	.meters {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	.meter-top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 4px;
	}
	.meter-top span {
		font-size: 10px;
		letter-spacing: 1.4px;
		color: #6b7c90;
	}
	.meter-top b {
		font-size: 20px;
		color: #cdd8e6;
	}
	.meter-top b.flow {
		color: #ffd166;
	}
	.meter-top b.muted {
		font-size: 12px;
		color: #55617a;
	}
	.bar {
		height: 10px;
		background: #17202e;
		border-radius: 999px;
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		border-radius: 999px;
		transition: width 0.12s linear;
	}
	.fill.focus {
		background: linear-gradient(90deg, #8a6a2a, #ffd166);
	}
	.fill.calm {
		background: linear-gradient(90deg, #2a6a3d, #6be585);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		background: #131b26;
		border: 1px solid #1f2937;
		border-radius: 999px;
		padding: 3px 9px;
		font-size: 11px;
		font-family: ui-monospace, monospace;
		color: #a9b6c6;
	}
	.chip i {
		font-style: normal;
		color: #5a6577;
	}
	.chip.ok {
		border-color: #2f6b45;
		color: #6be585;
	}
	.chip.warn {
		border-color: #6b4a2f;
		color: #e8a23a;
	}

	.viz {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr 110px;
		grid-template-rows: auto 1fr;
		gap: 8px;
	}
	.viz-cell {
		background: #0c111a;
		border-radius: 8px;
		padding: 6px 8px 4px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-height: 0;
	}
	.viz-cell.wide {
		grid-column: 1 / -1;
	}
	.viz-label {
		font-size: 8.5px;
		letter-spacing: 1.4px;
		color: #4d5a6b;
	}
	.viz-cell canvas {
		width: 100%;
		height: 62px;
		display: block;
	}
	.viz-cell.wide canvas {
		flex: 1;
		height: auto;
		min-height: 80px;
	}

	.commands {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.cmd-label {
		font-size: 9px;
		letter-spacing: 2px;
		color: #4d5a6b;
	}
	.cmd-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.rate {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		letter-spacing: 0.08em;
		color: #8b98a8;
	}
	.rate select {
		background: #0c111a;
		color: #cfd8e3;
		border: 1px solid #2b3543;
		border-radius: 6px;
		padding: 4px 6px;
		font: inherit;
		cursor: pointer;
	}
	.rate select:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.rate-warn {
		margin: 6px 0 0;
		font-size: 11px;
		line-height: 1.4;
		color: #e0a33a;
	}
	.diag {
		background: #0c111a;
		border-left: 3px solid #3a4757;
		border-radius: 6px;
		padding: 8px 10px;
	}
	.diag[data-verdict='OK'] {
		border-left-color: #5fe886;
	}
	.diag[data-verdict='FLOAT'],
	.diag[data-verdict='FLAT'] {
		border-left-color: #e8a23a;
	}
	.diag[data-verdict='RAILED'],
	.diag[data-verdict='DC_SAT'],
	.diag[data-verdict='ERR'] {
		border-left-color: #ff6b6b;
	}
	.diag b {
		font-size: 12px;
		letter-spacing: 1px;
	}
	.diag p {
		margin: 3px 0 5px;
		font-size: 11.5px;
		color: #8a9ab0;
		line-height: 1.45;
	}
	.diag code {
		display: block;
		font-size: 10.5px;
		color: #6b7c90;
		line-height: 1.5;
	}
	.diag small {
		display: block;
		margin-top: 5px;
		font-size: 9.5px;
		color: #4d5a6b;
		line-height: 1.4;
	}
	.diag-hint {
		margin: 0;
		font-size: 11.5px;
		color: #4d5a6b;
		line-height: 1.5;
	}
</style>

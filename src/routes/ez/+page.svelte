<script lang="ts">
	// EZ mode — the dead-simple view. Connects to the NeuroFocus v2 headset and shows
	// plain-language state (BLINK! / FOCUSED / RELAXED) instead of graphs. Reuses the same
	// DSP + BLE contract as the main BERGER·1 app.
	import { onDestroy } from 'svelte';
	import * as dsp from '$lib/dsp';
	import {
		ADC_PROFILES,
		BLE_SERVICE,
		BLE_DATA,
		BLE_CMD,
		BLE_SAMPLE_RATE
	} from '$lib/neurofocus';

	/* eslint-disable @typescript-eslint/no-explicit-any */
	type Ble = any;

	const FS = BLE_SAMPLE_RATE;

	// ---- reactive UI state ----
	let status = $state<'idle' | 'connecting' | 'live' | 'error'>('idle');
	let statusMsg = $state('Not connected');
	let sps = $state(0);
	let blinkCount = $state(0);
	let blinking = $state(false); // true briefly right after a blink -> drives the flash
	let focus = $state(0); // 0..100 attention estimate
	let calm = $state(0); // 0..100 relaxation (alpha) estimate
	let mood = $state<'—' | 'FOCUSED' | 'RELAXED' | 'NEUTRAL'>('—');
	let signalOk = $state(false); // is there real electrode activity at all?

	// ---- processing state (non-reactive) ----
	let dev: Ble = null;
	let chain = dsp.makeChain(FS, { lo: 1, hi: 45, line: 60 });
	const settings = { ...ADC_PROFILES.v2 };
	const buf: number[] = []; // filtered µV history
	const BUF_CAP = FS * 4; // 4 s window
	let emaSq = 0; // slow baseline power (for adaptive blink threshold)
	let refractory = 0; // samples remaining before another blink can fire
	let focusEma = 0;
	let calmEma = 0;
	let sinceFocus = 0;
	let blinkTimer: ReturnType<typeof setTimeout> | null = null;

	// SPS meter
	let spsCount = 0;
	let spsT = 0;
	let spark: HTMLCanvasElement | null = $state(null);

	const BLINK_K = 4.5; // blink if |y| exceeds K x baseline RMS ...
	const BLINK_FLOOR = 12; // ... and this µV floor (so a flat/noisy line can't trigger)
	const REFRACTORY = Math.round(0.3 * FS); // ~300 ms between blinks

	function onSample(uv: number) {
		const y = chain.step(uv); // band-passed µV
		buf.push(y);
		if (buf.length > BUF_CAP) buf.shift();

		// adaptive baseline (slow, so an occasional blink barely moves it)
		emaSq = emaSq * 0.995 + y * y * 0.005;
		const rms = Math.sqrt(emaSq);
		signalOk = rms > 1.5; // essentially-flat line => not coupled

		// blink = sharp deflection above the adaptive threshold + a floor
		if (refractory > 0) refractory--;
		else if (Math.abs(y) > Math.max(BLINK_FLOOR, BLINK_K * rms)) {
			fireBlink();
			refractory = REFRACTORY;
		}

		// focus / calm from band powers, ~2x per second
		if (++sinceFocus >= Math.round(FS / 2) && buf.length >= 128) {
			sinceFocus = 0;
			updateBands();
		}
	}

	function fireBlink() {
		blinkCount++;
		blinking = true;
		if (blinkTimer) clearTimeout(blinkTimer);
		blinkTimer = setTimeout(() => (blinking = false), 450);
	}

	function updateBands() {
		const seg = Float64Array.from(buf.slice(-Math.min(buf.length, FS * 4)));
		const { freqs, psd } = dsp.welch(seg, FS, 128, 0.5);
		const bp = dsp.bandPowers(freqs, psd);
		// engagement lives in the theta/alpha/beta trio; delta is dominated by drift+blinks,
		// gamma by noise — so score within that trio only.
		const active = bp.theta + bp.alpha + bp.beta + 1e-9;
		const betaFrac = bp.beta / active; // more beta -> more focused/engaged
		const alphaFrac = bp.alpha / active; // more alpha -> more relaxed
		focusEma = focusEma * 0.7 + betaFrac * 0.3;
		calmEma = calmEma * 0.7 + alphaFrac * 0.3;
		focus = Math.round(Math.min(100, focusEma * 160)); // betaFrac ~0.6 reads ~100
		calm = Math.round(Math.min(100, calmEma * 160));
		mood = !signalOk ? 'NEUTRAL' : focus >= 55 ? 'FOCUSED' : calm >= 55 ? 'RELAXED' : 'NEUTRAL';
		drawSpark();
	}

	function drawSpark() {
		const c = spark;
		if (!c) return;
		const ctx = c.getContext('2d');
		if (!ctx) return;
		const w = c.width,
			h = c.height;
		ctx.clearRect(0, 0, w, h);
		const n = Math.min(buf.length, FS * 3);
		if (n < 2) return;
		const data = buf.slice(-n);
		let mx = 1;
		for (const v of data) mx = Math.max(mx, Math.abs(v));
		mx *= 1.1;
		ctx.strokeStyle = signalOk ? '#4cc9f0' : '#556';
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let i = 0; i < n; i++) {
			const x = (i / (n - 1)) * w;
			const yy = h / 2 - (data[i] / mx) * (h / 2 - 3);
			i === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
		}
		ctx.stroke();
	}

	function onData(e: Event) {
		const dv = (e.target as { value?: DataView }).value;
		if (!dv) return;
		const vals = dsp.parseFrame(new TextDecoder().decode(dv));
		for (const v of vals) {
			onSample(dsp.countsToUv(v, settings));
			spsCount++;
		}
		const now = performance.now();
		if (now - spsT >= 1000) {
			sps = Math.round((spsCount * 1000) / (now - spsT));
			spsCount = 0;
			spsT = now;
		}
	}

	async function connect() {
		const nav = navigator as Navigator & { bluetooth?: Ble };
		if (!nav.bluetooth) {
			status = 'error';
			statusMsg = 'Web Bluetooth needs Chrome or Edge (desktop / Android).';
			return;
		}
		try {
			status = 'connecting';
			statusMsg = 'Pick your headset…';
			dev = await nav.bluetooth.requestDevice({
				filters: [{ services: [BLE_SERVICE] }],
				optionalServices: [BLE_SERVICE]
			});
			dev.addEventListener('gattserverdisconnected', onDisconnect);
			statusMsg = 'Connecting…';
			const server = await dev.gatt.connect();
			const svc = await server.getPrimaryService(BLE_SERVICE);
			const dataChar = await svc.getCharacteristic(BLE_DATA);
			const cmdChar = await svc.getCharacteristic(BLE_CMD);
			chain.reset();
			buf.length = 0;
			emaSq = 0;
			spsT = performance.now();
			await dataChar.startNotifications();
			dataChar.addEventListener('characteristicvaluechanged', onData);
			try {
				await cmdChar.writeValue(new TextEncoder().encode('b')); // start streaming
			} catch {
				/* streaming auto-starts on connect anyway */
			}
			status = 'live';
			statusMsg = 'Connected — ' + (dev.name || 'headset');
		} catch (err) {
			status = 'error';
			statusMsg = err instanceof Error ? err.message : String(err);
		}
	}

	function onDisconnect() {
		status = 'idle';
		statusMsg = 'Disconnected';
		signalOk = false;
		mood = '—';
	}

	function disconnect() {
		if (dev?.gatt?.connected) dev.gatt.disconnect();
	}

	onDestroy(() => {
		if (blinkTimer) clearTimeout(blinkTimer);
		disconnect();
	});
</script>

<svelte:head><title>NeuroFocus · EZ</title></svelte:head>

<main class:flash={blinking}>
	<header>
		<span class="brand">NeuroFocus <b>EZ</b></span>
		<a class="full" href="/">full view →</a>
	</header>

	{#if status !== 'live'}
		<section class="hero">
			<h1>How's your brain?</h1>
			<p class="sub">Connect the headset and it'll tell you — in plain words.</p>
			<button class="cta" onclick={connect} disabled={status === 'connecting'}>
				{status === 'connecting' ? 'Connecting…' : 'Connect headset'}
			</button>
			<p class="msg" class:err={status === 'error'}>{statusMsg}</p>
		</section>
	{:else}
		<section class="live">
			<!-- BIG blink cue -->
			<div class="blink" class:on={blinking}>👁 BLINKED</div>

			<!-- headline state -->
			<div
				class="mood"
				class:focused={mood === 'FOCUSED'}
				class:relaxed={mood === 'RELAXED'}
				class:neutral={mood === 'NEUTRAL'}
			>
				{mood}
			</div>

			<!-- two simple meters -->
			<div class="meters">
				<div class="meter">
					<span class="lbl">FOCUS</span>
					<div class="bar"><i style="width:{focus}%" class="fill focus"></i></div>
					<span class="pct">{focus}</span>
				</div>
				<div class="meter">
					<span class="lbl">CALM</span>
					<div class="bar"><i style="width:{calm}%" class="fill calm"></i></div>
					<span class="pct">{calm}</span>
				</div>
			</div>

			<!-- live signal + stats -->
			<canvas bind:this={spark} width="520" height="60" class="spark"></canvas>
			<div class="stats">
				<span>blinks <b>{blinkCount}</b></span>
				<span>{sps} Hz</span>
				<span class="sig" class:ok={signalOk}>{signalOk ? 'signal ✓' : 'no signal'}</span>
				<button class="ghost" onclick={disconnect}>disconnect</button>
			</div>
			<p class="note">
				Single channel — <b>blinks are reliable</b>; focus / calm are rough estimates. If it says
				“no signal”, check the electrodes (esp. the DRL / bias).
			</p>
		</section>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
	}
	main {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		background: #0a0d14;
		color: #e8eef6;
		font-family:
			ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, Segoe UI, sans-serif;
		transition: background 0.12s ease;
	}
	main.flash {
		background: #16324a;
	}
	header {
		width: 100%;
		max-width: 560px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 18px 22px;
		box-sizing: border-box;
	}
	.brand {
		letter-spacing: 0.5px;
		font-weight: 500;
		color: #9fb2c6;
	}
	.brand b {
		color: #4cc9f0;
	}
	.full {
		color: #6b7c90;
		text-decoration: none;
		font-size: 14px;
	}
	.hero {
		margin: auto;
		text-align: center;
		padding: 24px;
	}
	.hero h1 {
		font-size: clamp(30px, 8vw, 46px);
		margin: 0 0 8px;
	}
	.sub {
		color: #8a9ab0;
		margin: 0 0 28px;
	}
	.cta {
		border: 0;
		border-radius: 999px;
		background: #4cc9f0;
		color: #04121a;
		font: inherit;
		font-weight: 700;
		font-size: 18px;
		padding: 15px 34px;
		cursor: pointer;
	}
	.cta:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.msg {
		margin-top: 18px;
		color: #7c8ca0;
		min-height: 1.2em;
	}
	.msg.err {
		color: #ff8a8a;
	}

	.live {
		margin: auto;
		width: 100%;
		max-width: 560px;
		padding: 10px 22px 40px;
		box-sizing: border-box;
		text-align: center;
	}
	.blink {
		font-size: clamp(28px, 7vw, 40px);
		font-weight: 800;
		letter-spacing: 1px;
		color: #7fe3ff;
		opacity: 0;
		transform: scale(0.9);
		transition:
			opacity 0.1s ease,
			transform 0.1s ease;
		height: 1.1em;
	}
	.blink.on {
		opacity: 1;
		transform: scale(1);
	}
	.mood {
		font-size: clamp(56px, 17vw, 104px);
		font-weight: 900;
		letter-spacing: -1px;
		margin: 6px 0 26px;
		line-height: 1;
		color: #55617a;
	}
	.mood.focused {
		color: #ffd166;
	}
	.mood.relaxed {
		color: #6be585;
	}
	.mood.neutral {
		color: #8a9ab0;
	}

	.meters {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin: 0 auto 28px;
		max-width: 420px;
	}
	.meter {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.lbl {
		width: 62px;
		text-align: left;
		font-size: 13px;
		letter-spacing: 1px;
		color: #8a9ab0;
	}
	.bar {
		flex: 1;
		height: 14px;
		background: #17202e;
		border-radius: 999px;
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		border-radius: 999px;
		transition: width 0.3s ease;
	}
	.fill.focus {
		background: #ffd166;
	}
	.fill.calm {
		background: #6be585;
	}
	.pct {
		width: 34px;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: #cdd8e6;
	}

	.spark {
		width: 100%;
		max-width: 520px;
		height: 60px;
		display: block;
		margin: 8px auto 14px;
		background: #0c111a;
		border-radius: 10px;
	}
	.stats {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 18px;
		color: #7c8ca0;
		font-size: 14px;
	}
	.stats b {
		color: #e8eef6;
	}
	.sig.ok {
		color: #6be585;
	}
	.ghost {
		background: transparent;
		border: 1px solid #26313f;
		color: #9fb2c6;
		border-radius: 8px;
		padding: 5px 12px;
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.note {
		color: #61708a;
		font-size: 12.5px;
		max-width: 440px;
		margin: 18px auto 0;
		line-height: 1.5;
	}
</style>

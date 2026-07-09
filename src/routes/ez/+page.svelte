<script lang="ts">
	// EZ mode — the dead-simple view. Connects to the NeuroFocus v4 headset and shows
	// plain-language state (BLINK! / FOCUSED / RELAXED) instead of graphs. Reuses the same
	// BLE link + focus engine as /demo and the main BERGER·1 app.
	import { onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { ADC_PROFILES } from '$lib/adc';
	import { NeuroLink, V4_SAMPLE_RATE } from '$lib/ble';
	import { FocusEngine } from '$lib/focus';

	// firmware/v4: ADS1220 at 175 SPS (DR_LVL_3), 24-bit bipolar, AD8422 in-amp ahead of it.
	const FS = V4_SAMPLE_RATE;
	const SCALE = ADC_PROFILES.v4;

	// ---- reactive UI state ----
	let status = $state<'idle' | 'connecting' | 'live' | 'error'>('idle');
	let statusMsg = $state('Not connected');
	let sps = $state(0);
	let blinkCount = $state(0);
	let blinking = $state(false); // true briefly right after a blink -> drives the flash
	let focus = $state(0); // 0..100 attention estimate
	let calm = $state(0); // 0..100 relaxation (alpha) estimate
	let mood = $state<'—' | 'FOCUSED' | 'RELAXED' | 'NEUTRAL' | 'CALIBRATING'>('—');
	let signalOk = $state(false); // is there real electrode activity at all?
	let calibrating = $state(true); // focus is meaningless until the baseline is known
	let calLeft = $state(0);
	let spark: HTMLCanvasElement | null = $state(null);

	// ---- processing state (non-reactive) ----
	let link: NeuroLink | null = null;
	let blinkTimer: ReturnType<typeof setTimeout> | null = null;
	let raf = 0;

	const engine = new FocusEngine(FS, {
		line: 60,
		onBlink: () => {
			blinkCount++;
			blinking = true;
			if (blinkTimer) clearTimeout(blinkTimer);
			blinkTimer = setTimeout(() => (blinking = false), 450);
		}
	});

	function tick() {
		raf = requestAnimationFrame(tick);
		const m = engine.read();
		focus = Math.round(m.focus);
		calm = Math.round(m.calm);
		signalOk = m.signalOk;
		calibrating = m.calibrating;
		calLeft = m.calibrationLeftSec;
		// 50 is this user's own baseline engagement, so "focused" means meaningfully above it.
		mood = m.calibrating
			? 'CALIBRATING'
			: !m.signalOk
				? 'NEUTRAL'
				: m.focus >= 60
					? 'FOCUSED'
					: m.calm >= 55
						? 'RELAXED'
						: 'NEUTRAL';
		sps = link?.stats.sps ?? 0;
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
		const data = engine.trace(FS * 3);
		if (data.length < 2) return;
		let mx = 1;
		for (const v of data) mx = Math.max(mx, Math.abs(v));
		mx *= 1.1;
		ctx.strokeStyle = signalOk ? '#4cc9f0' : '#556';
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let i = 0; i < data.length; i++) {
			const x = (i / (data.length - 1)) * w;
			const yy = h / 2 - (data[i] / mx) * (h / 2 - 3);
			if (i === 0) ctx.moveTo(x, yy);
			else ctx.lineTo(x, yy);
		}
		ctx.stroke();
	}

	async function connect() {
		if (!NeuroLink.supported) {
			status = 'error';
			statusMsg = 'Web Bluetooth needs Chrome or Edge (desktop / Android).';
			return;
		}
		engine.reset();
		blinkCount = 0;
		link = new NeuroLink({
			onSamples: (counts) => engine.pushCounts(counts, SCALE),
			onState: (s, detail) => {
				statusMsg = detail;
				status =
					s === 'live' ? 'live' : s === 'error' ? 'error' : s === 'idle' ? 'idle' : 'connecting';
				if (s !== 'live') signalOk = false;
			}
		});
		try {
			await link.connect();
			if (!raf) tick();
		} catch (e) {
			// NeuroLink already turned the raw GATT error into something actionable.
			status = 'error';
			statusMsg = e instanceof Error ? e.message : String(e);
			link = null;
		}
	}

	async function disconnect() {
		cancelAnimationFrame(raf);
		raf = 0;
		await link?.disconnect();
		link = null;
		status = 'idle';
		statusMsg = 'Disconnected';
		signalOk = false;
		mood = '—';
	}

	onDestroy(() => {
		// onDestroy also runs during SSR, where there is no rAF.
		if (!browser) return;
		if (blinkTimer) clearTimeout(blinkTimer);
		cancelAnimationFrame(raf);
		void disconnect();
	});
</script>

<svelte:head><title>NeuroFocus · EZ</title></svelte:head>

<main class:flash={blinking}>
	<header>
		<span class="brand">NeuroFocus <b>EZ</b></span>
		<nav>
			<a class="full" href={resolve('/demo')}>demo →</a>
			<a class="full" href={resolve('/')}>full view →</a>
		</nav>
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

			{#if calibrating}
				<p class="note" style="margin-top:0">
					Learning your baseline — sit normally for another {calLeft.toFixed(0)}s. Focus is scored
					against <b>you</b>, not against other people.
				</p>
			{/if}

			<!-- two simple meters -->
			<div class="meters">
				<div class="meter">
					<span class="lbl">FOCUS</span>
					<div class="bar"><i style="width:{calibrating ? 0 : focus}%" class="fill focus"></i></div>
					<span class="pct">{calibrating ? '—' : focus}</span>
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
			ui-rounded,
			'SF Pro Rounded',
			system-ui,
			-apple-system,
			Segoe UI,
			sans-serif;
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
	nav {
		display: flex;
		gap: 16px;
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
		max-width: 460px;
		line-height: 1.5;
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

<script lang="ts">
	import { onMount } from 'svelte';
	import { NeuroFocus } from '$lib/neurofocus';

	let app: NeuroFocus | undefined;

	onMount(() => {
		app = new NeuroFocus();
		app.mount();
		return () => app?.destroy();
	});
</script>

<svelte:head>
	<title>BERGER·1 · EEG PSD & Spectrogram</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@400;500;600;700&family=Saira+Semi+Condensed:wght@600;700&family=Space+Mono:wght@400;700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div
	style="position:fixed;inset:0;display:flex;overflow:auto;padding:16px;background:radial-gradient(125% 120% at 50% -10%,#272019,#16110c 65%,#0c0805);font-family:'Saira Condensed',sans-serif"
>
	<div
		style="position:relative;flex:1;min-width:940px;min-height:560px;display:flex;flex-direction:column;gap:11px;border-radius:16px;padding:15px 17px 13px;overflow:hidden;background:linear-gradient(176deg,#ece6d6,#dbd4c1 46%,#c9bfa9);border:1px solid #b6ad96;box-shadow:0 34px 70px -26px rgba(0,0,0,.85),inset 0 2px 0 rgba(255,255,255,.55),inset 0 -3px 9px rgba(0,0,0,.16)"
	>
		<!-- corner screws -->
		<span style="position:absolute;top:9px;left:9px;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 36% 30%,#fff,#c2baa3 55%,#8f876f);box-shadow:0 1px 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.07)"><span style="position:absolute;inset:0;margin:auto;width:8px;height:1.5px;background:rgba(0,0,0,.28);transform:rotate(40deg)"></span></span>
		<span style="position:absolute;top:9px;right:9px;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 36% 30%,#fff,#c2baa3 55%,#8f876f);box-shadow:0 1px 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.07)"><span style="position:absolute;inset:0;margin:auto;width:8px;height:1.5px;background:rgba(0,0,0,.28);transform:rotate(-25deg)"></span></span>
		<span style="position:absolute;bottom:9px;left:9px;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 36% 30%,#fff,#c2baa3 55%,#8f876f);box-shadow:0 1px 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.07)"><span style="position:absolute;inset:0;margin:auto;width:8px;height:1.5px;background:rgba(0,0,0,.28);transform:rotate(15deg)"></span></span>
		<span style="position:absolute;bottom:9px;right:9px;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 36% 30%,#fff,#c2baa3 55%,#8f876f);box-shadow:0 1px 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.07)"><span style="position:absolute;inset:0;margin:auto;width:8px;height:1.5px;background:rgba(0,0,0,.28);transform:rotate(-40deg)"></span></span>

		<!-- BRAND PLATE -->
		<div style="display:flex;align-items:center;gap:18px;flex:none;padding:0 22px 9px;border-bottom:1px solid rgba(0,0,0,.13)">
			<div style="display:flex;flex-direction:column;line-height:1">
				<div style="display:flex;align-items:baseline;gap:4px">
					<span style="font:700 27px 'Saira Semi Condensed',sans-serif;letter-spacing:4px;color:#39342a;text-shadow:0 1px 0 rgba(255,255,255,.6),0 -1px 0 rgba(0,0,0,.12)">BERGER</span>
					<span style="font:700 27px 'Saira Semi Condensed',sans-serif;letter-spacing:1px;color:#c8642a;text-shadow:0 1px 0 rgba(255,255,255,.5)">·1</span>
				</div>
				<span style="font:600 9px 'Saira Condensed';letter-spacing:3.5px;color:#6a6149;margin-top:3px;text-shadow:0 1px 0 rgba(255,255,255,.55)">ELECTROENCEPHALOGRAPH</span>
			</div>
			<div style="padding:5px 11px;border-radius:5px;background:linear-gradient(180deg,#d7d0bd,#c3baa3);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),inset 0 -1px 2px rgba(0,0,0,.18),0 1px 0 rgba(255,255,255,.4);border:1px solid #b0a890">
				<span style="font:600 10px 'Saira Condensed';letter-spacing:2.5px;color:#5a513d;text-shadow:0 1px 0 rgba(255,255,255,.5)">α-RHYTHM ANALYSER · 1–45 Hz</span>
			</div>

			<div style="flex:1"></div>

			<div style="display:flex;align-items:center;gap:9px;padding:6px 13px;background:#0b0f0b;border-radius:6px;box-shadow:inset 0 1px 5px rgba(0,0,0,.85),0 1px 0 rgba(255,255,255,.45)">
				<span id="nf-dot" style="width:10px;height:10px;border-radius:50%;background:#2a3329;box-shadow:0 0 0 1px rgba(0,0,0,.5)"></span>
				<span id="nf-mode" style="font:600 12px 'Space Mono',monospace;letter-spacing:.5px;color:#7fae8c">idle</span>
			</div>

			<div style="display:flex;gap:9px">
				<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
					<span style="font:600 8px 'Saira Condensed';letter-spacing:2px;color:#6a6149;text-shadow:0 1px 0 rgba(255,255,255,.5)">FS · Hz</span>
					<span style="min-width:50px;text-align:right;font:700 15px 'DSEG7','Space Mono',monospace;color:#5fe886;background:#0a0f0b;border-radius:4px;padding:3px 7px;box-shadow:inset 0 1px 4px rgba(0,0,0,.85),0 1px 0 rgba(255,255,255,.4)" id="nf-fs">000</span>
				</div>
				<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
					<span style="font:600 8px 'Saira Condensed';letter-spacing:2px;color:#6a6149;text-shadow:0 1px 0 rgba(255,255,255,.5)">SPS</span>
					<span style="min-width:50px;text-align:right;font:700 15px 'DSEG7','Space Mono',monospace;color:#5fe886;background:#0a0f0b;border-radius:4px;padding:3px 7px;box-shadow:inset 0 1px 4px rgba(0,0,0,.85),0 1px 0 rgba(255,255,255,.4)" id="nf-sps">000</span>
				</div>
				<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
					<span style="font:600 8px 'Saira Condensed';letter-spacing:2px;color:#6a6149;text-shadow:0 1px 0 rgba(255,255,255,.5)">OVF</span>
					<span style="min-width:42px;text-align:right;font:700 15px 'DSEG7','Space Mono',monospace;color:#e8a23a;background:#0a0f0b;border-radius:4px;padding:3px 7px;box-shadow:inset 0 1px 4px rgba(0,0,0,.85),0 1px 0 rgba(255,255,255,.4)" id="nf-ovf">000</span>
				</div>
			</div>
		</div>

		<!-- BANNER -->
		<div id="nf-banner" style="display:none;flex:none;padding:6px 14px;border-radius:6px;background:#f0e2c0;border:1px solid #d8c489;color:#7a5a1a;font:500 11px 'Space Mono',monospace;letter-spacing:.3px"></div>

		<!-- MAIN DECK -->
		<div style="flex:1;display:grid;grid-template-columns:1.5fr 1fr;gap:12px;min-height:0">
			<!-- LEFT: GREEN PHOSPHOR (time domain) -->
			<div style="display:flex;flex-direction:column;gap:8px;min-height:0;border-radius:10px;padding:9px 10px 10px;background:linear-gradient(160deg,#14130d,#1d1a12);box-shadow:inset 0 2px 11px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.5)">
				<div style="display:flex;justify-content:space-between;align-items:center;flex:none">
					<span style="font:600 10px 'Saira Condensed';letter-spacing:2.5px;color:rgba(140,235,168,.7)">EEG ACTIVITY · CH1 · BAND-PASS 1–45 Hz</span>
					<span style="font:400 10px 'Space Mono',monospace;color:rgba(140,235,168,.45)">µV · 4 s SWEEP</span>
				</div>
				<div style="position:relative;flex:0.42;min-height:0;border-radius:5px;overflow:hidden;background:radial-gradient(135% 130% at 50% 32%,#0d1f13,#06100a 64%,#03080500)">
					<canvas id="nf-raw" style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
					<div style="position:absolute;inset:0;pointer-events:none;border-radius:5px;background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0px,rgba(0,0,0,0) 2px,rgba(0,0,0,.16) 3px);animation:nf-scan 9s linear infinite;box-shadow:inset 0 0 36px 6px rgba(0,0,0,.5)"></div>
				</div>
				<div style="display:flex;justify-content:space-between;align-items:center;flex:none;padding-top:1px">
					<span style="font:600 10px 'Saira Condensed';letter-spacing:2.5px;color:rgba(140,235,168,.7)">SPECTROGRAM · WATERFALL</span>
					<span style="font:400 10px 'Space Mono',monospace;color:rgba(140,235,168,.45)">0–45 Hz · dB</span>
				</div>
				<div style="position:relative;flex:0.58;min-height:0;border-radius:5px;overflow:hidden;background:radial-gradient(135% 130% at 50% 32%,#0d1f13,#06100a 64%,#03080500)">
					<canvas id="nf-spec" style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
					<div style="position:absolute;inset:0;pointer-events:none;border-radius:5px;background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0px,rgba(0,0,0,0) 2px,rgba(0,0,0,.14) 3px);animation:nf-scan 9s linear infinite;box-shadow:inset 0 0 38px 7px rgba(0,0,0,.45)"></div>
				</div>
			</div>

			<!-- RIGHT: AMBER PHOSPHOR (frequency domain) -->
			<div style="display:grid;grid-template-rows:1.12fr 1fr;gap:12px;min-height:0">
				<div style="display:flex;flex-direction:column;gap:8px;min-height:0;border-radius:10px;padding:9px 10px 10px;background:linear-gradient(160deg,#14130d,#1d1a12);box-shadow:inset 0 2px 11px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.5)">
					<div style="display:flex;justify-content:space-between;align-items:center;flex:none">
						<span style="font:600 10px 'Saira Condensed';letter-spacing:2.5px;color:rgba(255,190,110,.78)">SPECTRUM · WELCH PSD</span>
						<span style="display:flex;align-items:center;gap:5px;font:400 9px 'Saira Condensed';letter-spacing:1.5px;color:rgba(255,190,110,.5)">α PEAK<span style="font:700 13px 'DSEG7','Space Mono',monospace;color:#ffb33a;background:#0a0703;border-radius:3px;padding:2px 5px;box-shadow:inset 0 1px 3px rgba(0,0,0,.85)" id="nf-peak">00.0</span>Hz</span>
					</div>
					<div style="position:relative;flex:1;min-height:0;border-radius:5px;overflow:hidden;background:radial-gradient(135% 130% at 50% 32%,#1f160a,#100b05 64%,#0a070300)">
						<canvas id="nf-psd" style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
						<div style="position:absolute;inset:0;pointer-events:none;border-radius:5px;background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0px,rgba(0,0,0,0) 2px,rgba(0,0,0,.16) 3px);animation:nf-scan 9s linear infinite;box-shadow:inset 0 0 34px 6px rgba(0,0,0,.5)"></div>
					</div>
				</div>
				<div style="display:flex;flex-direction:column;gap:8px;min-height:0;border-radius:10px;padding:9px 10px 10px;background:linear-gradient(160deg,#14130d,#1d1a12);box-shadow:inset 0 2px 11px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.5)">
					<div style="display:flex;justify-content:space-between;align-items:center;flex:none">
						<span style="font:600 10px 'Saira Condensed';letter-spacing:2.5px;color:rgba(255,190,110,.78)">BAND POWER</span>
						<span style="font:400 10px 'Space Mono',monospace;color:rgba(255,190,110,.45)">δ θ α β γ</span>
					</div>
					<div style="position:relative;flex:1;min-height:0;border-radius:5px;overflow:hidden;background:radial-gradient(135% 130% at 50% 32%,#1f160a,#100b05 64%,#0a070300)">
						<canvas id="nf-band" style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
						<div style="position:absolute;inset:0;pointer-events:none;border-radius:5px;background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0px,rgba(0,0,0,0) 2px,rgba(0,0,0,.14) 3px);animation:nf-scan 9s linear infinite;box-shadow:inset 0 0 30px 5px rgba(0,0,0,.5)"></div>
					</div>
				</div>
			</div>
		</div>

		<!-- CONTROL DECK -->
		<div style="flex:none;display:flex;align-items:stretch;gap:13px;padding-top:10px;border-top:1px solid rgba(0,0,0,.13)">
			<!-- SOURCE -->
			<div style="display:flex;flex-direction:column;gap:7px;padding:8px 12px;border-radius:9px;background:rgba(0,0,0,.045);box-shadow:inset 0 1px 2px rgba(0,0,0,.08),0 1px 0 rgba(255,255,255,.4)">
				<span style="font:600 9px 'Saira Condensed';letter-spacing:3px;color:#6a6149;text-shadow:0 1px 0 rgba(255,255,255,.5)">SIGNAL SOURCE</span>
				<div style="display:flex;gap:8px">
					<button class="nf-btn" onclick={() => app?.startDemo()} style="cursor:pointer;border-radius:7px;padding:8px 13px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#2c4a36;background:linear-gradient(180deg,#e6f0e2,#c6d6bf);border:1px solid #9fb39a;box-shadow:0 2px 0 #9bae93,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.7)">◊ Test Signal</button>
					<button class="nf-btn" onclick={() => app?.openFile()} style="cursor:pointer;border-radius:7px;padding:8px 13px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#3a3528;background:linear-gradient(180deg,#efeadd,#d2ccba);border:1px solid #b3ab95;box-shadow:0 2px 0 #b0a890,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.7)">▤ Load File</button>
					<button class="nf-btn" onclick={() => app?.connectBLE()} style="cursor:pointer;border-radius:7px;padding:8px 13px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#2c4a36;background:linear-gradient(180deg,#e6f0e2,#c6d6bf);border:1px solid #9fb39a;box-shadow:0 2px 0 #9bae93,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.7)">∿ Link BLE</button>
					<button class="nf-btn" onclick={() => app?.connectNeuroSky()} style="cursor:pointer;border-radius:7px;padding:8px 13px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#2c4a36;background:linear-gradient(180deg,#e6f0e2,#c6d6bf);border:1px solid #9fb39a;box-shadow:0 2px 0 #9bae93,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.7)">∿ NeuroSky</button>
					<button class="nf-btn" onclick={() => app?.connectEmotiv()} title="Emotiv Cortex API — coming soon" style="cursor:not-allowed;opacity:.55;border-radius:7px;padding:8px 13px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#4a4636;background:linear-gradient(180deg,#e4ded0,#cfc8b6);border:1px solid #b3ab95;box-shadow:0 2px 0 #b0a890,inset 0 1px 0 rgba(255,255,255,.6)">⌁ Emotiv · soon</button>
					<button class="nf-btn" onclick={() => app?.stopAll()} style="cursor:pointer;border-radius:7px;padding:8px 13px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#6e2a2a;background:linear-gradient(180deg,#f0dcdc,#d6b6b6);border:1px solid #b39595;box-shadow:0 2px 0 #b09090,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.6)">■ Stop</button>
				</div>
			</div>

			<!-- COMPARE -->
			<div style="display:flex;flex-direction:column;gap:7px;padding:8px 12px;border-radius:9px;background:rgba(0,0,0,.045);box-shadow:inset 0 1px 2px rgba(0,0,0,.08),0 1px 0 rgba(255,255,255,.4)">
				<span style="font:600 9px 'Saira Condensed';letter-spacing:3px;color:#6a6149;text-shadow:0 1px 0 rgba(255,255,255,.5)">ALPHA TEST · EYES OPEN / CLOSED</span>
				<div style="display:flex;gap:8px;align-items:center">
					<button class="nf-btn" onclick={() => app?.captureOpen()} style="display:flex;align-items:center;gap:7px;cursor:pointer;border-radius:7px;padding:8px 12px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#1f3a5a;background:linear-gradient(180deg,#dfeaf5,#bcd0e6);border:1px solid #96b0cc;box-shadow:0 2px 0 #92acc8,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.7)"><span style="width:9px;height:9px;border-radius:50%;background:#5aa9ff;box-shadow:0 0 5px #5aa9ff"></span>Eyes Open</button>
					<button class="nf-btn" onclick={() => app?.captureClosed()} style="display:flex;align-items:center;gap:7px;cursor:pointer;border-radius:7px;padding:8px 12px 9px;font:600 11px 'Saira Condensed';letter-spacing:1.5px;text-transform:uppercase;color:#6a4a14;background:linear-gradient(180deg,#f5e9d2,#e6cfa6);border:1px solid #ccb086;box-shadow:0 2px 0 #c8ac82,0 4px 6px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.7)"><span style="width:9px;height:9px;border-radius:50%;background:#ffae5a;box-shadow:0 0 5px #ffae5a"></span>Eyes Closed</button>
					<div style="position:relative;border-radius:5px;overflow:hidden;background:radial-gradient(135% 130% at 50% 32%,#101a16,#070d0a);box-shadow:inset 0 1px 6px rgba(0,0,0,.85),0 1px 0 rgba(255,255,255,.4)">
						<canvas id="nf-cmp" width="150" height="46" style="display:block;width:150px;height:46px"></canvas>
					</div>
				</div>
			</div>

			<div style="flex:1"></div>

			<!-- RATIO READOUT -->
			<div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:4px;padding:7px 15px;border-radius:9px;background:#0a0703;box-shadow:inset 0 2px 8px rgba(0,0,0,.85),0 1px 0 rgba(255,255,255,.4)">
				<span style="font:600 9px 'Saira Condensed';letter-spacing:3px;color:rgba(255,190,110,.65)">ALPHA RATIO · C / O</span>
				<div style="display:flex;align-items:baseline;gap:4px">
					<span style="font:700 30px 'DSEG7','Space Mono',monospace;color:#ffb33a;text-shadow:0 0 9px rgba(255,150,40,.55)" id="nf-ratio">0.00</span>
					<span style="font:400 16px 'Space Mono',monospace;color:rgba(255,190,110,.6)">×</span>
				</div>
			</div>
		</div>

		<!-- STATUS LINE -->
		<div style="flex:none;display:flex;align-items:center;gap:10px;padding:2px 6px 0">
			<span style="width:6px;height:6px;border-radius:50%;background:#c8642a"></span>
			<span style="font:500 10px 'Space Mono',monospace;letter-spacing:.5px;color:#6a6149;text-shadow:0 1px 0 rgba(255,255,255,.5)" id="nf-msg">system ready — port of eeg_process_segment.py · detrend → notch → 1–45 Hz → Welch</span>
			<span style="flex:1"></span>
			<span style="font:500 10px 'Space Mono',monospace;letter-spacing:1px;color:#9a917a">α DISCOVERED BY H. BERGER · 1924</span>
		</div>

		<input id="nf-file" type="file" accept=".json,application/json" onchange={(e) => app?.onFile(e)} style="display:none" />
	</div>
</div>

<style>
	@font-face {
		font-family: 'DSEG7';
		src: url('https://cdn.jsdelivr.net/npm/dseg@0.46.0/fonts/DSEG7-Classic/DSEG7Classic-Bold.woff2') format('woff2');
		font-weight: 700;
		font-display: swap;
	}
	@keyframes -global-nf-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.45;
		}
	}
	@keyframes -global-nf-scan {
		to {
			background-position: 0 6px;
		}
	}
	:global(.nf-btn) {
		transition:
			transform 0.05s ease,
			filter 0.05s ease;
	}
	:global(.nf-btn:active) {
		transform: translateY(2px);
		filter: brightness(0.96);
	}
	:global(::-webkit-scrollbar) {
		width: 8px;
		height: 8px;
	}
	:global(::-webkit-scrollbar-thumb) {
		background: #b3ab95;
		border-radius: 4px;
	}
</style>

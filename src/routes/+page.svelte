<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		NeuroFocus,
		SWEEP_SEC,
		UV_PER_DIV,
		type AdcProfile,
		type ScopeState
	} from '$lib/neurofocus';
	import { RATE_LADDER } from '$lib/ble';
	import { focusFeasibility } from '$lib/focus';
	import { bergerFeasibility, type BergerState } from '$lib/berger';
	import type { V5Status } from '$lib/ble';

	let app: NeuroFocus | undefined;
	let adc = $state<AdcProfile>('v5');
	let rateSel = $state(175);
	let currentTab = $state('monitor');

	let scope = $state<ScopeState>({
		sweepSec: 8,
		uvPerDiv: 'auto',
		effectiveUvPerDiv: 1,
		hold: false,
		secPerDiv: 1
	});
	let berger = $state<BergerState | null>(null);
	let v5Status = $state<V5Status | null>(null);

	const rateNote = (sps: number): string => (focusFeasibility(sps, 60).ok ? '' : ' · no focus');
	const bergerNote = (sps: number): string => (bergerFeasibility(sps).ok ? '' : ' · no alpha test');

	function setAdc(p: AdcProfile): void {
		adc = p;
		app?.setAdcProfile(p);
	}

	function setRate(sps: number): void {
		void app?.deviceSetRate(sps);
	}

	function connectEsp32(): void {
		void app?.connectBLE(adc);
	}

	function onSweep(e: Event): void {
		const v = Number((e.currentTarget as HTMLSelectElement).value);
		app?.setSweep(v as (typeof SWEEP_SEC)[number]);
	}

	function onUvPerDiv(e: Event): void {
		const raw = (e.currentTarget as HTMLSelectElement).value;
		app?.setUvPerDiv(raw === 'auto' ? 'auto' : (Number(raw) as (typeof UV_PER_DIV)[number]));
	}

	const phaseLabel = (b: BergerState): string =>
		b.phase === 'ready'
			? `GET READY · ${b.secondsLeft}s`
			: b.phase === 'open'
				? `EYES OPEN · ${b.secondsLeft}s`
				: b.phase === 'closed'
					? `EYES CLOSED · ${b.secondsLeft}s`
					: b.phase === 'done'
						? 'COMPLETE'
						: b.phase.toUpperCase();

	onMount(() => {
		app = new NeuroFocus({
			onScope: (s) => (scope = s),
			onBerger: (b) => (berger = b),
			onStatus: (s) => (v5Status = s)
		});
		app.setAdcProfile(adc);
		return () => app?.destroy();
	});
</script>

<svelte:head>
	<title>NeuroFocus Web — EEG Diagnostic Workstation</title>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Consolas&display=swap" rel="stylesheet" />
</svelte:head>

<!-- ROOT CONTAINER: height: 100vh and overflow: hidden fixes the infinite scroll issue -->
<div class="h-screen w-full flex flex-col bg-slate-950 text-slate-200 font-['Inter'] overflow-hidden p-3 gap-3">
	
	<!-- TOP BAR -->
	<header class="flex-none bg-slate-900 border border-slate-800 rounded-xl shadow-lg p-3 px-5 flex items-center justify-between z-10">
		<!-- Connection Controls -->
		<div class="flex items-center gap-3">
			<span class="text-xs font-semibold text-cyan-400 tracking-wider">HARDWARE LINK</span>
			
			<div class="flex bg-slate-950 rounded-lg p-1 border border-slate-800">
				<button type="button" class="px-3 py-1 text-xs font-bold rounded-md transition-colors {adc === 'v2' ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}" onclick={() => setAdc('v2')}>ESP32 V2</button>
				<button type="button" class="px-3 py-1 text-xs font-bold rounded-md transition-colors {adc === 'v4' ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}" onclick={() => setAdc('v4')}>ADS1220 V4</button>
				<button type="button" class="px-3 py-1 text-xs font-bold rounded-md transition-colors {adc === 'v5' ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}" onclick={() => setAdc('v5')}>VERTEX V5</button>
			</div>

			<button class="bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold py-1.5 px-4 rounded-lg shadow-md transition-all active:scale-95" onclick={() => connectEsp32()}>
				Scan & Connect
			</button>
			
			<button class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-1.5 px-4 rounded-lg border border-slate-700 transition-all active:scale-95" onclick={() => app?.stopAll()}>
				Stop All
			</button>
			
			<button class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-1.5 px-4 rounded-lg border border-slate-700 transition-all active:scale-95 flex items-center gap-2" onclick={() => app?.startDemo()}>
				<span class="text-emerald-400">●</span> Demo Stream
			</button>
		</div>

		<!-- Telemetry Mini -->
		<div class="flex items-center gap-5 bg-slate-950 px-4 py-1.5 rounded-lg border border-slate-800">
			<div class="flex items-center gap-2">
				<div id="nf-dot" class="w-2.5 h-2.5 rounded-full bg-slate-700 shadow-[0_0_5px_rgba(0,0,0,0.5)]"></div>
				<span id="nf-mode" class="font-['Consolas'] text-xs font-bold text-slate-400 tracking-wide uppercase">IDLE</span>
			</div>
			
			{#if v5Status}
			<div class="h-4 w-px bg-slate-800"></div>
			<div class="flex gap-3 font-['Consolas'] text-xs">
				<div class="flex flex-col items-center leading-none" title="{v5Status.vbat_mv}mV">
					<span class="text-[9px] text-slate-500">BATTERY</span>
					<span class="font-bold {v5Status.vbat_pct < 20 ? 'text-rose-400' : 'text-cyan-400'} mt-0.5 flex items-center gap-1">
						{v5Status.vbat_pct}%
						{#if v5Status.is_charging}<span class="text-[10px]">⚡</span>{/if}
						{#if v5Status.is_full}<span class="text-[10px]">🔋</span>{/if}
					</span>
				</div>
				<div class="flex flex-col items-center leading-none">
					<span class="text-[9px] text-slate-500">RSSI</span>
					<span class="font-bold text-emerald-400 mt-0.5">{v5Status.rssi ?? '--'}</span>
				</div>
				<div class="flex flex-col items-center leading-none">
					<span class="text-[9px] text-slate-500">GYRO</span>
					<span class="font-bold text-slate-300 mt-0.5 text-[10px]">
						{v5Status.gx},{v5Status.gy},{v5Status.gz}
					</span>
				</div>
			</div>
			{/if}

			<div class="h-4 w-px bg-slate-800"></div>
			
			<div class="flex gap-4 font-['Consolas'] text-xs">
				<div class="flex flex-col items-center leading-none">
					<span class="text-[9px] text-slate-500">TARGET</span>
					<span id="nf-fs" class="font-bold text-emerald-400 mt-0.5">000</span>
				</div>
				<div class="flex flex-col items-center leading-none">
					<span class="text-[9px] text-slate-500">LIVE SPS</span>
					<span id="nf-sps" class="font-bold text-emerald-400 mt-0.5">000</span>
				</div>
				<div class="flex flex-col items-center leading-none">
					<span class="text-[9px] text-slate-500">DROP %</span>
					<span id="nf-loss" class="font-bold text-rose-400 mt-0.5">--</span>
				</div>
			</div>
		</div>
	</header>

	<!-- MAIN WORKSPACE -->
	<div class="flex-1 flex flex-col min-h-0">
		<!-- Tabs -->
		<div class="flex gap-1 px-2">
			<button class="px-5 py-2 text-xs font-bold rounded-t-lg transition-colors border border-b-0 {currentTab === 'monitor' ? 'bg-slate-900 border-slate-700 text-cyan-400' : 'bg-slate-950 border-transparent text-slate-500 hover:bg-slate-900'}" onclick={() => currentTab = 'monitor'}>
				Live Monitor & PSD
			</button>
			<button class="px-5 py-2 text-xs font-bold rounded-t-lg transition-colors border border-b-0 {currentTab === 'berger' ? 'bg-slate-900 border-slate-700 text-cyan-400' : 'bg-slate-950 border-transparent text-slate-500 hover:bg-slate-900'}" onclick={() => currentTab = 'berger'}>
				Hans Berger Protocol
			</button>
			<button class="px-5 py-2 text-xs font-bold rounded-t-lg transition-colors border border-b-0 {currentTab === 'telemetry' ? 'bg-slate-900 border-slate-700 text-cyan-400' : 'bg-slate-950 border-transparent text-slate-500 hover:bg-slate-900'}" onclick={() => currentTab = 'telemetry'}>
				Telemetry & DSP Settings
			</button>
		</div>

		<!-- Tab Content Area -->
		<div class="flex-1 bg-slate-900 border border-slate-700 rounded-lg rounded-tl-none p-4 min-h-0 overflow-y-auto shadow-inner relative">
			
			<!-- TAB 1: LIVE MONITOR -->
			<div class="h-full flex-col gap-4 {currentTab === 'monitor' ? 'flex' : 'hidden'}">
				
				<!-- Filters/Controls Bar -->
				<div class="flex items-center gap-4 flex-none bg-slate-950/50 p-2.5 rounded-lg border border-slate-800">
					<span class="text-xs font-bold text-cyan-500">OSCILLOSCOPE CONTROLS</span>
					
					<select class="bg-slate-800 text-slate-200 border border-slate-700 rounded px-2 py-1 text-xs font-['Consolas'] outline-none focus:border-cyan-500" value={scope.sweepSec} onchange={onSweep}>
						{#each SWEEP_SEC as s (s)}
							<option value={s}>{s} s SWEEP</option>
						{/each}
					</select>
					
					<select class="bg-slate-800 text-slate-200 border border-slate-700 rounded px-2 py-1 text-xs font-['Consolas'] outline-none focus:border-cyan-500" value={String(scope.uvPerDiv)} onchange={onUvPerDiv}>
						<option value="auto">AUTO SCALE</option>
						{#each UV_PER_DIV as v (v)}
							<option value={String(v)}>{v} µV/DIV</option>
						{/each}
					</select>

					<button class="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold py-1 px-3 rounded shadow-sm transition-colors active:scale-95" onclick={() => app?.autoset()}>AUTOSET</button>
					<button class="{scope.hold ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'} text-xs font-bold py-1 px-3 rounded shadow-sm transition-colors active:scale-95 w-16 text-center" onclick={() => app?.setHold(!scope.hold)}>{scope.hold ? 'RESUME' : 'HOLD'}</button>

					<div class="flex-1 text-right text-xs font-['Consolas'] text-slate-500">
						<span id="nf-scope-label">
							{scope.secPerDiv < 1 ? `${(scope.secPerDiv * 1000).toFixed(0)} ms` : `${scope.secPerDiv} s`}/div · 
							{scope.effectiveUvPerDiv < 10 ? scope.effectiveUvPerDiv.toFixed(1) : scope.effectiveUvPerDiv.toFixed(0)} µV/div
						</span>
					</div>
				</div>

				<!-- Charts Grid -->
				<!-- Key fix for infinite scroll: min-h-0 allows flex children to shrink instead of exploding -->
				<div class="flex-1 grid grid-cols-2 grid-rows-2 gap-4 min-h-0">
					
					<!-- Chart: Oscillogram -->
					<div class="flex flex-col bg-[#0b0e14] border border-slate-800 rounded-xl overflow-hidden shadow-md min-h-0 relative">
						<div class="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 flex justify-between items-center absolute top-0 w-full z-10 backdrop-blur-sm">
							<span class="text-[10px] font-bold text-emerald-400 tracking-wider">LIVE EEG OSCILLOGRAM (µV)</span>
						</div>
						<div class="flex-1 relative mt-7">
							<canvas id="nf-raw" class="absolute inset-0 w-full h-full block"></canvas>
						</div>
					</div>

					<!-- Chart: Welch PSD -->
					<div class="flex flex-col bg-[#0b0e14] border border-slate-800 rounded-xl overflow-hidden shadow-md min-h-0 relative">
						<div class="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 flex justify-between items-center absolute top-0 w-full z-10 backdrop-blur-sm">
							<span class="text-[10px] font-bold text-amber-400 tracking-wider">POWER SPECTRAL DENSITY (PSD)</span>
							<span class="text-[10px] font-bold text-amber-500">α PEAK: <span id="nf-peak" class="font-['Consolas'] ml-1 bg-slate-950 px-1 rounded text-amber-300">00.0</span> Hz</span>
						</div>
						<div class="flex-1 relative mt-7">
							<canvas id="nf-psd" class="absolute inset-0 w-full h-full block"></canvas>
						</div>
					</div>

					<!-- Chart: Spectrogram Waterfall -->
					<div class="flex flex-col bg-[#0b0e14] border border-slate-800 rounded-xl overflow-hidden shadow-md min-h-0 relative">
						<div class="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 flex justify-between items-center absolute top-0 w-full z-10 backdrop-blur-sm">
							<span class="text-[10px] font-bold text-cyan-400 tracking-wider">SPECTROGRAM (WATERFALL)</span>
						</div>
						<div class="flex-1 relative mt-7">
							<canvas id="nf-spec" class="absolute inset-0 w-full h-full block"></canvas>
						</div>
					</div>

					<!-- Chart: Band Power -->
					<div class="flex flex-col bg-[#0b0e14] border border-slate-800 rounded-xl overflow-hidden shadow-md min-h-0 relative">
						<div class="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 flex justify-between items-center absolute top-0 w-full z-10 backdrop-blur-sm">
							<span class="text-[10px] font-bold text-purple-400 tracking-wider">BAND POWER (δ θ α β γ)</span>
						</div>
						<div class="flex-1 relative mt-7">
							<canvas id="nf-band" class="absolute inset-0 w-full h-full block"></canvas>
						</div>
					</div>
					
				</div>
			</div>

			<!-- TAB 2: BERGER PROTOCOL -->
			<div class="h-full flex-col gap-6 {currentTab === 'berger' ? 'flex' : 'hidden'} p-4">
				<div class="max-w-4xl mx-auto w-full flex gap-8">
					
					<!-- Berger Controls -->
					<div class="flex-1 bg-[#0b0e14] border border-slate-800 rounded-xl p-6 shadow-md flex flex-col">
						<h2 class="text-xl font-bold text-cyan-400 mb-2">Hans Berger Alpha Test</h2>
						<p class="text-sm text-slate-400 mb-8 leading-relaxed">
							Measures occipital Alpha (8-12 Hz) suppression with eyes OPEN versus elevation with eyes CLOSED. 
							Follow the on-screen prompts.
						</p>

						<div class="flex flex-col gap-4 items-center bg-slate-900/50 p-6 rounded-lg border border-slate-800/50 mb-8">
							<div class="text-sm font-bold tracking-widest {berger?.phase === 'closed' ? 'text-amber-500' : berger?.phase === 'open' ? 'text-cyan-400' : 'text-slate-500'}">
								{berger ? phaseLabel(berger) : 'SYSTEM READY'}
							</div>
							
							<div class="flex gap-2">
								{#each Array(berger?.blocks ?? 3) as _, i (i)}
									<div class="w-3 h-3 rounded-full {berger && i < berger.block ? 'bg-emerald-500' : berger && i === berger.block && berger.phase !== 'idle' ? 'bg-amber-400 shadow-[0_0_8px_#fbbf24]' : 'bg-slate-800'}"></div>
								{/each}
							</div>
							
							{#if berger && berger.rejected > 0}
								<span class="text-xs text-rose-400 font-bold mt-2">{berger.rejected} artifacts rejected</span>
							{/if}
						</div>

						<div class="mt-auto flex gap-4">
							{#if !berger || berger.phase === 'idle' || berger.phase === 'done' || berger.phase === 'aborted'}
								<button class="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-3 rounded-lg shadow-lg transition-transform active:scale-95 text-sm tracking-wide" onclick={() => app?.bergerStart()}>
									START BERGER PROTOCOL
								</button>
							{:else}
								<button class="flex-1 bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded-lg shadow-lg transition-transform active:scale-95 text-sm tracking-wide" onclick={() => app?.bergerAbort()}>
									ABORT TEST
								</button>
							{/if}
						</div>
					</div>

					<!-- Berger Results -->
					<div class="w-[340px] flex flex-col gap-6">
						<div class="bg-[#0b0e14] border border-slate-800 rounded-xl p-6 shadow-md flex flex-col items-center justify-center min-h-[200px]">
							<span class="text-[10px] font-bold text-amber-500 tracking-widest mb-4">ALPHA RATIO (CLOSED / OPEN)</span>
							<div class="flex items-baseline gap-2">
								<span id="nf-ratio" class="font-['Consolas'] text-6xl font-bold text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.3)]">—</span>
								<span class="text-2xl text-amber-600/50">×</span>
							</div>
							<span id="nf-verdict" class="text-sm font-bold text-amber-300 mt-4 min-h-[20px] text-center"></span>
						</div>

						<div class="bg-[#0b0e14] border border-slate-800 rounded-xl overflow-hidden shadow-md h-[120px] relative flex flex-col">
							<div class="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 absolute top-0 w-full z-10 text-center backdrop-blur-sm">
								<span class="text-[9px] font-bold text-slate-400 tracking-wider">SPECTRAL OVERLAY</span>
							</div>
							<div class="flex-1 relative mt-7 p-2">
								<canvas id="nf-cmp" class="w-full h-full block"></canvas>
							</div>
						</div>
					</div>

				</div>
			</div>

			<!-- TAB 3: TELEMETRY & SETTINGS -->
			<div class="h-full flex-col gap-6 {currentTab === 'telemetry' ? 'flex' : 'hidden'} p-4">
				<div class="grid grid-cols-2 gap-6 h-full max-w-5xl mx-auto w-full">
					
					<!-- ESP32 Device Commands -->
					<div class="bg-[#0b0e14] border border-slate-800 rounded-xl p-6 flex flex-col gap-6">
						<h2 class="text-lg font-bold text-cyan-400">Hardware Commands</h2>
						
						<div class="grid grid-cols-2 gap-3">
							<button class="bg-slate-800 hover:bg-slate-700 text-emerald-400 text-xs font-bold py-3 rounded-lg border border-slate-700 transition-colors" onclick={() => app?.deviceStart()}>▶ START HW STREAM</button>
							<button class="bg-slate-800 hover:bg-slate-700 text-rose-400 text-xs font-bold py-3 rounded-lg border border-slate-700 transition-colors" onclick={() => app?.deviceStop()}>⏸ STOP HW STREAM</button>
							<button class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-3 rounded-lg border border-slate-700 transition-colors" onclick={() => app?.deviceReset()}>↺ RESET ADS1220</button>
							<button class="bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-bold py-3 rounded-lg border border-slate-700 transition-colors" onclick={() => app?.deviceDiag()}>⚕ DIAGNOSTIC</button>
						</div>

						<div class="mt-4 bg-slate-900 p-4 rounded-lg border border-slate-800/80">
							<label class="block text-[10px] font-bold text-slate-500 mb-2 tracking-widest">SAMPLE RATE (SPS)</label>
							<select class="w-full bg-slate-950 text-slate-200 border border-slate-700 rounded-md px-3 py-2 text-sm font-['Consolas'] outline-none focus:border-cyan-500" bind:value={rateSel} onchange={() => setRate(rateSel)}>
								{#each RATE_LADDER as r (r)}
									<option value={r}>{r} SPS {rateNote(r)} {bergerNote(r)}</option>
								{/each}
							</select>
							<p class="text-xs text-slate-500 mt-3 font-['Inter']">
								Sets the ADS1220 output rate (20..2000 SPS). Higher rates allow wider frequency bands but may incur packet loss over Bluetooth.
							</p>
						</div>

						<div class="mt-auto">
							<input id="nf-file" type="file" accept=".json,application/json" onchange={(e) => app?.onFile(e)} style="display:none" />
							<button class="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-3 rounded-lg border border-slate-700 transition-colors flex items-center justify-center gap-2" onclick={() => (document.getElementById('nf-file') as HTMLInputElement)?.click()}>
								▤ LOAD DATA FILE
							</button>
						</div>
					</div>

					<!-- Log Window & Banner -->
					<div class="flex flex-col gap-4">
						<div id="nf-banner" class="hidden bg-amber-900/30 border border-amber-700 text-amber-400 text-xs font-['Consolas'] p-3 rounded-lg">
							<!-- Banner messages injected here -->
						</div>
						
						<div class="flex-1 bg-[#0b0e14] border border-slate-800 rounded-xl overflow-hidden flex flex-col min-h-[300px]">
							<div class="px-4 py-3 bg-slate-900/80 border-b border-slate-800">
								<span class="text-xs font-bold text-slate-400 tracking-wider">SYSTEM LOGS</span>
							</div>
							<div class="flex-1 p-4 font-['Consolas'] text-xs text-emerald-400/80 overflow-y-auto leading-relaxed">
								<div id="nf-msg" class="break-words">
									System ready. DSP Pipeline: Detrend → Notch → 1–45 Hz → Welch.
								</div>
								<div class="mt-2 text-slate-600">Waiting for hardware connection...</div>
							</div>
						</div>
					</div>

				</div>
			</div>

		</div>
	</div>
</div>

<style>
	/* Any extra global or scoped styles can go here. We've mostly moved to Tailwind. */
	:global(::-webkit-scrollbar) {
		width: 6px;
		height: 6px;
	}
	:global(::-webkit-scrollbar-track) {
		background: #0f172a; 
	}
	:global(::-webkit-scrollbar-thumb) {
		background: #334155; 
		border-radius: 3px;
	}
	:global(::-webkit-scrollbar-thumb:hover) {
		background: #475569; 
	}
</style>

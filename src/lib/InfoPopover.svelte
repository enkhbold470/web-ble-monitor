<script lang="ts">
	import type { Explainer } from './explainers';

	let { explainer, align = 'left' }: { explainer: Explainer; align?: 'left' | 'right' } = $props();

	let open = $state(false);
	let root = $state<HTMLSpanElement | undefined>(undefined);

	// Deterministic id so the trigger can point at its own popover for a11y.
	const panelId = `nf-info-${Math.random().toString(36).slice(2, 9)}`;

	function toggle(): void {
		open = !open;
	}

	// Escape + click-outside close only exist while the popover is open. $effect runs
	// AFTER the opening click has finished propagating, so the click that opened it does
	// not immediately trip the document listener; the teardown removes both listeners.
	$effect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				open = false;
			}
		}
		function onDocClick(e: MouseEvent): void {
			if (root && !root.contains(e.target as Node)) open = false;
		}
		window.addEventListener('keydown', onKey);
		document.addEventListener('click', onDocClick);
		return () => {
			window.removeEventListener('keydown', onKey);
			document.removeEventListener('click', onDocClick);
		};
	});
</script>

<span bind:this={root} style="position:relative;display:inline-flex;vertical-align:middle">
	<button
		type="button"
		aria-label={`About ${explainer.title}`}
		aria-expanded={open}
		aria-controls={panelId}
		onclick={toggle}
		style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border-radius:50%;cursor:pointer;font:600 9px 'Saira Condensed',sans-serif;line-height:1;color:rgba(255,200,140,{open
			? '0.95'
			: '0.62'});background:{open
			? 'rgba(255,180,90,.16)'
			: 'rgba(0,0,0,.28)'};border:1px solid rgba(255,190,110,.32);box-shadow:inset 0 1px 1px rgba(0,0,0,.55),0 1px 0 rgba(255,255,255,.10);transition:color .08s ease,background .08s ease"
	>
		<span aria-hidden="true" style="font-style:italic;transform:translateY(-.5px)">i</span>
	</button>

	{#if open}
		<div
			id={panelId}
			role="dialog"
			aria-label={explainer.title}
			style="position:absolute;top:calc(100% + 6px);{align === 'right'
				? 'right:0'
				: 'left:0'};z-index:1000;max-width:320px;width:max-content;min-width:238px;padding:11px 13px 12px;border-radius:8px;text-align:left;cursor:default;background:linear-gradient(162deg,#191712,#221d15);border:1px solid #4a4231;box-shadow:0 14px 34px -12px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.06)"
		>
			<div
				style="font:600 9px 'Saira Condensed',sans-serif;letter-spacing:3px;color:rgba(255,190,110,.82);padding-bottom:7px;margin-bottom:8px;border-bottom:1px solid rgba(255,190,110,.16)"
			>
				{explainer.title}
			</div>

			{#each explainer.body as para (para)}
				<p
					style="margin:0 0 7px;font:400 11px 'Space Mono',monospace;line-height:1.5;color:rgba(232,222,200,.9)"
				>
					{para}
				</p>
			{/each}

			<div
				style="margin-top:9px;padding:8px 9px 8px 10px;border-left:2px solid rgba(200,100,42,.7);border-radius:0 5px 5px 0;background:rgba(200,100,42,.08)"
			>
				<div
					style="font:600 8px 'Saira Condensed',sans-serif;letter-spacing:2.5px;color:rgba(230,150,90,.9);margin-bottom:6px"
				>
					WHAT THIS DOES NOT TELL YOU
				</div>
				<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px">
					{#each explainer.caveats as caveat (caveat)}
						<li
							style="position:relative;padding-left:12px;font:400 10px 'Space Mono',monospace;line-height:1.45;color:rgba(226,196,168,.88)"
						>
							<span
								aria-hidden="true"
								style="position:absolute;left:0;top:0;color:rgba(200,100,42,.85)">›</span
							>{caveat}
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}
</span>

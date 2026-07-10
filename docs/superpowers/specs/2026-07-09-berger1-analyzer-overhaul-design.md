# BERGER·1 analyzer overhaul — design

Date: 2026-07-09
Branch: `feat/analyzer-truthfulness`

## Why

Two classes of problem, both of which make the instrument lie:

1. **Dead and misleading readouts.** `OVF` is rendered but never assigned. `ALPHA RATIO · C/O`
   shows a hardcoded `0.00` that means "you haven't captured both epochs yet" and says so
   nowhere. `unit` is write-only state. The spectrogram FFT size is pinned at 256 across a
   20–2000 SPS ladder. A live rate change re-tunes `fs` without flushing the DSP buffers.

2. **The focus score can be computed where it is not defensible.** The sample-rate selector
   offers 20/45/90 SPS. At those rates `β/(α+θ)` is either unrepresentable or contaminated:

   | fs (SPS) | Nyquist | passband top (`0.49·fs`) | β 13–30 Hz | 60 Hz mains | verdict |
   |---|---|---|---|---|---|
   | 20 | 10.0 | 9.8 | absent | folds to DC (on-chip FIR active) | β not measurable |
   | 45 | 22.5 | 22.1 | truncated | **folds to 15 Hz — mid-β** | contaminated |
   | 90 | 45.0 | 44.1 | present | **folds to 30 Hz — top of β** | contaminated |
   | 175 | 87.5 | 85.8 | present | 60 Hz notchable | **safe** |
   | 330+ | ≥165 | ≥45 | present | 60 Hz + harmonics notchable | safe |

   The ADS1220's on-chip 50/60 Hz FIR is only specified at 20 SPS — the firmware says so at
   `ads1220_driver.cpp:760`. So at 45 and 90 SPS mains hum lands inside beta, which is the
   **numerator** of the focus score, with no rejection anywhere in the chain. Mains hum reads
   as concentration.

Correction to an earlier claim: the mains notch **already** defaults to 60 Hz
(`adc.ts:24`, `focus.ts:142`, `demo/+page.svelte:39`). Nothing to change; it is merely never
displayed, so it cannot be confirmed by looking. We surface it.

## Locked facts this must not violate

From the workspace `CLAUDE.md`: the metric is Pope et al. (1995) `β/(α+θ)` (PMID 7647180),
never `θ/β`; the sensor is a single **around-ear** dry channel, never "Fp1"/"frontal"; beta
overlaps jaw/temporalis/neck EMG so a clench reads as focus; `calibrating` and `signalOk`
exist so the UI can refuse to show a number it has not earned; association, never causation;
true claims only.

## Scope

Seven changes, in dependency order. Each is independently testable.

### 1. Focus feasibility gate (`focus.ts`)

New pure export, used by every consumer:

```ts
export function aliasOf(f: number, fs: number): number;         // fold f into [0, fs/2]
export function focusFeasibility(fs: number, line = 60): { ok: boolean; reason: string | null };
```

Rule — both conditions must hold, and on this ladder both reduce to **fs ≥ 175**:

- **β inside the passband:** `0.49 · fs ≥ 30`
- **mains notchable:** `line < 0.49 · fs`

`FocusMetrics` gains `fsOk: boolean` and `fsReason: string | null`. When `!fsOk` the engine
does **not** accumulate a calibration baseline and reports `focus: 0` alongside `fsOk: false`.
Consumers render the reason, not the number — the same contract as `calibrating`/`signalOk`.

`0.49` is not arbitrary: it is exactly the clamp `dsp.makeChain` already applies to the
analysis low-pass (`dsp.ts:117`), so the gate matches the filter that actually runs.

The 20/45/90 rungs stay in the selector for raw-signal debugging and firmware bring-up. They
are marked in the `<option>` text and the focus readout explains itself.

### 2. Oscilloscope controls for `EEG ACTIVITY` (`scope.ts`, new)

Today `drawRaw` plots a fixed 4 s window with **one `lineTo` vertex per sample** and a
**per-frame peak auto-gain**. At 2000 SPS that is ~8000 vertices overplotted into ~560 px,
and the gain always stretches the largest sample to ~87 % of half-height — so in-band noise
always fills the screen no matter how quiet the signal truly is. That is the whole complaint.

New pure module:

```ts
export const SWEEP_SEC = [1, 2, 4, 8, 10] as const;
export const UV_PER_DIV = [2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
export const V_DIVS = 4;  // grid rows; trace spans ±2 divisions from centre

export interface Column { min: number; max: number }
export function minMaxDecimate(data: ArrayLike<number>, cols: number): Column[];
export function percentileAbs(data: ArrayLike<number>, p: number): number;
export function autosetUvPerDiv(data: ArrayLike<number>): number;
```

- **min/max decimation** — each pixel column draws the `[min, max]` of the samples that land
  in it. Transients survive; overplot dies. When `n < cols` it degrades to one column per
  sample and the renderer draws a polyline instead.
- **Horizontal** — `SWEEP` select (1/2/4/8/10 s). `filt` already holds `fs·12 s`, so no new
  buffering. Grid is 8 columns, so the header prints `sweep/8` s/div.
- **Vertical** — `µV/DIV` select with an `AUTO` entry. `AUTO` keeps auto-ranging but with a
  fast-attack / slow-release envelope instead of the instantaneous per-frame peak, so one
  spike no longer collapses the trace. Fixed rungs map `py = h/2 − v/(uvPerDiv·2) · (h/2)`.
- **AUTOSET** — one shot: `autosetUvPerDiv` takes the 99.5th percentile of `|v|` (robust to a
  single spike), picks the smallest rung that fits it within ±2 divisions, and resets sweep
  to 4 s.
- **RUN/HOLD** — freezes the trace against a snapshot buffer for inspection.

Header becomes `EEG ACTIVITY · CH1 · BAND-PASS 1–45 Hz · NOTCH 60 Hz`, and the static
`4 s SWEEP` label becomes live: `0.5 s/div · 20 µV/div`.

### 3. Guided Berger test (`berger.ts`, new)

Replaces the two snapshot buttons. `capture()` today grabs the trailing 10 s the instant you
click, with no timing cue, no artifact rejection, and no averaging — one blink dominates.

A sample-clocked state machine (deterministic; no wall clock, so it is unit-testable):

```
ready 3 s → [ OPEN 20 s → CLOSED 20 s ] × 3 → done
```

- First **2 s of every epoch is discarded** (transition, eye movement, settling).
- The remainder is chopped into **2 s sub-epochs**. A sub-epoch is rejected if peak-to-peak
  exceeds `artifactUv` (default 150 µV) or RMS falls below the 1.5 µV biosignal floor.
- Epoch alpha power = mean of accepted sub-epoch alpha (8–13 Hz) powers. An epoch with fewer
  than half its sub-epochs accepted is invalid.
- Per-block ratio `r_i = closed_i / open_i`. Result ratio is the **median** of valid blocks.

**Verdict is by consistency, not by a magic constant.** An around-ear electrode sits far from
the occipital alpha generator, so the textbook 2–5× occipital ratio does not apply and
hard-coding 1.5 would be inventing a threshold:

- `inconclusive` — fewer than ⌈blocks/2⌉ valid blocks
- `pass` — every valid block > 1.0 **and** median ≥ 1.2
- `weak` — median > 1.0 but not consistent across blocks
- `fail` — median ≤ 1.0

Berger has its own feasibility rule (alpha only needs 13 Hz, not 30): `0.49·fs ≥ 13`, i.e.
fs ≥ 45 — so the alpha test is valid on rungs where the *focus score* is not. Mains folds to
15 Hz at 45 SPS, which is outside the 8–13 Hz alpha band, so alpha is unaffected there.

UI: START/ABORT, a phase chip with countdown (`EYES CLOSED — 14 s`), three block dots, a
rejected-epoch counter, a WebAudio beep at each transition (never a modal dialog), the
existing open-vs-closed PSD compare canvas fed from the averaged epochs, and a verdict chip.
`nf-ratio` initialises to `—`, not `0.00`.

### 4. Explainer popovers (`explainers.ts` + `InfoPopover.svelte`, new)

An ⓘ affordance in each panel header opens a popover. Content is honest and derived from the
code that actually runs:

- **Welch PSD** — it is genuinely live (~2 updates/s) but each estimate is a **10 s trailing
  average** of 75 %-overlapped Hann segments, so a state change takes up to ~10 s to fully
  appear. Internally µV²/Hz with correct SciPy-style density scaling (`dsp.ts:216,228-231`),
  but the drawn vertical axis is auto-ranged and unlabelled — it reads **shape, not absolute
  power**. Header gains `· 10 s TRAILING`; the y-axis gains a `rel. dB` label.
- **Band power** — per-band meaning and the mandatory caveat for each. Delta on a dry
  electrode is mostly motion/sweat/drift, not brain. Beta carries the EMG clench caveat.
  Gamma on one dry channel is essentially muscle and mains residue.
- **Spectrogram** — X is time (newest at the right, ~65 s shown), Y is 0 Hz at the bottom to
  `min(45, 0.49·fs)` at the top, colour is dB with contrast **auto-scaled to the visible
  window**, so brightness is relative. Look for a steady ~10 Hz line brightening on eye
  closure; vertical streaks are blinks; a bright floor is drift.
- **Scope** and **Berger test** get one too.

Popover closes on Escape and click-outside. No `alert()`/`confirm()` anywhere.

### 5. Delete NeuroSky and the Emotiv stub

`thinkgear.ts` (93) + `thinkgear.test.ts` (67) deleted outright. From `neurofocus.ts`: the
import, the `nsPort`/`nsReader`/`nsAbort`/`NS_BAUD`/`NEUROSKY_UV` fields, `connectNeuroSky`,
`neuroSkyOpenFailed`, `readMindWave`, `connectEmotiv`, and the NeuroSky teardown inside
`stopAll`. From `+page.svelte`: both source buttons and the help text. `SIGNAL SOURCE` reduces
to **Test / File / ESP32 / Stop** — what actually works.

The historical spec `2026-06-26-neurosky-emotiv-sources-design.md` is **kept** and marked
superseded; it records why the dead ends were dead ends. The web repo's `CLAUDE.md` loses its
NeuroSky section; the workspace `CLAUDE.md` keeps its "do not retry the dead ends" note with a
line saying the web client no longer ships a NeuroSky source.

### 6. Dead-code repairs (`neurofocus.ts`)

- `ovf` — **wire it**: `if (this.link) this.ovf = this.link.stats.dropped;` in the 500 ms
  cadence block. `/demo` already proves the value is available and meaningful. Zeroed on
  `reset()`/`stopAll()`.
- `unit` — **delete** the field and its four writes; it is never read.
- `setFs()` — call `reset()` when `fs` actually changes, so a live `~` rate change cannot mix
  old-rate samples into the new Welch window. `setAdcProfile()` resets too, since the counts→µV
  scale changed under the buffer.
- `nfftSpec` — derive from `fs`: `clamp(nextPow2(fs), 128, 1024)` (≈1 s of samples), recomputed
  in `setFs`. `drawSpec` clamps `fmax` to `min(45, 0.49·fs)` and only labels ticks below it.

### 7. `/ez` follows the device rate

`/ez` builds `FocusEngine` once at `FS = V4_SAMPLE_RATE` (175) and never passes `onInfo`, so a
board at any other rate silently mis-scales every frequency. Mirror `/demo`: pass `onInfo` and
rebuild the engine at the reported `sps` (`FocusEngine.fs` is readonly by design).

## Architecture

Three new pure modules with no DOM and no I/O, each independently testable:

```
scope.ts       minMaxDecimate / autosetUvPerDiv        ← drawRaw consumes
berger.ts      BergerProtocol state machine            ← neurofocus.ts drives, +page renders
explainers.ts  copy only                               ← InfoPopover.svelte renders
focus.ts       + focusFeasibility / aliasOf            ← demo, ez, neurofocus gate on it
```

`neurofocus.ts` stays the DOM-owning controller. Nothing new goes into it that can live in a
pure module — it is already the largest file and the drawing methods are mechanical.

## Testing

- `focus.test.ts` — feasibility table across the full 20–2000 ladder for `line` ∈ {50, 60};
  `aliasOf` folding; engine reports `fsOk: false` and refuses to calibrate at 45/90 SPS.
- `scope.test.ts` — `minMaxDecimate` preserves extrema and column count, degrades correctly
  when `n < cols`; `percentileAbs` ignores a lone spike; `autosetUvPerDiv` picks the smallest
  fitting rung.
- `berger.test.ts` — phase transitions at exact sample boundaries; settle samples discarded;
  artifact rejection by p2p and by RMS floor; median-of-blocks ratio; each verdict branch;
  `abort()` from every phase; feasibility below 45 SPS.
- Existing `dsp.test.ts` / `ble.test.ts` / `analysis.test.ts` / `game.test.ts` must stay green.
- `thinkgear.test.ts` deleted with its module.
- Headless Playwright: load `/`, assert no console errors, drive the sweep/µV selects and
  AUTOSET, confirm `#nf-fs` / `#nf-sps` / `#nf-ratio` and that the scope header text updates.

## Verification

`bunx vitest run` + `bunx svelte-check` + `bun run build`, then the Playwright pass. Pre-existing
eslint ternary-as-statement errors in the canvas drawing code are left alone per `CLAUDE.md`.

## Out of scope

Firmware changes. The `/demo` route's game and session report. The `neurofocus-finc` landing
page. Multi-channel support. Any change to the Pope index itself.

# CLAUDE.md

Guidance for working in this repo.

## What this is

**BERGER·1** — a single-page, browser-based EEG analyzer (Welch PSD, spectrogram,
band powers, eyes-open/closed alpha "Berger effect" test). SvelteKit + Svelte 5,
TypeScript, Bun, deployed on Cloudflare (`@sveltejs/adapter-cloudflare`). All DSP
runs client-side, dependency-free.

## Commands

```bash
bun run dev        # vite dev server
bun run build      # production build (also cf:build)
bun run check      # svelte-check (type check)
bun run test:unit  # vitest (unit)
bun run lint       # prettier --check + eslint
bun run format     # prettier --write
bunx vitest run    # run unit tests once
```

Deploy: `bun run cf:deploy` (wrangler). Node/Playwright e2e: `bun run test:e2e`.

## Architecture

One ingest path feeds every source into shared DSP, then a rAF loop draws.

- **`src/lib/dsp.ts`** — dependency-free DSP: biquad band-pass + mains notch,
  radix-2 FFT, `welch()` PSD, `bandPowers()`, `stftColumn()`, `peakFreq()`,
  ASCII frame/capture parsers, synthetic signal generator. Mirrors the Python
  `eeg_process_segment.py` pipeline. Unit-tested in `dsp.test.ts`.
- **`src/lib/ble.ts`** — the ESP32 link: GATT contract, `decodeFrame()` (all three
  firmware wire formats), `parseDiag()`, and `NeuroLink` (retrying connect,
  auto-reconnect, serialised GATT ops, drop accounting). Unit-tested in `ble.test.ts`.
  **Read the firmware v4 section below before touching it.**
- **`src/lib/adc.ts`** — `ADC_PROFILES`: counts→µV per board revision (v2 12-bit
  unipolar ESP32-C3 SAR; v4 24-bit bipolar ADS1220 behind an AD8422 ×100).
- **`src/lib/focus.ts`** — `FocusEngine`. The score is the **Pope et al. (1995) engagement
  index, `beta/(alpha+theta)`** (PMID 7647180) — the ratio neurofocus.dev is built on. It is
  an unbounded ratio, so it is mapped to 0–100 by a logistic in log-ratio against a
  **per-user baseline** measured over the first 20 s and then **frozen** (a rolling baseline
  would drag the score back to 50 forever). 50 == your own baseline; the number is not
  comparable between people. Two chains run over the same samples: 1–45 Hz for rhythms,
  0.5–6 Hz for blinks. Also exports **`focusFeasibility(fs, line)`** — see the sample-rate
  section below; the engine refuses to calibrate or score when it returns `ok: false`.
  Unit-tested in `focus.test.ts`.
- **`src/lib/scope.ts`** — pure scope math: `minMaxDecimate` (one `[min,max]` per pixel
  column, so a 2000 SPS trace stays readable instead of overplotting 8000 vertices),
  `autosetUvPerDiv`, `autoEnvelope`. Unit-tested in `scope.test.ts`.
- **`src/lib/berger.ts`** — `BergerProtocol`: the guided eyes-open/closed alpha test.
  Sample-clocked (never a wall clock, so it is deterministic and testable). 3 blocks ×
  20 s open / 20 s closed, first 2 s of each epoch discarded, 2 s sub-epochs rejected on
  peak-to-peak or RMS-floor artifact, alpha averaged per condition. Verdict is by
  **cross-block consistency**, not a hardcoded ratio — an around-ear electrode is far from
  the occipital alpha generator, so the textbook 2–5× does not apply. Unit-tested.
- **`src/lib/explainers.ts` + `InfoPopover.svelte`** — the ⓘ popovers on each panel. Copy
  is a scientific claim: keep it true, keep the caveats.
- **`src/lib/game.ts`** — DASH: a deterministic Geometry-Dash-style runner (seeded level,
  fixed 1/120 s timestep). Pure and testable; never driven off a raw rAF delta.
- **`src/lib/analysis.ts`** — post-session stats, including the headline "did focus sag
  before your deaths?" test. Read its header before touching it: the guards there are the
  whole point.
- **`src/lib/neurofocus.ts`** — `NeuroFocus` class: owns all UI canvases/readouts
  (by DOM id), the ingest pipeline (`ingest()` → `this.filt` → `welch`), every
  signal source, and the eyes-open/closed compare. Largest file; drawing methods
  are mechanical.
- **`src/routes/+page.svelte`** — the whole BERGER·1 UI (skeuomorphic panel, heavy
  inline styles + a few `nf-*` CSS classes). Mounts `NeuroFocus`.
- **`src/routes/demo/+page.svelte`** — `/demo`: the product demo for *"catch tilt before it
  costs you the round"*. DASH on the left, played with SPACE; the passive focus monitor and
  every device command on the right; a session report at the end. **Focus never controls the
  game** — that is the point, and it is what makes the post-session analysis meaningful.
  **Practice mode** synthesises EEG through the identical DSP path so the demo works with no
  hardware; its focus stream is causally blind to deaths and is labelled synthetic.
- **`src/routes/ez/+page.svelte`** — `/ez`: plain-language blink + focus/calm view.

### Signal sources (all funnel into `ingest()`)
- **Test** — synthetic 10 Hz alpha demo (in-app, no hardware). Runs on mount at 600 Hz.
- **File** — load a capture JSON.
- **ESP32 BLE** (`connectBLE(version)`) — firmware v4 (or v2) over Web Bluetooth/GATT.
  `version` picks BOTH the sample rate and the ADC profile; they must match the board.

NeuroSky and the Emotiv stub were **removed on 2026-07-09** (`thinkgear.ts`,
`connectNeuroSky`, `connectEmotiv`, ~300 lines). The historical design record is in
`docs/superpowers/specs/2026-06-26-neurosky-emotiv-sources-design.md`; the working parser
is in git history. Don't re-add them without a reason — the dead ends are documented in the
workspace `CLAUDE.md`.

## What the focus number is worth (do not oversell it)

One ear/forehead-referenced channel. Beta (13–30 Hz) overlaps jaw, temporalis and neck EMG,
so **clenching your teeth raises "focus" exactly like concentrating does** and a single
channel cannot separate them. The score is within-session and within-user only.

- `calibrating` and `signalOk` exist so the UI can refuse to show a number it has not earned.
  Honour them. A detached electrode collapses alpha+theta to the noise floor, `E` explodes,
  and an ungated score would read as flawless concentration.
- `analysis.ts` prints associations, never causation. A hard section of the level lowers
  measured focus *and* kills you, so difficulty is a confound. Deaths also cluster, which is
  why pre-death windows overlapping another death are discarded rather than analysed.

## ESP32 firmware v4 — the hard-won truth (read before touching `ble.ts`)

Source of truth is `../neurofocus/firmware/v4/src/` — derive from it, never guess.

- **GATT** (`ble_manager.h`): service `0338ff7c-…`, data char `ad615f2b-…` (READ+NOTIFY),
  command char `b5e3d1c9-…` (WRITE + WRITE_NR + **NOTIFY**). Device name `NEUROFOCUS_V4_*`.
- **The command char notifies too.** DIAG replies come back on it, not on the data stream.
  Subscribe to both or `d` will silently time out.
- **Commands** (`config.h`): `b` start, `s` stop, `v` reset, `d` diagnostic. The firmware
  auto-starts streaming on BLE connect. `v` re-inits the ADS1220 and leaves streaming
  **OFF** — re-send `b`. `d` pauses the stream ~1.5 s.
- **Wire format is compile-time** (`BLE_DATA_MODE`), so `decodeFrame()` detects rather
  than assumes. v4 defaults to `BINARY_BATCH`: `[0xE7 0x1E][seq u16 LE][n u8][n×i32 LE]`.
  The other two are ASCII (`#<startIdx>,<overflow> <int>…`, or one int per notify).
  ASCII payloads are 7-bit, so `0xE7` can never start one — the sniff is unambiguous.
  **Decoding a binary frame as ASCII yields zero samples**, which is what "connects but
  no data" looks like.
- **Ask the board for its sample rate; don't hard-code one — and it CHANGES at runtime.** The
  firmware's ADS1220 rate is runtime-selectable (the `~<0-7>` command, ladder
  20/45/90/175/330/600/1000/2000 SPS = `RATE_LADDER` in `ble.ts`). `NeuroLink.setSampleRate(sps)`
  snaps to the nearest rung and writes `~<idx>`; the board re-emits `INFO` on **every** change, and
  `NeuroLink` fires `opts.onInfo` — which `neurofocus.ts connectBLE` wires to `setFs(info.sps)`, so
  the whole DSP chain (Welch window, spectrogram, filter chain) re-tunes live. Firmware ≥ v4.1 also
  answers `i` on connect (`link.deviceInfo`); `V4_SAMPLE_RATE` (175) is only the pre-v4.1 fallback.
  A wrong fs slides every frequency by the same ratio — the old hard-coded 600 rendered real 10 Hz
  alpha at ~34 Hz. Never use the *measured* rate either: BLE drops make it sag and compress the axis.
  The `+page.svelte` DEVICE panel has a SAMPLE RATE `<select>` bound to `deviceSetRate`. Note the
  batch size in `INFO` (`batch=`) now scales with the rate (6 at 175, up to 64 at 2000 SPS).
- **Scaling**: 24-bit bipolar, VREF 3.3 V, PGA 1, AFE (`U12` = AD8422) ×100 → one count is
  ≈ 393.2 nV at the ADC, ≈ 3.93 nV at the electrode. Note the firmware's own `AFE_GAIN` is
  `1.0`, so **DIAG's µV are ADC-referred — ~100× the electrode-referred µV the web app
  shows.** The `/demo` DIAG panel says so explicitly; keep that caveat.
- **`GATT Server is disconnected. Cannot retrieve services.`** — thrown by Chrome at
  `getPrimaryService()`. `gatt.connect()` resolves before the link has settled, and the
  ESP32 (Bluedroid) accepts **one central at a time**. Three things fix it, all in
  `NeuroLink`: (1) retry the whole connect→settle→discover handshake, re-checking
  `gatt.connected`; (2) if the device is already connected, `disconnect()` first and wait;
  (3) **disconnect on `pagehide`** — a tab that reloads without releasing GATT leaves the
  board believing it still has a central, and the next connect fails exactly this way.
- Web Bluetooth permits **one GATT operation in flight**; `NeuroLink` serialises them
  through a promise chain. Overlapping writes throw "GATT operation already in progress".
- A too-small ATT MTU silently truncates a 37-byte frame. `decodeFrame()` trusts the byte
  count over the declared `n` and flags `truncated`; the `/demo` chips surface it.

## Sample rate and mains — where the focus score is and isn't defensible

The mains notch **already defaults to 60 Hz** everywhere (`adc.ts` `line: 60`, `focus.ts`
`line ?? 60`, `/demo` `DEFAULT_MAINS = 60`). North America. Do not "fix" it to 50.

The firmware's runtime rate ladder is `20/45/90/175/330/600/1000/2000` SPS, and the focus
score is **not** computable on the bottom three. `focusFeasibility(fs, line)` encodes both
reasons; the engine returns `fsOk: false` + `fsReason` and refuses to freeze a baseline:

| fs | passband top (`0.49·fs`) | β 13–30 Hz | 60 Hz mains | focus |
|---|---|---|---|---|
| 20 | 9.8 | absent | folds to DC (on-chip FIR active here) | ✗ |
| 45 | 22.1 | truncated | **folds to 15 Hz — mid-β** | ✗ |
| 90 | 44.1 | present | **folds to 30 Hz — top of β** | ✗ |
| 175+ | ≥85.8 | present | notchable | ✓ |

The ADS1220's on-chip 50/60 Hz FIR is only specified at 20 SPS (see the firmware's
`ads1220_driver.cpp`), and the digital notch can only be placed below the passband edge — so
at 45/90 SPS mains hum lands inside beta, the **numerator** of the score, with nothing
removing it. Hum reads as concentration. `175` is both the lowest defensible rung and the v4
boot default.

The **alpha test** is a separate gate: alpha only reaches 13 Hz, so `bergerFeasibility(fs)`
passes from **45 SPS** up (at 45 SPS mains folds to 15 Hz, outside the 8–13 Hz alpha band).

`fsOk` is a third display gate alongside `signalOk` and `calibrating`. Honour all three.

## Conventions / gotchas

- **Verify before claiming done**: `bunx vitest run` + `bunx svelte-check` + build.
  For UI/streaming, drive it headless with the installed `playwright` package
  (place the script inside the repo so `node_modules` resolves) — load the page,
  check `#nf-sps` / `#nf-peak` / `#nf-ratio`, assert no console errors.
- Pre-existing eslint errors exist in the canvas drawing code (ternary-as-statement
  in `drawRaw`/`drawPsd`/`drawCmp`) — not introduced by recent work; leave them.
- Specs live in `docs/superpowers/specs/`.

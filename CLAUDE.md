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
- **`src/lib/thinkgear.ts`** — `ThinkGearParser`: streaming NeuroSky TGAM byte
  parser (sync `0xAA 0xAA`, checksum, `0x80` raw / `0x02/0x04/0x05` eSense).
  Tolerates split chunks, garbage, bad checksums. Unit-tested in `thinkgear.test.ts`.
- **`src/lib/neurofocus.ts`** — `NeuroFocus` class: owns all UI canvases/readouts
  (by DOM id), the ingest pipeline (`ingest()` → `this.filt` → `welch`), every
  signal source, and the eyes-open/closed compare. Largest file; drawing methods
  are mechanical.
- **`src/routes/+page.svelte`** — the whole UI (skeuomorphic BERGER·1 panel,
  heavy inline styles + a few `nf-*` CSS classes). Mounts `NeuroFocus`.

### Signal sources (all funnel into `ingest()`)
- **Test** — synthetic 10 Hz alpha demo (in-app, no hardware). Runs on mount.
- **File** — load a capture JSON.
- **ESP32 BLE** (`connectBLE`) — custom firmware over Web Bluetooth/GATT,
  ASCII-integer frames. Service `0338ff7c-…`.
- **NeuroSky** (`connectNeuroSky`) — see below.
- **Emotiv** — stub ("coming soon"; raw EEG needs the paid Cortex API).

## NeuroSky — the hard-won truth (read before touching it)

The path went through several dead ends; the **current, correct** design is
**in-browser Web Serial**, no extra apps:

- The MindWave streams raw `0x80` EEG continuously over its **Bluetooth-serial
  (RFCOMM/SPP)** link with **no enable command** — confirmed via brainbang/mindwave,
  pymindwave2, and the NF-ios project. `connectNeuroSky()` opens the serial port
  with `navigator.serial` at **57600 baud** and parses with `ThinkGearParser`
  in-browser. Raw = **512 Hz**, scale **0.51 µV/unit**.
- **Dead ends (do NOT retry):** pure Web Bluetooth GATT raw is not possible on
  MWM2 (raw enable handshake is locked in NeuroSky's compiled SDK; `0x02`-over-GATT
  is "empirically insufficient" per NF-ios). ThinkGear Connector + a WebSocket
  bridge worked but the user rejected TGC as annoying — removed.
- **macOS gotchas (this is what usually breaks live use):**
  - Needs the one-time official NeuroSky driver so `/dev/cu.MindWaveMobile-*` appears.
  - A serial port is **single-owner**: if another browser/tab holds it (e.g. Dia),
    `open()` fails with "Failed to open serial port" / "Resource busy". Use one
    browser; `connectNeuroSky()` releases any port it holds before reopening, and
    `stopAll()` closes it.
  - The port only opens while the headset is **actively connected** (solid LED,
    macOS Bluetooth "Connected") — paired-but-disconnected fails. `open()` is
    retried 4× to wake the RFCOMM link.
  - Diagnose with `lsof /dev/cu.MindWaveMobile` (who holds it) and a native
    `cat /dev/cu.MindWaveMobile` read to confirm the headset streams `0xAA` packets.

Reference project with the working native/SDK paths: `/Users/inky/Desktop/NF-ios`.

## Conventions / gotchas

- **Verify before claiming done**: `bunx vitest run` + `bunx svelte-check` + build.
  For UI/streaming, drive it headless with the installed `playwright` package
  (place the script inside the repo so `node_modules` resolves) — load the page,
  check `#nf-sps` / `#nf-peak` / `#nf-ratio`, assert no console errors.
- Pre-existing eslint errors exist in the canvas drawing code (ternary-as-statement
  in `drawRaw`/`drawPsd`/`drawCmp`) — not introduced by recent work; leave them.
- Specs live in `docs/superpowers/specs/`.

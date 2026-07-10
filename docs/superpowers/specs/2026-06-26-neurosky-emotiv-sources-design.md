# NeuroSky + Emotiv source support

**Date:** 2026-06-26
**Status:** SUPERSEDED — implemented, then removed from the web client on 2026-07-09.

> Both sources were deleted (`thinkgear.ts`, `connectNeuroSky`, `connectEmotiv`, ~300 lines):
> the ESP32 board is the only hardware BERGER·1 targets, and the Emotiv stub never worked
> (raw EEG needs the paid Cortex API). This document is kept because it records **why the
> dead ends were dead ends** — read it before anyone proposes re-adding NeuroSky. The working
> `ThinkGearParser` is recoverable from git history.
>
> See `docs/superpowers/specs/2026-07-09-berger1-analyzer-overhaul-design.md`, section 5.

## Goal

Let BERGER·1 acquire EEG from consumer headsets in addition to the existing
custom-firmware BLE device, and keep the manual eyes-open / eyes-closed alpha
test working with every source.

## Connectivity reality (why each source differs)

- **Custom firmware (existing):** Web Bluetooth / GATT, ASCII-integer frames. Unchanged.
- **NeuroSky MindWave:** **in-browser Web Serial** — no ThinkGear Connector, no
  bridge, no extra process. Raw `0x80` EEG streams automatically over the headset's
  Bluetooth-serial link with no enable command (confirmed via brainbang/mindwave,
  pymindwave2 + web research), so the browser opens the MindWave serial port
  (`/dev/cu.MindWaveMobile-*`, 57600 baud) directly and parses ThinkGear in-browser.
  Needs the one-time official NeuroSky driver so the port appears. Raw 512 Hz,
  scale 0.51 µV/unit. Pure Web Bluetooth GATT raw is NOT possible.
- **Emotiv (EPOC/Insight):** raw EEG is AES-encrypted; only obtainable via the
  paid **Cortex API** (local WebSocket). Out of scope for now → "coming soon" stub.

The DSP pipeline (`welch`, `bandPowers`, eyes-open/closed compare) is
source-agnostic: everything flows through `ingest()` → `this.filt`. So this work
adds **input adapters only**, no DSP or test-flow changes.

## Components

### 1. `src/lib/thinkgear.ts` (new, pure, unit-tested)
Streaming ThinkGear/TGAM packet parser. Stateful across byte chunks.
- Framing: `0xAA 0xAA` sync, payload length, payload, checksum (validated).
- Payload codes consumed:
  - `0x80` raw EEG — 16-bit big-endian signed, 512 Hz → emitted as samples.
  - `0x02` poor-signal (0 good … 200 no-contact), `0x04` attention, `0x05` meditation → status.
- API: `push(bytes: Uint8Array): { raw: number[]; poorSignal?: number; attention?: number; meditation?: number }`.
- Invalid checksums / partial packets are buffered, not thrown.

### 2. `neurofocus.ts` — adapter methods
- `connectNeuroSky()`: `navigator.serial.requestPort()` → `open({baudRate:57600})`
  → async read loop feeds bytes to the in-browser `ThinkGearParser` → raw via
  `ingest()` at `fs = 512`, scaled 0.51 µV/unit. `reset()`/`setFs()`/`setMode('live
  · neurosky', …)` on connect; reader cancelled + port closed in `stopAll()`.
  Capability guard + clear messages for missing Web Serial / cancelled chooser.
- `connectEmotiv()`: status-line stub — "Emotiv (Cortex API) — coming soon".
- `stopAll()`: also cancels the serial reader and closes the port.
- Capability guard: missing `navigator.serial` → banner message (mirrors the
  existing Web Bluetooth guard).

### 3. `+page.svelte` — source picker
Add to the existing SIGNAL SOURCE row: a `∿ NeuroSky` button and a disabled
`Emotiv · soon` button, alongside Test / File / BLE. Eyes-open/closed manual
capture and alpha-ratio readout are untouched.

## Decisions

- **Scaling:** NeuroSky raw is not calibrated µV; the alpha ratio (C/O) is
  relative and unaffected. Absolute µV labels are approximate — acceptable, same
  as the synthetic demo.
- **No new dependencies:** Web Serial is a browser API.
- **Browser support:** Web Serial is Chromium desktop only; non-supporting
  browsers get a clear banner message.

## Testing

- Unit tests for `thinkgear.ts`: valid packet, raw-sample decode, split across
  chunks, bad checksum dropped, sync resync after garbage.
- Manual: NeuroSky button streams; eyes-open/closed compare + alpha ratio update.

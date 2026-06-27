# NeuroSky + Emotiv source support

**Date:** 2026-06-26
**Status:** Approved

## Goal

Let BERGER·1 acquire EEG from consumer headsets in addition to the existing
custom-firmware BLE device, and keep the manual eyes-open / eyes-closed alpha
test working with every source.

## Connectivity reality (why each source differs)

- **Custom firmware (existing):** Web Bluetooth / GATT, ASCII-integer frames. Unchanged.
- **NeuroSky MindWave Mobile 2:** **local bridge → WebSocket** (`bridge/neurosky-bridge.ts`).
  A browser cannot get MWM2 raw directly — the raw enable handshake is inside
  NeuroSky's compiled SDK, `0x02`-over-GATT is empirically insufficient (proven
  in NF-ios), and modern macOS exposes no serial port for SPP. The bridge connects
  to NeuroSky's free **ThinkGear Connector** (TCP `127.0.0.1:13854`,
  `enableRawOutput:true`) and re-serves raw as `ws://localhost:8127`. `--mock`
  streams synthetic alpha for dev/test. Raw 512 Hz, scale 0.51 µV/unit.
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
- `connectNeuroSky()`: opens `ws://localhost:8127` (the bridge). `onmessage`
  parses `{raw:number[], poorSignal?}` and feeds raw via `ingest()` at `fs = 512`,
  scaled 0.51 µV/unit. `reset()`/`setFs()`/`setMode('live · neurosky', …)` on open;
  socket closed in `stopAll()`. Clear error if the bridge isn't running.

### 2b. `bridge/neurosky-bridge.ts` (new, Bun)
TCP client to ThinkGear Connector (`enableRawOutput:true`) → WebSocket server on
8127. `--mock` streams synthetic 10 Hz alpha at 512 Hz. Batches raw every 50 ms.
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

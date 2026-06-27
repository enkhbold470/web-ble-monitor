// Streaming ThinkGear (TGAM) parser for NeuroSky MindWave headsets.
//
// NeuroSky speaks Bluetooth Classic (SPP), not BLE, so the browser reaches it
// over the Web Serial API. The byte stream is a sequence of packets:
//
//   0xAA 0xAA  [PLENGTH]  [PAYLOAD…PLENGTH bytes]  [CHKSUM]
//   CHKSUM = (~(sum of payload bytes & 0xFF)) & 0xFF
//
// Payload codes we consume:
//   0x80  raw EEG   — 2-byte big-endian signed, sampled at 512 Hz
//   0x02  poor-signal (0 = good contact … 200 = off head)
//   0x04  attention   (0–100)
//   0x05  meditation  (0–100)
// Multi-byte codes (>= 0x80) are length-prefixed; 0x55 is the extended-code
// marker and is skipped. Everything else (e.g. 0x83 ASIC band powers) is ignored.
//
// push() is fed arbitrary serial chunks and tolerates packets split across
// chunk boundaries, leading garbage, and corrupt checksums.

export interface ThinkGearReading {
	/** Raw EEG samples decoded from this chunk, in stream order (512 Hz). */
	raw: number[];
	poorSignal?: number;
	attention?: number;
	meditation?: number;
}

const SYNC = 0xaa;
const MAX_PAYLOAD = 169;

export class ThinkGearParser {
	private buf: number[] = [];

	push(bytes: Uint8Array): ThinkGearReading {
		for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
		const out: ThinkGearReading = { raw: [] };
		this.drain(out);
		return out;
	}

	private drain(out: ThinkGearReading): void {
		for (;;) {
			// Find the 0xAA 0xAA sync pair, dropping any garbage before it.
			let s = 0;
			while (s + 1 < this.buf.length && !(this.buf[s] === SYNC && this.buf[s + 1] === SYNC)) s++;
			if (s > 0) this.buf.splice(0, s);
			if (this.buf.length < 3) return; // need sync, sync, plength

			const plength = this.buf[2];
			if (plength > MAX_PAYLOAD) {
				// Not a length byte (e.g. a third sync); skip one and re-scan.
				this.buf.shift();
				continue;
			}
			const total = 3 + plength + 1; // sync, sync, plength, payload, checksum
			if (this.buf.length < total) return; // wait for the rest of the packet

			const payload = this.buf.slice(3, 3 + plength);
			let sum = 0;
			for (const b of payload) sum = (sum + b) & 0xff;
			if ((~sum & 0xff) !== this.buf[3 + plength]) {
				// Corrupt packet: drop the sync bytes and resync.
				this.buf.splice(0, 2);
				continue;
			}

			this.parsePayload(payload, out);
			this.buf.splice(0, total);
		}
	}

	private parsePayload(p: number[], out: ThinkGearReading): void {
		let i = 0;
		while (i < p.length) {
			let code = p[i++];
			while (code === 0x55 && i < p.length) code = p[i++]; // extended-code marker
			if (code & 0x80) {
				const vlen = p[i++];
				if (code === 0x80 && vlen >= 2) {
					let raw = (p[i] << 8) | p[i + 1];
					if (raw >= 0x8000) raw -= 0x10000; // sign-extend 16-bit
					out.raw.push(raw);
				}
				i += vlen;
			} else {
				const val = p[i++];
				if (code === 0x02) out.poorSignal = val;
				else if (code === 0x04) out.attention = val;
				else if (code === 0x05) out.meditation = val;
			}
		}
	}
}

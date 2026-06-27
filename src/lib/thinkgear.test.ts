import { describe, it, expect } from 'vitest';
import { ThinkGearParser } from './thinkgear';

/** Build a valid ThinkGear packet from a payload byte array. */
function packet(payload: number[]): number[] {
	let sum = 0;
	for (const b of payload) sum = (sum + b) & 0xff;
	const chk = ~sum & 0xff;
	return [0xaa, 0xaa, payload.length, ...payload, chk];
}

/** Raw-EEG payload (code 0x80, 2-byte big-endian value). */
function rawPayload(value: number): number[] {
	const v = value & 0xffff;
	return [0x80, 0x02, (v >> 8) & 0xff, v & 0xff];
}

const u8 = (a: number[]) => new Uint8Array(a);

describe('ThinkGearParser', () => {
	it('decodes a positive raw EEG sample', () => {
		const out = new ThinkGearParser().push(u8(packet(rawPayload(258))));
		expect(out.raw).toEqual([258]);
	});

	it('decodes a negative raw EEG sample (signed 16-bit)', () => {
		const out = new ThinkGearParser().push(u8(packet(rawPayload(-2))));
		expect(out.raw).toEqual([-2]);
	});

	it('decodes poor-signal, attention and meditation', () => {
		const out = new ThinkGearParser().push(
			u8(packet([0x02, 200, 0x04, 47, 0x05, 88]))
		);
		expect(out.poorSignal).toBe(200);
		expect(out.attention).toBe(47);
		expect(out.meditation).toBe(88);
	});

	it('reassembles a packet split across two push() calls', () => {
		const bytes = packet(rawPayload(1000));
		const p = new ThinkGearParser();
		const first = p.push(u8(bytes.slice(0, 3)));
		expect(first.raw).toEqual([]);
		const second = p.push(u8(bytes.slice(3)));
		expect(second.raw).toEqual([1000]);
	});

	it('resyncs past leading garbage', () => {
		const bytes = [0x12, 0x34, 0x00, ...packet(rawPayload(7))];
		const out = new ThinkGearParser().push(u8(bytes));
		expect(out.raw).toEqual([7]);
	});

	it('drops a packet with a bad checksum', () => {
		const bytes = packet(rawPayload(500));
		bytes[bytes.length - 1] ^= 0xff; // corrupt checksum
		const out = new ThinkGearParser().push(u8(bytes));
		expect(out.raw).toEqual([]);
	});

	it('parses two raw samples streamed back to back', () => {
		const stream = [...packet(rawPayload(10)), ...packet(rawPayload(-10))];
		const out = new ThinkGearParser().push(u8(stream));
		expect(out.raw).toEqual([10, -10]);
	});
});

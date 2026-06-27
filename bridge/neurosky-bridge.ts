// NeuroSky → WebSocket bridge (run with Bun).
//
// A browser tab cannot get raw EEG from a MindWave Mobile 2 directly: the raw
// enable handshake lives inside NeuroSky's compiled SDK, and modern macOS no
// longer exposes a serial port for SPP devices. The reliable path is NeuroSky's
// free **ThinkGear Connector (TGC)** desktop app, which owns the Bluetooth link
// and streams JSON over TCP 127.0.0.1:13854. This bridge connects to TGC with
// raw output enabled, and re-exposes the samples as a WebSocket the web app can
// reach.
//
//   Real headset:  install + open ThinkGear Connector, connect your MindWave,
//                  then:  bun bridge/neurosky-bridge.ts
//   No hardware:   bun bridge/neurosky-bridge.ts --mock
//                  (synthetic 10 Hz alpha so the UI + eyes test work + are
//                   Playwright-testable)
//
// Browser protocol: JSON messages { raw: number[], poorSignal?, attention?,
// meditation? } where `raw` are ThinkGear raw units (~0.51 µV/unit, 512 Hz).

import type { ServerWebSocket } from 'bun';

const WS_PORT = Number(process.env.NS_BRIDGE_PORT ?? 8127);
const TGC_HOST = '127.0.0.1';
const TGC_PORT = 13854;
const RAW_FS = 512;
const FLUSH_MS = 50;
const MOCK = process.argv.includes('--mock');

const clients = new Set<ServerWebSocket<unknown>>();

function broadcast(msg: {
	raw: number[];
	poorSignal?: number;
	attention?: number;
	meditation?: number;
}): void {
	if (!clients.size) return;
	const s = JSON.stringify(msg);
	for (const ws of clients) ws.send(s);
}

// ---- WebSocket server (browser-facing) ----
Bun.serve({
	port: WS_PORT,
	fetch(req, server) {
		if (server.upgrade(req)) return;
		return new Response('NeuroSky bridge is running — connect via WebSocket.', { status: 200 });
	},
	websocket: {
		open(ws) {
			clients.add(ws);
			console.log(
				`[bridge] browser connected (${clients.size} client${clients.size > 1 ? 's' : ''})`
			);
		},
		close(ws) {
			clients.delete(ws);
			console.log(`[bridge] browser disconnected (${clients.size} left)`);
		},
		message() {
			/* browser doesn't send anything */
		}
	}
});
console.log(
	`[bridge] WebSocket listening on ws://localhost:${WS_PORT}  (${MOCK ? 'MOCK' : 'ThinkGear Connector'} mode)`
);

// ---- Source: synthetic alpha (no hardware) ----
function startMock(): void {
	let i = 0;
	const perFlush = Math.round((RAW_FS * FLUSH_MS) / 1000);
	setInterval(() => {
		const raw: number[] = [];
		for (let k = 0; k < perFlush; k++, i++) {
			const t = i / RAW_FS;
			// eyes-closed-ish: strong 10 Hz alpha + pink-ish noise, in µV → raw units.
			const uv =
				40 * Math.sin(2 * Math.PI * 10 * t) +
				8 * Math.sin(2 * Math.PI * 6 * t) +
				18 * (Math.random() * 2 - 1);
			raw.push(Math.round(uv / 0.51));
		}
		broadcast({ raw, poorSignal: 0, attention: 50, meditation: 50 });
	}, FLUSH_MS);
}

// ---- Source: ThinkGear Connector (TCP JSON) ----
function startTGC(): void {
	let buf = '';
	let rawBatch: number[] = [];
	let poorSignal: number | undefined;
	let attention: number | undefined;
	let meditation: number | undefined;

	const flush = setInterval(() => {
		if (rawBatch.length || poorSignal !== undefined) {
			broadcast({ raw: rawBatch, poorSignal, attention, meditation });
			rawBatch = [];
			poorSignal = attention = meditation = undefined;
		}
	}, FLUSH_MS);

	const connect = (): void => {
		Bun.connect({
			hostname: TGC_HOST,
			port: TGC_PORT,
			socket: {
				open(socket) {
					console.log('[bridge] connected to ThinkGear Connector — requesting raw output');
					socket.write('{"enableRawOutput":true,"format":"Json"}\n');
				},
				data(_socket, chunk) {
					buf += chunk.toString('utf8');
					let nl: number;
					while ((nl = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						if (!line) continue;
						try {
							const msg = JSON.parse(line) as {
								rawEeg?: number;
								poorSignalLevel?: number;
								eSense?: { attention?: number; meditation?: number };
							};
							if (typeof msg.rawEeg === 'number') rawBatch.push(msg.rawEeg);
							if (typeof msg.poorSignalLevel === 'number') poorSignal = msg.poorSignalLevel;
							if (msg.eSense?.attention !== undefined) attention = msg.eSense.attention;
							if (msg.eSense?.meditation !== undefined) meditation = msg.eSense.meditation;
						} catch {
							/* ignore partial / non-JSON lines */
						}
					}
				},
				error() {
					console.error(
						'[bridge] ThinkGear Connector error — is the TGC app running and connected to your MindWave?'
					);
				},
				close() {
					console.warn('[bridge] TGC connection closed — retrying in 3s');
					setTimeout(connect, 3000);
				}
			}
		}).catch(() => {
			console.error(
				'[bridge] cannot reach ThinkGear Connector at 127.0.0.1:13854 — start the TGC app. Retrying in 3s.'
			);
			setTimeout(connect, 3000);
		});
	};
	connect();
	process.on('exit', () => clearInterval(flush));
}

if (MOCK) startMock();
else startTGC();

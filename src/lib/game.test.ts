import { describe, expect, it } from 'vitest';
import {
	CUBE,
	DT,
	GRAVITY,
	GROUND_Y,
	JUMP_V,
	LEVEL_LEN,
	SPEED,
	advance,
	generateLevel,
	initialState,
	mulberry32,
	progress,
	step,
	type Obstacle
} from './game';

const noObstacles: Obstacle[] = [];

/** Run `sec` seconds of physics, jumping only on the first substep if asked. */
function run(sec: number, obstacles: Obstacle[], jumpAt: number[] = []) {
	const s = initialState();
	const n = Math.round(sec / DT);
	for (let i = 0; i < n; i++) {
		const t = i * DT;
		const jump = jumpAt.some((j) => t >= j && t < j + DT);
		step(s, obstacles, jump);
	}
	return s;
}

describe('mulberry32', () => {
	it('is deterministic for a seed and differs between seeds', () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		const c = mulberry32(43);
		const seqA = [a(), a(), a()];
		const seqB = [b(), b(), b()];
		const seqC = [c(), c(), c()];
		expect(seqA).toEqual(seqB);
		expect(seqA).not.toEqual(seqC);
	});

	it('stays in [0, 1)', () => {
		const r = mulberry32(7);
		for (let i = 0; i < 500; i++) {
			const v = r();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe('generateLevel', () => {
	it('is reproducible — the same seed builds the same level', () => {
		expect(generateLevel(123)).toEqual(generateLevel(123));
	});

	it('different seeds build different levels', () => {
		expect(generateLevel(1)).not.toEqual(generateLevel(2));
	});

	it('leaves the first stretch clear so the EEG window can fill', () => {
		const lvl = generateLevel(9);
		expect(lvl[0].x).toBeGreaterThanOrEqual(900);
	});

	it('every obstacle is individually clearable from the ground', () => {
		// A jump covers SPEED * airtime horizontally and peaks at JUMP_V^2/(2*GRAVITY).
		const airtime = (2 * -JUMP_V) / GRAVITY; // 0.6 s
		const reach = SPEED * airtime; // 192 px
		const apex = (JUMP_V * JUMP_V) / (2 * GRAVITY); // 108 px
		expect(reach).toBeCloseTo(192, 5);
		expect(apex).toBeCloseTo(108, 5);
		for (const seed of [1, 2, 3, 99]) {
			for (const o of generateLevel(seed)) {
				if (o.kind === 'spike') expect(o.w).toBeLessThan(reach);
				else expect(o.h).toBeLessThan(apex);
			}
		}
	});

	it('spans the level and stops before the end', () => {
		const lvl = generateLevel(5);
		expect(lvl.length).toBeGreaterThan(10);
		expect(lvl[lvl.length - 1].x).toBeLessThan(LEVEL_LEN);
	});
});

describe('physics', () => {
	it('starts on the ground and runs at a constant speed', () => {
		const s = run(1, noObstacles);
		expect(s.y).toBe(GROUND_Y);
		expect(s.onGround).toBe(true);
		expect(s.x).toBeCloseTo(SPEED * 1, 0);
	});

	it('a jump peaks at the analytic apex and lands after the analytic airtime', () => {
		const apex = (JUMP_V * JUMP_V) / (2 * GRAVITY);
		const s = initialState();
		let maxY = 0;
		let landedAt: number | null = null;
		for (let i = 0; i < Math.round(1.2 / DT); i++) {
			step(s, noObstacles, i === 0);
			maxY = Math.max(maxY, s.y);
			if (landedAt === null && i > 2 && s.onGround) landedAt = s.t;
		}
		expect(maxY).toBeGreaterThan(apex * 0.93);
		expect(maxY).toBeLessThanOrEqual(apex + 1);
		expect(landedAt).toBeCloseTo((2 * -JUMP_V) / GRAVITY, 1);
	});

	it('cannot double jump', () => {
		const s = initialState();
		step(s, noObstacles, true);
		const vyAfterFirst = s.vy;
		step(s, noObstacles, true); // pressed again mid-air
		// vy only changed by gravity, not by a second impulse.
		expect(s.vy).toBeCloseTo(vyAfterFirst + GRAVITY * DT, 6);
	});

	it('is fully deterministic — identical inputs give an identical trajectory', () => {
		const lvl = generateLevel(11);
		const a = run(6, lvl, [1.0, 2.5, 4.0]);
		const b = run(6, lvl, [1.0, 2.5, 4.0]);
		expect(a).toEqual(b);
	});
});

describe('collisions', () => {
	const spikeAt = (x: number): Obstacle[] => [{ kind: 'spike', x, y: GROUND_Y, w: 30, h: 30 }];
	const blockAt = (x: number, h: number): Obstacle[] => [
		{ kind: 'block', x, y: GROUND_Y, w: 90, h }
	];

	it('running into a spike kills', () => {
		const s = run(3, spikeAt(400));
		expect(s.deaths).toBe(1);
	});

	it('jumping over a spike survives', () => {
		// Jump so the cube is airborne when it reaches x=400 (t = 400/320 = 1.25 s).
		const s = run(3, spikeAt(400), [1.05]);
		expect(s.deaths).toBe(0);
	});

	it('landing on top of a block is safe and the cube stands on its surface', () => {
		const h = 60;
		const s = initialState();
		const lvl = blockAt(400, h);
		let landedY: number | null = null;
		// Jump at t = 0.95 s so the descent meets the block top.
		for (let i = 0; i < Math.round(1.6 / DT); i++) {
			step(s, lvl, i === Math.round(0.95 / DT));
			// The first time it is grounded above the floor, it is standing on the block.
			if (landedY === null && s.onGround && s.y > GROUND_Y) landedY = s.y;
		}
		expect(s.deaths).toBe(0);
		expect(landedY).toBeCloseTo(h, 5);
	});

	it('runs off the far edge of a block and falls back to the floor', () => {
		const s = initialState();
		const lvl = blockAt(400, 60);
		for (let i = 0; i < Math.round(2.4 / DT); i++) step(s, lvl, i === Math.round(0.95 / DT));
		expect(s.deaths).toBe(0);
		expect(s.y).toBe(GROUND_Y);
		expect(s.onGround).toBe(true);
	});

	it('running into the side of a block kills', () => {
		const s = run(3, blockAt(400, 60)); // never jumps
		expect(s.deaths).toBe(1);
	});

	/** Step until the cube dies (or we give up), returning the state at that instant. */
	function runUntilDeath(obstacles: Obstacle[]) {
		const s = initialState();
		for (let i = 0; i < Math.round(10 / DT); i++) {
			step(s, obstacles, false);
			if (s.justDied) break;
		}
		return s;
	}

	it('a death restarts the attempt from the start and keeps best progress', () => {
		const s = runUntilDeath(spikeAt(400));
		expect(s.deaths).toBe(1);
		expect(s.attempt).toBe(2);
		expect(s.x).toBe(0);
		expect(s.bestProgress).toBeGreaterThan(0);
		expect(s.respawnIn).toBeGreaterThan(0);
	});

	it('input is ignored during the respawn pause', () => {
		const s = runUntilDeath(spikeAt(400));
		const t = s.t;
		step(s, spikeAt(400), true); // try to jump mid-respawn
		expect(s.x).toBe(0); // world did not advance
		expect(s.y).toBe(GROUND_Y); // and the jump was swallowed
		expect(s.t).toBeCloseTo(t + DT, 6);
	});

	it('resumes running once the respawn pause elapses', () => {
		const s = run(3, spikeAt(400)); // death ~1.25 s, respawn 0.8 s, then it runs again
		expect(s.deaths).toBe(1);
		expect(s.x).toBeGreaterThan(0);
	});

	it('the spike hitbox is forgiving — brushing the very tip does not kill', () => {
		// A square hitbox on a triangle would kill here; the narrowed column must not.
		const spike: Obstacle[] = [{ kind: 'spike', x: 100, y: GROUND_Y, w: 30, h: 30 }];
		const s = initialState();
		s.x = 100 - CUBE + 5; // cube's right edge just inside the spike's drawn footprint
		s.y = 26; // and high up, near the tip
		step(s, spike, false);
		expect(s.deaths).toBe(0);
	});
});

describe('advance — fixed timestep driver', () => {
	it('carries the sub-step remainder so physics never depends on frame rate', () => {
		const s1 = initialState();
		const s2 = initialState();
		const lvl = generateLevel(3);

		// One caller runs 60 fps, the other a jittery 37/143 fps. Same wall-clock total.
		let carry = 0;
		for (let i = 0; i < 120; i++) {
			const r = advance(s1, lvl, 1 / 60 + carry, false);
			carry = r.carry;
		}
		let carry2 = 0;
		let acc = 0;
		const total = 120 / 60;
		while (acc < total - 1e-9) {
			const dt = Math.min(acc % 2 < 1 ? 1 / 37 : 1 / 143, total - acc);
			acc += dt;
			const r = advance(s2, lvl, dt + carry2, false);
			carry2 = r.carry;
		}
		// Both consumed the same number of whole DT steps, so x matches to within one step.
		expect(Math.abs(s1.x - s2.x)).toBeLessThanOrEqual(SPEED * DT + 1e-6);
	});

	it('buffers a jump until the cube is grounded, but never autojumps', () => {
		const s = initialState();
		const r1 = advance(s, noObstacles, 0.05, true); // grounded: fires immediately
		expect(r1.consumedJump).toBe(true);
		expect(s.onGround).toBe(false);

		// Mid-air, a held key must not produce a second jump.
		const vy = s.vy;
		const r2 = advance(s, noObstacles, DT, true);
		expect(r2.consumedJump).toBe(false);
		expect(s.vy).toBeGreaterThan(vy); // only gravity acted
	});

	it('reports death timestamps for the analysis to join on', () => {
		const s = initialState();
		const lvl: Obstacle[] = [{ kind: 'spike', x: 400, y: GROUND_Y, w: 30, h: 30 }];
		let carry = 0;
		const deaths: number[] = [];
		for (let i = 0; i < 200; i++) {
			const r = advance(s, lvl, 1 / 60 + carry, false);
			carry = r.carry;
			deaths.push(...r.deathTimes);
		}
		expect(deaths.length).toBeGreaterThanOrEqual(1);
		// x = 400 at t = 400/320 = 1.25 s; the cube dies as it arrives.
		expect(deaths[0]).toBeGreaterThan(1.0);
		expect(deaths[0]).toBeLessThan(1.5);
	});

	it('caps catch-up so a backgrounded tab cannot fast-forward the level', () => {
		const s = initialState();
		advance(s, noObstacles, 60, false); // 60 seconds in one frame
		expect(progress(s)).toBeLessThan(1);
		expect(s.x).toBeLessThanOrEqual(240 * DT * SPEED + 1e-6);
	});
});

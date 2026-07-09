// DASH — a deterministic, Geometry-Dash-style auto-runner.
//
// The player plays this with the keyboard. EEG never touches it: focus is measured
// passively alongside, so that "was this player focused, and did losing focus cost them?"
// is a question about an untouched performance record rather than a self-fulfilling loop.
//
// Determinism is the point. A seeded level and a fixed timestep mean two sessions face the
// same obstacles at the same times, so comparing focus across attempts compares like with
// like. Never drive `step()` off a raw rAF delta.

/** Seeded PRNG (mulberry32). Same seed, same level, forever. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---- world constants (px, px/s, px/s²) ----
export const SPEED = 320; // constant horizontal scroll
export const GRAVITY = 2400;
export const JUMP_V = -720; // impulse; apex = JUMP_V²/(2·GRAVITY) = 108 px
export const CUBE = 30; // side length
export const GROUND_Y = 0; // world y grows upward from the floor
export const LEVEL_LEN = 12000; // px -> 12000/320 = 37.5 s of level
/** Fixed physics timestep. Everything is integrated at exactly this dt. */
export const DT = 1 / 120;
/** Forgiveness: the cube's hitbox is inset from its sprite on every side. */
const HITBOX_INSET = 4;
/** Seconds of stillness after a death before the next attempt begins. */
export const RESPAWN_SEC = 0.8;

export type ObstacleKind = 'spike' | 'block';

export interface Obstacle {
	kind: ObstacleKind;
	/** Left edge, in world px. */
	x: number;
	/** Bottom edge above the floor. Blocks may float; spikes sit on the ground. */
	y: number;
	w: number;
	h: number;
}

export interface GameState {
	/** World x of the cube's left edge; also the progress measure. */
	x: number;
	/** Cube bottom above the floor. */
	y: number;
	vy: number;
	onGround: boolean;
	/** Cosmetic; a real Geometry Dash cube spins in the air. */
	rot: number;
	attempt: number;
	deaths: number;
	/** Seconds since the session began — the clock the analysis joins focus on. */
	t: number;
	/** > 0 while the death animation plays and input is ignored. */
	respawnIn: number;
	/** Best fraction of the level reached across attempts, 0..1. */
	bestProgress: number;
	/** Set for exactly one step() when the cube dies, so callers can log the timestamp. */
	justDied: boolean;
	/** True once the cube crosses LEVEL_LEN. */
	finished: boolean;
}

/**
 * Build a level from a seed. Obstacles are placed so that each is individually clearable
 * from the ground: a jump covers 192 px horizontally (0.6 s of air) and peaks at 108 px, so
 * gaps stay under 150 px and stacks under 90 px. Spacing never drops below the 0.6 s of air
 * a jump costs, which keeps the level fair rather than frame-perfect.
 */
export function generateLevel(seed: number): Obstacle[] {
	const rnd = mulberry32(seed);
	const out: Obstacle[] = [];
	// First obstacle far enough in that the player is settled and the EEG window has filled.
	let x = 900;
	while (x < LEVEL_LEN - 400) {
		const roll = rnd();
		if (roll < 0.45) {
			// single spike
			out.push({ kind: 'spike', x, y: GROUND_Y, w: 30, h: 30 });
			x += 260 + rnd() * 220;
		} else if (roll < 0.7) {
			// twin spikes — one jump clears both (60 px < 192 px reach)
			out.push({ kind: 'spike', x, y: GROUND_Y, w: 30, h: 30 });
			out.push({ kind: 'spike', x: x + 30, y: GROUND_Y, w: 30, h: 30 });
			x += 300 + rnd() * 240;
		} else if (roll < 0.88) {
			// a block to land on, then drop off
			const h = 40 + Math.floor(rnd() * 40); // 40..80 px, under the 108 px apex
			out.push({ kind: 'block', x, y: GROUND_Y, w: 90, h });
			x += 320 + rnd() * 220;
		} else {
			// block with a spike immediately after: land, then jump again
			const h = 40 + Math.floor(rnd() * 30);
			out.push({ kind: 'block', x, y: GROUND_Y, w: 80, h });
			out.push({ kind: 'spike', x: x + 80 + 110, y: GROUND_Y, w: 30, h: 30 });
			x += 420 + rnd() * 200;
		}
	}
	return out;
}

export function initialState(): GameState {
	return {
		x: 0,
		y: GROUND_Y,
		vy: 0,
		onGround: true,
		rot: 0,
		attempt: 1,
		deaths: 0,
		t: 0,
		respawnIn: 0,
		bestProgress: 0,
		justDied: false,
		finished: false
	};
}

/**
 * The box an obstacle actually kills with, which is not the box it is drawn as. A spike is
 * drawn as a 30 px triangle but most of that footprint is empty air near the tip, so its
 * hitbox is a narrow column through the middle. Blocks collide as drawn.
 */
function hitbox(o: Obstacle): { x: number; y: number; w: number; h: number } {
	if (o.kind !== 'spike') return o;
	return { x: o.x + 8, y: o.y, w: o.w - 16, h: o.h - 8 };
}

/**
 * Axis-aligned overlap of the cube against an obstacle's hitbox.
 *
 * The cube is inset HORIZONTALLY only. Its bottom edge stays flush with the sprite: the
 * feet are where they look like they are. Insetting the bottom would float the cube 4 px
 * above the ground and, worse, break landing detection — the first step where the raised
 * hitbox dips below a block's top surface can have the sprite already several px below it,
 * so a legal landing reads as a side impact.
 */
function overlaps(cx: number, cy: number, o: Obstacle): boolean {
	const h = hitbox(o);
	const l = cx + HITBOX_INSET;
	const r = cx + CUBE - HITBOX_INSET;
	const b = cy;
	const t = cy + CUBE;
	return l < h.x + h.w && r > h.x && b < h.y + h.h && t > h.y;
}

function die(s: GameState): void {
	s.deaths++;
	s.attempt++;
	s.justDied = true;
	s.respawnIn = RESPAWN_SEC;
	s.x = 0;
	s.y = GROUND_Y;
	s.vy = 0;
	s.rot = 0;
	s.onGround = true;
}

/**
 * Advance the world by exactly DT seconds. Pure w.r.t. `obstacles`; mutates and returns `s`.
 *
 * `jump` is edge-triggered by the caller: pass true only on the frame the key goes down,
 * or holding it would autojump. The cube can only jump from the ground — there is no
 * double jump and no variable jump height, which is what makes deaths attributable to
 * timing rather than to how long a key was held.
 */
export function step(s: GameState, obstacles: Obstacle[], jump: boolean): GameState {
	s.justDied = false;
	s.t += DT;

	if (s.respawnIn > 0) {
		s.respawnIn -= DT;
		return s;
	}
	if (s.finished) return s;

	if (jump && s.onGround) {
		s.vy = JUMP_V;
		s.onGround = false;
	}

	// Where the cube's bottom was before this step. Captured BEFORE integration and before
	// the ground clamp — a landing test must compare against the true previous position,
	// not one the clamp has already rewritten.
	const prevBottom = s.y;

	// Integrate. y grows upward, JUMP_V is negative, so gravity subtracts.
	s.vy += GRAVITY * DT;
	s.y -= s.vy * DT;
	s.x += SPEED * DT;
	if (!s.onGround) s.rot += 6.5 * DT;

	if (s.y <= GROUND_Y) {
		s.y = GROUND_Y;
		s.vy = 0;
		s.onGround = true;
		s.rot = 0;
	} else {
		s.onGround = false;
	}

	for (const o of obstacles) {
		// Cheap reject: obstacles are sorted by x, but the list is short enough to scan.
		if (o.x > s.x + CUBE || o.x + o.w < s.x) continue;

		if (o.kind === 'spike') {
			if (overlaps(s.x, s.y, o)) {
				die(s);
				return s;
			}
			continue;
		}

		// Block: landing on top is safe, running into the side is not.
		if (!overlaps(s.x, s.y, o)) continue;
		const top = o.y + o.h;
		const falling = s.vy >= 0;
		// Treat it as a landing only if the cube's bottom was at or above the top surface a
		// step ago. Anything else is a side impact.
		if (falling && prevBottom >= top - 1) {
			s.y = top;
			s.vy = 0;
			s.onGround = true;
			s.rot = 0;
		} else {
			die(s);
			return s;
		}
	}

	const progress = Math.min(1, s.x / LEVEL_LEN);
	if (progress > s.bestProgress) s.bestProgress = progress;
	if (s.x >= LEVEL_LEN) s.finished = true;
	return s;
}

/** 0..1 fraction of the level the cube has covered this attempt. */
export function progress(s: GameState): number {
	return Math.min(1, s.x / LEVEL_LEN);
}

/**
 * Run the fixed-timestep loop for `elapsed` real seconds, consuming at most one jump.
 * Callers accumulate real time and hand it here, so physics never depends on frame rate.
 *
 * A queued jump fires on the first substep where the cube is actually on the ground. That
 * makes it a short input buffer rather than a swallowed press: hitting jump a few
 * milliseconds before landing still jumps, which is what players expect and what keeps a
 * death attributable to timing rather than to frame boundaries. It is NOT autojump — the
 * caller drops an unconsumed queue after its buffer window.
 *
 * Returns the leftover time to carry into the next frame, and the death timestamps (in
 * session seconds) that occurred during this call, which is what the focus analysis joins on.
 */
export function advance(
	s: GameState,
	obstacles: Obstacle[],
	elapsed: number,
	jumpQueued: boolean
): { carry: number; consumedJump: boolean; deathTimes: number[] } {
	let acc = elapsed;
	let consumedJump = false;
	const deathTimes: number[] = [];
	// Cap the catch-up so a backgrounded tab cannot fast-forward through the level.
	let budget = 240;
	while (acc >= DT && budget-- > 0) {
		const jumpNow = jumpQueued && !consumedJump && s.onGround && s.respawnIn <= 0;
		step(s, obstacles, jumpNow);
		if (jumpNow) consumedJump = true;
		if (s.justDied) deathTimes.push(s.t);
		acc -= DT;
	}
	return { carry: acc, consumedJump, deathTimes };
}

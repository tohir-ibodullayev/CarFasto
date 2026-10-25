import {
  FIRST_WAVE_DISTANCE,
  LANES,
  LANE_CHANGE_S,
  PLAN_REACTION_S,
  PLAN_REPEAT_S,
  PLAYER_CAR,
  START_LANE,
  TRAFFIC_BODY,
  TRAFFIC_COLORS,
  VIEW_AHEAD,
  gapAt,
  speedAt,
  type TrafficKind,
} from '../constants';
import { nextRandom, pick, randomInt } from './rng';

export interface Wave {
  index: number;
  /** Absolute track distance at which this wave's obstacle centres reach the player cars. */
  distance: number;
  blocked: number[];
  kinds: TrafficKind[];
  colors: number[];
}

export interface TrafficState {
  rng: number;
  nextWave: Wave;
  pending: number[][];
  waveCount: number;
}

interface Pattern {
  waves: number[][];
  gapMul?: number;
}

/** Hand-designed obstacle groups. Every transition is still validated before use. */
const PATTERNS: Pattern[][] = [
  [
    { waves: [[0]] },
    { waves: [[1]] },
    { waves: [[2]] },
    { waves: [[3]] },
    { waves: [[0], [3]] },
    { waves: [[1], [2]] },
  ],
  [
    { waves: [[0, 1]] },
    { waves: [[1, 2]] },
    { waves: [[2, 3]] },
    { waves: [[0, 3]] },
    { waves: [[0, 2]] },
    { waves: [[1, 3]] },
    { waves: [[0, 1], [2, 3]] },
    { waves: [[1, 2], [0, 3]] },
    { waves: [[0], [1, 2], [3]] },
    { waves: [[0, 2], [1, 3]] },
  ],
  [
    { waves: [[0, 1, 2]] },
    { waves: [[1, 2, 3]] },
    { waves: [[0, 1, 3]] },
    { waves: [[0, 2, 3]] },
    { waves: [[0, 1, 2], [1, 2, 3]], gapMul: 1.45 },
    { waves: [[1, 2, 3], [0, 2, 3]], gapMul: 1.2 },
    { waves: [[0, 1, 3], [0, 2, 3]] },
    { waves: [[0, 3], [0, 1, 3], [1, 2, 3]], gapMul: 1.1 },
    { waves: [[1, 2], [0, 1, 2], [0, 1]] },
  ],
];

function tierWeights(timeS: number): [number, number, number] {
  if (timeS < 12) return [1, 0, 0];
  if (timeS < 28) return [0.35, 0.65, 0];
  if (timeS < 48) return [0.1, 0.6, 0.3];
  return [0, 0.5, 0.5];
}

export function freeLanes(blocked: readonly number[]): number[] {
  const free: number[] = [];
  for (let lane = 0; lane < LANES; lane++) if (!blocked.includes(lane)) free.push(lane);
  return free;
}

function waveHitLength(wave: Pick<Wave, 'kinds'>): number {
  return Math.max(...wave.kinds.map((k) => TRAFFIC_BODY[k].hitLength));
}

/** The shortest vehicle appears last, so it decides when the whole wave is visible. */
function waveVisualLength(wave: Pick<Wave, 'kinds'>): number {
  return Math.min(...wave.kinds.map((k) => TRAFFIC_BODY[k].length));
}

/**
 * How many consecutive single-lane moves a team can complete between passing one wave and
 * reaching the next, given the closing speed, the time the next wave becomes visible, a
 * reaction allowance, the lane-change animation and the per-player shake cooldown.
 */
export function maxMovesBetween(
  gapDistance: number,
  speed: number,
  prevHitLength: number,
  nextHitLength: number,
  nextVisualLength: number,
): number {
  const tPass = (PLAYER_CAR.hitLength + prevHitLength) / 2 / speed;
  const tContact = (gapDistance - (PLAYER_CAR.hitLength + nextHitLength) / 2) / speed;
  const tVisible = (gapDistance - nextVisualLength / 2 - VIEW_AHEAD) / speed;
  const start = Math.max(tPass, tVisible + PLAN_REACTION_S);
  const available = tContact - start;
  if (available < LANE_CHANGE_S) return 0;
  return 1 + Math.floor((available - LANE_CHANGE_S) / PLAN_REPEAT_S + 1e-9);
}

/** Every lane the car could occupy while passing `prev` must reach some free lane of `next`. */
export function isTransitionReachable(
  prevBlocked: readonly number[],
  nextBlocked: readonly number[],
  maxMoves: number,
): boolean {
  if (nextBlocked.length >= LANES || nextBlocked.length === 0) return false;
  const nextFree = freeLanes(nextBlocked);
  return freeLanes(prevBlocked).every((a) => nextFree.some((b) => Math.abs(a - b) <= maxMoves));
}

function makeWave(state: { rng: number }, index: number, distance: number, blocked: number[], tier: number): Wave {
  const kinds: TrafficKind[] = blocked.map(() => {
    const r = nextRandom(state);
    if (tier === 0) return r < 0.75 ? 'car' : 'van';
    return r < 0.55 ? 'car' : r < 0.8 ? 'van' : 'truck';
  });
  const colors = blocked.map(() => randomInt(state, TRAFFIC_COLORS.length));
  return { index, distance, blocked: [...blocked].sort((a, b) => a - b), kinds, colors };
}

function chooseTier(state: { rng: number }, timeS: number): number {
  const weights = tierWeights(timeS);
  let r = nextRandom(state);
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

function pickPattern(state: { rng: number }, tier: number): Pattern {
  const pattern = pick(state, PATTERNS[tier]);
  if (nextRandom(state) < 0.5) return pattern;
  return { ...pattern, waves: pattern.waves.map((w) => w.map((lane) => LANES - 1 - lane)) };
}

export function createTraffic(seed: number): TrafficState {
  const state = { rng: seed | 0 };
  const firstBlocked = [START_LANE];
  const nextWave = makeWave(state, 0, FIRST_WAVE_DISTANCE, firstBlocked, 0);
  return { rng: state.rng, nextWave, pending: [], waveCount: 1 };
}

/**
 * Plan the wave after `traffic.nextWave`. Uses only the seed-driven RNG and the simulation
 * clock, never steering, so both roads always receive the same traffic.
 */
export function planFollowingWave(traffic: TrafficState, timeS: number, trackDistance: number): void {
  const prev = traffic.nextWave;
  const prevHit = waveHitLength(prev);
  const v0 = speedAt(timeS);

  const attempt = (blocked: number[], tier: number, gapMul: number): Wave | null => {
    const gapDistance = gapAt(timeS) * gapMul * v0;
    const arrivalTime = timeS + (prev.distance - trackDistance + gapDistance) / v0;
    const checkSpeed = speedAt(arrivalTime + 0.5);
    const wave = makeWave(traffic, traffic.waveCount, prev.distance + gapDistance, blocked, tier);
    const moves = maxMovesBetween(gapDistance, checkSpeed, prevHit, waveHitLength(wave), waveVisualLength(wave));
    return isTransitionReachable(prev.blocked, wave.blocked, moves) ? wave : null;
  };

  let chosen: Wave | null = null;
  if (traffic.pending.length > 0) {
    const blocked = traffic.pending.shift()!;
    chosen = attempt(blocked, blocked.length - 1, 1);
    if (!chosen) traffic.pending = [];
  }
  if (!chosen) {
    for (const gapMul of [1, 1.25, 1.6]) {
      for (let tries = 0; tries < 8 && !chosen; tries++) {
        const tier = chooseTier(traffic, timeS);
        const pattern = pickPattern(traffic, tier);
        const mul = gapMul * (pattern.gapMul ?? 1);
        chosen = attempt(pattern.waves[0], tier, mul);
        if (chosen) traffic.pending = pattern.waves.slice(1).map((w) => [...w]);
      }
      if (chosen) break;
    }
  }
  if (!chosen) {
    // Blocking a lane that was already blocked never forces a move, so this is always reachable.
    const prevBlocked = prev.blocked;
    chosen = attempt([pick(traffic, prevBlocked)], 0, 1.6) ?? makeWave(traffic, traffic.waveCount, prev.distance + 2 * v0, [prevBlocked[0]], 0);
    traffic.pending = [];
  }
  traffic.nextWave = chosen;
  traffic.waveCount++;
}

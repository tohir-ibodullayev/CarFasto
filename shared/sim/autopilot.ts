import {
  LANE_CHANGE_S,
  PLAN_REACTION_S,
  PLAYER_CAR,
  TRAFFIC_BODY,
  VIEW_AHEAD,
  type TrafficKind,
} from '../constants';
import { freeLanes } from './traffic';

export interface PlanObstacle {
  lane: number;
  z: number;
  kind: TrafficKind;
}

interface PlanWave {
  z: number;
  blocked: number[];
  visible: boolean;
}

function reach(kind: TrafficKind): number {
  return (PLAYER_CAR.hitLength + TRAFFIC_BODY[kind].hitLength) / 2;
}

/** Obstacles of one wave share the same z; a wave counts as seen only once all of it is visible. */
function groupWaves(obstacles: PlanObstacle[], horizon: number): PlanWave[] {
  const waves: PlanWave[] = [];
  for (const o of obstacles) {
    if (o.z < -reach(o.kind)) continue;
    let wave = waves.find((w) => Math.abs(w.z - o.z) < 0.05);
    if (!wave) {
      wave = { z: o.z, blocked: [], visible: true };
      waves.push(wave);
    }
    wave.blocked.push(o.lane);
    if (o.z - TRAFFIC_BODY[o.kind].length / 2 > horizon) wave.visible = false;
  }
  return waves.filter((w) => w.visible).sort((a, b) => a.z - b.z);
}

/**
 * Picks the lane a sensible team would head for next, looking a few visible waves ahead
 * with a human-like reaction delay. Used by the dev autopilot and the fairness tests.
 */
export function planTargetLane(carLane: number, speed: number, obstacles: PlanObstacle[], reactionS = PLAN_REACTION_S): number {
  const waves = groupWaves(obstacles, VIEW_AHEAD - speed * reactionS).slice(0, 3);
  if (waves.length === 0) return carLane;
  let best = { cost: Infinity, first: carLane };
  const dfs = (i: number, lane: number, cost: number, first: number) => {
    if (cost >= best.cost) return;
    if (i === waves.length) {
      best = { cost, first };
      return;
    }
    for (const next of freeLanes(waves[i].blocked)) {
      dfs(i + 1, next, cost + Math.abs(next - lane) * (i === 0 ? 1 : 0.9), i === 0 ? next : first);
    }
  };
  dfs(0, carLane, 0, carLane);
  return best.first;
}

/** True if starting a lane change into `target` now would not sweep into an obstacle. */
export function isMoveSafe(target: number, speed: number, obstacles: PlanObstacle[]): boolean {
  const sweep = speed * LANE_CHANGE_S;
  return !obstacles.some((o) => o.lane === target && o.z > -reach(o.kind) && o.z < reach(o.kind) + sweep);
}

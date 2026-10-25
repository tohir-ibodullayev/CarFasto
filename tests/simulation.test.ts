import { describe, expect, it } from 'vitest';
import {
  LANES,
  LANE_CHANGE_TICKS,
  PLAN_REACTION_S,
  PLAN_REPEAT_S,
  PLAYER_CAR,
  START_LANE,
  TICK_RATE,
  TRAFFIC_BODY,
  VIEW_AHEAD,
  type Direction,
  type Team,
} from '../shared/constants';
import { applySteer, carCollides, createSim, stepSim, type SimState } from '../shared/sim/simulation';
import { freeLanes, isTransitionReachable, maxMovesBetween } from '../shared/sim/traffic';

function stepN(sim: SimState, n: number) {
  for (let i = 0; i < n; i++) stepSim(sim);
}

function trafficSignature(sim: SimState) {
  return sim.obstacles.map((o) => `${o.id}:${o.lane}:${o.z.toFixed(6)}:${o.kind}:${o.color}`).join('|');
}

/** A competent team: sees traffic with human reaction delay, obeys the per-player shake cooldown. */
function makeBot(team: Team) {
  const lastMove: Record<Direction, number> = { left: -1e9, right: -1e9 };
  const repeatTicks = Math.ceil(PLAN_REPEAT_S * TICK_RATE);
  return (sim: SimState) => {
    const car = sim.cars[team];
    if (car.moveTick >= 0 || car.crashed) return;
    const horizon = VIEW_AHEAD - sim.speed * PLAN_REACTION_S;
    const waves = new Map<number, { z: number; blocked: number[]; visible: boolean }>();
    for (const o of sim.obstacles) {
      const reach = (PLAYER_CAR.hitLength + TRAFFIC_BODY[o.kind].hitLength) / 2;
      if (o.z < -reach) continue;
      const w = waves.get(o.wave) ?? { z: o.z, blocked: [], visible: true };
      w.blocked.push(o.lane);
      w.z = Math.min(w.z, o.z);
      if (o.z - TRAFFIC_BODY[o.kind].length / 2 > horizon) w.visible = false;
      waves.set(o.wave, w);
    }
    const ordered = [...waves.values()]
      .filter((w) => w.visible)
      .sort((a, b) => a.z - b.z)
      .slice(0, 3);
    if (ordered.length === 0) return;
    let best = { cost: Infinity, first: car.lane };
    const dfs = (i: number, lane: number, cost: number, first: number) => {
      if (cost >= best.cost) return;
      if (i === ordered.length) {
        best = { cost, first };
        return;
      }
      for (const next of freeLanes(ordered[i].blocked)) {
        dfs(i + 1, next, cost + Math.abs(next - lane) * (i === 0 ? 1 : 0.9), i === 0 ? next : first);
      }
    };
    dfs(0, car.lane, 0, car.lane);
    if (best.first === car.lane) return;
    const dir: Direction = best.first < car.lane ? 'left' : 'right';
    if (sim.tick - lastMove[dir] < repeatTicks) return;
    const target = car.lane + (dir === 'left' ? -1 : 1);
    const sweep = sim.speed * (LANE_CHANGE_TICKS / TICK_RATE);
    const unsafe = sim.obstacles.some((o) => {
      if (o.lane !== target) return false;
      const reach = (PLAYER_CAR.hitLength + TRAFFIC_BODY[o.kind].hitLength) / 2;
      return o.z > -reach && o.z < reach + sweep;
    });
    if (unsafe) return;
    if (applySteer(sim, team, dir) === 'ok') lastMove[dir] = sim.tick;
  };
}

describe('steering', () => {
  it('moves exactly one lane in the requested direction, animated over ~150 ms', () => {
    const sim = createSim(1);
    expect(sim.cars.blue.lane).toBe(START_LANE);
    expect(applySteer(sim, 'blue', 'right')).toBe('ok');
    stepSim(sim);
    expect(sim.cars.blue.x).toBeGreaterThan(START_LANE);
    expect(sim.cars.blue.x).toBeLessThan(START_LANE + 1);
    stepN(sim, LANE_CHANGE_TICKS);
    expect(sim.cars.blue.lane).toBe(START_LANE + 1);
    expect(sim.cars.blue.x).toBe(START_LANE + 1);
    expect(sim.cars.orange.lane).toBe(START_LANE);
    expect((LANE_CHANGE_TICKS / TICK_RATE) * 1000).toBeGreaterThanOrEqual(120);
    expect((LANE_CHANGE_TICKS / TICK_RATE) * 1000).toBeLessThanOrEqual(180);
  });

  it('ignores commands while a lane change is active instead of queueing them', () => {
    const sim = createSim(1);
    expect(applySteer(sim, 'orange', 'right')).toBe('ok');
    expect(applySteer(sim, 'orange', 'right')).toBe('busy');
    expect(applySteer(sim, 'orange', 'left')).toBe('busy');
    stepN(sim, LANE_CHANGE_TICKS + 2);
    expect(sim.cars.orange.lane).toBe(START_LANE + 1);
    expect(sim.cars.orange.moveTick).toBe(-1);
  });

  it('keeps cars within the four lanes', () => {
    const sim = createSim(1);
    for (let i = 0; i < 6; i++) {
      applySteer(sim, 'blue', 'left');
      stepN(sim, LANE_CHANGE_TICKS + 1);
    }
    expect(sim.cars.blue.lane).toBe(0);
    expect(applySteer(sim, 'blue', 'left')).toBe('edge');
    for (let i = 0; i < 6; i++) {
      applySteer(sim, 'blue', 'right');
      stepN(sim, LANE_CHANGE_TICKS + 1);
    }
    expect(sim.cars.blue.lane).toBe(LANES - 1);
    expect(applySteer(sim, 'blue', 'right')).toBe('edge');
  });
});

describe('fair traffic', () => {
  it('is identical regardless of how either team steers', () => {
    const a = createSim(12345);
    const b = createSim(12345);
    for (let tick = 0; tick < 60 * 40; tick++) {
      if (tick % 37 === 0) applySteer(b, 'blue', tick % 74 === 0 ? 'left' : 'right');
      if (tick % 23 === 0) applySteer(b, 'orange', 'right');
      // Keep both alive so the traffic comparison covers a long round.
      a.result = null;
      b.result = null;
      a.cars.blue.crashed = a.cars.orange.crashed = b.cars.blue.crashed = b.cars.orange.crashed = false;
      stepSim(a);
      stepSim(b);
      expect(trafficSignature(b)).toBe(trafficSignature(a));
    }
    expect(a.obstacles.length).toBeGreaterThan(0);
  });

  it('never blocks all four lanes and every wave transition is reachable', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const sim = createSim(seed * 7919);
      const waves: { distance: number; blocked: number[]; kinds: string[] }[] = [];
      let lastIndex = -1;
      while (sim.timeS < 150) {
        const w = sim.traffic.nextWave;
        if (w.index !== lastIndex) {
          waves.push({ distance: w.distance, blocked: w.blocked, kinds: w.kinds });
          lastIndex = w.index;
        }
        sim.result = null;
        sim.cars.blue.crashed = sim.cars.orange.crashed = false;
        stepSim(sim);
      }
      for (const w of waves) {
        expect(w.blocked.length).toBeGreaterThan(0);
        expect(w.blocked.length).toBeLessThan(LANES);
      }
      expect(waves.length).toBeGreaterThan(40);
    }
  });

  it('rejects transitions that look open but cannot be reached in time', () => {
    // Free lane jumps from 3 to 0: one empty lane per wave is not enough with a short gap.
    const moves = maxMovesBetween(9, 8.5, 0.74, 0.74, 0.9);
    expect(moves).toBeLessThan(3);
    expect(isTransitionReachable([0, 1, 2], [1, 2, 3], moves)).toBe(false);
    expect(isTransitionReachable([0, 1, 2], [0, 1, 2], 0)).toBe(true);
    expect(isTransitionReachable([0], [0, 1, 2, 3], 4)).toBe(false);
  });

  it('can be survived by a competent team for well past the target round length', () => {
    const survival: number[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const sim = createSim(seed * 104729);
      const blue = makeBot('blue');
      const orange = makeBot('orange');
      while (!sim.result && sim.timeS < 150) {
        blue(sim);
        orange(sim);
        stepSim(sim);
      }
      survival.push(sim.result ? sim.result.timeS : 150);
      expect(sim.result, `seed ${seed * 104729} crashed at ${sim.result?.timeS.toFixed(1)}s`).toBeNull();
    }
    expect(Math.min(...survival)).toBeGreaterThanOrEqual(150);
  });

  it('starts easy: the first ten seconds only contain single obstacles', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const sim = createSim(seed);
      while (sim.timeS < 10) {
        sim.result = null;
        stepSim(sim);
        const perWave = new Map<number, number>();
        for (const o of sim.obstacles) perWave.set(o.wave, (perWave.get(o.wave) ?? 0) + 1);
        for (const count of perWave.values()) expect(count).toBe(1);
      }
    }
  });

  it('an idle team crashes within the first obstacles', () => {
    const sim = createSim(99);
    while (!sim.result && sim.timeS < 30) stepSim(sim);
    expect(sim.result).not.toBeNull();
    expect(sim.result!.winner).toBe('draw');
  });
});

describe('collisions', () => {
  it('uses the moving car position during a lane change', () => {
    const obstacle = { lane: 2, z: 0, kind: 'car' as const };
    expect(carCollides({ x: 1 }, obstacle)).toBe(false);
    expect(carCollides({ x: 1.5 }, obstacle)).toBe(false);
    expect(carCollides({ x: 1.7 }, obstacle)).toBe(true);
    expect(carCollides({ x: 2 }, { ...obstacle, z: 0.9 })).toBe(false);
    expect(carCollides({ x: 2 }, { ...obstacle, z: 0.7 })).toBe(true);
  });

  it('declares the other team the winner when one car crashes', () => {
    const sim = createSim(5);
    // Orange dodges the first wave (which blocks the start lane); blue does nothing.
    applySteer(sim, 'orange', 'right');
    while (!sim.result && sim.timeS < 20) stepSim(sim);
    expect(sim.result).toEqual({ winner: 'orange', timeS: sim.timeS, crashed: ['blue'] });
    expect(sim.cars.blue.crashed).toBe(true);
    expect(sim.cars.orange.crashed).toBe(false);
    const tick = sim.tick;
    stepSim(sim);
    expect(sim.tick).toBe(tick);
  });

  it('declares a draw when both cars crash in the same step', () => {
    const sim = createSim(5);
    while (!sim.result && sim.timeS < 20) stepSim(sim);
    expect(sim.result?.winner).toBe('draw');
    expect(sim.result?.crashed.sort()).toEqual(['blue', 'orange']);
  });
});

import {
  DESPAWN_Z,
  DT,
  LANES,
  LANE_CHANGE_TICKS,
  PLAYER_CAR,
  SPAWN_Z,
  START_LANE,
  TEAMS,
  TRAFFIC_BODY,
  TRAFFIC_KINDS,
  levelAt,
  speedAt,
  type Direction,
  type Team,
  type TrafficKind,
} from '../constants';
import type { CarSnapshot, ObstacleTuple, RoundResult } from '../protocol';
import { createTraffic, planFollowingWave, type TrafficState } from './traffic';

export interface CarState {
  lane: number;
  fromLane: number;
  toLane: number;
  /** Ticks elapsed in the current lane change, or -1 when idle. */
  moveTick: number;
  x: number;
  crashed: boolean;
}

export interface Obstacle {
  id: number;
  wave: number;
  lane: number;
  z: number;
  kind: TrafficKind;
  color: number;
}

export interface SimState {
  seed: number;
  tick: number;
  timeS: number;
  distance: number;
  speed: number;
  cars: Record<Team, CarState>;
  obstacles: Obstacle[];
  traffic: TrafficState;
  nextObstacleId: number;
  result: RoundResult | null;
}

export type SteerOutcome = 'ok' | 'busy' | 'edge' | 'crashed' | 'over';

function createCar(): CarState {
  return { lane: START_LANE, fromLane: START_LANE, toLane: START_LANE, moveTick: -1, x: START_LANE, crashed: false };
}

export function createSim(seed: number): SimState {
  return {
    seed,
    tick: 0,
    timeS: 0,
    distance: 0,
    speed: speedAt(0),
    cars: { blue: createCar(), orange: createCar() },
    obstacles: [],
    traffic: createTraffic(seed),
    nextObstacleId: 1,
    result: null,
  };
}

/** Starts a one-lane move. Commands arriving while the car is already moving are dropped, not queued. */
export function applySteer(sim: SimState, team: Team, direction: Direction): SteerOutcome {
  if (sim.result) return 'over';
  const car = sim.cars[team];
  if (car.crashed) return 'crashed';
  if (car.moveTick >= 0) return 'busy';
  const target = car.lane + (direction === 'left' ? -1 : 1);
  if (target < 0 || target >= LANES) return 'edge';
  car.fromLane = car.lane;
  car.toLane = target;
  car.moveTick = 0;
  return 'ok';
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function advanceCar(car: CarState): void {
  if (car.moveTick < 0) return;
  car.moveTick++;
  const progress = Math.min(1, car.moveTick / LANE_CHANGE_TICKS);
  car.x = car.fromLane + (car.toLane - car.fromLane) * easeInOut(progress);
  if (progress >= 1) {
    car.lane = car.toLane;
    car.fromLane = car.toLane;
    car.x = car.lane;
    car.moveTick = -1;
  }
}

export function carCollides(car: Pick<CarState, 'x'>, obstacle: Pick<Obstacle, 'lane' | 'z' | 'kind'>): boolean {
  const body = TRAFFIC_BODY[obstacle.kind];
  return (
    Math.abs(obstacle.z) < (PLAYER_CAR.hitLength + body.hitLength) / 2 &&
    Math.abs(car.x - obstacle.lane) < (PLAYER_CAR.hitWidth + body.hitWidth) / 2
  );
}

function spawnTraffic(sim: SimState): void {
  while (sim.traffic.nextWave.distance - sim.distance <= SPAWN_Z) {
    const wave = sim.traffic.nextWave;
    wave.blocked.forEach((lane, i) => {
      sim.obstacles.push({
        id: sim.nextObstacleId++,
        wave: wave.index,
        lane,
        z: wave.distance - sim.distance,
        kind: wave.kinds[i],
        color: wave.colors[i],
      });
    });
    planFollowingWave(sim.traffic, sim.timeS, sim.distance);
  }
}

/** Advances the round by one fixed timestep. Both cars are evaluated before any outcome is decided. */
export function stepSim(sim: SimState): void {
  if (sim.result) return;
  for (const team of TEAMS) advanceCar(sim.cars[team]);

  sim.speed = speedAt(sim.timeS);
  const advance = sim.speed * DT;
  sim.distance += advance;
  for (const o of sim.obstacles) o.z -= advance;
  sim.obstacles = sim.obstacles.filter((o) => o.z > DESPAWN_Z);
  spawnTraffic(sim);

  sim.tick++;
  sim.timeS = sim.tick * DT;

  const crashed: Team[] = [];
  for (const team of TEAMS) {
    const car = sim.cars[team];
    if (sim.obstacles.some((o) => carCollides(car, o))) {
      car.crashed = true;
      crashed.push(team);
    }
  }
  if (crashed.length > 0) {
    const winner: RoundResult['winner'] = crashed.length === 2 ? 'draw' : crashed[0] === 'blue' ? 'orange' : 'blue';
    sim.result = { winner, timeS: sim.timeS, crashed };
  }
}

export function carSnapshot(car: CarState): CarSnapshot {
  return { x: round3(car.x), lane: car.lane, moving: car.moveTick >= 0, crashed: car.crashed };
}

export function trafficSnapshot(sim: SimState): ObstacleTuple[] {
  return sim.obstacles.map((o) => [o.id, o.lane, round3(o.z), TRAFFIC_KINDS.indexOf(o.kind), o.color]);
}

export function simLevel(sim: SimState): number {
  return levelAt(sim.timeS);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

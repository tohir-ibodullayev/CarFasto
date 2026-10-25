import type { Team } from '../../../shared/constants';
import type { CarSnapshot, Phase, Snapshot } from '../../../shared/protocol';

export interface ViewObstacle {
  id: number;
  lane: number;
  z: number;
  kind: number;
  color: number;
}

export interface ViewState {
  phase: Phase;
  round: number;
  timeS: number;
  distance: number;
  speed: number;
  level: number;
  countdownMs: number | null;
  cars: Record<Team, CarSnapshot>;
  traffic: ViewObstacle[];
}

const INTERP_DELAY_MS = 100;
/** ~5s at 20 Hz — enough for smooth interp plus a ~2s pre-crash replay lookback. */
const MAX_SNAPS = 100;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Buffers server snapshots and renders slightly in the past so motion stays smooth between
 * the 20 Hz updates. Server and client clocks are related through a filtered offset.
 */
export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  private offset: number | null = null;

  push(snap: Snapshot): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && (snap.round !== last.round || snap.tick < last.tick)) this.snaps = [];
    const sample = performance.now() - snap.serverTime;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    this.snaps.push(snap);
    if (this.snaps.length > MAX_SNAPS) this.snaps.splice(0, this.snaps.length - MAX_SNAPS);
  }

  clear(): void {
    this.snaps = [];
  }

  latest(): Snapshot | null {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  /** Snapshots covering [crash − lookback, crash + after], for client-side slow-mo replay. */
  captureClip(lookbackMs: number, afterCrashMs: number): Snapshot[] | null {
    const snaps = this.snaps;
    if (snaps.length < 2) return null;
    let crashIdx = snaps.findIndex((s) => s.cars.blue.crashed || s.cars.orange.crashed);
    if (crashIdx < 0) crashIdx = snaps.length - 1;
    const crashTime = snaps[crashIdx]!.serverTime;
    const startTime = crashTime - lookbackMs;
    const endTime = Math.min(snaps[snaps.length - 1]!.serverTime, crashTime + afterCrashMs);
    let from = 0;
    while (from < snaps.length - 1 && snaps[from + 1]!.serverTime < startTime) from++;
    const clip = snaps.filter((s) => s.serverTime >= snaps[from]!.serverTime && s.serverTime <= endTime);
    return clip.length >= 2 ? clip.map((s) => structuredClone(s)) : null;
  }

  sample(now = performance.now()): ViewState | null {
    if (this.snaps.length === 0 || this.offset === null) return null;
    const renderTime = now - this.offset - INTERP_DELAY_MS;
    return viewFromSnapshots(this.snaps, renderTime, this.snaps[this.snaps.length - 1]!.countdownMs);
  }
}

/** Interpolate a view at an absolute serverTime within a snapshot list. */
export function viewFromSnapshots(snaps: Snapshot[], renderTime: number, countdownMs?: number | null): ViewState | null {
  if (snaps.length === 0) return null;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i - 1]!.serverTime > renderTime) i--;
  const b = snaps[i]!;
  const a = snaps[Math.max(0, i - 1)]!;
  if (a === b || renderTime >= b.serverTime || b.tick === a.tick) {
    const base = toView(renderTime >= b.serverTime ? b : a);
    if (countdownMs !== undefined) base.countdownMs = countdownMs;
    return base;
  }
  const t = Math.min(1, Math.max(0, (renderTime - a.serverTime) / (b.serverTime - a.serverTime)));
  const byId = new Map(a.traffic.map((o) => [o[0], o]));
  return {
    phase: t < 1 ? a.phase : b.phase,
    round: b.round,
    timeS: lerp(a.timeS, b.timeS, t),
    distance: lerp(a.distance, b.distance, t),
    speed: lerp(a.speed, b.speed, t),
    level: b.level,
    countdownMs: countdownMs !== undefined ? countdownMs : b.countdownMs,
    cars: {
      blue: lerpCar(a.cars.blue, b.cars.blue, t),
      orange: lerpCar(a.cars.orange, b.cars.orange, t),
    },
    traffic: b.traffic.map((o) => {
      const prev = byId.get(o[0]);
      return { id: o[0], lane: o[1], z: prev ? lerp(prev[2], o[2], t) : o[2], kind: o[3], color: o[4] };
    }),
  };
}

function lerpCar(a: CarSnapshot, b: CarSnapshot, t: number): CarSnapshot {
  return { x: lerp(a.x, b.x, t), lane: t < 0.5 ? a.lane : b.lane, moving: a.moving || b.moving, crashed: b.crashed && t > 0.5 };
}

function toView(s: Snapshot): ViewState {
  return {
    phase: s.phase,
    round: s.round,
    timeS: s.timeS,
    distance: s.distance,
    speed: s.speed,
    level: s.level,
    countdownMs: s.countdownMs,
    cars: s.cars,
    traffic: s.traffic.map((o) => ({ id: o[0], lane: o[1], z: o[2], kind: o[3], color: o[4] })),
  };
}

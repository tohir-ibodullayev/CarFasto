import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../shared/protocol';
import { SnapshotBuffer, viewFromSnapshots } from '../client/src/lib/interpolation';
import { CrashReplay } from '../client/src/lib/replay';

function snap(partial: Partial<Snapshot> & Pick<Snapshot, 'tick' | 'serverTime'>): Snapshot {
  return {
    phase: 'playing',
    round: 1,
    timeS: partial.tick / 60,
    distance: partial.tick * 0.1,
    speed: 5,
    level: 1,
    countdownMs: null,
    cars: {
      blue: { x: 1, lane: 1, moving: false, crashed: false },
      orange: { x: 2, lane: 2, moving: false, crashed: false },
    },
    traffic: [[1, 0, 5, 0, 0]],
    ...partial,
  };
}

describe('SnapshotBuffer.captureClip', () => {
  it('keeps snapshots from before the crash through a short hold after', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i < 60; i++) {
      const crashed = i >= 50;
      buf.push(
        snap({
          tick: i,
          serverTime: 1000 + i * 50,
          cars: {
            blue: { x: 1, lane: 1, moving: false, crashed },
            orange: { x: 2, lane: 2, moving: false, crashed: false },
          },
        }),
      );
    }
    const clip = buf.captureClip(500, 150);
    expect(clip).not.toBeNull();
    expect(clip!.length).toBeGreaterThan(5);
    expect(clip![0]!.serverTime).toBeLessThanOrEqual(1000 + 50 * 50);
    expect(clip!.some((s) => s.cars.blue.crashed)).toBe(true);
    expect(clip![clip!.length - 1]!.serverTime).toBeGreaterThanOrEqual(1000 + 50 * 50);
  });
});

describe('viewFromSnapshots', () => {
  it('interpolates car x between neighboring snapshots', () => {
    const a = snap({
      tick: 1,
      serverTime: 1000,
      cars: {
        blue: { x: 0, lane: 0, moving: true, crashed: false },
        orange: { x: 1, lane: 1, moving: false, crashed: false },
      },
    });
    const b = snap({
      tick: 2,
      serverTime: 1100,
      cars: {
        blue: { x: 1, lane: 1, moving: true, crashed: false },
        orange: { x: 1, lane: 1, moving: false, crashed: false },
      },
    });
    const mid = viewFromSnapshots([a, b], 1050);
    expect(mid?.cars.blue.x).toBeCloseTo(0.5, 5);
  });
});

describe('CrashReplay', () => {
  it('plays slower than realtime and eventually completes', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i < 80; i++) {
      buf.push(
        snap({
          tick: i,
          serverTime: 5000 + i * 50,
          cars: {
            blue: { x: 1, lane: 1, moving: false, crashed: i >= 70 },
            orange: { x: 2, lane: 2, moving: false, crashed: false },
          },
        }),
      );
    }
    const start = 20_000;
    const replay = CrashReplay.tryStart(buf, start);
    expect(replay).not.toBeNull();
    const early = replay!.status(start + 200);
    expect(early.done).toBe(false);
    expect(early.progress).toBeGreaterThan(0);
    expect(early.progress).toBeLessThan(0.2);
    // Clip is ~2.45s of game time at ~0.4x → several seconds of wall time.
    expect(replay!.status(start + 30_000).done).toBe(true);
    const view = replay!.sample(start + 500);
    expect(view).not.toBeNull();
    expect(view!.cars.blue.crashed).toBe(false);
  });
});

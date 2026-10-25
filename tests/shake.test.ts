import { describe, expect, it } from 'vitest';
import { ShakeDetector } from '../client/src/lib/shake';

/** Feeds a sequence of linear-acceleration magnitudes at 60 Hz along a given axis. */
function feed(d: ShakeDetector, magnitudes: number[], startMs = 0, axis: 'x' | 'y' | 'z' = 'x') {
  let triggers = 0;
  magnitudes.forEach((m, i) => {
    const v = { x: 0, y: 0, z: 0, [axis]: i % 2 ? -m : m };
    if (d.process(v, null, startMs + i * 16.7).triggered) triggers++;
  });
  return triggers;
}

const calm = (n: number) => Array(n).fill(0.4);
const shake = (peak: number, n = 12) => Array.from({ length: n }, () => peak);

describe('ShakeDetector', () => {
  it('turns one physical shake (many high samples) into exactly one command', () => {
    const d = new ShakeDetector({ threshold: 13 });
    expect(feed(d, [...calm(10), ...shake(25, 20), ...calm(10)])).toBe(1);
  });

  it('works regardless of phone orientation', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const d = new ShakeDetector({ threshold: 13 });
      expect(feed(d, [...calm(5), ...shake(20), ...calm(5)], 0, axis)).toBe(1);
    }
  });

  it('needs motion to settle and the cooldown to pass before re-arming', () => {
    const d = new ShakeDetector({ threshold: 13, cooldownMs: 400, settleMs: 90 });
    // Two shakes separated by a 4-sample (67 ms) calm: too short to settle.
    expect(feed(d, [...shake(20, 6), ...calm(4), ...shake(20, 6)])).toBe(1);
    // Two shakes with a long enough calm between them count twice.
    const d2 = new ShakeDetector({ threshold: 13, cooldownMs: 400, settleMs: 90 });
    expect(feed(d2, [...shake(20, 6), ...calm(30), ...shake(20, 6)])).toBe(2);
  });

  it('ignores gentle movement and respects sensitivity', () => {
    const d = new ShakeDetector({ threshold: 13 });
    expect(feed(d, [...calm(5), ...shake(9), ...calm(5)])).toBe(0);
    d.setThreshold(7.5);
    expect(feed(d, [...calm(5), ...shake(9), ...calm(5)], 1000)).toBe(1);
  });

  it('handles null and missing sensor values safely', () => {
    const d = new ShakeDetector();
    expect(d.process(null, null, 0)).toEqual({ magnitude: null, triggered: false });
    expect(d.process({ x: null, y: 1, z: 2 }, { x: null, y: null, z: null }, 10)).toEqual({ magnitude: null, triggered: false });
    expect(d.process({ x: NaN, y: 0, z: 0 }, undefined, 20).magnitude).toBeNull();
  });

  it('filters gravity when only accelerationIncludingGravity is available', () => {
    const d = new ShakeDetector({ threshold: 13 });
    let triggers = 0;
    let t = 0;
    // Phone resting flat: 9.81 m/s² on z must not count as a shake.
    for (let i = 0; i < 60; i++) if (d.process(null, { x: 0, y: 0, z: 9.81 }, (t += 16.7)).triggered) triggers++;
    expect(triggers).toBe(0);
    // A vigorous shake along x on top of gravity.
    for (let i = 0; i < 10; i++) if (d.process(null, { x: i % 2 ? -30 : 30, y: 0, z: 9.81 }, (t += 16.7)).triggered) triggers++;
    expect(triggers).toBe(1);
  });

  it('reset() discards an in-progress shake so nothing fires on resume', () => {
    const d = new ShakeDetector({ threshold: 13 });
    d.reset(0);
    expect(feed(d, shake(25, 20), 10)).toBe(0);
    expect(feed(d, [...calm(30), ...shake(25, 5)], 1000)).toBe(1);
  });
});

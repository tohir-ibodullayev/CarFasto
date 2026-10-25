export interface Vec3Like {
  x: number | null | undefined;
  y: number | null | undefined;
  z: number | null | undefined;
}

export const SENSITIVITY_LEVELS = [
  { label: 'Very low', threshold: 22 },
  { label: 'Low', threshold: 17 },
  { label: 'Normal', threshold: 13 },
  { label: 'High', threshold: 10 },
  { label: 'Very high', threshold: 7.5 },
] as const;
export const DEFAULT_SENSITIVITY = 2;

export interface ShakeOptions {
  /** Linear acceleration magnitude (m/s², gravity removed) that counts as a shake. */
  threshold: number;
  /** Re-arm only once the magnitude falls below threshold * rearmRatio ... */
  rearmRatio: number;
  /** ... and stays there for this long. */
  settleMs: number;
  /** Minimum time between two shakes. */
  cooldownMs: number;
  /** Low-pass factor used to estimate gravity when only accelerationIncludingGravity exists. */
  gravityAlpha: number;
}

export const DEFAULT_SHAKE_OPTIONS: ShakeOptions = {
  threshold: SENSITIVITY_LEVELS[DEFAULT_SENSITIVITY].threshold,
  rearmRatio: 0.35,
  settleMs: 90,
  cooldownMs: 400,
  gravityAlpha: 0.8,
};

const GRAVITY_WARMUP_SAMPLES = 10;

function finite(v: Vec3Like | null | undefined): v is { x: number; y: number; z: number } {
  return (
    !!v &&
    typeof v.x === 'number' &&
    typeof v.y === 'number' &&
    typeof v.z === 'number' &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

export interface ShakeSample {
  /** Orientation-independent linear acceleration magnitude, or null if the sample had no usable data. */
  magnitude: number | null;
  triggered: boolean;
}

/**
 * Turns device-motion samples into discrete shakes: one physical shake yields one trigger.
 * A trigger disarms the detector; it re-arms only after motion settles and the cooldown passes.
 */
export class ShakeDetector {
  options: ShakeOptions;
  private gravity: [number, number, number] | null = null;
  private gravitySamples = 0;
  private armed = true;
  private calmSince: number | null = null;
  private lastTrigger = -Infinity;

  constructor(options: Partial<ShakeOptions> = {}) {
    this.options = { ...DEFAULT_SHAKE_OPTIONS, ...options };
  }

  setThreshold(threshold: number): void {
    this.options = { ...this.options, threshold };
  }

  /** Forget in-progress motion: the next shake must start from a settled phone. */
  reset(now: number): void {
    this.armed = false;
    this.calmSince = null;
    this.lastTrigger = now;
  }

  process(acceleration: Vec3Like | null | undefined, withGravity: Vec3Like | null | undefined, now: number): ShakeSample {
    let magnitude: number;
    if (finite(acceleration)) {
      magnitude = Math.hypot(acceleration.x, acceleration.y, acceleration.z);
    } else if (finite(withGravity)) {
      const a = this.options.gravityAlpha;
      if (!this.gravity) this.gravity = [withGravity.x, withGravity.y, withGravity.z];
      const g = this.gravity;
      g[0] = a * g[0] + (1 - a) * withGravity.x;
      g[1] = a * g[1] + (1 - a) * withGravity.y;
      g[2] = a * g[2] + (1 - a) * withGravity.z;
      this.gravitySamples++;
      magnitude = Math.hypot(withGravity.x - g[0], withGravity.y - g[1], withGravity.z - g[2]);
      if (this.gravitySamples < GRAVITY_WARMUP_SAMPLES) return { magnitude, triggered: false };
    } else {
      return { magnitude: null, triggered: false };
    }

    const { threshold, rearmRatio, settleMs, cooldownMs } = this.options;
    if (!this.armed) {
      if (magnitude < threshold * rearmRatio) {
        this.calmSince ??= now;
        if (now - this.calmSince >= settleMs && now - this.lastTrigger >= cooldownMs) this.armed = true;
      } else {
        this.calmSince = null;
      }
    }
    if (this.armed && magnitude >= threshold && now - this.lastTrigger >= cooldownMs) {
      this.armed = false;
      this.calmSince = null;
      this.lastTrigger = now;
      return { magnitude, triggered: true };
    }
    return { magnitude, triggered: false };
  }
}

import type { Snapshot } from '../../../shared/protocol';
import { SnapshotBuffer, type ViewState, viewFromSnapshots } from './interpolation';

const LOOKBACK_MS = 2000;
const AFTER_CRASH_MS = 450;
/** Playback rate for most of the clip (1 = realtime). */
const BASE_RATE = 0.48;
/** Slower rate for the final stretch into the impact. */
const FINALE_RATE = 0.28;
/** How much of the clip (from the end) uses FINALE_RATE, in clip-time ms. */
const FINALE_CLIP_MS = 700;

export interface ReplayStatus {
  active: boolean;
  progress: number;
  done: boolean;
}

/**
 * Slow-motion playback of buffered snapshots covering the moments before a crash.
 * Client-only — uses the host/display snapshot ring, no server changes.
 */
export class CrashReplay {
  private readonly snaps: Snapshot[];
  private readonly t0: number;
  private readonly t1: number;
  private readonly wallStart: number;
  private readonly wallDuration: number;

  private constructor(snaps: Snapshot[], wallStart: number) {
    this.snaps = snaps;
    this.t0 = snaps[0]!.serverTime;
    this.t1 = snaps[snaps.length - 1]!.serverTime;
    this.wallStart = wallStart;
    this.wallDuration = wallMsForClip(this.t1 - this.t0);
  }

  static tryStart(buffer: SnapshotBuffer, now = performance.now()): CrashReplay | null {
    const snaps = buffer.captureClip(LOOKBACK_MS, AFTER_CRASH_MS);
    if (!snaps || snaps.length < 2) return null;
    return new CrashReplay(snaps, now);
  }

  sample(now = performance.now()): ViewState | null {
    const clipT = clipTimeAtWall(now - this.wallStart, this.t1 - this.t0);
    const target = this.t0 + Math.min(this.t1 - this.t0, Math.max(0, clipT));
    return viewFromSnapshots(this.snaps, target);
  }

  status(now = performance.now()): ReplayStatus {
    const elapsed = now - this.wallStart;
    const done = elapsed >= this.wallDuration;
    return {
      active: !done,
      progress: Math.min(1, elapsed / this.wallDuration),
      done,
    };
  }
}

function wallMsForClip(clipDuration: number): number {
  const finale = Math.min(FINALE_CLIP_MS, clipDuration);
  const head = clipDuration - finale;
  return head / BASE_RATE + finale / FINALE_RATE;
}

/** Map wall-clock elapsed ms → clip-time ms with a slower finale. */
function clipTimeAtWall(elapsedWall: number, clipDuration: number): number {
  const finale = Math.min(FINALE_CLIP_MS, clipDuration);
  const head = clipDuration - finale;
  const headWall = head / BASE_RATE;
  if (elapsedWall <= headWall) return elapsedWall * BASE_RATE;
  return head + (elapsedWall - headWall) * FINALE_RATE;
}

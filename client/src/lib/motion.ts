import type { Vec3Like } from './shake';

export type MotionPermission = 'granted' | 'denied' | 'unsupported';

interface PermissionCapableMotionEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export function motionSupport() {
  const supported = typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  const needsPermission =
    supported && typeof (DeviceMotionEvent as unknown as PermissionCapableMotionEvent).requestPermission === 'function';
  return { supported, needsPermission, secure: window.isSecureContext };
}

/**
 * Must be called synchronously from a click/tap handler: iOS only shows the permission
 * prompt when requestPermission() runs inside the user gesture.
 */
export function requestMotionPermission(): Promise<MotionPermission> {
  if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return Promise.resolve('unsupported');
  const request = (DeviceMotionEvent as unknown as PermissionCapableMotionEvent).requestPermission;
  if (typeof request !== 'function') return Promise.resolve('granted');
  return request
    .call(DeviceMotionEvent)
    .then((r) => (r === 'granted' ? 'granted' : 'denied'))
    .catch(() => 'denied' as const);
}

export type MotionListener = (acceleration: Vec3Like | null, withGravity: Vec3Like | null, now: number) => void;

export function listenMotion(listener: MotionListener): () => void {
  const handler = (e: DeviceMotionEvent) => listener(e.acceleration, e.accelerationIncludingGravity, performance.now());
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}

/** Screen wake lock with automatic re-acquire when the page becomes visible again. */
export class WakeLockKeeper {
  private sentinel: { release: () => Promise<void>; released?: boolean } | null = null;
  private wanted = false;
  status: 'idle' | 'active' | 'unsupported' | 'failed' = 'idle';
  onChange: (status: WakeLockKeeper['status']) => void = () => {};

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') void this.acquire();
    });
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<any> } };
    if (!nav.wakeLock) return this.set('unsupported');
    if (this.sentinel && !this.sentinel.released) return;
    try {
      this.sentinel = await nav.wakeLock.request('screen');
      this.set('active');
      (this.sentinel as any).addEventListener?.('release', () => {
        if (document.visibilityState !== 'visible') this.set('idle');
      });
    } catch {
      this.set('failed');
    }
  }

  private set(status: WakeLockKeeper['status']) {
    this.status = status;
    this.onChange(status);
  }
}

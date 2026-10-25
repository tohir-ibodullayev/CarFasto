import { useEffect, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { TEAM_LABEL, roleDirection, roleTeam, type Role } from '../../../shared/constants';
import { sfx } from '../lib/audio';
import type { ConnState } from '../lib/net';

export function ConnPill({ state }: { state: ConnState }) {
  const label = { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline' }[state];
  return (
    <span className={`pill conn-${state}`}>
      <span className="dot" /> {label}
    </span>
  );
}

export function QrCode({ value, size = 280 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: 'M', color: { dark: '#0a0c12', light: '#ffffff' } })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size]);
  return src ? (
    <img className="qr" src={src} width={size} height={size} alt={`QR code for ${value}`} />
  ) : (
    <div className="qr" style={{ width: size, height: size }} />
  );
}

export function roleLabel(role: Role): string {
  return `${TEAM_LABEL[roleTeam(role)]} · ${roleDirection(role) === 'left' ? 'Left' : 'Right'}`;
}

export function Arrow({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg className="arrow-svg" viewBox="0 0 100 100" aria-hidden="true">
      <path
        d="M62 12 L24 50 L62 88 L62 66 L84 66 L84 34 L62 34 Z"
        transform={direction === 'right' ? 'translate(100,0) scale(-1,1)' : undefined}
        fill="currentColor"
      />
    </svg>
  );
}

export function MuteButton() {
  const muted = useSyncExternalStore(
    (cb) => sfx.subscribe(cb),
    () => sfx.muted,
  );
  return (
    <button
      className="btn btn-ghost btn-small"
      onClick={() => {
        sfx.unlock();
        sfx.setMuted(!muted);
      }}
      aria-label={muted ? 'Unmute sound' : 'Mute sound'}
    >
      {muted ? 'Sound: off' : 'Sound: on'}
    </button>
  );
}

/** Re-renders periodically, for countdown labels. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

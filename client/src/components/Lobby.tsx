import { ROLES, TEAM_LABEL, roleDirection, roleTeam, type Role } from '../../../shared/constants';
import type { PublicPlayer, RoomState } from '../../../shared/protocol';
import type { ConnState } from '../lib/net';
import { SIM_KEYS } from '../lib/simBots';
import { Arrow, ConnPill, MuteButton, QrCode, useNow } from './common';

interface LobbyProps {
  room: RoomState;
  joinUrl: string;
  conn: ConnState;
  isHost: boolean;
  testFlash: Partial<Record<Role, number>>;
  onStart?: () => void;
  onKick?: (role: Role) => void;
  sim?: { roles: Role[]; autopilot: boolean; onAutopilot: (on: boolean) => void; onFill: () => void; onClear: () => void } | null;
  error?: string | null;
}

function motionChip(p: PublicPlayer) {
  switch (p.motion) {
    case 'motion':
      return <span className="chip chip-ok">Motion</span>;
    case 'touch':
      return <span className="chip chip-warn">TOUCH FALLBACK</span>;
    case 'sim':
      return <span className="chip chip-sim">KEYBOARD SIM</span>;
    default:
      return <span className="chip">Setting up controls</span>;
  }
}

function Slot({ role, player, flash, isHost, onKick, now }: {
  role: Role;
  player: PublicPlayer | null;
  flash: boolean;
  isHost: boolean;
  onKick?: (role: Role) => void;
  now: number;
}) {
  const team = roleTeam(role);
  const dir = roleDirection(role);
  return (
    <div className={`slot slot-${team} ${player ? 'slot-filled' : ''} ${flash ? 'slot-flash' : ''}`}>
      <div className="slot-head">
        <span className="slot-role">
          {dir === 'left' && <Arrow direction="left" />}
          {TEAM_LABEL[team].toUpperCase()} · {dir.toUpperCase()}
          {dir === 'right' && <Arrow direction="right" />}
        </span>
        {player && isHost && onKick && (
          <button className="btn btn-ghost btn-tiny" onClick={() => onKick(role)} title="Free this seat">
            Remove
          </button>
        )}
      </div>
      {player ? (
        <>
          <div className="slot-name">{player.name}</div>
          <div className="chips">
            {player.connected ? (
              <span className="chip chip-ok">Connected</span>
            ) : (
              <span className="chip chip-bad">
                Reconnecting
                {player.reservedUntil ? ` · seat held ${Math.max(0, Math.ceil((player.reservedUntil - now) / 1000))}s` : ''}
              </span>
            )}
            {motionChip(player)}
            {player.shakeTested ? <span className="chip chip-ok">Shake tested</span> : <span className="chip">Not tested</span>}
            {player.ready ? <span className="chip chip-ready">READY</span> : <span className="chip">Not ready</span>}
          </div>
        </>
      ) : (
        <div className="slot-empty">Waiting for a player…</div>
      )}
    </div>
  );
}

export function Lobby({ room, joinUrl, conn, isHost, testFlash, onStart, onKick, sim, error }: LobbyProps) {
  const now = useNow(500);
  const perfNow = performance.now();
  const missing = ROLES.filter((r) => !room.players[r]).length;
  const notReady = ROLES.filter((r) => room.players[r] && !(room.players[r]!.ready && room.players[r]!.connected)).length;
  const isLocalhost = /^(localhost|127\.|\[::1\])/.test(new URL(joinUrl).hostname);
  const isHttps = joinUrl.startsWith('https://');
  const displayUrl = `${window.location.origin}/display/${room.code}`;

  let startHint = 'Everyone is ready!';
  if (!room.hostConnected) startHint = 'Host screen disconnected';
  else if (missing > 0) startHint = `Waiting for ${missing} more player${missing === 1 ? '' : 's'}`;
  else if (notReady > 0) startHint = `Waiting for ${notReady} player${notReady === 1 ? '' : 's'} to be ready`;

  return (
    <main className="lobby">
      <header className="lobby-header">
        <div className="logo logo-small">
          <span className="logo-blue">SPLIT</span> <span className="logo-orange">STEERING</span>
        </div>
        <div className="header-right">
          {!isHost && <span className="pill">Read-only display</span>}
          <ConnPill state={conn} />
          {isHost && <MuteButton />}
        </div>
      </header>

      <div className="lobby-body">
        <section className="join-panel">
          <h2>Scan to join</h2>
          <QrCode value={joinUrl} size={260} />
          <div className="room-code" aria-label="Room code">
            {room.code}
          </div>
          <div className="join-url">{joinUrl.replace(/^https?:\/\//, '')}</div>
          {isLocalhost && (
            <p className="warn">
              Phones cannot open <b>localhost</b>. Open this host page through your LAN address or an HTTPS tunnel, or set{' '}
              <code>PUBLIC_ORIGIN</code>.
            </p>
          )}
          {!isHttps && !isLocalhost && (
            <p className="warn">
              This link is not HTTPS, so phones will need the <b>touch fallback</b>. Motion sensors require HTTPS.
            </p>
          )}
        </section>

        <section className="slots-panel">
          <div className="slots">
            {ROLES.map((role) => (
              <Slot
                key={role}
                role={role}
                player={room.players[role]}
                flash={perfNow - (testFlash[role] ?? -1e9) < 700}
                isHost={isHost && room.phase === 'lobby'}
                onKick={onKick}
                now={now}
              />
            ))}
          </div>

          {isHost && (
            <div className="start-row">
              <button className="btn btn-primary btn-xl btn-start" disabled={!room.canStart} onClick={onStart}>
                Start race
              </button>
              <p className={room.canStart ? 'hint hint-ok' : 'hint'}>{startHint}</p>
              {error && <p className="error">{error}</p>}
            </div>
          )}
          {!isHost && <p className="hint">Waiting for the host to start the race…</p>}

          {isHost && sim && (
            <div className="sim-panel">
              <div className="sim-title">KEYBOARD SIMULATION (DEV ONLY)</div>
              <p>
                Fills empty seats with simulated controllers. Each one is a separate Socket.IO client that goes through the same
                join, ready and steering validation as a phone.
              </p>
              <div className="sim-keys">
                {ROLES.map((r) => (
                  <span key={r} className={`chip ${sim.roles.includes(r) ? 'chip-sim' : ''}`}>
                    {TEAM_LABEL[roleTeam(r)]} {roleDirection(r)}: <b>{SIM_KEYS[r].label}</b>
                  </span>
                ))}
              </div>
              <div className="sim-actions">
                <button className="btn btn-secondary btn-small" onClick={sim.onFill} disabled={missing === 0}>
                  Fill empty seats with simulated players
                </button>
                {sim.roles.length > 0 && (
                  <button className="btn btn-ghost btn-small" onClick={sim.onClear}>
                    Remove simulated players
                  </button>
                )}
              </div>
              <label className="sim-toggle">
                <input type="checkbox" checked={sim.autopilot} onChange={(e) => sim.onAutopilot(e.target.checked)} />
                Autopilot for simulated players (toggle with <b>P</b>): they steer their own direction automatically, so one real
                phone can be tested alone.
              </label>
            </div>
          )}

          {isHost && (
            <p className="small-print">
              Optional second screen (read-only): <a href={displayUrl} target="_blank" rel="noreferrer">{displayUrl}</a>
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ROLES, TEAM_LABEL, roleFor, type Role } from '../../../shared/constants';
import type { RoomState } from '../../../shared/protocol';
import type { SnapshotBuffer } from '../lib/interpolation';
import type { ConnState } from '../lib/net';
import { GameRenderer, formatTime } from '../lib/renderer';
import { SIM_KEYS } from '../lib/simBots';
import { ConnPill, MuteButton, roleLabel, useNow } from './common';

interface Props {
  room: RoomState;
  buffer: SnapshotBuffer;
  conn: ConnState;
  isHost: boolean;
  onAction?: (action: 'resume' | 'playAgain' | 'toLobby') => void;
  simRoles?: Role[];
  autopilot?: boolean;
  error?: string | null;
}

export function GameScreen({ room, buffer, conn, isHost, onAction, simRoles = [], autopilot = false, error }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const [showResult, setShowResult] = useState(false);
  const now = useNow(500);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const renderer = new GameRenderer(isHost);
    let raf = 0;
    const frame = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer.draw(ctx, w, h, buffer.sample(), roomRef.current, performance.now());
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [buffer, isHost]);

  useEffect(() => {
    if (room.phase !== 'finished') {
      setShowResult(false);
      return;
    }
    const id = setTimeout(() => setShowResult(true), 1100);
    return () => clearTimeout(id);
  }, [room.phase, room.round]);

  const result = room.result;
  const winnerTeam = result && result.winner !== 'draw' ? result.winner : null;

  return (
    <div className="game">
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="game-topbar">
        <ConnPill state={conn} />
        {!isHost && <span className="pill">Read-only display</span>}
        {isHost && <MuteButton />}
      </div>
      {simRoles.length > 0 && (
        <div className="sim-legend">
          <span>KEYBOARD SIM (DEV)</span>
          <span>Autopilot {autopilot ? 'ON' : 'off'} (P)</span>
          {simRoles.map((r) => (
            <span key={r}>
              {roleLabel(r)}: <b>{SIM_KEYS[r].label}</b>
            </span>
          ))}
        </div>
      )}

      {room.phase === 'paused' && room.pause && (
        <div className="overlay">
          <div className="overlay-card">
            <h1 className="overlay-title">PAUSED</h1>
            {room.pause.missing.length > 0 ? (
              <ul className="missing">
                {room.pause.missing.map((m) => {
                  const reserved = m.role !== 'host' ? room.players[m.role]?.reservedUntil : null;
                  return (
                    <li key={m.role}>
                      <b>{m.name}</b> {m.role === 'host' ? '' : `(${roleLabel(m.role)})`}{' '}
                      {m.abandoned
                        ? 'did not return. End the round to go back to the lobby.'
                        : `disconnected${reserved ? `, seat held for ${Math.max(0, Math.ceil((reserved - now) / 1000))}s` : ''}`}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="overlay-sub">Everyone is back. {isHost ? 'Press Resume for a 3-second countdown.' : 'Waiting for the host to resume.'}</p>
            )}
            {isHost && onAction && (
              <div className="overlay-actions">
                <button className="btn btn-primary btn-xl" disabled={!room.canResume} onClick={() => onAction('resume')}>
                  Resume
                </button>
                <button className="btn btn-ghost" onClick={() => onAction('toLobby')}>
                  End round · back to lobby
                </button>
              </div>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      )}

      {room.phase === 'finished' && showResult && result && (
        <div className="overlay overlay-result">
          <div className={`overlay-card result-card ${winnerTeam ? `result-${winnerTeam}` : 'result-draw'}`}>
            <div className="result-kicker">{winnerTeam ? 'WINNER' : 'BOTH CARS CRASHED'}</div>
            <h1 className="result-title">{winnerTeam ? `${TEAM_LABEL[winnerTeam].toUpperCase()} TEAM WINS!` : "IT'S A DRAW!"}</h1>
            {winnerTeam && (
              <p className="result-names">
                {room.players[roleFor(winnerTeam, 'left')]?.name ?? '?'} &amp; {room.players[roleFor(winnerTeam, 'right')]?.name ?? '?'}
              </p>
            )}
            <p className="result-time">Survived {formatTime(result.timeS)}</p>
            {isHost && onAction && (
              <div className="overlay-actions">
                <button
                  className="btn btn-primary btn-xl"
                  disabled={!ROLES.every((r) => room.players[r]?.connected)}
                  onClick={() => onAction('playAgain')}
                >
                  Play again
                </button>
                <button className="btn btn-ghost" onClick={() => onAction('toLobby')}>
                  Back to lobby
                </button>
              </div>
            )}
            {!isHost && <p className="overlay-sub">Waiting for the host…</p>}
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

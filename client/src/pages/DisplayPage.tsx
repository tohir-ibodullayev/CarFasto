import { useEffect, useRef, useState } from 'react';
import type { RoomState, ServerConfig, Snapshot } from '../../../shared/protocol';
import { GameScreen } from '../components/GameScreen';
import { Lobby } from '../components/Lobby';
import { SnapshotBuffer } from '../lib/interpolation';
import { createSocket, loadServerConfig, publicOrigin, request, trackConnection, type ConnState } from '../lib/net';

/** Read-only mirror of a match for a second screen. */
export function DisplayPage({ code }: { code: string }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef(new SnapshotBuffer());

  useEffect(() => {
    void loadServerConfig().then(setConfig);
    const socket = createSocket();
    const untrack = trackConnection(socket, setConn);
    socket.on('room:state', (s: RoomState) => setRoom(s));
    socket.on('game:snapshot', (s: Snapshot) => bufferRef.current.push(s));
    socket.on('connect', async () => {
      const res = await request<{ ok: true; state: RoomState; snapshot: Snapshot | null }>(socket, 'room:watch', {
        code,
        display: true,
      });
      if (!res.ok) return setError(res.message);
      setError(null);
      setRoom(res.state);
      if (res.snapshot) bufferRef.current.push(res.snapshot);
    });
    return () => {
      untrack();
      socket.disconnect();
    };
  }, [code]);

  if (error || !room) {
    return (
      <main className="center-screen">
        <div className="panel">
          <h1>Display · {code}</h1>
          <p className={error ? 'error' : 'hint'}>{error ?? 'Connecting…'}</p>
        </div>
      </main>
    );
  }

  if (room.phase === 'lobby') {
    return (
      <Lobby room={room} joinUrl={room.joinUrl ?? `${publicOrigin(config)}/join/${room.code}`} conn={conn} isHost={false} testFlash={{}} />
    );
  }
  return <GameScreen room={room} buffer={bufferRef.current} conn={conn} isHost={false} />;
}

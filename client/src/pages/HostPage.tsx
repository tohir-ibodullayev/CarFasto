import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { ROLES, type Role } from '../../../shared/constants';
import type { RoomState, ServerConfig, Snapshot } from '../../../shared/protocol';
import { GameScreen } from '../components/GameScreen';
import { Lobby } from '../components/Lobby';
import { sfx } from '../lib/audio';
import { SnapshotBuffer } from '../lib/interpolation';
import { createSocket, loadServerConfig, resolveJoinUrl, request, trackConnection, type ConnState } from '../lib/net';
import { navigate, storageGet, storageSet } from '../lib/router';
import { SIM_KEYS, SimBots } from '../lib/simBots';

interface HostCreds {
  code: string;
  hostToken: string;
}

type HostAck = { ok: true; code: string; hostToken?: string; state: RoomState; snapshot?: Snapshot | null };

export function HostPage({ initialCode }: { initialCode: string | null }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testFlash, setTestFlash] = useState<Partial<Record<Role, number>>>({});
  const [bots, setBots] = useState<SimBots | null>(null);
  const [botRoles, setBotRoles] = useState<Role[]>([]);
  const [autopilot, setAutopilot] = useState(false);
  const autopilotRef = useRef<{ bots: SimBots | null; on: boolean }>({ bots: null, on: false });
  autopilotRef.current = { bots, on: autopilot };
  const bufferRef = useRef(new SnapshotBuffer());
  const socketRef = useRef<Socket | null>(null);
  const credsRef = useRef<HostCreds | null>(null);

  useEffect(() => {
    void loadServerConfig().then(setConfig);
    const socket = createSocket();
    socketRef.current = socket;
    const untrack = trackConnection(socket, setConn);
    socket.on('room:state', (s: RoomState) => setRoom(s));
    socket.on('game:snapshot', (s: Snapshot) => {
      bufferRef.current.push(s);
      const ap = autopilotRef.current;
      if (ap.on && ap.bots) ap.bots.autopilot(s);
    });
    socket.on('lobby:test', ({ role }: { role: Role }) => {
      setTestFlash((f) => ({ ...f, [role]: performance.now() }));
      sfx.blip();
    });
    socket.on('host:replaced', () => setFatal('This game is now being hosted from another tab or device.'));
    socket.on('connect', async () => {
      const saved = credsRef.current ?? (initialCode ? storageGet<HostCreds>(localStorage, `ss-host-${initialCode}`) : null);
      if (saved) {
        const res = await request<HostAck>(socket, 'host:attach', saved);
        if (res.ok) {
          credsRef.current = saved;
          setRoom(res.state);
          if (res.snapshot) bufferRef.current.push(res.snapshot);
          setFatal(null);
        } else {
          setFatal(res.error === 'room_not_found' ? 'This game no longer exists (rooms expire when unused).' : res.message);
        }
        return;
      }
      if (initialCode) {
        setFatal(`This browser does not hold the host key for room ${initialCode}.`);
        return;
      }
      const res = await request<HostAck>(socket, 'host:create');
      if (!res.ok) {
        setFatal(res.message);
        return;
      }
      const creds = { code: res.code, hostToken: res.hostToken! };
      credsRef.current = creds;
      storageSet(localStorage, `ss-host-${res.code}`, creds);
      navigate(`/host/${res.code}`, true);
      setRoom(res.state);
    });
    const unlock = () => sfx.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      untrack();
      socket.disconnect();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [initialCode]);

  const code = room?.code ?? null;
  useEffect(() => {
    if (!code || !config?.simEnabled) return;
    const b = new SimBots(code);
    setBots(b);
    void b.restore().then(() => setBotRoles(b.roles));
    return () => b.dispose();
  }, [code, config?.simEnabled]);

  useEffect(() => {
    if (!bots) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'KeyP') {
        setAutopilot((on) => !on);
        return;
      }
      const role = ROLES.find((r) => SIM_KEYS[r].codes.includes(e.code));
      if (role && bots.roles.includes(role)) {
        e.preventDefault();
        void bots.press(role);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bots]);

  const act = useCallback(async (action: string, extra: object = {}) => {
    const socket = socketRef.current;
    const creds = credsRef.current;
    if (!socket || !creds) return;
    sfx.unlock();
    const res = await request<{ ok: true }>(socket, 'host:action', { ...creds, action, ...extra });
    setError(res.ok ? null : res.message);
    if (res.ok && action === 'toLobby') bufferRef.current.clear();
  }, []);

  if (fatal) {
    return (
      <main className="center-screen">
        <div className="panel">
          <h1>Host screen</h1>
          <p className="error">{fatal}</p>
          <button
            className="btn btn-primary"
            onClick={() => {
              window.location.href = '/host';
            }}
          >
            Create a new game
          </button>
        </div>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="center-screen">
        <div className="panel">
          <h1>Creating game…</h1>
          <p className="hint">{conn === 'connected' ? 'Setting up your room.' : 'Connecting to the game server…'}</p>
        </div>
      </main>
    );
  }

  const joinUrl = resolveJoinUrl(room.joinUrl, room.code, config);

  if (room.phase === 'lobby') {
    return (
      <Lobby
        room={room}
        joinUrl={joinUrl}
        conn={conn}
        isHost
        testFlash={testFlash}
        error={error}
        onStart={() => act('start')}
        onKick={(role) => {
          if (bots?.roles.includes(role)) {
            bots.remove(role);
            setBotRoles(bots.roles);
          }
          void act('kick', { role });
        }}
        sim={
          bots && room.simEnabled
            ? {
                roles: botRoles,
                autopilot,
                onAutopilot: setAutopilot,
                onFill: async () => {
                  await bots.fill(ROLES.filter((r) => !room.players[r]));
                  setBotRoles(bots.roles);
                },
                onClear: async () => {
                  await bots.removeAll();
                  setBotRoles(bots.roles);
                },
              }
            : null
        }
      />
    );
  }

  return (
    <GameScreen
      room={room}
      buffer={bufferRef.current}
      conn={conn}
      isHost
      error={error}
      simRoles={botRoles}
      autopilot={autopilot}
      onAction={async (action) => {
        await act(action);
        if (action === 'toLobby' && bots) await bots.readyAll().catch(() => {});
      }}
    />
  );
}

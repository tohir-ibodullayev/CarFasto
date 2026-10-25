import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { CODE_LENGTH, NAME_MAX_LENGTH, ROLES, TEAM_LABEL, roleDirection, roleTeam, type Role } from '../../../shared/constants';
import type { InputAck, JoinOk, RoomState, ServerConfig } from '../../../shared/protocol';
import { normalizeRoomCode } from '../../../shared/validation';
import { Arrow, ConnPill, roleLabel } from '../components/common';
import { listenMotion, motionSupport, requestMotionPermission, WakeLockKeeper } from '../lib/motion';
import { createSocket, loadServerConfig, request, trackConnection, type ConnState } from '../lib/net';
import { navigate, storageGet, storageSet } from '../lib/router';
import { DEFAULT_SENSITIVITY, SENSITIVITY_LEVELS, ShakeDetector } from '../lib/shake';

interface Session {
  role: Role;
  sessionToken: string;
  name: string;
}

type MotionMode = 'pending' | 'motion' | 'touch';
type MotionIssue = null | 'denied' | 'unsupported' | 'nodata';
type Flash = { t: number; ok: boolean; text: string };

const REJECT_TEXT: Record<string, string> = {
  busy: 'Car already moving',
  edge: 'Road edge!',
  rate_limited: 'Too fast',
  duplicate: 'Duplicate',
  inactive: 'Not racing right now',
  stale: 'Old input dropped',
  crashed: 'Crashed',
  not_joined: 'Not joined',
  offline: 'Offline: not sent',
  timeout: 'No answer from server',
};

export function ControllerPage({ initialCode }: { initialCode: string | null }) {
  const code = initialCode;
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState(storageGet<string>(localStorage, 'ss-name') ?? '');
  const [pickedRole, setPickedRole] = useState<Role | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [motionMode, setMotionMode] = useState<MotionMode>('pending');
  const [motionIssue, setMotionIssue] = useState<MotionIssue>(null);
  const [sensitivity, setSensitivity] = useState(storageGet<number>(localStorage, 'ss-sensitivity') ?? DEFAULT_SENSITIVITY);
  const [meter, setMeter] = useState(0);
  const [localFlash, setLocalFlash] = useState(0);
  const [serverFlash, setServerFlash] = useState<Flash | null>(null);
  const [localTests, setLocalTests] = useState(0);
  const [wakeStatus, setWakeStatus] = useState<WakeLockKeeper['status']>('idle');
  const [countdownStart, setCountdownStart] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const epochRef = useRef(0);
  const seqRef = useRef(1);
  const detectorRef = useRef(new ShakeDetector({ threshold: SENSITIVITY_LEVELS[sensitivity].threshold }));
  const magnitudeRef = useRef(0);
  const samplesRef = useRef(0);
  const stopMotionRef = useRef<(() => void) | null>(null);
  const wakeRef = useRef<WakeLockKeeper | null>(null);
  const motionModeRef = useRef<MotionMode>('pending');
  sessionRef.current = session;
  roomRef.current = room;
  motionModeRef.current = motionMode;

  const myPlayer = session && room ? room.players[session.role] : null;
  const phase = room?.phase ?? 'lobby';

  const saveSession = useCallback(
    (s: Session | null) => {
      setSession(s);
      sessionRef.current = s;
      if (code) storageSet(localStorage, `ss-session-${code}`, s);
    },
    [code],
  );

  const applyJoin = useCallback(
    (res: JoinOk, state: RoomState) => {
      epochRef.current = res.epoch;
      seqRef.current = res.nextSeq;
      saveSession({ role: res.role, sessionToken: res.sessionToken, name: res.name });
      setRoom(state);
      // Never act on motion that happened before this (re)connection.
      detectorRef.current.reset(performance.now());
      const local = motionModeRef.current;
      const server = state.players[res.role]?.motion;
      if (local !== 'pending' && server !== local) void request(socketRef.current!, 'player:status', { motion: local });
    },
    [saveSession],
  );

  // ------------------------------------------------------------------ connection
  useEffect(() => {
    if (!code) return;
    void loadServerConfig().then(setConfig);
    const socket = createSocket();
    socketRef.current = socket;
    const untrack = trackConnection(socket, setConn);
    socket.on('room:state', (s: RoomState) => setRoom(s));
    socket.on('player:removed', () => {
      saveSession(null);
      setNotice('The host removed you from this seat. You can join again.');
    });
    socket.on('session:replaced', () => {
      setNotice('This seat was opened on another device or tab.');
      saveSession(null);
    });
    socket.on('connect', async () => {
      const saved = storageGet<Session>(localStorage, `ss-session-${code}`);
      if (saved) {
        const res = await request<JoinOk & { ok: true; state: RoomState }>(socket, 'player:resume', {
          code,
          sessionToken: saved.sessionToken,
        });
        if (res.ok) {
          applyJoin(res, res.state);
          setRoomError(null);
          return;
        }
        saveSession(null);
        if (res.error === 'session_expired') setNotice('Your previous seat was released. Pick a role to join again.');
      }
      const res = await request<{ ok: true; state: RoomState }>(socket, 'room:watch', { code });
      if (res.ok) {
        setRoom(res.state);
        setRoomError(null);
      } else {
        setRoomError(res.message);
      }
    });
    return () => {
      untrack();
      socket.disconnect();
    };
  }, [code, applyJoin, saveSession]);

  // ------------------------------------------------------------------ steering
  const sendInput = useCallback(() => {
    const now = performance.now();
    setLocalFlash(now);
    const socket = socketRef.current;
    const ph = roomRef.current?.phase;
    if (!sessionRef.current || !socket) return;
    if (ph === 'lobby') setLocalTests((n) => n + 1);
    if (ph !== 'playing' && ph !== 'lobby') return;
    // Shakes made while offline are dropped, never buffered and replayed later.
    if (!socket.connected) {
      setServerFlash({ t: now, ok: false, text: REJECT_TEXT.offline });
      return;
    }
    const seq = seqRef.current++;
    socket.timeout(3000).emit('player:input', { seq, epoch: epochRef.current }, (err: Error | null, ack: InputAck) => {
      const t = performance.now();
      if (err) return setServerFlash({ t, ok: false, text: REJECT_TEXT.timeout });
      if (ack.ok) {
        navigator.vibrate?.(35);
        setServerFlash({ t, ok: true, text: ph === 'lobby' ? 'Server confirmed!' : 'Accepted' });
      } else {
        setServerFlash({ t, ok: false, text: REJECT_TEXT[ack.reason ?? ''] ?? 'Rejected' });
      }
    });
  }, []);

  useEffect(() => {
    detectorRef.current.setThreshold(SENSITIVITY_LEVELS[sensitivity].threshold);
    storageSet(localStorage, 'ss-sensitivity', sensitivity);
  }, [sensitivity]);

  // Reset the detector whenever a countdown starts so nothing stale fires on GO.
  useEffect(() => {
    if (phase === 'countdown') {
      detectorRef.current.reset(performance.now());
      setCountdownStart(performance.now());
      void wakeRef.current?.acquire();
    } else {
      setCountdownStart(null);
    }
  }, [phase, room?.round]);

  useEffect(() => {
    if (countdownStart === null) return;
    const id = setInterval(() => forceTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [countdownStart]);

  // Live meter for the shake test (10 Hz is plenty).
  useEffect(() => {
    if (motionMode !== 'motion') return;
    const id = setInterval(() => setMeter(magnitudeRef.current), 100);
    return () => clearInterval(id);
  }, [motionMode]);

  useEffect(() => () => stopMotionRef.current?.(), []);

  // Re-render once the short feedback flashes have expired.
  useEffect(() => {
    const a = setTimeout(() => forceTick((n) => n + 1), 240);
    const b = setTimeout(() => forceTick((n) => n + 1), 520);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [localFlash, serverFlash]);

  useEffect(() => {
    if (!config?.simEnabled || !session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['Space', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
        sendInput();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [config?.simEnabled, session, sendInput]);

  const ensureWakeLock = () => {
    if (!wakeRef.current) {
      wakeRef.current = new WakeLockKeeper();
      wakeRef.current.onChange = setWakeStatus;
    }
    void wakeRef.current.acquire();
  };

  const setMode = (mode: MotionMode) => {
    setMotionMode(mode);
    motionModeRef.current = mode;
    setLocalTests(0);
    setServerFlash(null);
    if (socketRef.current && sessionRef.current) void request(socketRef.current, 'player:status', { motion: mode });
  };

  const enableMotion = () => {
    // requestPermission must run synchronously inside this tap handler (iOS).
    const permission = requestMotionPermission();
    ensureWakeLock();
    void permission.then((result) => {
      if (result !== 'granted') {
        setMotionIssue(result === 'denied' ? 'denied' : 'unsupported');
        return;
      }
      setMotionIssue(null);
      stopMotionRef.current?.();
      samplesRef.current = 0;
      detectorRef.current.reset(performance.now());
      stopMotionRef.current = listenMotion((acc, accG, now) => {
        const r = detectorRef.current.process(acc, accG, now);
        if (r.magnitude === null) return;
        samplesRef.current++;
        magnitudeRef.current = r.magnitude;
        if (r.triggered) sendInput();
      });
      setMode('motion');
      setTimeout(() => {
        if (samplesRef.current === 0 && motionModeRef.current === 'motion') setMotionIssue('nodata');
      }, 2500);
    });
  };

  const useTouch = () => {
    stopMotionRef.current?.();
    stopMotionRef.current = null;
    ensureWakeLock();
    setMotionIssue(null);
    setMode('touch');
  };

  const join = async (e: FormEvent) => {
    e.preventDefault();
    if (!socketRef.current || !code || !pickedRole) return;
    setBusy(true);
    setJoinError(null);
    storageSet(localStorage, 'ss-name', name.trim());
    const res = await request<JoinOk & { ok: true; state: RoomState }>(socketRef.current, 'player:join', {
      code,
      name,
      role: pickedRole,
    });
    setBusy(false);
    if (!res.ok) {
      setJoinError(res.message);
      return;
    }
    setNotice(null);
    applyJoin(res, res.state);
  };

  // ------------------------------------------------------------------ render
  if (!code) return <CodeEntry />;

  if (roomError) {
    return (
      <main className="ctrl ctrl-neutral">
        <div className="ctrl-card">
          <h1>Can&apos;t join</h1>
          <p className="error">{roomError}</p>
          <button className="btn btn-primary" onClick={() => navigate('/join')}>
            Enter another code
          </button>
        </div>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="ctrl ctrl-neutral">
        <div className="ctrl-card">
          <h1>Room {code}</h1>
          <ConnPill state={conn} />
        </div>
      </main>
    );
  }

  if (!session || !myPlayer) {
    const taken = ROLES.filter((r) => room.players[r]).length;
    return (
      <main className="ctrl ctrl-neutral">
        <form className="ctrl-card" onSubmit={join}>
          <div className="ctrl-top">
            <span className="pill">Room {room.code}</span>
            <ConnPill state={conn} />
          </div>
          {notice && <p className="notice">{notice}</p>}
          {room.phase !== 'lobby' ? (
            <p className="error">A round is in progress. Wait for the host to return to the lobby, then join.</p>
          ) : taken === 4 ? (
            <p className="error">This room already has four players.</p>
          ) : null}
          <label className="field-label" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            className="text-input"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sam"
            autoComplete="nickname"
            required
          />
          <div className="field-label">Pick your seat</div>
          <div className="role-grid">
            {ROLES.map((role) => {
              const p = room.players[role];
              const team = roleTeam(role);
              const dir = roleDirection(role);
              return (
                <button
                  type="button"
                  key={role}
                  className={`role-btn role-${team} ${pickedRole === role ? 'role-picked' : ''}`}
                  disabled={!!p || room.phase !== 'lobby'}
                  onClick={() => setPickedRole(role)}
                >
                  <span className="role-team">{TEAM_LABEL[team].toUpperCase()}</span>
                  <span className="role-dir">
                    {dir === 'left' && <Arrow direction="left" />}
                    {dir.toUpperCase()}
                    {dir === 'right' && <Arrow direction="right" />}
                  </span>
                  <span className="role-who">{p ? `Taken by ${p.name}` : 'Available'}</span>
                </button>
              );
            })}
          </div>
          {joinError && <p className="error">{joinError}</p>}
          <button
            className="btn btn-primary btn-xl"
            type="submit"
            disabled={busy || !pickedRole || !name.trim() || room.phase !== 'lobby' || conn !== 'connected'}
          >
            {busy ? 'Joining…' : pickedRole ? `Join as ${roleLabel(pickedRole)}` : 'Pick a seat'}
          </button>
        </form>
      </main>
    );
  }

  const team = roleTeam(session.role);
  const dir = roleDirection(session.role);
  const now = performance.now();
  const localActive = now - localFlash < 220;
  const serverActive = serverFlash && now - serverFlash.t < 500;
  const support = motionSupport();

  const header = (
    <div className="ctrl-top">
      <span className="pill">
        {session.name} · Room {room.code}
      </span>
      <ConnPill state={conn} />
    </div>
  );

  const roleBanner = (
    <div className="role-banner">
      <div className="role-banner-team">{TEAM_LABEL[team].toUpperCase()} TEAM</div>
      <div className="role-banner-dir">
        {dir === 'left' && <Arrow direction="left" />}
        <span>{dir.toUpperCase()}</span>
        {dir === 'right' && <Arrow direction="right" />}
      </div>
      <div className="role-banner-sub">
        You move the {TEAM_LABEL[team].toLowerCase()} car one lane <b>{dir}</b>
      </div>
    </div>
  );

  const motionSetup = (
    <div className="setup-step">
      <h3>1 · Controls</h3>
      {!support.secure && (
        <p className="warn">
          Motion sensors need <b>HTTPS</b>. This page is not secure, so use the touch controls or open the HTTPS link.
        </p>
      )}
      <button className="btn btn-primary btn-xl" onClick={enableMotion}>
        Enable motion
      </button>
      <button className="btn btn-ghost" onClick={useTouch}>
        Use touch controls instead
      </button>
      {motionIssue === 'denied' && (
        <p className="error">Motion permission was denied. On iPhone, close and reopen this tab to be asked again, or use touch controls.</p>
      )}
      {motionIssue === 'unsupported' && <p className="error">This browser has no motion sensor access. Use touch controls.</p>}
    </div>
  );

  const noDataHelp = motionIssue === 'nodata' && (
    <div className="warn">
      <b>No motion readings are arriving.</b> Check that the page is opened over HTTPS, that motion access is allowed (iPhone:
      Settings › Safari › Motion &amp; Orientation Access on older iOS; Android Chrome: Site settings › Motion sensors), and that
      battery saver is not blocking sensors.
      <button className="btn btn-secondary btn-small" onClick={useTouch}>
        Switch to touch controls
      </button>
    </div>
  );

  const touchPad = (label: string) => (
    <button
      className={`touch-pad ${localActive ? 'touch-pad-active' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault();
        sendInput();
      }}
    >
      <Arrow direction={dir} />
      <span>{label}</span>
      <small>TOUCH FALLBACK</small>
    </button>
  );

  // ---------------------------------------------------------------- lobby setup
  if (phase === 'lobby') {
    const tested = myPlayer.shakeTested;
    return (
      <main className={`ctrl ctrl-${team}`}>
        {header}
        {roleBanner}
        {notice && <p className="notice">{notice}</p>}
        {motionMode === 'pending' ? (
          motionSetup
        ) : (
          <div className="setup-step">
            <h3>2 · {motionMode === 'motion' ? 'Shake test' : 'Tap test'}</h3>
            {motionMode === 'motion' ? (
              <>
                <p>Hold the phone firmly and give it one sharp shake.</p>
                <div className="meter">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.min(100, (meter / SENSITIVITY_LEVELS[sensitivity].threshold) * 100)}%` }}
                  />
                  <div className="meter-mark" />
                </div>
                {noDataHelp}
              </>
            ) : (
              touchPad(`TAP TO TEST ${dir.toUpperCase()}`)
            )}
            <div className="test-status">
              <span className={`test-dot ${localActive ? 'on' : ''}`}>Detected on phone {localTests > 0 ? `×${localTests}` : ''}</span>
              <span className={`test-dot ${tested ? 'ok' : ''} ${serverActive && serverFlash?.ok ? 'on' : ''}`}>
                {tested ? 'Server confirmed' : 'Waiting for server'}
              </span>
            </div>
            {serverActive && !serverFlash!.ok && <p className="hint">{serverFlash!.text}</p>}
            <div className="row-actions">
              <button
                className="btn btn-ghost btn-small"
                onClick={() => {
                  setLocalTests(0);
                  setServerFlash(null);
                  detectorRef.current.reset(performance.now());
                }}
              >
                Test shake again
              </button>
              {motionMode === 'motion' ? (
                <button className="btn btn-ghost btn-small" onClick={useTouch}>
                  Switch to touch
                </button>
              ) : (
                <button className="btn btn-ghost btn-small" onClick={enableMotion}>
                  Try motion
                </button>
              )}
            </div>
            {motionMode === 'motion' && (
              <label className="sensitivity">
                Sensitivity: <b>{SENSITIVITY_LEVELS[sensitivity].label}</b>
                <input
                  type="range"
                  min={0}
                  max={SENSITIVITY_LEVELS.length - 1}
                  step={1}
                  value={sensitivity}
                  onChange={(e) => setSensitivity(Number(e.target.value))}
                />
              </label>
            )}
          </div>
        )}
        {motionMode !== 'pending' && (
          <div className="setup-step">
            <h3>3 · Ready</h3>
            <button
              className={`btn btn-xl ${myPlayer.ready ? 'btn-ready' : 'btn-primary'}`}
              disabled={!tested || conn !== 'connected'}
              onClick={() => void request(socketRef.current!, 'player:status', { ready: !myPlayer.ready })}
            >
              {myPlayer.ready ? 'READY! (tap to undo)' : tested ? "I'm ready" : 'Do the test first'}
            </button>
          </div>
        )}
        <details className="ctrl-more">
          <summary>Change seat or leave</summary>
          <div className="role-grid role-grid-small">
            {ROLES.filter((r) => r !== session.role).map((r) => (
              <button
                key={r}
                className={`role-btn role-${roleTeam(r)}`}
                disabled={!!room.players[r]}
                onClick={async () => {
                  const res = await request<{ ok: true; role: Role }>(socketRef.current!, 'player:changeRole', { role: r });
                  if (res.ok) saveSession({ ...session, role: res.role });
                  else setNotice(res.message);
                }}
              >
                {roleLabel(r)}
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost btn-small"
            onClick={async () => {
              await request(socketRef.current!, 'player:leave');
              saveSession(null);
            }}
          >
            Leave seat
          </button>
        </details>
        <WakeNote status={wakeStatus} />
        {config?.simEnabled && <p className="dev-note">DEV: keyboard Space / arrows send this phone&apos;s input.</p>}
      </main>
    );
  }

  // ---------------------------------------------------------------- in round
  let body: ReactNode;
  if (motionMode === 'pending') {
    body = (
      <>
        <p className="notice">Re-enable your controls to keep playing.</p>
        {motionSetup}
      </>
    );
  } else if (phase === 'countdown') {
    const remaining = countdownStart === null ? 3 : Math.max(1, 3 - Math.floor((now - countdownStart) / 1000));
    body = (
      <div className="big-state">
        <div className="countdown-num">{remaining}</div>
        <p>Get ready to {motionMode === 'motion' ? 'shake' : 'tap'} {dir.toUpperCase()}</p>
      </div>
    );
  } else if (phase === 'playing') {
    body =
      motionMode === 'touch' ? (
        touchPad(`TAP ${dir.toUpperCase()}`)
      ) : (
        <div className={`play-arrow ${localActive ? 'local-flash' : ''}`}>
          <Arrow direction={dir} />
          <div className="play-label">SHAKE {dir.toUpperCase()}</div>
          {noDataHelp}
        </div>
      );
  } else if (phase === 'paused') {
    body = (
      <div className="big-state">
        <div className="state-title">PAUSED</div>
        {room.pause?.missing.length ? (
          <p>
            Waiting for{' '}
            {room.pause.missing.map((m) => (m.role === 'host' ? 'the host screen' : `${m.name}${m.abandoned ? ' (left)' : ''}`)).join(', ')}
          </p>
        ) : (
          <p>Everyone is back. The host will resume with a countdown.</p>
        )}
      </div>
    );
  } else {
    const result = room.result;
    const won = result?.winner === team;
    const draw = result?.winner === 'draw';
    body = (
      <div className={`big-state ${won ? 'state-won' : ''}`}>
        <div className="state-title">{draw ? 'DRAW!' : won ? 'YOU WIN!' : 'CRASHED!'}</div>
        <p>{draw ? 'Both cars crashed at the same moment.' : won ? 'Your team survived longer.' : `${TEAM_LABEL[result?.winner === 'blue' ? 'blue' : 'orange']} team wins.`}</p>
        <p className="hint">Watch the big screen. The host can start a rematch.</p>
      </div>
    );
  }

  return (
    <main className={`ctrl ctrl-${team} ctrl-play ${serverActive ? (serverFlash!.ok ? 'flash-ok' : 'flash-bad') : ''}`}>
      {header}
      <div className="play-banner">
        {TEAM_LABEL[team].toUpperCase()} · {dir.toUpperCase()}
        {motionMode === 'touch' && <span className="chip chip-warn">TOUCH</span>}
      </div>
      {body}
      <div className="feedback-row">
        <span className={`fb ${localActive ? 'fb-on' : ''}`}>{motionMode === 'touch' ? 'Tap' : 'Shake'} detected</span>
        <span className={`fb ${serverActive ? (serverFlash!.ok ? 'fb-ok' : 'fb-bad') : ''}`}>
          {serverActive ? serverFlash!.text : 'Server'}
        </span>
      </div>
      <WakeNote status={wakeStatus} />
    </main>
  );
}

function WakeNote({ status }: { status: WakeLockKeeper['status'] }) {
  if (status === 'active') return <p className="wake-note">Screen will stay awake.</p>;
  return <p className="wake-note">Keep this page open and your screen unlocked while playing.</p>;
}

function CodeEntry() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="ctrl ctrl-neutral">
      <form
        className="ctrl-card"
        onSubmit={(e) => {
          e.preventDefault();
          const code = normalizeRoomCode(value);
          if (!code) return setError(`Room codes have ${CODE_LENGTH} letters or numbers.`);
          navigate(`/join/${code}`);
        }}
      >
        <h1>Join a game</h1>
        <label className="field-label" htmlFor="code">
          Room code
        </label>
        <input
          id="code"
          className="text-input code-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase());
            setError(null);
          }}
          maxLength={CODE_LENGTH + 2}
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="ABC123"
        />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-xl" type="submit">
          Join
        </button>
      </form>
    </main>
  );
}

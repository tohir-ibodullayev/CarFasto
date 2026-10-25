import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { COUNTDOWN_TICKS, LANE_CHANGE_TICKS, ROLES, START_LANE, TICK_MS, type Role } from '../shared/constants';
import type { InputAck, RoomState, Snapshot } from '../shared/protocol';
import { createApp, type App } from '../server/src/app';
import { loadConfig, type AppConfig } from '../server/src/config';
import type { Room } from '../server/src/room';

interface Player {
  socket: Socket;
  role: Role;
  sessionToken: string;
  epoch: number;
  seq: number;
}

let app: App | null = null;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (app) await app.close();
  app = null;
});

async function startServer(overrides: Partial<AppConfig> = {}) {
  app = createApp(loadConfig({ NODE_ENV: 'test' }, { port: 0, host: '127.0.0.1', ...overrides }));
  const port = await app.listen({ startLoop: false });
  return { url: `http://127.0.0.1:${port}`, app };
}

function client(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emit<T = any>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await wait(5);
  }
}

async function hostRoom(url: string) {
  const host = await client(url);
  const created = await emit(host, 'host:create');
  expect(created.ok).toBe(true);
  expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
  const room = app!.manager.get(created.code)!;
  const action = (action: string, extra: object = {}) =>
    emit(host, 'host:action', { code: created.code, hostToken: created.hostToken, action, ...extra });
  return { host, code: created.code as string, hostToken: created.hostToken as string, room, action };
}

async function joinPlayer(url: string, code: string, role: Role, name: string = role): Promise<Player> {
  const socket = await client(url);
  const res = await emit(socket, 'player:join', { code, name, role });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return { socket, role, sessionToken: res.sessionToken, epoch: res.epoch, seq: res.nextSeq - 1 };
}

function sendInput(p: Player, extra: object = {}): Promise<InputAck> {
  p.seq++;
  return emit<InputAck>(p.socket, 'player:input', { seq: p.seq, epoch: p.epoch, ...extra });
}

/** Ticks the room by hand; input acks resolve on the tick that applies them. */
function tick(room: Room, n = 1) {
  for (let i = 0; i < n; i++) room.tick();
}

async function readyAll(players: Player[], room: Room) {
  for (const p of players) {
    expect((await emit(p.socket, 'player:status', { motion: 'touch' })).ok).toBe(true);
    expect((await sendInput(p)).ok).toBe(true); // lobby shake test
    expect((await emit(p.socket, 'player:status', { ready: true })).ok).toBe(true);
  }
  expect(room.canStart()).toBe(true);
}

async function fullMatch(overrides: Partial<AppConfig> = {}) {
  const { url } = await startServer(overrides);
  const h = await hostRoom(url);
  const players = {} as Record<Role, Player>;
  for (const role of ROLES) players[role] = await joinPlayer(url, h.code, role, `P-${role}`);
  // Spread the lobby shake tests so the per-player rate limit is not involved.
  await readyAll(Object.values(players), h.room);
  return { url, ...h, players };
}

async function startPlaying(m: Awaited<ReturnType<typeof fullMatch>>) {
  expect((await m.action('start')).ok).toBe(true);
  expect(m.room.phase).toBe('countdown');
  tick(m.room, COUNTDOWN_TICKS);
  expect(m.room.phase).toBe('playing');
  for (const p of Object.values(m.players)) p.socket.removeAllListeners('room:state');
}

/** Sends an input and ticks until its ack arrives. */
async function steer(m: { room: Room }, p: Player, extra: object = {}) {
  const pending = sendInput(p, extra);
  let ack: InputAck | null = null;
  pending.then((a) => (ack = a));
  await until(() => {
    if (!ack) tick(m.room);
    return ack !== null;
  });
  return ack!;
}

describe('rooms and roles', () => {
  it('four clients join and claim four distinct roles', async () => {
    const { url } = await startServer();
    const h = await hostRoom(url);
    const states: RoomState[] = [];
    h.host.on('room:state', (s: RoomState) => states.push(s));
    for (const role of ROLES) await joinPlayer(url, h.code, role, `N ${role}`);
    await until(() => ROLES.every((r) => states.at(-1)?.players[r]?.connected));
    const last = states.at(-1)!;
    expect(ROLES.map((r) => last.players[r]!.name)).toEqual(ROLES.map((r) => `N ${r}`));
    expect(last.canStart).toBe(false);
  });

  it('rejects duplicate roles, a fifth player, bad codes and bad names', async () => {
    const { url } = await startServer();
    const h = await hostRoom(url);
    await joinPlayer(url, h.code, 'blue-left', 'Ana');
    const dup = await client(url);
    expect(await emit(dup, 'player:join', { code: h.code, name: 'Ana', role: 'blue-left' })).toMatchObject({
      ok: false,
      error: 'role_taken',
    });
    for (const role of ROLES.slice(1)) await joinPlayer(url, h.code, role);
    expect(await emit(dup, 'player:join', { code: h.code, name: 'Eve', role: 'orange-left' })).toMatchObject({
      error: 'room_full',
    });
    expect(await emit(dup, 'player:join', { code: 'abc', name: 'Eve', role: 'blue-left' })).toMatchObject({
      error: 'invalid_code',
    });
    expect(await emit(dup, 'player:join', { code: 'ZZZZZZ', name: 'Eve', role: 'blue-left' })).toMatchObject({
      error: 'room_not_found',
    });
    expect(await emit(dup, 'player:join', { code: h.code, name: '   ', role: 'blue-left' })).toMatchObject({
      error: 'bad_name',
    });
    expect(await emit(dup, 'player:join', { code: h.code, name: 'x'.repeat(30), role: 'blue-left' })).toMatchObject({
      error: 'bad_name',
    });
    expect(await emit(dup, 'player:join', { code: h.code, name: 'Eve', role: 'purple-up' })).toMatchObject({
      error: 'bad_request',
    });
  });

  it('a display name cannot take over an existing seat; only the session token can', async () => {
    const { url } = await startServer();
    const h = await hostRoom(url);
    const ana = await joinPlayer(url, h.code, 'blue-left', 'Ana');
    const imposter = await client(url);
    expect((await emit(imposter, 'player:join', { code: h.code, name: 'Ana', role: 'blue-left' })).error).toBe('role_taken');
    expect((await emit(imposter, 'player:resume', { code: h.code, sessionToken: 'A'.repeat(32) })).error).toBe(
      'session_expired',
    );
    expect(h.room.roleOfSocket(ana.socket.id!)).toBe('blue-left');
  });

  it('rejects host actions without the host credential', async () => {
    const m = await fullMatch();
    const blue = m.players['blue-left'].socket;
    expect(await emit(blue, 'host:action', { code: m.code, hostToken: 'x'.repeat(32), action: 'start' })).toMatchObject({
      error: 'unauthorized',
    });
    // A correct token from a socket that is not the attached host is also refused.
    expect(await emit(blue, 'host:action', { code: m.code, hostToken: m.hostToken, action: 'start' })).toMatchObject({
      error: 'unauthorized',
    });
    expect(m.room.phase).toBe('lobby');
  });

  it('start requires every role connected and ready', async () => {
    const { url } = await startServer();
    const h = await hostRoom(url);
    const ps = [];
    for (const role of ROLES.slice(0, 3)) ps.push(await joinPlayer(url, h.code, role));
    expect(await h.action('start')).toMatchObject({ error: 'not_ready' });
    const last = await joinPlayer(url, h.code, 'orange-right');
    // Ready is refused until motion mode is chosen and the shake test was done.
    expect(await emit(last.socket, 'player:status', { ready: true })).toMatchObject({ error: 'not_ready' });
    await readyAll([...ps, last], h.room);
    expect((await h.action('start')).ok).toBe(true);
  });

  it('prevents new controllers and role changes during an active round', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const late = await client(m.url);
    expect(await emit(late, 'room:watch', { code: m.code })).toMatchObject({ ok: true });
    expect(await emit(late, 'player:join', { code: m.code, name: 'Late', role: 'blue-left' })).toMatchObject({
      error: 'round_active',
    });
    expect(await emit(m.players['blue-left'].socket, 'player:changeRole', { role: 'orange-left' })).toMatchObject({
      error: 'round_active',
    });
  });

  it('refuses keyboard-simulation seats when simulation is disabled', async () => {
    const { url } = await startServer({ simEnabled: false });
    const h = await hostRoom(url);
    const bot = await client(url);
    expect(await emit(bot, 'player:join', { code: h.code, name: 'Bot', role: 'blue-left', sim: true })).toMatchObject({
      error: 'sim_disabled',
    });
  });
});

describe('steering through the server', () => {
  it('derives team and direction from the seat, ignoring client claims', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const sim = m.room.sim!;
    const ack = await steer(m, m.players['blue-left'], { team: 'orange', direction: 'right', role: 'orange-right' });
    expect(ack).toMatchObject({ ok: true, lane: START_LANE - 1 });
    tick(m.room, LANE_CHANGE_TICKS + 1);
    expect(sim.cars.blue.lane).toBe(START_LANE - 1);
    expect(sim.cars.orange.lane).toBe(START_LANE);

    await wait(130);
    expect(await steer(m, m.players['orange-right'])).toMatchObject({ ok: true, lane: START_LANE + 1 });
    tick(m.room, LANE_CHANGE_TICKS + 1);
    expect(sim.cars.orange.lane).toBe(START_LANE + 1);

    expect(await steer(m, m.players['blue-right'])).toMatchObject({ ok: true });
    await wait(130);
    expect(await steer(m, m.players['orange-left'])).toMatchObject({ ok: true });
    tick(m.room, LANE_CHANGE_TICKS + 1);
    expect(sim.cars.blue.lane).toBe(START_LANE);
    expect(sim.cars.orange.lane).toBe(START_LANE);
  });

  it('enforces lane bounds', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const left = m.players['blue-left'];
    expect(await steer(m, left)).toMatchObject({ ok: true });
    tick(m.room, LANE_CHANGE_TICKS + 1);
    await wait(130);
    expect(await steer(m, left)).toMatchObject({ ok: false, reason: 'edge' });
    expect(m.room.sim!.cars.blue.lane).toBe(0);
  });

  it('applies the first arrival and drops simultaneous commands while moving', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const a = sendInput(m.players['orange-left']);
    const b = sendInput(m.players['orange-right']);
    await wait(50);
    tick(m.room);
    const [ackA, ackB] = await Promise.all([a, b]);
    expect(ackA).toMatchObject({ ok: true, lane: START_LANE - 1 });
    expect(ackB).toMatchObject({ ok: false, reason: 'busy' });
    tick(m.room, LANE_CHANGE_TICKS + 5);
    expect(m.room.sim!.cars.orange.lane).toBe(START_LANE - 1);
  });

  it('rejects duplicate sequence numbers and excessive input rates', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const p = m.players['blue-right'];
    expect(await steer(m, p)).toMatchObject({ ok: true });
    const dup = await emit<InputAck>(p.socket, 'player:input', { seq: p.seq, epoch: p.epoch });
    expect(dup).toMatchObject({ ok: false, reason: 'duplicate' });
    const older = await emit<InputAck>(p.socket, 'player:input', { seq: p.seq - 1, epoch: p.epoch });
    expect(older).toMatchObject({ ok: false, reason: 'duplicate' });
    // A burst faster than any real shake is rate limited.
    const burst = await Promise.all(Array.from({ length: 5 }, () => sendInput(p)));
    expect(burst.every((a) => a.ok === false && a.reason === 'rate_limited')).toBe(true);
    // Malformed payloads never move the car.
    expect(await emit<InputAck>(p.socket, 'player:input', { seq: 'x' })).toMatchObject({ ok: false });
    expect(await emit<InputAck>(p.socket, 'player:input', { seq: -4, epoch: p.epoch })).toMatchObject({ ok: false });
  });

  it('streams identical traffic to both roads and finishes with a winner overlay state', async () => {
    const m = await fullMatch();
    const snaps: Snapshot[] = [];
    m.host.on('game:snapshot', (s: Snapshot) => snaps.push(s));
    await startPlaying(m);
    // Orange dodges the opening obstacle (which blocks the start lane); blue does not.
    expect(await steer(m, m.players['orange-right'])).toMatchObject({ ok: true });
    for (let i = 0; i < 60 * 30 && m.room.phase === 'playing'; i++) tick(m.room);
    expect(m.room.phase).toBe('finished');
    const state = m.room.publicState();
    expect(state.result?.winner).toBe('orange');
    await until(() => snaps.some((s) => s.phase === 'finished'));
    const final = snaps.find((s) => s.phase === 'finished')!;
    expect(final.cars.blue.crashed).toBe(true);
    expect(final.cars.orange.crashed).toBe(false);
    expect(Array.isArray(final.traffic)).toBe(true);
  });
});

describe('disconnects, reconnection and rematch', () => {
  it('pauses immediately on a controller disconnect and resumes without time drift', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const room = m.room;
    let t = 1000;
    room.update(t);
    for (let i = 0; i < 30; i++) room.update((t += TICK_MS));
    const tickBefore = room.sim!.tick;
    const timeBefore = room.sim!.timeS;
    const trafficBefore = JSON.stringify(room.sim!.obstacles);

    const victim = m.players['orange-left'];
    victim.socket.disconnect();
    await until(() => room.phase === 'paused');
    const pause = room.publicState().pause!;
    expect(pause.missing).toEqual([{ role: 'orange-left', name: 'P-orange-left', abandoned: false }]);

    // Ten real seconds pass while paused: nothing advances.
    for (let i = 0; i < 100; i++) room.update((t += 100));
    expect(room.sim!.tick).toBe(tickBefore);
    expect(JSON.stringify(room.sim!.obstacles)).toBe(trafficBefore);
    expect(await m.action('resume')).toMatchObject({ error: 'not_ready' });

    const back = await client(m.url);
    const res = await emit(back, 'player:resume', { code: m.code, sessionToken: victim.sessionToken });
    expect(res).toMatchObject({ ok: true, role: 'orange-left' });
    expect(room.phase).toBe('paused'); // explicit host resume is required
    expect(room.canResume()).toBe(true);
    expect((await m.action('resume')).ok).toBe(true);
    expect(room.phase).toBe('countdown');

    room.update(t);
    for (let i = 0; i < COUNTDOWN_TICKS; i++) room.update((t += TICK_MS));
    room.update((t += 1));
    expect(room.phase).toBe('playing');
    expect(room.sim!.tick).toBe(tickBefore);
    expect(room.sim!.timeS).toBeCloseTo(timeBefore, 9);
    for (let i = 0; i < 6; i++) room.update((t += TICK_MS));
    // About 100 ms of real time after resuming yields about 6 ticks, never a catch-up burst.
    expect(room.sim!.tick - tickBefore).toBeGreaterThanOrEqual(4);
    expect(room.sim!.tick - tickBefore).toBeLessThanOrEqual(7);
  });

  it('does not replay stale commands after reconnecting', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    const room = m.room;
    const p = m.players['blue-right'];
    // Commands sitting in the queue when the phone drops are discarded.
    const queued = sendInput(p);
    await wait(30);
    p.socket.disconnect();
    await until(() => room.phase === 'paused');
    // The socket closed before an ack could arrive, and the queued command was dropped.
    expect(await Promise.race([queued, wait(200).then(() => null)])).toBeNull();
    expect(room.sim!.cars.blue.moveTick).toBe(-1);

    const back = await client(m.url);
    const res = await emit(back, 'player:resume', { code: m.code, sessionToken: p.sessionToken });
    expect(res.ok).toBe(true);
    expect(res.epoch).toBeGreaterThan(p.epoch);
    // A message stamped with the old connection epoch (e.g. a buffered shake) is refused.
    const stale = await emit<InputAck>(back, 'player:input', { seq: res.nextSeq + 5, epoch: p.epoch });
    expect(stale).toMatchObject({ ok: false, reason: 'stale' });
    // Inputs during pause or the resume countdown are not buffered for later.
    const during = await emit<InputAck>(back, 'player:input', { seq: res.nextSeq + 6, epoch: res.epoch });
    expect(during).toMatchObject({ ok: false, reason: 'inactive' });
    await m.action('resume');
    const inCountdown = await emit<InputAck>(back, 'player:input', { seq: res.nextSeq + 7, epoch: res.epoch });
    expect(inCountdown).toMatchObject({ ok: false, reason: 'inactive' });
    tick(room, COUNTDOWN_TICKS);
    expect(room.phase).toBe('playing');
    tick(room, 3);
    expect(room.sim!.cars.blue.moveTick).toBe(-1);
    expect(room.sim!.cars.blue.lane).toBe(START_LANE);
  });

  it('pauses when the host disconnects and lets the host reattach with its credential', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    m.host.disconnect();
    await until(() => m.room.phase === 'paused');
    expect(m.room.publicState().pause!.missing[0].role).toBe('host');
    const newHost = await client(m.url);
    expect((await emit(newHost, 'host:attach', { code: m.code, hostToken: 'bad'.repeat(10) })).ok).toBe(false);
    const attached = await emit(newHost, 'host:attach', { code: m.code, hostToken: m.hostToken });
    expect(attached.ok).toBe(true);
    expect(attached.snapshot.phase).toBe('paused');
    expect(
      (await emit(newHost, 'host:action', { code: m.code, hostToken: m.hostToken, action: 'resume' })).ok,
    ).toBe(true);
  });

  it('releases a seat after the reconnection window and lets the host end the round', async () => {
    const m = await fullMatch({ reconnectWindowMs: 100 });
    await startPlaying(m);
    m.players['blue-left'].socket.disconnect();
    await until(() => m.room.phase === 'paused');
    await wait(150);
    app!.manager.cleanup();
    const state = m.room.publicState();
    expect(state.players['blue-left']).toBeNull();
    expect(state.pause!.missing).toEqual([{ role: 'blue-left', name: 'P-blue-left', abandoned: true }]);
    expect(state.canResume).toBe(false);
    expect((await m.action('toLobby')).ok).toBe(true);
    expect(m.room.phase).toBe('lobby');
    const replacement = await joinPlayer(m.url, m.code, 'blue-left', 'Sub');
    expect(replacement.role).toBe('blue-left');
  });

  it('play again resets the complete round state', async () => {
    const m = await fullMatch();
    await startPlaying(m);
    expect(await steer(m, m.players['blue-right'])).toMatchObject({ ok: true });
    for (let i = 0; i < 60 * 30 && m.room.phase === 'playing'; i++) tick(m.room);
    expect(m.room.phase).toBe('finished');
    const oldSim = m.room.sim!;
    expect(oldSim.result).not.toBeNull();

    expect((await m.action('playAgain')).ok).toBe(true);
    const sim = m.room.sim!;
    expect(sim).not.toBe(oldSim);
    expect(m.room.phase).toBe('countdown');
    expect(sim.tick).toBe(0);
    expect(sim.distance).toBe(0);
    expect(sim.result).toBeNull();
    expect(sim.obstacles).toEqual([]);
    for (const team of ['blue', 'orange'] as const) {
      expect(sim.cars[team]).toMatchObject({ lane: START_LANE, x: START_LANE, moveTick: -1, crashed: false });
    }
    expect(m.room.publicState()).toMatchObject({ round: 2, result: null, pause: null });
    // Sequence numbers keep increasing across rounds, so an old seq cannot be replayed.
    const p = m.players['blue-right'];
    const replay = await emit<InputAck>(p.socket, 'player:input', { seq: p.seq, epoch: p.epoch });
    expect(replay.reason).toBe('duplicate');

    expect((await m.action('toLobby')).ok).toBe(true);
    expect(m.room.sim).toBeNull();
    expect(ROLES.every((r) => m.room.publicState().players[r]!.ready === false)).toBe(true);
  });

  it('cleans up abandoned rooms after the idle timeout', async () => {
    const { url } = await startServer({ roomIdleTimeoutMs: 50 });
    const h = await hostRoom(url);
    h.host.disconnect();
    await until(() => !h.room.hostConnected);
    app!.manager.cleanup();
    expect(app!.manager.get(h.code)).toBeDefined();
    await wait(80);
    app!.manager.cleanup();
    expect(app!.manager.get(h.code)).toBeUndefined();
  });
});

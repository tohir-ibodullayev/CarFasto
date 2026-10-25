import { afterAll, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { ROLES, SHAKE_COOLDOWN_MS, roleDirection, roleTeam, type Role } from '../shared/constants';
import { TRAFFIC_KIND_INDEX, type Snapshot } from '../shared/protocol';
import { isMoveSafe, planTargetLane } from '../shared/sim/autopilot';
import { createApp } from '../server/src/app';
import { loadConfig } from '../server/src/config';

const app = createApp(loadConfig({ NODE_ENV: 'test' }, { port: 0, host: '127.0.0.1' }));
const sockets: Socket[] = [];
afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await app.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function client(url: string): Promise<Socket> {
  return new Promise((resolve) => {
    const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    s.once('connect', () => resolve(s));
  });
}
const emit = (s: Socket, e: string, p?: unknown): Promise<any> => new Promise((r) => s.emit(e, p, r));

it('runs a real-time match with four controllers, pauses and resumes without drift', async () => {
  const port = await app.listen();
  const url = `http://127.0.0.1:${port}`;
  const host = await client(url);
  const { code, hostToken } = await emit(host, 'host:create');
  const snaps: { at: number; s: Snapshot }[] = [];
  host.on('game:snapshot', (s: Snapshot) => snaps.push({ at: Date.now(), s }));

  const players: Record<Role, { socket: Socket; token: string; epoch: number; seq: number; last: number }> = {} as never;
  for (const role of ROLES) {
    const socket = await client(url);
    const res = await emit(socket, 'player:join', { code, name: role.slice(0, 10), role });
    expect(res.ok).toBe(true);
    players[role] = { socket, token: res.sessionToken, epoch: res.epoch, seq: 0, last: 0 };
    await emit(socket, 'player:status', { motion: 'touch' });
    await emit(socket, 'player:input', { seq: ++players[role].seq, epoch: res.epoch });
    await emit(socket, 'player:status', { ready: true });
  }
  expect((await emit(host, 'host:action', { code, hostToken, action: 'start' })).ok).toBe(true);

  // Each controller independently "shakes" when its team needs to go its way.
  let acks = 0;
  host.on('game:snapshot', (s: Snapshot) => {
    if (s.phase !== 'playing') return;
    const obstacles = s.traffic.map((o) => ({ lane: o[1], z: o[2], kind: TRAFFIC_KIND_INDEX[o[3]] }));
    for (const role of ROLES) {
      const p = players[role];
      const car = s.cars[roleTeam(role)];
      if (!p.socket.connected || car.moving || Date.now() - p.last < SHAKE_COOLDOWN_MS) continue;
      const target = planTargetLane(car.lane, s.speed, obstacles);
      const dir = target < car.lane ? 'left' : target > car.lane ? 'right' : null;
      if (dir !== roleDirection(role) || !isMoveSafe(target, s.speed, obstacles)) continue;
      p.last = Date.now();
      p.socket.emit('player:input', { seq: ++p.seq, epoch: p.epoch }, (a: { ok: boolean }) => a.ok && acks++);
    }
  });

  await wait(3000 + 6000);
  const playing = snaps.filter((x) => x.s.phase === 'playing');
  expect(playing.length).toBeGreaterThan(80);
  const span = (playing.at(-1)!.at - playing[0].at) / 1000;
  const rate = (playing.length - 1) / span;
  expect(rate).toBeGreaterThan(16);
  expect(rate).toBeLessThan(24);
  // Simulation time tracks wall time at the fixed timestep.
  const simSpan = playing.at(-1)!.s.timeS - playing[0].s.timeS;
  expect(Math.abs(simSpan - span)).toBeLessThan(0.25);
  expect(acks).toBeGreaterThan(0);
  const room = app.manager.get(code)!;
  expect(room.phase).toBe('playing');

  // Disconnect a controller: everything freezes.
  players['orange-right'].socket.disconnect();
  await wait(100);
  expect(room.phase).toBe('paused');
  const frozenAt = room.sim!.timeS;
  await wait(1500);
  expect(room.sim!.timeS).toBe(frozenAt);

  const back = await client(url);
  const resumed = await emit(back, 'player:resume', { code, sessionToken: players['orange-right'].token });
  expect(resumed.ok).toBe(true);
  players['orange-right'] = { ...players['orange-right'], socket: back, epoch: resumed.epoch, seq: resumed.nextSeq - 1 };
  expect((await emit(host, 'host:action', { code, hostToken, action: 'resume' })).ok).toBe(true);
  await wait(3000 + 500);
  expect(room.phase).toBe('playing');
  // ~0.5 s of play after the resume countdown, not 0.5 s + the 1.6 s paused + 3 s countdown.
  expect(room.sim!.timeS - frozenAt).toBeGreaterThan(0.3);
  expect(room.sim!.timeS - frozenAt).toBeLessThan(0.8);
}, 30000);

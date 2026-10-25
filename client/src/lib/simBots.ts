import type { Socket } from 'socket.io-client';
import { ROLES, SHAKE_COOLDOWN_MS, TEAM_LABEL, roleDirection, roleTeam, type Role } from '../../../shared/constants';
import { TRAFFIC_KIND_INDEX, type JoinOk, type Snapshot } from '../../../shared/protocol';
import { isMoveSafe, planTargetLane } from '../../../shared/sim/autopilot';
import { createSocket, request } from './net';
import { storageGet, storageSet } from './router';

/** Development keys. Each simulated player is a real Socket.IO client using the normal controller path. */
export const SIM_KEYS: Record<Role, { codes: string[]; label: string }> = {
  'blue-left': { codes: ['KeyA'], label: 'A' },
  'blue-right': { codes: ['KeyD'], label: 'D' },
  'orange-left': { codes: ['ArrowLeft', 'KeyJ'], label: '← / J' },
  'orange-right': { codes: ['ArrowRight', 'KeyL'], label: '→ / L' },
};

interface Bot {
  role: Role;
  socket: Socket;
  epoch: number;
  seq: number;
  lastPress: number;
}

export class SimBots {
  private bots = new Map<Role, Bot>();
  private storageKey: string;

  constructor(private readonly code: string) {
    this.storageKey = `ss-bots-${code}`;
  }

  get roles(): Role[] {
    return [...this.bots.keys()];
  }

  private saved(): Partial<Record<Role, string>> {
    return storageGet(sessionStorage, this.storageKey) ?? {};
  }

  private save(role: Role, token: string | null) {
    const all = this.saved();
    if (token) all[role] = token;
    else delete all[role];
    storageSet(sessionStorage, this.storageKey, all);
  }

  private connect(role: Role, setup: (socket: Socket) => Promise<(JoinOk & { ok: true }) | null>): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createSocket();
      let first = true;
      socket.on('connect', async () => {
        const res = await setup(socket);
        if (!res) {
          if (first) socket.disconnect();
          this.bots.delete(role);
          resolve(false);
          return;
        }
        const bot = this.bots.get(role);
        if (bot) {
          bot.epoch = res.epoch;
          bot.seq = res.nextSeq - 1;
        } else {
          this.bots.set(role, { role, socket, epoch: res.epoch, seq: res.nextSeq - 1, lastPress: 0 });
        }
        this.save(role, res.sessionToken);
        if (first) resolve(true);
        first = false;
        // Subsequent reconnects resume with the stored token.
        setup = async (s) => {
          const r = await request<JoinOk & { ok: true }>(s, 'player:resume', { code: this.code, sessionToken: res.sessionToken });
          return r.ok ? r : null;
        };
      });
      socket.on('player:removed', () => this.remove(role));
    });
  }

  /** Re-attach bots from a previous page load (same browser tab). */
  async restore(): Promise<void> {
    const saved = this.saved();
    await Promise.all(
      ROLES.filter((r) => saved[r] && !this.bots.has(r)).map((role) =>
        this.connect(role, async (socket) => {
          const r = await request<JoinOk & { ok: true }>(socket, 'player:resume', { code: this.code, sessionToken: saved[role] });
          if (!r.ok) this.save(role, null);
          return r.ok ? r : null;
        }),
      ),
    );
  }

  async fill(roles: Role[]): Promise<void> {
    await Promise.all(
      roles
        .filter((r) => !this.bots.has(r))
        .map((role) =>
          this.connect(role, async (socket) => {
            const name = `Sim ${TEAM_LABEL[roleTeam(role)]} ${roleDirection(role) === 'left' ? 'L' : 'R'}`;
            const r = await request<JoinOk & { ok: true }>(socket, 'player:join', { code: this.code, name, role, sim: true });
            return r.ok ? r : null;
          }),
        ),
    );
    for (const role of roles) {
      const bot = this.bots.get(role);
      if (!bot) continue;
      await this.press(role);
      await request(bot.socket, 'player:status', { ready: true });
    }
  }

  press(role: Role): Promise<unknown> {
    const bot = this.bots.get(role);
    if (!bot || !bot.socket.connected) return Promise.resolve(null);
    bot.seq++;
    return request(bot.socket, 'player:input', { seq: bot.seq, epoch: bot.epoch });
  }

  /**
   * Dev autopilot: each simulated player presses its own key when the planner wants its
   * team's car to move in that player's direction. Inputs still go through the server.
   */
  autopilot(snap: Snapshot): void {
    if (snap.phase !== 'playing') return;
    const now = performance.now();
    const obstacles = snap.traffic.map((o) => ({ lane: o[1], z: o[2], kind: TRAFFIC_KIND_INDEX[o[3]] ?? 'car' }));
    for (const bot of this.bots.values()) {
      const car = snap.cars[roleTeam(bot.role)];
      if (car.moving || car.crashed || now - bot.lastPress < SHAKE_COOLDOWN_MS + 30) continue;
      const target = planTargetLane(car.lane, snap.speed, obstacles);
      if (target === car.lane) continue;
      const dir = target < car.lane ? 'left' : 'right';
      if (dir !== roleDirection(bot.role)) continue;
      if (!isMoveSafe(car.lane + (dir === 'left' ? -1 : 1), snap.speed, obstacles)) continue;
      bot.lastPress = now;
      void this.press(bot.role);
    }
  }

  async readyAll(): Promise<void> {
    for (const bot of this.bots.values()) await request(bot.socket, 'player:status', { ready: true });
  }

  remove(role: Role): void {
    const bot = this.bots.get(role);
    if (!bot) return;
    this.bots.delete(role);
    this.save(role, null);
    bot.socket.disconnect();
  }

  async removeAll(): Promise<void> {
    for (const bot of [...this.bots.values()]) {
      await request(bot.socket, 'player:leave', {}, 1000);
      this.remove(bot.role);
    }
  }

  /** Disconnect without releasing seats, e.g. on page unload: they can be restored. */
  dispose(): void {
    for (const bot of this.bots.values()) bot.socket.disconnect();
    this.bots.clear();
  }
}

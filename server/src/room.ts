import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  COUNTDOWN_TICKS,
  INPUT_MAX_PER_WINDOW,
  INPUT_MIN_INTERVAL_MS,
  INPUT_WINDOW_MS,
  ROLES,
  SNAPSHOT_EVERY_TICKS,
  TICK_MS,
  roleDirection,
  roleTeam,
  type Role,
} from '../../shared/constants';
import {
  ERROR_MESSAGES,
  type ErrorCode,
  type InputAck,
  type InputRejectReason,
  type JoinOk,
  type MotionMode,
  type PauseInfo,
  type Phase,
  type PublicPlayer,
  type Result,
  type RoomState,
  type Snapshot,
} from '../../shared/protocol';
import {
  applySteer,
  carSnapshot,
  createSim,
  simLevel,
  stepSim,
  trafficSnapshot,
  type SimState,
  type SteerOutcome,
} from '../../shared/sim/simulation';

export interface Broadcaster {
  /** Lobby/room state for everyone watching this room. */
  state(code: string, state: RoomState): void;
  /** Game snapshots for the host and display screens. */
  snapshot(code: string, snapshot: Snapshot): void;
  event(code: string, name: string, payload: unknown): void;
  toSocket(socketId: string, name: string, payload: unknown): void;
}

export interface RoomDeps {
  out: Broadcaster;
  now: () => number;
  reconnectWindowMs: number;
  simEnabled: boolean;
  joinUrl: string | null;
}

interface PlayerSlot {
  role: Role;
  name: string;
  sessionToken: string;
  epoch: number;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  motion: MotionMode;
  shakeTested: boolean;
  ready: boolean;
  sim: boolean;
  lastSeq: number;
  inputTimes: number[];
}

interface QueuedInput {
  role: Role;
  seq: number;
  ack: (ack: InputAck) => void;
}

export function fail(error: ErrorCode): { ok: false; error: ErrorCode; message: string } {
  return { ok: false, error, message: ERROR_MESSAGES[error] };
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const STEER_REJECT: Record<Exclude<SteerOutcome, 'ok'>, InputRejectReason> = {
  busy: 'busy',
  edge: 'edge',
  crashed: 'crashed',
  over: 'inactive',
};

export class Room {
  readonly code: string;
  readonly hostToken = newToken();
  readonly createdAt: number;
  hostSocketId: string | null = null;
  readonly displays = new Set<string>();
  readonly watchers = new Set<string>();
  private players: Record<Role, PlayerSlot | null> = {
    'blue-left': null,
    'blue-right': null,
    'orange-left': null,
    'orange-right': null,
  };
  /** Names of players whose reservation expired during the current round. */
  private abandoned: Partial<Record<Role, string>> = {};
  phase: Phase = 'lobby';
  sim: SimState | null = null;
  private countdownTicks = 0;
  private round = 0;
  private inputQueue: QueuedInput[] = [];
  private accumulator = 0;
  private lastUpdate: number | null = null;
  private loopTicks = 0;
  lastOccupiedAt: number;

  constructor(
    code: string,
    private readonly deps: RoomDeps,
  ) {
    this.code = code;
    this.createdAt = deps.now();
    this.lastOccupiedAt = this.createdAt;
  }

  // ---------------------------------------------------------------- queries

  checkHost(token: unknown): boolean {
    return typeof token === 'string' && sameToken(token, this.hostToken);
  }

  roleOfSocket(socketId: string): Role | null {
    for (const role of ROLES) if (this.players[role]?.socketId === socketId) return role;
    return null;
  }

  private slotOfSocket(socketId: string): PlayerSlot | null {
    const role = this.roleOfSocket(socketId);
    return role ? this.players[role] : null;
  }

  get hostConnected(): boolean {
    return this.hostSocketId !== null;
  }

  private allPlayersConnected(): boolean {
    return ROLES.every((r) => this.players[r]?.connected);
  }

  canStart(): boolean {
    return (
      this.phase === 'lobby' &&
      this.hostConnected &&
      ROLES.every((r) => {
        const p = this.players[r];
        return p !== null && p.connected && p.ready;
      })
    );
  }

  canResume(): boolean {
    return this.phase === 'paused' && this.hostConnected && this.allPlayersConnected();
  }

  connectedCount(): number {
    let n = (this.hostConnected ? 1 : 0) + this.displays.size + this.watchers.size;
    for (const role of ROLES) if (this.players[role]?.connected) n++;
    return n;
  }

  private pauseInfo(): PauseInfo | null {
    if (this.phase !== 'paused') return null;
    const missing: PauseInfo['missing'] = [];
    if (!this.hostConnected) missing.push({ role: 'host', name: 'Host screen', abandoned: false });
    for (const role of ROLES) {
      const p = this.players[role];
      if (p && !p.connected) missing.push({ role, name: p.name, abandoned: false });
      if (!p && this.abandoned[role]) missing.push({ role, name: this.abandoned[role]!, abandoned: true });
    }
    return { missing };
  }

  publicState(): RoomState {
    const players = {} as Record<Role, PublicPlayer | null>;
    for (const role of ROLES) {
      const p = this.players[role];
      players[role] = p
        ? {
            name: p.name,
            connected: p.connected,
            motion: p.motion,
            shakeTested: p.shakeTested,
            ready: p.ready,
            sim: p.sim,
            reservedUntil: p.disconnectedAt === null ? null : p.disconnectedAt + this.deps.reconnectWindowMs,
          }
        : null;
    }
    return {
      code: this.code,
      phase: this.phase,
      joinUrl: this.deps.joinUrl,
      players,
      hostConnected: this.hostConnected,
      displays: this.displays.size,
      pause: this.pauseInfo(),
      result: this.sim?.result ?? null,
      canStart: this.canStart(),
      canResume: this.canResume(),
      round: this.round,
      simEnabled: this.deps.simEnabled,
    };
  }

  snapshot(): Snapshot | null {
    const sim = this.sim;
    if (!sim) return null;
    return {
      tick: sim.tick,
      serverTime: this.deps.now(),
      phase: this.phase,
      round: this.round,
      timeS: sim.timeS,
      distance: sim.distance,
      speed: sim.speed,
      level: simLevel(sim),
      countdownMs: this.phase === 'countdown' ? Math.max(0, this.countdownTicks * TICK_MS) : null,
      cars: { blue: carSnapshot(sim.cars.blue), orange: carSnapshot(sim.cars.orange) },
      traffic: trafficSnapshot(sim),
    };
  }

  broadcast(): void {
    this.deps.out.state(this.code, this.publicState());
  }

  private broadcastSnapshot(): void {
    const snap = this.snapshot();
    if (snap) this.deps.out.snapshot(this.code, snap);
  }

  // ---------------------------------------------------------------- phases

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.accumulator = 0;
    this.lastUpdate = null;
    if (phase !== 'playing') this.flushInputs('inactive');
    this.broadcast();
    this.broadcastSnapshot();
  }

  private flushInputs(reason: InputRejectReason): void {
    const queue = this.inputQueue;
    this.inputQueue = [];
    for (const q of queue) q.ack({ seq: q.seq, ok: false, reason });
  }

  private resetInputState(): void {
    this.flushInputs('stale');
    for (const role of ROLES) {
      const p = this.players[role];
      if (p) p.inputTimes = [];
    }
  }

  private pauseIfActive(): void {
    if (this.phase === 'countdown' || this.phase === 'playing') this.setPhase('paused');
    else this.broadcast();
  }

  private beginRound(): void {
    this.round++;
    this.abandoned = {};
    this.sim = createSim(randomInt(1, 2 ** 31 - 1));
    this.countdownTicks = COUNTDOWN_TICKS;
    this.resetInputState();
    this.setPhase('countdown');
  }

  // ---------------------------------------------------------------- host

  attachHost(socketId: string): string | null {
    const previous = this.hostSocketId;
    this.hostSocketId = socketId;
    this.broadcast();
    return previous && previous !== socketId ? previous : null;
  }

  hostAction(action: string, role: unknown): Result {
    switch (action) {
      case 'start':
        if (!this.canStart()) return fail('not_ready');
        this.beginRound();
        return { ok: true };
      case 'playAgain':
        if (this.phase !== 'finished' || !this.allPlayersConnected()) return fail('not_ready');
        this.beginRound();
        return { ok: true };
      case 'resume':
        if (!this.canResume()) return fail('not_ready');
        // A fresh countdown with stale steering cleared; the simulation clock does not move meanwhile.
        this.resetInputState();
        this.countdownTicks = COUNTDOWN_TICKS;
        this.setPhase('countdown');
        return { ok: true };
      case 'toLobby':
        if (this.phase === 'lobby') return { ok: true };
        this.sim = null;
        this.abandoned = {};
        for (const r of ROLES) {
          const p = this.players[r];
          if (p) p.ready = false;
        }
        this.resetInputState();
        this.setPhase('lobby');
        return { ok: true };
      case 'kick': {
        if (this.phase !== 'lobby' || typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
          return fail('bad_request');
        }
        const slot = this.players[role as Role];
        if (slot) {
          this.players[role as Role] = null;
          if (slot.socketId) this.deps.out.toSocket(slot.socketId, 'player:removed', { reason: 'kicked' });
          this.broadcast();
        }
        return { ok: true };
      }
      default:
        return fail('bad_request');
    }
  }

  // ---------------------------------------------------------------- players

  join(socketId: string, name: string, role: Role, sim: boolean): Result<JoinOk> {
    if (sim && !this.deps.simEnabled) return fail('sim_disabled');
    if (this.phase !== 'lobby') return fail('round_active');
    if (this.roleOfSocket(socketId)) return fail('bad_request');
    if (ROLES.every((r) => this.players[r] !== null)) return fail('room_full');
    if (this.players[role]) return fail('role_taken');
    const slot: PlayerSlot = {
      role,
      name,
      sessionToken: newToken(),
      epoch: 1,
      socketId,
      connected: true,
      disconnectedAt: null,
      motion: sim ? 'sim' : 'pending',
      shakeTested: false,
      ready: false,
      sim,
      lastSeq: 0,
      inputTimes: [],
    };
    this.players[role] = slot;
    this.broadcast();
    return { ok: true, role, sessionToken: slot.sessionToken, epoch: slot.epoch, nextSeq: 1, name };
  }

  findSession(sessionToken: string): PlayerSlot | null {
    for (const role of ROLES) {
      const p = this.players[role];
      if (p && sameToken(p.sessionToken, sessionToken)) return p;
    }
    return null;
  }

  /** Reconnect with the opaque session token. Returns the replaced socket id, if any. */
  resume(socketId: string, sessionToken: string): Result<JoinOk & { replaced: string | null }> {
    const slot = this.findSession(sessionToken);
    if (!slot) return fail('session_expired');
    const replaced = slot.socketId && slot.socketId !== socketId ? slot.socketId : null;
    slot.socketId = socketId;
    slot.connected = true;
    slot.disconnectedAt = null;
    slot.epoch++;
    slot.inputTimes = [];
    this.inputQueue = this.inputQueue.filter((q) => {
      if (q.role !== slot.role) return true;
      q.ack({ seq: q.seq, ok: false, reason: 'stale' });
      return false;
    });
    this.broadcast();
    return {
      ok: true,
      role: slot.role,
      sessionToken: slot.sessionToken,
      epoch: slot.epoch,
      nextSeq: slot.lastSeq + 1,
      name: slot.name,
      replaced,
    };
  }

  changeRole(socketId: string, role: Role): Result<{ role: Role }> {
    const slot = this.slotOfSocket(socketId);
    if (!slot) return fail('unauthorized');
    if (this.phase !== 'lobby') return fail('round_active');
    if (slot.role === role) return { ok: true, role };
    if (this.players[role]) return fail('role_taken');
    this.players[slot.role] = null;
    slot.role = role;
    slot.ready = false;
    this.players[role] = slot;
    this.broadcast();
    return { ok: true, role };
  }

  setStatus(socketId: string, motion: Exclude<MotionMode, 'sim'> | undefined, ready: boolean | undefined): Result {
    const slot = this.slotOfSocket(socketId);
    if (!slot) return fail('unauthorized');
    if (motion !== undefined && !slot.sim && motion !== slot.motion) {
      slot.motion = motion;
      if (this.phase === 'lobby') {
        slot.shakeTested = false;
        slot.ready = false;
      }
    }
    if (ready !== undefined) {
      if (this.phase !== 'lobby') return fail('round_active');
      if (ready && (slot.motion === 'pending' || !slot.shakeTested)) return fail('not_ready');
      slot.ready = ready;
    }
    this.broadcast();
    return { ok: true };
  }

  leave(socketId: string): void {
    const slot = this.slotOfSocket(socketId);
    if (!slot) return;
    if (this.phase === 'lobby') {
      this.players[slot.role] = null;
      this.broadcast();
    } else {
      this.markDisconnected(slot);
    }
  }

  private markDisconnected(slot: PlayerSlot): void {
    slot.socketId = null;
    slot.connected = false;
    slot.disconnectedAt = this.deps.now();
    slot.ready = this.phase === 'lobby' ? false : slot.ready;
    this.inputQueue = this.inputQueue.filter((q) => {
      if (q.role !== slot.role) return true;
      q.ack({ seq: q.seq, ok: false, reason: 'stale' });
      return false;
    });
    this.pauseIfActive();
  }

  /** Returns true if the socket belonged to this room. */
  detachSocket(socketId: string): boolean {
    if (this.hostSocketId === socketId) {
      this.hostSocketId = null;
      this.pauseIfActive();
      return true;
    }
    if (this.displays.delete(socketId) || this.watchers.delete(socketId)) {
      this.broadcast();
      return true;
    }
    const slot = this.slotOfSocket(socketId);
    if (slot) {
      this.markDisconnected(slot);
      return true;
    }
    return false;
  }

  input(socketId: string, seq: number, epoch: unknown, ack: (ack: InputAck) => void): void {
    const slot = this.slotOfSocket(socketId);
    if (!slot) return ack({ seq, ok: false, reason: 'not_joined' });
    if (epoch !== slot.epoch) return ack({ seq, ok: false, reason: 'stale' });
    if (seq <= slot.lastSeq) return ack({ seq, ok: false, reason: 'duplicate' });
    slot.lastSeq = seq;
    if (this.phase !== 'playing' && this.phase !== 'lobby') return ack({ seq, ok: false, reason: 'inactive' });

    const now = this.deps.now();
    slot.inputTimes = slot.inputTimes.filter((t) => now - t < INPUT_WINDOW_MS);
    const last = slot.inputTimes[slot.inputTimes.length - 1];
    if ((last !== undefined && now - last < INPUT_MIN_INTERVAL_MS) || slot.inputTimes.length >= INPUT_MAX_PER_WINDOW) {
      return ack({ seq, ok: false, reason: 'rate_limited' });
    }
    slot.inputTimes.push(now);

    if (this.phase === 'lobby') {
      const changed = !slot.shakeTested;
      slot.shakeTested = true;
      this.deps.out.event(this.code, 'lobby:test', { role: slot.role });
      if (changed) this.broadcast();
      return ack({ seq, ok: true });
    }
    this.inputQueue.push({ role: slot.role, seq, ack });
  }

  // ---------------------------------------------------------------- loop

  /** Advance by however many fixed steps real time allows. Inactive phases never accumulate time. */
  update(now: number): void {
    if (this.phase !== 'countdown' && this.phase !== 'playing') {
      this.lastUpdate = null;
      this.accumulator = 0;
      return;
    }
    if (this.lastUpdate === null) this.lastUpdate = now;
    this.accumulator += Math.max(0, now - this.lastUpdate);
    this.lastUpdate = now;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < 6) {
      this.accumulator -= TICK_MS;
      steps++;
      this.tick();
      if (this.phase !== 'countdown' && this.phase !== 'playing') return;
    }
    if (steps === 6) this.accumulator = Math.min(this.accumulator, TICK_MS);
  }

  tick(): void {
    const sim = this.sim;
    if (!sim) return;
    if (this.phase === 'countdown') {
      this.countdownTicks--;
      if (this.countdownTicks <= 0) {
        this.setPhase('playing');
        return;
      }
    } else if (this.phase === 'playing') {
      const queue = this.inputQueue;
      this.inputQueue = [];
      for (const q of queue) {
        const team = roleTeam(q.role);
        const outcome = applySteer(sim, team, roleDirection(q.role));
        q.ack(
          outcome === 'ok'
            ? { seq: q.seq, ok: true, lane: sim.cars[team].toLane }
            : { seq: q.seq, ok: false, reason: STEER_REJECT[outcome] },
        );
      }
      stepSim(sim);
      if (sim.result) {
        this.setPhase('finished');
        return;
      }
    } else {
      return;
    }
    this.loopTicks++;
    if (this.loopTicks % SNAPSHOT_EVERY_TICKS === 0) this.broadcastSnapshot();
  }

  /** Releases reserved roles whose owners did not return in time. */
  expireReservations(now: number): void {
    let changed = false;
    for (const role of ROLES) {
      const p = this.players[role];
      if (p && !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= this.deps.reconnectWindowMs) {
        this.players[role] = null;
        if (this.phase !== 'lobby') this.abandoned[role] = p.name;
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }
}

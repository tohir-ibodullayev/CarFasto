import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH } from '../../shared/constants';
import type { AppConfig } from './config';
import { Room, type Broadcaster } from './room';

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** Which room each socket currently belongs to (host, player, display or watcher). */
  readonly socketRoom = new Map<string, string>();
  private loop: NodeJS.Timeout | null = null;
  private housekeeping: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly out: Broadcaster,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => number = () => Date.now(),
  ) {}

  private generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  create(): Room | null {
    if (this.rooms.size >= this.config.maxRooms) return null;
    const code = this.generateCode();
    const room = new Room(code, {
      out: this.out,
      now: this.wallNow,
      reconnectWindowMs: this.config.reconnectWindowMs,
      simEnabled: this.config.simEnabled,
      joinUrl: this.config.publicOrigin ? `${this.config.publicOrigin}/join/${code}` : null,
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  roomOfSocket(socketId: string): Room | undefined {
    const code = this.socketRoom.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }

  /** Detach a socket from whatever room it was in. */
  detach(socketId: string): Room | undefined {
    const room = this.roomOfSocket(socketId);
    this.socketRoom.delete(socketId);
    room?.detachSocket(socketId);
    return room;
  }

  start(): void {
    if (this.loop) return;
    this.loop = setInterval(() => this.updateAll(), 4);
    this.housekeeping = setInterval(() => this.cleanup(), 1000);
  }

  stop(): void {
    if (this.loop) clearInterval(this.loop);
    if (this.housekeeping) clearInterval(this.housekeeping);
    this.loop = this.housekeeping = null;
  }

  updateAll(): void {
    const now = this.now();
    for (const room of this.rooms.values()) room.update(now);
  }

  cleanup(): void {
    const wall = this.wallNow();
    for (const [code, room] of this.rooms) {
      room.expireReservations(wall);
      if (room.connectedCount() > 0) {
        room.lastOccupiedAt = wall;
      } else if (wall - room.lastOccupiedAt > this.config.roomIdleTimeoutMs) {
        this.rooms.delete(code);
        for (const [socketId, c] of this.socketRoom) if (c === code) this.socketRoom.delete(socketId);
      }
    }
  }
}

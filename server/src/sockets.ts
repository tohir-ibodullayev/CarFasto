import type { Server, Socket } from 'socket.io';
import type { Result } from '../../shared/protocol';
import {
  isClientMotionMode,
  isRecord,
  isRole,
  isSeq,
  isToken,
  normalizeRoomCode,
  sanitizeName,
} from '../../shared/validation';
import type { Room } from './room';
import { fail } from './room';
import type { RoomManager } from './roomManager';

export const stateChannel = (code: string) => `room:${code}`;
export const snapChannel = (code: string) => `snap:${code}`;

type Ack = (response: unknown) => void;

/** Simple token bucket so one socket cannot flood the server with events. */
function rateLimiter(capacity: number, refillPerSecond: number) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSecond);
    last = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}

export function registerSocketHandlers(io: Server, manager: RoomManager): void {
  io.on('connection', (socket: Socket) => {
    const allow = rateLimiter(40, 25);

    const on = (event: string, handler: (payload: Record<string, unknown>, ack: Ack) => void) => {
      socket.on(event, (payload: unknown, maybeAck: unknown) => {
        const ack: Ack = typeof maybeAck === 'function' ? (maybeAck as Ack) : () => {};
        if (!allow()) return ack(fail('rate_limited'));
        if (payload !== undefined && payload !== null && !isRecord(payload)) return ack(fail('bad_request'));
        try {
          handler((payload ?? {}) as Record<string, unknown>, ack);
        } catch (err) {
          console.error(`Error handling ${event}`, err);
          ack(fail('bad_request'));
        }
      });
    };

    const roomFromPayload = (payload: Record<string, unknown>): Result<{ room: Room }> => {
      const code = normalizeRoomCode(payload.code);
      if (!code) return fail('invalid_code');
      const room = manager.get(code);
      if (!room) return fail('room_not_found');
      return { ok: true, room };
    };

    /** Moves this socket into `room`, leaving any previous room first. */
    const enter = (room: Room) => {
      const current = manager.roomOfSocket(socket.id);
      if (current && current !== room) {
        manager.detach(socket.id);
        socket.leave(stateChannel(current.code));
        socket.leave(snapChannel(current.code));
      } else if (current === room) {
        room.displays.delete(socket.id);
        room.watchers.delete(socket.id);
      }
      manager.socketRoom.set(socket.id, room.code);
      socket.join(stateChannel(room.code));
    };

    const replaceSocket = (oldId: string, event: string) => {
      const old = io.sockets.sockets.get(oldId);
      if (old) {
        old.emit(event);
        manager.socketRoom.delete(oldId);
        old.disconnect(true);
      }
    };

    // ------------------------------------------------------------------ host

    on('host:create', (_payload, ack) => {
      const room = manager.create();
      if (!room) return ack(fail('server_full'));
      enter(room);
      socket.join(snapChannel(room.code));
      room.attachHost(socket.id);
      ack({ ok: true, code: room.code, hostToken: room.hostToken, state: room.publicState() });
    });

    on('host:attach', (payload, ack) => {
      const found = roomFromPayload(payload);
      if (!found.ok) return ack(found);
      const { room } = found;
      if (!room.checkHost(payload.hostToken)) return ack(fail('unauthorized'));
      enter(room);
      socket.join(snapChannel(room.code));
      const previous = room.attachHost(socket.id);
      if (previous) replaceSocket(previous, 'host:replaced');
      ack({ ok: true, code: room.code, state: room.publicState(), snapshot: room.snapshot() });
    });

    on('host:action', (payload, ack) => {
      const found = roomFromPayload(payload);
      if (!found.ok) return ack(found);
      const { room } = found;
      if (!room.checkHost(payload.hostToken) || room.hostSocketId !== socket.id) return ack(fail('unauthorized'));
      if (typeof payload.action !== 'string') return ack(fail('bad_request'));
      ack(room.hostAction(payload.action, payload.role));
    });

    // --------------------------------------------------------------- viewers

    on('room:watch', (payload, ack) => {
      const found = roomFromPayload(payload);
      if (!found.ok) return ack(found);
      const { room } = found;
      // A joined controller re-watching must keep its seat.
      if (room.roleOfSocket(socket.id)) return ack({ ok: true, state: room.publicState() });
      enter(room);
      if (payload.display === true) {
        room.displays.add(socket.id);
        socket.join(snapChannel(room.code));
      } else {
        room.watchers.add(socket.id);
      }
      room.broadcast();
      ack({ ok: true, state: room.publicState(), snapshot: payload.display === true ? room.snapshot() : null });
    });

    // --------------------------------------------------------------- players

    on('player:join', (payload, ack) => {
      const found = roomFromPayload(payload);
      if (!found.ok) return ack(found);
      const { room } = found;
      const name = sanitizeName(payload.name);
      if (!name) return ack(fail('bad_name'));
      if (!isRole(payload.role)) return ack(fail('bad_request'));
      if (room.roleOfSocket(socket.id)) return ack(fail('bad_request'));
      const result = room.join(socket.id, name, payload.role, payload.sim === true);
      if (result.ok) {
        enter(room);
        room.broadcast();
      }
      ack(result.ok ? { ...result, state: room.publicState() } : result);
    });

    on('player:resume', (payload, ack) => {
      const found = roomFromPayload(payload);
      if (!found.ok) return ack(found);
      const { room } = found;
      if (!isToken(payload.sessionToken)) return ack(fail('session_expired'));
      if (!room.findSession(payload.sessionToken)) return ack(fail('session_expired'));
      enter(room);
      const result = room.resume(socket.id, payload.sessionToken);
      if (!result.ok) return ack(result);
      if (result.replaced) replaceSocket(result.replaced, 'session:replaced');
      const { replaced: _replaced, ...ok } = result;
      ack({ ...ok, state: room.publicState() });
    });

    on('player:changeRole', (payload, ack) => {
      const room = manager.roomOfSocket(socket.id);
      if (!room) return ack(fail('unauthorized'));
      if (!isRole(payload.role)) return ack(fail('bad_request'));
      ack(room.changeRole(socket.id, payload.role));
    });

    on('player:status', (payload, ack) => {
      const room = manager.roomOfSocket(socket.id);
      if (!room) return ack(fail('unauthorized'));
      const motion = payload.motion === undefined ? undefined : isClientMotionMode(payload.motion) ? payload.motion : null;
      const ready = payload.ready === undefined ? undefined : typeof payload.ready === 'boolean' ? payload.ready : null;
      if (motion === null || ready === null) return ack(fail('bad_request'));
      ack(room.setStatus(socket.id, motion, ready));
    });

    on('player:leave', (_payload, ack) => {
      const room = manager.roomOfSocket(socket.id);
      if (room) room.leave(socket.id);
      ack({ ok: true });
    });

    on('player:input', (payload, ack) => {
      if (!isSeq(payload.seq)) return ack({ seq: 0, ok: false, reason: 'duplicate' });
      const room = manager.roomOfSocket(socket.id);
      if (!room) return ack({ seq: payload.seq, ok: false, reason: 'not_joined' });
      // Only the sequence number and epoch are read: team and direction come from the seat.
      room.input(socket.id, payload.seq, payload.epoch, ack);
    });

    socket.on('disconnect', () => {
      manager.detach(socket.id);
    });
  });
}

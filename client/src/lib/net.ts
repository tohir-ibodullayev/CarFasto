import { io, type Socket } from 'socket.io-client';
import { buildJoinUrl, normalizePublicOrigin } from '../../../shared/origin';
import type { ErrorCode, ServerConfig } from '../../../shared/protocol';

/** Optional when the frontend and backend share an origin (the default). */
const SERVER_URL: string = import.meta.env.VITE_SERVER_URL || '';

export function createSocket(): Socket {
  return io(SERVER_URL || undefined, {
    transports: ['websocket', 'polling'],
    reconnectionDelay: 400,
    reconnectionDelayMax: 2000,
    forceNew: true,
  });
}

export type Failure = { ok: false; error: ErrorCode | 'timeout'; message: string };

export async function request<T>(socket: Socket, event: string, payload?: unknown, timeoutMs = 6000): Promise<T | Failure> {
  try {
    return (await socket.timeout(timeoutMs).emitWithAck(event, payload)) as T | Failure;
  } catch {
    return { ok: false, error: 'timeout', message: 'The server did not answer. Check your connection.' };
  }
}

let configPromise: Promise<ServerConfig> | null = null;
export function loadServerConfig(): Promise<ServerConfig> {
  configPromise ??= fetch(`${SERVER_URL}/api/config`)
    .then((r) => r.json() as Promise<ServerConfig>)
    .catch(() => ({ publicOrigin: null, simEnabled: false, reconnectWindowMs: 90000 }));
  return configPromise;
}

/** Prefer a valid server PUBLIC_ORIGIN; otherwise the page's own origin (correct on Render). */
export function publicOrigin(config: ServerConfig | null): string {
  return normalizePublicOrigin(config?.publicOrigin) ?? window.location.origin;
}

/** Prefer a server-provided join URL only if its origin is valid; otherwise rebuild from the page origin. */
export function resolveJoinUrl(roomJoinUrl: string | null | undefined, code: string, config: ServerConfig | null): string {
  if (roomJoinUrl) {
    try {
      const origin = normalizePublicOrigin(new URL(roomJoinUrl).origin);
      if (origin) return buildJoinUrl(origin, code);
    } catch {
      /* fall through */
    }
  }
  return buildJoinUrl(publicOrigin(config), code);
}

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export function trackConnection(socket: Socket, onChange: (state: ConnState) => void): () => void {
  const connect = () => onChange('connected');
  const disconnect = () => onChange(navigator.onLine ? 'reconnecting' : 'offline');
  const error = () => onChange(navigator.onLine ? 'reconnecting' : 'offline');
  socket.on('connect', connect);
  socket.on('disconnect', disconnect);
  socket.on('connect_error', error);
  return () => {
    socket.off('connect', connect);
    socket.off('disconnect', disconnect);
    socket.off('connect_error', error);
  };
}

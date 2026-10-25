export interface AppConfig {
  port: number;
  host: string;
  publicOrigin: string | null;
  simEnabled: boolean;
  production: boolean;
  corsOrigins: string[];
  reconnectWindowMs: number;
  roomIdleTimeoutMs: number;
  maxRooms: number;
  staticDir: string | null;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    console.warn(`Ignoring invalid PUBLIC_ORIGIN: ${value}`);
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const production = env.NODE_ENV === 'production';
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    publicOrigin: origin(env.PUBLIC_ORIGIN),
    simEnabled: bool(env.ENABLE_KEYBOARD_SIM, !production),
    production,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reconnectWindowMs: int(env.RECONNECT_WINDOW_MS, 90_000),
    roomIdleTimeoutMs: int(env.ROOM_IDLE_TIMEOUT_MS, 10 * 60_000),
    maxRooms: int(env.MAX_ROOMS, 500),
    staticDir: null,
    ...overrides,
  };
}

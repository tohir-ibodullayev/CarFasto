import type { Role, Team, TrafficKind } from './constants';

export type Phase = 'lobby' | 'countdown' | 'playing' | 'paused' | 'finished';
export type MotionMode = 'pending' | 'motion' | 'touch' | 'sim';

export interface PublicPlayer {
  name: string;
  connected: boolean;
  motion: MotionMode;
  shakeTested: boolean;
  ready: boolean;
  sim: boolean;
  /** Epoch ms when the reserved role is released, while disconnected. */
  reservedUntil: number | null;
}

export interface PauseInfo {
  /** Participants currently missing. `abandoned` means their reconnection window ran out. */
  missing: { role: Role | 'host'; name: string; abandoned: boolean }[];
}

export interface RoundResult {
  winner: Team | 'draw';
  timeS: number;
  crashed: Team[];
}

export interface RoomState {
  code: string;
  phase: Phase;
  joinUrl: string | null;
  players: Record<Role, PublicPlayer | null>;
  hostConnected: boolean;
  displays: number;
  pause: PauseInfo | null;
  result: RoundResult | null;
  canStart: boolean;
  canResume: boolean;
  round: number;
  simEnabled: boolean;
}

export interface CarSnapshot {
  x: number;
  lane: number;
  moving: boolean;
  crashed: boolean;
}

/** [id, lane, z, kindIndex, colorIndex] */
export type ObstacleTuple = [number, number, number, number, number];

export interface Snapshot {
  tick: number;
  serverTime: number;
  phase: Phase;
  round: number;
  timeS: number;
  distance: number;
  speed: number;
  level: number;
  countdownMs: number | null;
  cars: Record<Team, CarSnapshot>;
  /** One shared traffic list, mirrored onto both roads. */
  traffic: ObstacleTuple[];
}

export type InputRejectReason =
  | 'duplicate'
  | 'rate_limited'
  | 'inactive'
  | 'stale'
  | 'busy'
  | 'edge'
  | 'crashed'
  | 'not_joined';

export interface InputAck {
  seq: number;
  ok: boolean;
  reason?: InputRejectReason;
  /** Present for accepted steering: the lane the car is now heading to. */
  lane?: number;
}

export type ErrorCode =
  | 'bad_request'
  | 'invalid_code'
  | 'room_not_found'
  | 'room_full'
  | 'role_taken'
  | 'round_active'
  | 'bad_name'
  | 'unauthorized'
  | 'not_ready'
  | 'session_expired'
  | 'sim_disabled'
  | 'server_full'
  | 'rate_limited';

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'That request was not valid.',
  invalid_code: 'Room codes are 6 letters or numbers.',
  room_not_found: 'No game with that code. Check the code on the host screen.',
  room_full: 'This room already has four players.',
  role_taken: 'Someone already took that role. Pick another one.',
  round_active: 'A round is in progress. Wait for the host to return to the lobby.',
  bad_name: 'Enter a name of 1 to 16 characters.',
  unauthorized: 'You are not allowed to do that.',
  not_ready: 'Everyone must be connected and ready first.',
  session_expired: 'Your seat was released. Join again.',
  sim_disabled: 'Keyboard simulation is disabled on this server.',
  server_full: 'The server is busy. Try again in a minute.',
  rate_limited: 'Slow down a little.',
};

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: ErrorCode; message: string };

export interface ServerConfig {
  publicOrigin: string | null;
  simEnabled: boolean;
  reconnectWindowMs: number;
}

export interface JoinOk {
  role: Role;
  sessionToken: string;
  epoch: number;
  nextSeq: number;
  name: string;
}

export const TRAFFIC_KIND_INDEX: TrafficKind[] = ['car', 'van', 'truck'];

export const LANES = 4;

export const ROLES = ['blue-left', 'blue-right', 'orange-left', 'orange-right'] as const;
export type Role = (typeof ROLES)[number];
export type Team = 'blue' | 'orange';
export type Direction = 'left' | 'right';
export const TEAMS: readonly Team[] = ['blue', 'orange'];

export function roleTeam(role: Role): Team {
  return role.startsWith('blue') ? 'blue' : 'orange';
}

export function roleDirection(role: Role): Direction {
  return role.endsWith('left') ? 'left' : 'right';
}

export function roleFor(team: Team, direction: Direction): Role {
  return `${team}-${direction}` as Role;
}

export const TEAM_LABEL: Record<Team, string> = { blue: 'Blue', orange: 'Orange' };
export const TEAM_COLOR: Record<Team, string> = { blue: '#3ba4ff', orange: '#ff8a1f' };

// Simulation timing.
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY_TICKS = 3; // 20 snapshots per second
export const LANE_CHANGE_TICKS = 9; // 150 ms
export const LANE_CHANGE_S = LANE_CHANGE_TICKS / TICK_RATE;
export const COUNTDOWN_TICKS = 3 * TICK_RATE;

// World geometry. One world unit equals one lane width; z is distance ahead of the player car.
export const START_LANE = 1;
export const VIEW_AHEAD = 8.5;
export const VIEW_BEHIND = 1.5;
export const SPAWN_Z = 11;
export const DESPAWN_Z = -3;
export const FIRST_WAVE_DISTANCE = 15;

export interface BodySize {
  width: number;
  length: number;
  hitWidth: number;
  hitLength: number;
}

export const PLAYER_CAR: BodySize = { width: 0.5, length: 0.9, hitWidth: 0.42, hitLength: 0.74 };

export const TRAFFIC_KINDS = ['car', 'van', 'truck'] as const;
export type TrafficKind = (typeof TRAFFIC_KINDS)[number];
export const TRAFFIC_BODY: Record<TrafficKind, BodySize> = {
  car: { width: 0.5, length: 0.9, hitWidth: 0.42, hitLength: 0.74 },
  van: { width: 0.54, length: 1.1, hitWidth: 0.45, hitLength: 0.92 },
  truck: { width: 0.58, length: 1.6, hitWidth: 0.48, hitLength: 1.4 },
};
export const TRAFFIC_COLORS = ['#c9ced6', '#e5484d', '#46a758', '#8e4ec6', '#f5d90a', '#12a594', '#e93d82'];

// Difficulty curve (speeds in lanes per second, gaps in seconds between obstacle waves).
export const START_SPEED = 4.2;
export const MAX_SPEED = 8.5;
export const SPEED_RAMP = 0.06;
export const START_GAP_S = 2.5;
export const MIN_GAP_S = 1.15;
export const GAP_RAMP = 0.019;

export function speedAt(timeS: number): number {
  return Math.min(MAX_SPEED, START_SPEED + timeS * SPEED_RAMP);
}

export function gapAt(timeS: number): number {
  return Math.max(MIN_GAP_S, START_GAP_S - timeS * GAP_RAMP);
}

export function levelAt(timeS: number): number {
  return Math.min(9, 1 + Math.floor(timeS / 10));
}

// Assumptions used to prove that every traffic transition is reachable.
export const PLAN_REACTION_S = 0.45;
export const PLAN_REPEAT_S = 0.42; // one player's shake cooldown plus margin

// Input handling.
export const SHAKE_COOLDOWN_MS = 400;
export const INPUT_MIN_INTERVAL_MS = 120;
export const INPUT_MAX_PER_WINDOW = 6;
export const INPUT_WINDOW_MS = 1000;

// Rooms and validation.
export const CODE_LENGTH = 6;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const NAME_MAX_LENGTH = 16;

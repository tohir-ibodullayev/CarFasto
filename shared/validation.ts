import { CODE_ALPHABET, CODE_LENGTH, NAME_MAX_LENGTH, ROLES, type Role } from './constants';
import type { MotionMode } from './protocol';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/[\p{C}<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length < 1 || chars.length > NAME_MAX_LENGTH) return null;
  return cleaned;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isClientMotionMode(value: unknown): value is Exclude<MotionMode, 'sim'> {
  return value === 'pending' || value === 'motion' || value === 'touch';
}

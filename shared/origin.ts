/**
 * Normalize a configured public origin used for QR / join links.
 * Handles common Render paste mistakes like:
 *   https://app.onrender.comNODE_ENV=production
 *   app.onrender.com (missing scheme)
 * and rejects junk that would produce an unscannable QR.
 */
export function normalizePublicOrigin(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value) return null;

  // Keep only the first whitespace-separated token (paste of two env lines).
  value = value.split(/\s+/)[0] ?? '';

  // Strip a glued env assignment: https://host.tldNODE_ENV=production
  value = value.replace(/(https?:\/\/)?([^/\s]+?)(?:NODE_ENV|node_env)=[^/\s]*/i, (_m, scheme: string | undefined, host: string) => {
    return `${scheme ?? ''}${host}`;
  });

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname;
    if (!host || host.includes('=') || /\s/.test(host)) return null;
    // Must look like a hostname or IP, not a bare word with env junk.
    if (!/^[a-z0-9.-]+$/i.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Build a join URL from a trusted origin and room code. */
export function buildJoinUrl(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/join/${code}`;
}

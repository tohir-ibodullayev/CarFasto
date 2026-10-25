import { describe, expect, it } from 'vitest';
import { buildJoinUrl, normalizePublicOrigin } from '../shared/origin';
import { loadConfig } from '../server/src/config';

describe('normalizePublicOrigin', () => {
  it('accepts a clean https origin', () => {
    expect(normalizePublicOrigin('https://carfasto.onrender.com')).toBe('https://carfasto.onrender.com');
    expect(normalizePublicOrigin('https://carfasto.onrender.com/')).toBe('https://carfasto.onrender.com');
  });

  it('adds https when the scheme is missing', () => {
    expect(normalizePublicOrigin('carfasto.onrender.com')).toBe('https://carfasto.onrender.com');
  });

  it('strips a glued NODE_ENV paste mistake', () => {
    expect(normalizePublicOrigin('https://carfasto.onrender.comnode_env=production')).toBe(
      'https://carfasto.onrender.com',
    );
    expect(normalizePublicOrigin('https://carfasto.onrender.comNODE_ENV=production')).toBe(
      'https://carfasto.onrender.com',
    );
    expect(normalizePublicOrigin('carfasto.onrender.comnode_env=production')).toBe('https://carfasto.onrender.com');
  });

  it('keeps only the first token when two env lines were pasted', () => {
    expect(normalizePublicOrigin('https://carfasto.onrender.com\nNODE_ENV=production')).toBe(
      'https://carfasto.onrender.com',
    );
  });

  it('rejects empty or garbage values', () => {
    expect(normalizePublicOrigin('')).toBeNull();
    expect(normalizePublicOrigin('   ')).toBeNull();
    expect(normalizePublicOrigin(null)).toBeNull();
  });

  it('builds join URLs without a trailing slash on the origin', () => {
    expect(buildJoinUrl('https://carfasto.onrender.com', '3XK3VQ')).toBe(
      'https://carfasto.onrender.com/join/3XK3VQ',
    );
    expect(buildJoinUrl('https://carfasto.onrender.com/', '3XK3VQ')).toBe(
      'https://carfasto.onrender.com/join/3XK3VQ',
    );
  });
});

describe('loadConfig publicOrigin', () => {
  it('normalizes PUBLIC_ORIGIN and falls back to RENDER_EXTERNAL_URL', () => {
    expect(
      loadConfig({
        PUBLIC_ORIGIN: 'https://carfasto.onrender.comnode_env=production',
      }).publicOrigin,
    ).toBe('https://carfasto.onrender.com');

    expect(
      loadConfig({
        PUBLIC_ORIGIN: '',
        RENDER_EXTERNAL_URL: 'https://carfasto.onrender.com',
      }).publicOrigin,
    ).toBe('https://carfasto.onrender.com');
  });
});

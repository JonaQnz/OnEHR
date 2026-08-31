import { afterEach, describe, expect, it, vi } from 'vitest';

// QA review finding: every page/component used to hardcode the literal
// http://localhost:3001 directly (~27 files) instead of reading
// VITE_API_URL, bypassing it entirely and hardwiring every environment to
// "browser and API on the same host". This is the one shared source all
// of them now import from - verifies both the dev-default fallback and
// that a real deployment's VITE_API_URL actually takes effect.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('apiBaseUrl', () => {
  it('falls back to the fixed dev default when VITE_API_URL is unset', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const { API_ORIGIN, API_BASE_URL } = await import('./apiBaseUrl');
    expect(API_ORIGIN).toBe('http://localhost:3001');
    expect(API_BASE_URL).toBe('http://localhost:3001/api');
  });

  it('uses VITE_API_URL when a deployment actually configures it', async () => {
    vi.stubEnv('VITE_API_URL', 'https://forms.example.org');
    const { API_ORIGIN, API_BASE_URL } = await import('./apiBaseUrl');
    expect(API_ORIGIN).toBe('https://forms.example.org');
    expect(API_BASE_URL).toBe('https://forms.example.org/api');
  });
});

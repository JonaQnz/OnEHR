/**
 * The Forms API's base origin - overridable via `VITE_API_URL` at build
 * time (docker-compose.yml already sets this for the web service, and
 * main.tsx's global fetch-credentials patch already reads it the same
 * way). Falls back to the fixed dev default (browser and API both on
 * localhost) so nothing changes for the existing docker-compose dev
 * setup.
 *
 * QA review finding: every page/component used to hardcode the literal
 * `http://localhost:3001` directly instead of reading this - ~27 files,
 * independently, each bypassing `VITE_API_URL` entirely and hardwiring
 * every environment to "browser and API on the same host". That breaks
 * any real deployment where they aren't (the production Dockerfile
 * serves static `dist/` with no reverse proxy). One shared source
 * instead - every one of those files now imports API_ORIGIN/API_BASE_URL
 * from here rather than hand-rolling its own copy of the same fallback.
 */
export const API_ORIGIN: string = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_BASE_URL: string = `${API_ORIGIN}/api`;

export function loadServerConfig() {
  return {
    port: Number(process.env.PORT || 4300),
    // Must match frontend/vite.config.ts's own port (5180, not Vite's
    // default 5173 - that port belongs to the real Form Builder's own
    // docker-compose `web` container, see vite.config.ts's comment).
    // Confirmed live: a stale 5173 default here silently CORS-blocked
    // every real request from the frontend at 5180, surfacing to the user
    // only as a generic "Failed to fetch" with no indication of why.
    webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5180',
  };
}

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5180, not Vite's default 5173 - this repo's docker-compose `web`
// service (the real Form Builder's own Vite dev server) maps BOTH host
// ports 3000 and 5173 for its container, so 5173 collides with it
// whenever that container (re)starts - confirmed live (it crashed with
// exit 255 trying to bind an already-occupied 5173 after this generator's
// dev server had claimed it first).
export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
});

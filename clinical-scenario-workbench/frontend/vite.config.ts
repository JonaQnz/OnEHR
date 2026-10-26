import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5190 - distinct from the real Form Builder's own dev server (3000/
// 5173) and from vital-signs-generator's own frontend (5180), so all three
// can run side by side without colliding (see that project's own
// vite.config.ts comment for the exact collision this avoids).
export default defineConfig({
  plugins: [react()],
  server: { port: 5190 },
});

/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.VITE_DEV_API_PROXY ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev: the httpOnly refresh cookie and the websocket both go
    // through the Vite server, exactly like behind a production reverse proxy.
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/socket.io': { target: API, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // jsdom + Recharts per worker is memory-hungry; unbounded parallel forks
    // were killed by the OS (exit 134) on a dev laptop.
    maxWorkers: 2,
  },
});

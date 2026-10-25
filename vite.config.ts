import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT ?? 3000);
const clientPort = Number(process.env.CLIENT_DEV_PORT ?? 5173);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: true,
    port: clientPort,
    allowedHosts: true,
    proxy: {
      '/socket.io': { target: `http://localhost:${serverPort}`, ws: true },
      '/api': { target: `http://localhost:${serverPort}` },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});

import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type { ServerConfig } from '../../shared/protocol';
import type { AppConfig } from './config';
import type { Broadcaster } from './room';
import { RoomManager } from './roomManager';
import { registerSocketHandlers, snapChannel, stateChannel } from './sockets';

export interface App {
  http: HttpServer;
  io: Server;
  manager: RoomManager;
  /** `startLoop: false` lets tests drive the simulation clock by hand. */
  listen(options?: { startLoop?: boolean }): Promise<number>;
  close(): Promise<void>;
}

export function createApp(config: AppConfig): App {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  const http = createServer(app);
  const io = new Server(http, {
    // Detect vanished phones quickly so the round pauses promptly.
    pingInterval: 4000,
    pingTimeout: 5000,
    maxHttpBufferSize: 4096,
    cors: config.corsOrigins.length ? { origin: config.corsOrigins } : undefined,
  });

  const out: Broadcaster = {
    state: (code, state) => io.to(stateChannel(code)).emit('room:state', state),
    snapshot: (code, snapshot) => io.to(snapChannel(code)).emit('game:snapshot', snapshot),
    event: (code, name, payload) => io.to(stateChannel(code)).emit(name, payload),
    toSocket: (socketId, name, payload) => io.to(socketId).emit(name, payload),
  };
  const manager = new RoomManager(config, out);
  registerSocketHandlers(io, manager);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: manager.rooms.size });
  });

  app.get('/api/config', (_req, res) => {
    const body: ServerConfig = {
      publicOrigin: config.publicOrigin,
      simEnabled: config.simEnabled,
      reconnectWindowMs: config.reconnectWindowMs,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  if (config.staticDir && existsSync(config.staticDir)) {
    const staticDir = config.staticDir;
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return {
    http,
    io,
    manager,
    listen: (options = {}) =>
      new Promise((resolve) => {
        if (options.startLoop !== false) manager.start();
        http.listen(config.port, config.host, () => {
          const address = http.address();
          resolve(typeof address === 'object' && address ? address.port : config.port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        manager.stop();
        io.close(() => resolve());
      }),
  };
}

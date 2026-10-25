# Split Steering

**Two teams. Two cars. Four phones. Half the steering is yours.**

A competitive party racing game for exactly four players. One laptop shows two four-lane roads side by side. Each team (Blue and Orange) shares one car: the team's **LEFT** player shakes their phone to move the car one lane left, the **RIGHT** player shakes to move it one lane right. Acceleration is automatic, both roads get the exact same traffic, and the first team to crash loses.

- React + TypeScript + HTML Canvas frontend
- Node.js + TypeScript + Socket.IO backend with one authoritative game loop (60 Hz simulation, 20 Hz snapshots)
- No database, accounts or paid APIs. Rooms live in server memory.

## Quick start (local)

Requires Node.js 20 or newer (tested with Node 22).

```bash
npm ci          # reproducible install from package-lock.json
npm run dev     # API/Socket.IO server on :3000 + Vite dev client on :5173
```

Open <http://localhost:5173>, click **Host game**, and scan the QR code with a phone.

For development without four phones, the host lobby has a yellow **Keyboard simulation (dev only)** panel. It fills empty seats with simulated controllers. Each one is a separate Socket.IO client that goes through the same join, ready and steering validation as a phone. Keys on the host page: Blue left `A`, Blue right `D`, Orange left `←`/`J`, Orange right `→`/`L`. Press `P` (or tick the checkbox) to turn on an autopilot so simulated players steer on their own; that lets one real phone play alongside three bots. The simulation is on by default in development and **off by default in production** (`ENABLE_KEYBOARD_SIM`).

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch) and Vite client with hot reload |
| `npm run build` | Builds the client to `dist/client` and bundles the server to `dist/server` |
| `npm start` | Production server: serves the built client, the API and Socket.IO from one origin |
| `npm test` | Vitest: simulation, traffic fairness, shake detector, Socket.IO integration and real-time tests |
| `npm run typecheck` | `tsc --noEmit` over client, server, shared code and tests |

### Phones on your local network

Phones cannot open `localhost`. During development, open the host page via the LAN address that `npm run dev` prints (for example `http://192.168.1.20:5173`) so the QR code points there. Over plain HTTP, browsers block motion sensors, so phones will use the clearly labelled **touch fallback**, which the lobby shows as `TOUCH FALLBACK`.

To use real shake controls you need **HTTPS**. The quickest free option is a Cloudflare quick tunnel (no account needed; WebSockets work):

```bash
npm run build && npm start                     # production server on :3000
cloudflared tunnel --url http://localhost:3000 # prints https://<random>.trycloudflare.com
```

Open the printed `https://…trycloudflare.com/host` URL on the laptop. The QR code automatically uses that origin. You can also set `PUBLIC_ORIGIN` to pin it.

## Configuration

Copy `.env.example` to `.env` (the server loads it on start) or set the variables in your host's dashboard.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_ORIGIN` | (empty) | Public HTTPS origin used for the QR code and join links. Empty means the origin the host page was opened from. |
| `ENABLE_KEYBOARD_SIM` | `true` in dev, `false` in production | Allow simulated controllers |
| `RECONNECT_WINDOW_MS` | `90000` | How long a disconnected player's seat is reserved |
| `ROOM_IDLE_TIMEOUT_MS` | `600000` | Delete rooms with nobody connected after this long |
| `MAX_ROOMS` | `500` | Memory guard |
| `CORS_ORIGINS` / `VITE_SERVER_URL` | (empty) | Only for split frontend/backend hosting. Same-origin is the default and recommended. |

## HTTPS deployment

The game needs a host that runs a **long-lived Node process with WebSocket support**. A static site or a serverless function cannot hold the game loop. Run a **single instance**: rooms live in that process's memory.

### Render (free web service)

`NODE_ENV=production` makes `npm ci` skip build tools (`vite`, `esbuild`). Use `--include=dev` in the **build** command or the deploy will start without `dist/server/index.js`.

1. Push this repository to GitHub. On <https://render.com> create a **Web Service** from the repo (branch with this code, not an empty `main`).
2. Settings:

| Field | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Instance | Free (keep **one** instance — rooms are in memory) |

3. Environment variables — set each on its **own** line (do not paste `NODE_ENV` into the `PUBLIC_ORIGIN` value):

```
NODE_ENV=production
PUBLIC_ORIGIN=https://<your-service>.onrender.com
```

If `PUBLIC_ORIGIN` is missing or invalid, the server uses Render’s automatic `RENDER_EXTERNAL_URL`, and the host page falls back to the browser’s own origin so the QR still points at `/join/<code>`.

4. Deploy. Open the `.onrender.com` URL → **Host game**. Free instances sleep when idle — wake the site about a minute before a demo.

Or use the included `render.yaml` Blueprint (same build/start commands). After redeploy, create a **new** room so the QR picks up the fixed join URL.

### Fly.io (Docker)

```bash
fly launch --no-deploy          # detects the Dockerfile; choose an app name
fly secrets set PUBLIC_ORIGIN=https://<app>.fly.dev
fly scale count 1               # rooms are in memory: keep exactly one machine
fly deploy
```

### Any VPS (Docker + Caddy for automatic HTTPS)

```bash
docker build -t split-steering .
docker run -d --restart unless-stopped -p 3000:3000 -e PUBLIC_ORIGIN=https://game.example.com split-steering
```

Caddyfile (Caddy obtains the certificate and proxies WebSockets automatically):

```
game.example.com {
  reverse_proxy localhost:3000
}
```

Railway or any similar host works the same way: build `npm ci && npm run build`, start `npm start`, one instance.

## How it works

```
shared/        Types, constants, validation, deterministic simulation and traffic generator
server/src/    Express + Socket.IO, room lifecycle, fixed-timestep loop, input validation
client/src/    React pages (landing, host, controller, display), Canvas renderer, motion detection
tests/         Vitest suites
```

- **Authoritative server.** The server owns car positions, lane-change progress (150 ms), traffic, simulation time, collisions and results. Clients send only `{seq, epoch}`; team and direction come from the authenticated seat, never from the client.
- **Room lifecycle.** `lobby → countdown → playing → paused | finished`. Start needs all four seats connected and ready, and the host credential. New controllers cannot join a round in progress.
- **Inputs.** Applied in server arrival order at the next tick. While a car is mid-lane-change, further commands are dropped rather than queued. The server rejects duplicate or old sequence numbers, inputs from a previous connection epoch, inputs outside an active round, and bursts faster than 120 ms apart or more than 6 per second.
- **Fair traffic.** One seeded generator per round produces a single traffic list that is drawn on both roads, so both teams always see identical patterns. It is independent of steering. Obstacle groups come from small hand-designed patterns; every transition is checked for reachability. The check uses when the next group becomes fully visible, a reaction allowance, the 150 ms lane change and the 400 ms shake cooldown. Unreachable groups are replaced. Speed and density ramp up over about 70 seconds to capped maximums.
- **Collisions.** Collisions use the car's actual interpolated lane position during a lane change, with slightly forgiving hit boxes. Both cars are evaluated in the same step; if both crash in that step, the round is a draw.
- **Disconnects.** Any controller or host disconnect pauses immediately (no simulation time passes). The seat is reserved for `RECONNECT_WINDOW_MS` and reclaimed only with the opaque session token in the phone's localStorage, never by display name. The host must press Resume, which starts a 3-second countdown with stale inputs and the phone's shake detector cleared. If someone does not return, the host can end the round.
- **Motion.** Shakes are detected on the phone, never streamed. The detector uses the orientation-independent magnitude of `acceleration`, falling back to gravity-filtered `accelerationIncludingGravity`. It has a tunable threshold (5 sensitivity levels), hysteresis that re-arms only after motion settles, and a 400 ms cooldown, so one physical shake sends one command. iOS permission is requested directly in the **Enable motion** tap handler. The phone also requests a screen wake lock when supported.

## Testing

```bash
npm run typecheck && npm test
```

The automated tests cover:

- Four clients joining and claiming distinct roles, duplicate-role and fifth-player rejection, invalid codes and names, host-credential checks, no joining mid-round, and disabled simulation seats
- Team and direction coming from the seat even when the client lies, lane bounds, first-arrival-wins with no queued commands, and duplicate or excessive inputs
- Identical traffic regardless of steering, no group ever blocking all four lanes, unreachable transitions rejected, and a reaction-delayed bot surviving 150 s on 120 seeds
- Single crash, simultaneous-crash draw, and collisions during a lane change
- Pause and resume with zero simulation-time drift (manual clock and real time), no replay of stale commands after reconnecting, host reattach, seat expiry with host "end round", rematch resetting the full round state, and idle-room cleanup
- Shake detector behaviour: one shake gives one trigger, orientation independence, re-arming, sensitivity, null-safe sensor handling, gravity filtering, and reset

See [`docs/DEMO.md`](docs/DEMO.md) for the five-minute live demo script.

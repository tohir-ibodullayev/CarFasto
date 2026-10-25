import {
  LANES,
  PLAYER_CAR,
  TEAMS,
  TEAM_COLOR,
  TEAM_LABEL,
  TRAFFIC_BODY,
  TRAFFIC_COLORS,
  VIEW_AHEAD,
  VIEW_BEHIND,
  roleFor,
  type Team,
} from '../../../shared/constants';
import { TRAFFIC_KIND_INDEX, type RoomState } from '../../../shared/protocol';
import { sfx } from './audio';
import type { ViewState } from './interpolation';

interface Particle {
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

interface Layout {
  w: number;
  h: number;
  hudH: number;
  ppu: number;
  carY: number;
  roadW: number;
  roadX: Record<Team, number>;
  gap: number;
}

const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';
const ASPHALT = '#22252c';
const SHOULDER = '#101a17';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (w <= 0 || h <= 0) return;
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** Sets the font, shrinking it until `text` fits in `maxWidth`. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, px: number, maxWidth: number) {
  let size = Math.round(px);
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (size > 9 && ctx.measureText(text).width > maxWidth) {
    size -= 1;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export class GameRenderer {
  private particles: Particle[] = [];
  private crashAt: Record<Team, number | null> = { blue: null, orange: null };
  private prevMoving: Record<Team, boolean> = { blue: false, orange: false };
  private prevCountdown: number | null = null;
  private prevPhase: string | null = null;
  private prevRound = -1;
  private goAt: number | null = null;
  private lastFrame = 0;
  /** Sound only plays on the main host screen, not on extra displays. */
  constructor(private readonly playSound: boolean) {}

  private layout(w: number, h: number): Layout {
    const hudH = Math.max(76, Math.min(130, h * 0.13));
    const ppuByHeight = (h - hudH) / (VIEW_AHEAD + VIEW_BEHIND);
    const ppuByWidth = (w * 0.94) / (2 * LANES + 2.4);
    const ppu = Math.min(ppuByHeight, ppuByWidth);
    const roadW = LANES * ppu;
    const gap = Math.max(ppu * 1.4, Math.min(w * 0.16, w - 2 * roadW - ppu * 0.8));
    const carY = h - VIEW_BEHIND * ppu;
    return {
      w,
      h,
      hudH,
      ppu,
      carY,
      roadW,
      gap,
      roadX: { blue: w / 2 - gap / 2 - roadW, orange: w / 2 + gap / 2 },
    };
  }

  private detectEvents(view: ViewState, now: number, L: Layout) {
    if (view.round !== this.prevRound) {
      this.prevRound = view.round;
      this.particles = [];
      this.crashAt = { blue: null, orange: null };
      this.prevMoving = { blue: false, orange: false };
      this.goAt = null;
    }
    for (const team of TEAMS) {
      const car = view.cars[team];
      if (car.crashed && this.crashAt[team] === null) {
        this.crashAt[team] = now;
        this.burst(team, L.roadX[team] + (car.x + 0.5) * L.ppu, L.carY, L.ppu);
        if (this.playSound) sfx.crash();
      }
      if (car.moving && !this.prevMoving[team] && this.playSound) sfx.laneChange();
      this.prevMoving[team] = car.moving;
    }
    const cd = view.phase === 'countdown' && view.countdownMs !== null ? Math.ceil(view.countdownMs / 1000) : null;
    if (cd !== null && cd !== this.prevCountdown && cd > 0 && this.playSound) sfx.countdown(cd);
    this.prevCountdown = cd;
    if (view.phase === 'playing' && this.prevPhase === 'countdown') {
      this.goAt = now;
      if (this.playSound) sfx.countdown(0);
    }
    if (view.phase === 'finished' && this.prevPhase !== 'finished' && this.playSound) sfx.win();
    this.prevPhase = view.phase;
  }

  private burst(team: Team, x: number, y: number, ppu: number) {
    const colors = ['#ffd166', '#ff8a1f', '#ff4d4d', '#ffffff', '#8a8f98'];
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (0.6 + Math.random() * 2.6) * ppu;
      const life = 0.5 + Math.random() * 0.9;
      this.particles.push({
        team,
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life,
        maxLife: life,
        size: ppu * (0.04 + Math.random() * 0.08),
        color: colors[i % colors.length],
      });
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, view: ViewState | null, room: RoomState | null, now: number) {
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const L = this.layout(w, h);
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, w, h);
    const tint = ctx.createLinearGradient(0, 0, w, 0);
    tint.addColorStop(0, 'rgba(59,164,255,0.10)');
    tint.addColorStop(0.5, 'rgba(10,12,18,0)');
    tint.addColorStop(1, 'rgba(255,138,31,0.10)');
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, w, h);
    if (view) this.detectEvents(view, now, L);

    for (const team of TEAMS) this.drawRoad(ctx, L, team, view, now);
    this.drawCenter(ctx, L, view);
    this.drawHud(ctx, L, view, room);
    this.drawParticles(ctx, dt);
    if (view) this.drawCountdown(ctx, L, view, now);

    if (room && Object.values(room.players).some((p) => p?.sim)) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#f5d90a';
      fitFont(ctx, 'KEYBOARD SIM (DEV)', 800, L.hudH * 0.15, L.gap * 0.92);
      ctx.fillText('KEYBOARD SIM (DEV)', w / 2, h - 8);
    }
  }

  private drawRoad(ctx: CanvasRenderingContext2D, L: Layout, team: Team, view: ViewState | null, now: number) {
    const { ppu, carY, roadW, hudH, h } = L;
    const x0 = L.roadX[team];
    const distance = view?.distance ?? 0;
    const color = TEAM_COLOR[team];
    const crashAt = this.crashAt[team];
    let shakeX = 0;
    let shakeY = 0;
    if (crashAt !== null) {
      const k = Math.max(0, 1 - (now - crashAt) / 600);
      shakeX = (Math.random() - 0.5) * ppu * 0.25 * k;
      shakeY = (Math.random() - 0.5) * ppu * 0.25 * k;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - ppu * 0.6, hudH, roadW + ppu * 1.2, h - hudH);
    ctx.clip();
    ctx.translate(shakeX, shakeY);

    // Shoulders with scrolling texture.
    ctx.fillStyle = SHOULDER;
    ctx.fillRect(x0 - ppu * 0.7, hudH - ppu, roadW + ppu * 1.4, h - hudH + 2 * ppu);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    const zOf = (s: number) => s - distance;
    const yOf = (z: number) => carY - z * ppu;
    for (let s = Math.floor((distance - VIEW_BEHIND - 2) / 2) * 2; s < distance + VIEW_AHEAD + 3; s += 2) {
      const y = yOf(zOf(s));
      ctx.fillRect(x0 - ppu * 0.6, y, ppu * 0.45, ppu * 0.12);
      ctx.fillRect(x0 + roadW + ppu * 0.15, y - ppu, ppu * 0.45, ppu * 0.12);
    }

    // Asphalt.
    ctx.fillStyle = ASPHALT;
    ctx.fillRect(x0, hudH - ppu, roadW, h - hudH + 2 * ppu);

    // Rumble strips.
    for (let s = Math.floor(distance - VIEW_BEHIND - 2); s < distance + VIEW_AHEAD + 3; s += 0.5) {
      const y = yOf(zOf(s));
      ctx.fillStyle = Math.round(s * 2) % 2 === 0 ? '#e5484d' : '#e8e8e8';
      ctx.fillRect(x0 - ppu * 0.12, y - ppu * 0.5, ppu * 0.12, ppu * 0.5);
      ctx.fillRect(x0 + roadW, y - ppu * 0.5, ppu * 0.12, ppu * 0.5);
    }

    // Lane dividers.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const period = 1.4;
    for (let lane = 1; lane < LANES; lane++) {
      const lx = x0 + lane * ppu - ppu * 0.025;
      for (let s = Math.floor((distance - VIEW_BEHIND - 2) / period) * period; s < distance + VIEW_AHEAD + 3; s += period) {
        const y = yOf(zOf(s));
        ctx.fillRect(lx, y - ppu * 0.65, ppu * 0.05, ppu * 0.65);
      }
    }

    // Team-coloured edge glow.
    ctx.shadowColor = color;
    ctx.shadowBlur = ppu * 0.25;
    ctx.fillStyle = color;
    ctx.fillRect(x0 - ppu * 0.03, hudH, ppu * 0.04, h - hudH);
    ctx.fillRect(x0 + roadW - ppu * 0.01, hudH, ppu * 0.04, h - hudH);
    ctx.shadowBlur = 0;

    if (view) {
      for (const o of view.traffic) {
        if (o.z > VIEW_AHEAD + 1.5 || o.z < -VIEW_BEHIND - 1.5) continue;
        const kind = TRAFFIC_KIND_INDEX[o.kind] ?? 'car';
        const body = TRAFFIC_BODY[kind];
        drawVehicle(ctx, x0 + (o.lane + 0.5) * ppu, yOf(o.z), body.width * ppu, body.length * ppu, TRAFFIC_COLORS[o.color] ?? '#ccc', {
          facingUp: false,
          truck: kind === 'truck',
          van: kind === 'van',
        });
      }
      const car = view.cars[team];
      const dx = car.x - car.lane;
      const tilt = car.crashed && crashAt !== null ? ((now - crashAt) / 1000) * 5 : car.moving ? Math.sign(dx) * 0.16 : 0;
      drawVehicle(ctx, x0 + (car.x + 0.5) * ppu, carY, PLAYER_CAR.width * ppu, PLAYER_CAR.length * ppu, color, {
        facingUp: true,
        player: true,
        rotation: car.crashed ? Math.min(tilt, Math.PI * 1.25) : tilt,
      });
      if (car.crashed && crashAt !== null) {
        const k = Math.max(0, 1 - (now - crashAt) / 700);
        ctx.fillStyle = `rgba(255,80,60,${0.35 * k})`;
        ctx.fillRect(x0, hudH, roadW, h - hudH);
        ctx.font = `900 ${Math.round(ppu * 0.62)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = ppu * 0.08;
        ctx.strokeStyle = '#000';
        ctx.strokeText('CRASHED!', x0 + roadW / 2, carY - ppu * 2.2);
        ctx.fillStyle = '#ff5a4d';
        ctx.fillText('CRASHED!', x0 + roadW / 2, carY - ppu * 2.2);
      }
    }
    ctx.restore();
  }

  private drawCenter(ctx: CanvasRenderingContext2D, L: Layout, view: ViewState | null) {
    const cx = L.w / 2;
    const top = L.hudH + L.ppu * 0.6;
    const bottom = L.h - L.ppu * 0.8;
    const barW = Math.max(10, L.gap * 0.16);
    const speedFrac = view ? Math.min(1, (view.speed - 4.2) / (8.5 - 4.2)) : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, cx - barW / 2, top + L.ppu * 0.9, barW, bottom - top - L.ppu * 0.9, barW / 2);
    ctx.fill();
    const grad = ctx.createLinearGradient(0, bottom, 0, top);
    grad.addColorStop(0, '#46a758');
    grad.addColorStop(0.6, '#f5d90a');
    grad.addColorStop(1, '#e5484d');
    ctx.fillStyle = grad;
    const fillH = (bottom - top - L.ppu * 0.9) * (0.08 + 0.92 * speedFrac);
    roundRect(ctx, cx - barW / 2, bottom - fillH, barW, fillH, barW / 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#9aa3b2';
    ctx.font = `700 ${Math.round(Math.min(L.gap * 0.17, L.ppu * 0.28))}px ${FONT}`;
    ctx.fillText('SPEED', cx, top);
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${Math.round(Math.min(L.gap * 0.3, L.ppu * 0.5))}px ${FONT}`;
    ctx.fillText(`LV ${view?.level ?? 1}`, cx, top + L.ppu * 0.32);
  }

  private drawHud(ctx: CanvasRenderingContext2D, L: Layout, view: ViewState | null, room: RoomState | null) {
    const { hudH, w } = L;
    ctx.fillStyle = '#0d1018';
    ctx.fillRect(0, 0, w, hudH);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, hudH - 2, w, 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${Math.round(hudH * 0.42)}px ${FONT}`;
    ctx.fillText(formatTime(view?.timeS ?? 0), w / 2, hudH * 0.4);
    ctx.fillStyle = '#9aa3b2';
    const sub = `SURVIVAL TIME${room ? ` · ROUND ${room.round}` : ''}`;
    fitFont(ctx, sub, 700, hudH * 0.15, L.gap + L.ppu * 0.6);
    ctx.fillText(sub, w / 2, hudH * 0.8);

    for (const team of TEAMS) {
      const cx = L.roadX[team] + L.roadW / 2;
      const color = TEAM_COLOR[team];
      const crashed = view?.cars[team].crashed ?? false;
      ctx.fillStyle = color;
      fitFont(ctx, `${TEAM_LABEL[team].toUpperCase()} TEAM`, 900, hudH * 0.3, L.roadW * 0.7);
      ctx.fillText(`${TEAM_LABEL[team].toUpperCase()} TEAM`, cx, hudH * 0.3);
      if (crashed) {
        ctx.font = `900 ${Math.round(hudH * 0.13)}px ${FONT}`;
        ctx.fillStyle = '#ff5a4d';
        ctx.textAlign = team === 'blue' ? 'left' : 'right';
        ctx.fillText('CRASHED', team === 'blue' ? L.roadX.blue : L.roadX.orange + L.roadW, hudH * 0.12);
        ctx.textAlign = 'center';
      }
      const left = room?.players[roleFor(team, 'left')];
      const right = room?.players[roleFor(team, 'right')];
      const leftText = `◀ ${left?.name ?? '—'}${left && !left.connected ? ' (offline)' : ''}`;
      const rightText = `${right?.name ?? '—'}${right && !right.connected ? ' (offline)' : ''} ▶`;
      const y = hudH * 0.7;
      const pad = L.ppu * 0.15;
      const maxW = L.roadW / 2 - pad * 1.5;
      ctx.textAlign = 'right';
      ctx.fillStyle = left?.connected ? '#e9edf5' : '#ff5a4d';
      fitFont(ctx, leftText, 700, hudH * 0.19, maxW);
      ctx.fillText(leftText, cx - pad, y);
      ctx.textAlign = 'left';
      ctx.fillStyle = right?.connected ? '#e9edf5' : '#ff5a4d';
      fitFont(ctx, rightText, 700, hudH * 0.19, maxW);
      ctx.fillText(rightText, cx + pad, y);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText('|', cx, y);
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, dt: number) {
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawCountdown(ctx: CanvasRenderingContext2D, L: Layout, view: ViewState, now: number) {
    let text: string | null = null;
    let progress = 0;
    if (view.phase === 'countdown' && view.countdownMs !== null) {
      const n = Math.ceil(view.countdownMs / 1000);
      text = String(Math.max(1, n));
      progress = 1 - (view.countdownMs / 1000 - (n - 1));
    } else if (this.goAt !== null && now - this.goAt < 800 && view.phase === 'playing') {
      text = 'GO!';
      progress = (now - this.goAt) / 800;
    }
    if (!text) return;
    const size = Math.min(L.h * 0.32, L.w * 0.2) * (1.15 - 0.25 * progress);
    ctx.save();
    ctx.globalAlpha = 1 - Math.max(0, progress - 0.7) / 0.3;
    ctx.font = `900 ${Math.round(size)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.06;
    ctx.strokeStyle = '#000';
    const y = L.hudH + (L.h - L.hudH) * 0.45;
    ctx.strokeText(text, L.w / 2, y);
    ctx.fillStyle = text === 'GO!' ? '#46ff8a' : '#fff';
    ctx.fillText(text, L.w / 2, y);
    ctx.restore();
  }
}

interface VehicleOptions {
  facingUp: boolean;
  player?: boolean;
  truck?: boolean;
  van?: boolean;
  rotation?: number;
}

function drawVehicle(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, l: number, color: string, o: VehicleOptions) {
  ctx.save();
  ctx.translate(cx, cy);
  if (o.rotation) ctx.rotate(o.rotation);
  if (!o.facingUp) ctx.rotate(Math.PI);
  // Now the front of the vehicle points to -y.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, -w / 2 + w * 0.06, -l / 2 + l * 0.06, w, l, w * 0.25);
  ctx.fill();

  ctx.fillStyle = '#111';
  const wheelW = w * 0.16;
  const wheelL = l * (o.truck ? 0.12 : 0.2);
  const wheelYs = o.truck ? [-0.36, 0.12, 0.34] : [-0.28, 0.28];
  for (const wy of wheelYs) {
    ctx.fillRect(-w / 2 - wheelW * 0.35, wy * l - wheelL / 2, wheelW, wheelL);
    ctx.fillRect(w / 2 - wheelW * 0.65, wy * l - wheelL / 2, wheelW, wheelL);
  }

  if (o.player) {
    ctx.shadowColor = color;
    ctx.shadowBlur = w * 0.6;
  }
  if (o.truck) {
    ctx.fillStyle = '#d8dde6';
    roundRect(ctx, -w / 2, -l / 2 + l * 0.27, w, l * 0.73, w * 0.08);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, -w / 2, -l / 2, w, l * 0.25, w * 0.2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 1; i < 4; i++) ctx.fillRect(-w / 2, -l / 2 + l * (0.27 + i * 0.18), w, l * 0.015);
    ctx.fillStyle = '#1b2230';
    roundRect(ctx, -w * 0.38, -l / 2 + l * 0.05, w * 0.76, l * 0.08, w * 0.05);
    ctx.fill();
  } else {
    ctx.fillStyle = color;
    roundRect(ctx, -w / 2, -l / 2, w, l, w * 0.28);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (o.player) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(-w * 0.09, -l / 2 + l * 0.02, w * 0.18, l * 0.96);
    }
    ctx.fillStyle = '#1b2230';
    roundRect(ctx, -w * 0.38, -l * (o.van ? 0.36 : 0.26), w * 0.76, l * 0.2, w * 0.1);
    ctx.fill();
    roundRect(ctx, -w * 0.34, l * 0.2, w * 0.68, l * 0.12, w * 0.08);
    ctx.fill();
    if (o.van) {
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(-w / 2, -l * 0.12, w, l * 0.5);
    }
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff6c2';
  ctx.fillRect(-w * 0.42, -l / 2, w * 0.2, l * 0.04);
  ctx.fillRect(w * 0.22, -l / 2, w * 0.2, l * 0.04);
  ctx.fillStyle = '#ff3b3b';
  ctx.fillRect(-w * 0.42, l / 2 - l * 0.035, w * 0.18, l * 0.035);
  ctx.fillRect(w * 0.24, l / 2 - l * 0.035, w * 0.18, l * 0.035);
  ctx.restore();
}

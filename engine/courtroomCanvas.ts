import type { CaseFile } from "../schemas/case";

/**
 * HTML5 Canvas courtroom renderer.
 *
 * Two scene sources share one effects pipeline:
 *   - a pre-rendered witness sprite (e.g. /assets/witness-014.png), drawn
 *     cover-fit at device resolution, or
 *   - a procedural pixel-art courtroom drawn into a 320×180 buffer and
 *     scaled up with smoothing disabled, so every pixel stays crisp.
 *
 * On top of either, a 320×180 FX layer draws sweat drops and speed lines,
 * and the main canvas draws the OBJECTION! / HOLD IT! stamps, white flash,
 * zoom punch and screen shake (optionally mirrored onto a DOM element).
 */

export type WitnessPalette = CaseFile["witness"]["palette"];
export type SpriteSpec = NonNullable<CaseFile["witness"]["sprite"]>;
export type Pose = "point" | "recoil" | "slump" | "smug";

export interface CourtroomCanvasOptions {
  palette: WitnessPalette;
  sprite?: SpriteSpec | null;
  /** CSS font-family list for stamps (e.g. the resolved --font-display). */
  displayFont?: string;
  reducedMotion?: boolean;
  /** Element that physically shakes with the camera (the stage wrapper). */
  shakeElement?: HTMLElement | null;
}

interface Stamp {
  text: string;
  fill: string;
  start: number;
  duration: number;
  sizeRatio: number;
  rotation: number;
  burst: boolean;
  cx: number;
  cy: number;
}

interface Timed {
  start: number;
  duration: number;
}

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
}

interface Streak {
  y: number;
  len: number;
  speed: number;
  offset: number;
  thick: number;
  color: string;
}

export const LOW_W = 320;
export const LOW_H = 180;

const INK = "#141412";
const CRIMSON = "#D92D20";
const HN = "#FF6600";
const GREEN = "#157F3D";
const WHITE = "#FFFFFF";
const WALL = "#1B2028";
const WALL_DARK = "#12161C";
const WALL_LIGHT = "#262D38";
const RAIL = "#3B3C33";
const RAIL_LIGHT = "#4C4D42";
const WAINSCOT = "#2A2B25";
const WAINSCOT_DARK = "#1F201B";
const OAK = "#B8692A";
const OAK_PANEL = "#A85F25";
const OAK_LIGHT = "#D88A33";
const OAK_HI = "#F0A848";
const OAK_DARK = "#7E4312";
const OAK_GRAIN = "#9A541D";
const BRASS = "#D9B048";
const BRASS_HI = "#F2D27A";
const LENS = "#D7E7EC";
const STRING = "#B9B9AE";
const DEFAULT_DISPLAY_FONT = '"Barlow Condensed", Impact, "Arial Narrow", sans-serif';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/** Lighten (amount > 0) or darken (amount < 0) a #RRGGBB colour. */
export function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  const mix = (c: number) => Math.round((target - c) * p + c);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

/** mulberry32: tiny deterministic PRNG so the wood grain never shimmers. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function progress(anim: Timed, now: number): number | null {
  if (anim.duration <= 0) return null;
  const t = (now - anim.start) / anim.duration;
  return t >= 0 && t < 1 ? t : null;
}

function make2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  ctx.imageSmoothingEnabled = false;
  return [canvas, ctx];
}

type Px = (x: number, y: number, w: number, h: number, color: string) => void;

function pixelPen(g: CanvasRenderingContext2D): Px {
  return (x, y, w, h, color) => {
    g.fillStyle = color;
    g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
}

function strokeBox(px: Px, x: number, y: number, w: number, h: number, color: string): void {
  px(x, y, w, 1, color);
  px(x, y + h - 1, w, 1, color);
  px(x, y, 1, h, color);
  px(x + w - 1, y, 1, h, color);
}

/** Chunky stepped line, the pixel-art way to draw a limb. */
function thickLine(px: Px, x0: number, y0: number, x1: number, y1: number, thickness: number, color: string): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const half = thickness / 2;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    px(x0 + (x1 - x0) * t - half, y0 + (y1 - y0) * t - half, thickness, thickness, color);
  }
}

function drawDrop(px: Px, x: number, y: number, accent: string): void {
  const rim = shade(accent, -0.45);
  px(x + 1, y, 1, 2, accent);
  px(x, y + 2, 3, 2, accent);
  px(x - 1, y + 2, 1, 2, rim);
  px(x + 3, y + 2, 1, 2, rim);
  px(x + 1, y + 4, 1, 1, rim);
  px(x + 1, y + 2, 1, 1, WHITE);
}

export class CourtroomRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly low: HTMLCanvasElement;
  private readonly lowCtx: CanvasRenderingContext2D;
  private readonly fx: HTMLCanvasElement;
  private readonly fxCtx: CanvasRenderingContext2D;
  private readonly room: HTMLCanvasElement;
  private readonly stand: HTMLCanvasElement;
  private readonly random = prng(0x14c0de);

  private sprite: HTMLImageElement | null = null;
  private spriteReady = false;
  private spriteFailed = false;
  private raf = 0;
  private running = false;
  private destroyed = false;
  private observer: ResizeObserver | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private stress = 0;
  private pose: Pose = "point";
  private restingPose: Pose = "point";
  private poseUntil = 0;
  private thrust: Timed = { start: 0, duration: 0 };
  private stamps: Stamp[] = [];
  private verdictStamp: Stamp | null = null;
  private drops: Drop[] = [];
  private streaks: Streak[] = [];
  private shake = { start: 0, duration: 0, magnitude: 0 };
  private flash: Timed = { start: 0, duration: 0 };
  private punch = { start: 0, duration: 0, amount: 0 };
  private speed: Timed = { start: 0, duration: 0 };
  private dim = 0;
  private nextDropAt = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private options: CourtroomCanvasOptions,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available");
    this.ctx = ctx;
    [this.low, this.lowCtx] = make2d(LOW_W, LOW_H);
    [this.fx, this.fxCtx] = make2d(LOW_W, LOW_H);
    this.room = this.paintRoom();
    this.stand = this.paintStand();
    if (options.sprite) this.loadSprite(options.sprite.src);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas);
    }
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.render(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    this.observer?.disconnect();
    if (this.options.shakeElement) this.options.shakeElement.style.transform = "";
  }

  setOptions(patch: Partial<CourtroomCanvasOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  /** 0 = calm, 1 = about to break. Drives sweat rate, blush and expression. */
  setStress(composure: number, maxComposure: number): void {
    this.stress = clamp01(1 - composure / Math.max(1, maxComposure));
  }

  objection(text = "OBJECTION!"): void {
    const now = performance.now();
    this.addStamp({ text, fill: CRIMSON, duration: 1100, sizeRatio: 0.2, rotation: -0.1, burst: true, cx: 0.5, cy: 0.46 }, now);
    this.shake = { start: now, duration: 440, magnitude: 11 };
    this.flash = { start: now, duration: 170 };
    this.punch = { start: now, duration: 460, amount: 0.07 };
    this.speed = { start: now, duration: 700 };
    this.streaks = Array.from({ length: 26 }, () => ({
      y: Math.floor(this.random() * LOW_H),
      len: 18 + Math.floor(this.random() * 56),
      speed: 520 + this.random() * 420,
      offset: this.random() * (LOW_W + 80),
      thick: this.random() > 0.75 ? 2 : 1,
      color: this.random() > 0.7 ? CRIMSON : WHITE,
    }));
    this.setPose("recoil", 950);
    this.burstDrops(now, 6);
  }

  holdIt(text = "HOLD IT!"): void {
    const now = performance.now();
    this.addStamp({ text, fill: HN, duration: 950, sizeRatio: 0.15, rotation: -0.07, burst: false, cx: 0.5, cy: 0.42 }, now);
    this.shake = { start: now, duration: 220, magnitude: 4 };
    this.punch = { start: now, duration: 300, amount: 0.03 };
    this.pose = "point";
    this.poseUntil = 0;
    this.thrust = { start: now, duration: 260 };
  }

  /** Short neutral stamp, e.g. "TIME!" when the clock runs out. */
  notice(text: string, color: string = CRIMSON): void {
    const now = performance.now();
    this.addStamp({ text, fill: color, duration: 900, sizeRatio: 0.13, rotation: -0.05, burst: false, cx: 0.5, cy: 0.44 }, now);
    this.shake = { start: now, duration: 200, magnitude: 3 };
  }

  verdict(outcome: "win" | "lose", text: string, animate = true): void {
    const now = performance.now();
    this.verdictStamp = {
      text,
      fill: outcome === "win" ? GREEN : CRIMSON,
      start: animate ? now : now - 10_000,
      duration: Number.POSITIVE_INFINITY,
      sizeRatio: 0.15,
      rotation: -0.06,
      burst: outcome === "win",
      cx: 0.5,
      cy: 0.46,
    };
    this.restingPose = outcome === "win" ? "slump" : "smug";
    this.pose = this.restingPose;
    this.poseUntil = 0;
    this.dim = 0.38;
    if (animate) {
      this.shake = { start: now, duration: outcome === "win" ? 600 : 260, magnitude: outcome === "win" ? 13 : 5 };
      this.punch = { start: now, duration: 500, amount: outcome === "win" ? 0.08 : 0.03 };
      if (outcome === "win") {
        this.flash = { start: now, duration: 220 };
        this.burstDrops(now, 10);
      }
    }
  }

  reset(): void {
    this.verdictStamp = null;
    this.stamps = [];
    this.dim = 0;
    this.restingPose = "point";
    this.pose = "point";
    this.poseUntil = 0;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (!this.running) this.render(performance.now());
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private loadSprite(src: string): void {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      this.sprite = img;
      this.spriteReady = true;
    };
    img.onerror = () => {
      // Fall back to the procedural witness.
      this.sprite = null;
      this.spriteReady = false;
      this.spriteFailed = true;
    };
    img.src = src;
  }

  private addStamp(spec: Omit<Stamp, "start">, now: number): void {
    this.stamps = [...this.stamps.filter((s) => now - s.start < s.duration * 0.6), { ...spec, start: now }];
  }

  private setPose(pose: Pose, ms: number): void {
    this.pose = pose;
    this.poseUntil = performance.now() + ms;
  }

  private burstDrops(now: number, count: number): void {
    const [ax, ay] = this.headAnchor(now);
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (this.random() - 0.5) * 2.4;
      const speed = 40 + this.random() * 50;
      this.drops.push({
        x: ax + (this.random() - 0.5) * 14,
        y: ay + (this.random() - 0.5) * 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        born: now,
        life: 900 + this.random() * 500,
      });
    }
  }

  /** Head position in 320×180 space, where sweat spawns. */
  private headAnchor(now: number): [number, number] {
    const sprite = this.options.sprite;
    if (this.spriteReady && sprite) return [sprite.headX * LOW_W, sprite.headY * LOW_H];
    return [150, this.headY(now) + 4];
  }

  private headY(now: number): number {
    const bob = this.options.reducedMotion ? 0 : Math.round(Math.sin(now / 420) * 0.6);
    return 56 + bob + (this.pose === "slump" ? 5 : 0);
  }

  private render(now: number): void {
    const { ctx, width: w, height: h } = this;
    if (w <= 1 || h <= 1) return;
    const reduced = Boolean(this.options.reducedMotion);
    if (this.poseUntil && now > this.poseUntil) {
      this.pose = this.restingPose;
      this.poseUntil = 0;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    // While a sprite is still decoding, stay transparent so the viewport's CSS
    // background (the same image) shows through instead of a placeholder.
    const awaitingSprite = Boolean(this.options.sprite) && !this.spriteReady && !this.spriteFailed;
    if (awaitingSprite) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    ctx.fillStyle = WALL;
    ctx.fillRect(0, 0, w, h);

    // Camera: shake, zoom punch, idle breathing.
    let sx = 0;
    let sy = 0;
    const shakeT = reduced ? null : progress(this.shake, now);
    if (shakeT !== null) {
      const m = this.shake.magnitude * (1 - shakeT) * this.dpr;
      sx = (this.random() * 2 - 1) * m;
      sy = (this.random() * 2 - 1) * m;
    }
    let zoom = 1;
    const punchT = reduced ? null : progress(this.punch, now);
    if (punchT !== null) zoom += this.punch.amount * (1 - easeOutCubic(punchT));
    if (shakeT !== null) zoom = Math.max(zoom, 1 + (this.shake.magnitude * 2.4 * this.dpr) / w);
    const usingSprite = this.spriteReady && this.sprite !== null;
    if (usingSprite && !reduced) zoom *= 1 + 0.006 * (0.5 + 0.5 * Math.sin(now / 900));

    ctx.save();
    ctx.translate(w / 2 + sx, h / 2 + sy);
    ctx.scale(zoom, zoom);
    if (usingSprite && this.pose === "recoil" && !reduced) {
      ctx.rotate(-0.012 * clamp01((this.poseUntil - now) / 950));
    }
    ctx.translate(-w / 2, -h / 2);

    if (usingSprite && this.sprite) {
      this.drawSprite(this.sprite, w, h);
    } else {
      this.paintProcedural(now);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.low, 0, 0, w, h);
    }
    this.paintFx(now, reduced);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.fx, 0, 0, w, h);
    ctx.restore();

    if (this.dim > 0) {
      ctx.fillStyle = `rgba(20, 20, 18, ${this.dim})`;
      ctx.fillRect(0, 0, w, h);
    }
    const flashT = reduced ? null : progress(this.flash, now);
    if (flashT !== null) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * (1 - flashT)})`;
      ctx.fillRect(0, 0, w, h);
    }

    this.stamps = this.stamps.filter((s) => now - s.start < s.duration);
    for (const stamp of this.stamps) this.drawStamp(stamp, now, reduced);
    if (this.verdictStamp && this.stamps.length === 0) this.drawStamp(this.verdictStamp, now, reduced);

    const el = this.options.shakeElement;
    if (el) {
      if (shakeT !== null) {
        el.style.transform = `translate3d(${(sx / this.dpr) * 0.5}px, ${(sy / this.dpr) * 0.5}px, 0)`;
      } else if (el.style.transform) {
        el.style.transform = "";
      }
    }
  }

  private drawSprite(img: HTMLImageElement, w: number, h: number): void {
    const { ctx } = this;
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  private paintProcedural(now: number): void {
    const g = this.lowCtx;
    g.clearRect(0, 0, LOW_W, LOW_H);
    g.drawImage(this.room, 0, 0);
    this.paintWitness(g, now);
    g.drawImage(this.stand, 0, 0);
  }

  private paintRoom(): HTMLCanvasElement {
    const [canvas, g] = make2d(LOW_W, LOW_H);
    const px = pixelPen(g);
    px(0, 0, LOW_W, LOW_H, WALL);
    px(0, 0, LOW_W, 6, WALL_DARK);
    px(0, 6, LOW_W, 1, WALL_LIGHT);
    for (const x of [24, 88, 152, 216, 280]) {
      px(x, 7, 3, 93, WALL_DARK);
      px(x + 3, 7, 1, 93, WALL_LIGHT);
    }
    // Chair rail and wainscot.
    px(0, 100, LOW_W, 6, RAIL);
    px(0, 100, LOW_W, 1, RAIL_LIGHT);
    px(0, 106, LOW_W, 2, WAINSCOT_DARK);
    px(0, 108, LOW_W, 72, WAINSCOT);
    for (const x of [6, 84, 162, 240]) {
      strokeBox(px, x, 116, 72, 56, WAINSCOT_DARK);
      px(x + 1, 117, 70, 1, RAIL);
    }
    // Dithered floor shadow.
    for (let y = 170; y < LOW_H; y += 1) {
      for (let x = (y % 2); x < LOW_W; x += 2) px(x, y, 1, 1, WAINSCOT_DARK);
    }
    return canvas;
  }

  private paintStand(): HTMLCanvasElement {
    const [canvas, g] = make2d(LOW_W, LOW_H);
    const px = pixelPen(g);
    const rand = prng(0x0a4b);
    // Front face.
    px(44, 131, 232, 49, OAK);
    px(44, 131, 3, 49, OAK_DARK);
    px(273, 131, 3, 49, OAK_DARK);
    for (const x of [92, 160, 228]) px(x, 132, 2, 48, OAK_DARK);
    for (const [x, w] of [[52, 36], [100, 56], [168, 56], [236, 32]] as const) {
      px(x, 140, w, 36, OAK_PANEL);
      strokeBox(px, x, 140, w, 36, OAK_DARK);
      px(x + 1, 141, w - 2, 1, OAK_LIGHT);
    }
    // Wood grain, deterministic.
    for (let i = 0; i < 70; i += 1) {
      const x = 48 + Math.floor(rand() * 220);
      const y = 134 + Math.floor(rand() * 44);
      const len = 4 + Math.floor(rand() * 14);
      px(x, y, len, 1, OAK_GRAIN);
      if (rand() > 0.6) px(x + len, y + 1, 3, 1, OAK_GRAIN);
    }
    // Top lip.
    px(38, 122, 244, 9, OAK_LIGHT);
    px(38, 122, 244, 1, OAK_HI);
    px(38, 129, 244, 2, OAK_DARK);
    for (let x = 44; x < 276; x += 9) px(x + Math.floor(rand() * 4), 125, 5, 1, OAK);
    // Brass corners and centre plate.
    for (const x of [35, 273]) {
      px(x, 119, 12, 13, BRASS);
      px(x, 119, 12, 2, BRASS_HI);
      px(x + 3, 124, 2, 2, OAK_DARK);
      px(x + 7, 127, 2, 2, OAK_DARK);
    }
    px(148, 120, 24, 9, BRASS);
    px(148, 120, 24, 2, BRASS_HI);
    px(151, 124, 2, 2, OAK_DARK);
    px(167, 124, 2, 2, OAK_DARK);
    return canvas;
  }

  private paintWitness(g: CanvasRenderingContext2D, now: number): void {
    const px = pixelPen(g);
    const p = this.options.palette;
    const reduced = Boolean(this.options.reducedMotion);
    const hoodie = p.hoodie;
    const hoodieShade = shade(hoodie, -0.35);
    const hoodieDeep = shade(hoodie, -0.55);
    const skin = p.skin;
    const skinShade = shade(skin, -0.22);
    const hair = p.hair;
    const hairLight = shade(hair, 0.28);
    const pose = this.pose;
    const bob = reduced ? 0 : Math.round(Math.sin(now / 420) * 0.6);
    const hy = this.headY(now);

    // Body.
    px(110, 104 + bob, 10, 26, hoodieShade);
    px(116, 100 + bob, 68, 30, hoodie);
    px(120, 97 + bob, 60, 4, hoodie);
    px(116, 100 + bob, 6, 30, hoodieShade);
    px(132, 92 + bob, 36, 8, hoodieShade);
    px(136, 94 + bob, 28, 4, hoodieDeep);
    px(144, hy + 30, 12, 98 + bob - (hy + 30), skinShade);
    px(144, 98 + bob, 1, 14, STRING);
    px(155, 98 + bob, 1, 12, STRING);
    px(143, 111 + bob, 3, 2, STRING);
    px(154, 109 + bob, 3, 2, STRING);

    // Head.
    px(137, hy, 26, 28, skin);
    px(139, hy + 28, 22, 3, skin);
    px(141, hy + 31, 18, 2, skinShade);
    px(137, hy + 20, 3, 8, skinShade);
    px(133, hy + 10, 4, 9, skin);
    px(134, hy + 12, 2, 5, skinShade);

    // Hair.
    px(133, hy - 8, 34, 14, hair);
    px(131, hy - 2, 6, 16, hair);
    px(162, hy - 4, 6, 10, hair);
    // Tapered spikes: each row narrows toward the tip and leans right.
    for (const [x, w, h, lean] of [
      [131, 6, 6, -1],
      [136, 7, 10, 0],
      [143, 8, 12, 1],
      [151, 7, 10, 2],
      [157, 7, 8, 2],
      [163, 5, 6, 2],
    ] as const) {
      for (let r = 0; r < h; r += 1) {
        const t = r / h;
        const rowW = Math.max(1, Math.round(w * (1 - t)));
        const rowX = x + Math.round((w - rowW) / 2 + lean * t);
        px(rowX, hy - 7 - r, rowW, 1, hair);
      }
    }
    px(141, hy - 12, 2, 3, hairLight);
    px(148, hy - 14, 2, 4, hairLight);
    px(155, hy - 11, 2, 3, hairLight);
    px(138, hy + 5, 6, 3, hair);
    px(145, hy + 5, 5, 4, hair);
    px(152, hy + 5, 6, 2, hair);

    // Brows: angry by default, worried when slumped, relaxed when smug.
    const browY = hy + 9;
    if (pose === "slump") {
      px(141, browY, 3, 1, hair);
      px(144, browY - 1, 4, 1, hair);
      px(152, browY - 1, 4, 1, hair);
      px(156, browY, 3, 1, hair);
    } else if (pose === "smug") {
      px(141, browY - 1, 7, 1, hair);
      px(152, browY - 1, 7, 1, hair);
    } else {
      px(141, browY - 1, 3, 1, hair);
      px(144, browY, 4, 1, hair);
      px(152, browY, 4, 1, hair);
      px(156, browY - 1, 3, 1, hair);
    }

    // Glasses.
    const gy = hy + 11;
    for (const x of [140, 151]) {
      px(x + 1, gy + 1, 7, 5, LENS);
      strokeBox(px, x, gy, 9, 7, p.glasses);
      px(x + 2, gy + 1, 2, 1, WHITE);
    }
    px(149, gy + 2, 2, 1, p.glasses);
    px(137, gy + 2, 3, 1, p.glasses);

    // Eyes.
    if (pose === "slump") {
      px(143, gy + 4, 3, 1, INK);
      px(154, gy + 4, 3, 1, INK);
    } else {
      const look = pose === "point" ? 1 : pose === "recoil" ? -1 : 0;
      px(144 + look, gy + 2, 2, 3, INK);
      px(155 + look, gy + 2, 2, 3, INK);
    }

    // Nose and mouth.
    px(150, hy + 19, 2, 4, skinShade);
    const lip = shade(skin, -0.55);
    if (pose === "smug") {
      px(146, hy + 25, 8, 1, lip);
      px(154, hy + 24, 2, 1, lip);
    } else if (pose === "slump" || this.stress > 0.7) {
      px(146, hy + 24, 8, 3, "#5A2420");
      px(147, hy + 24, 6, 1, WHITE);
    } else {
      px(146, hy + 25, 8, 1, lip);
      px(145, hy + 26, 1, 1, lip);
      px(154, hy + 26, 1, 1, lip);
    }
    if (this.stress > 0.5) {
      px(139, hy + 20, 4, 2, "#E07A6A");
      px(157, hy + 20, 4, 2, "#E07A6A");
    }
    if (this.stress > 0.3) {
      const wobble = reduced ? 0 : Math.round(Math.sin(now / 300) * 0.8);
      drawDrop(px, 139, hy + 1 + wobble, p.accent);
    }

    // Right arm.
    if (pose === "point") {
      const tT = reduced ? null : progress(this.thrust, now);
      const reach = tT === null ? 1 : 0.55 + 0.45 * easeOutBack(tT);
      const wob = reduced ? 0 : Math.round(Math.sin(now / 260));
      const ex = 178 + 36 * reach;
      const ey = 104 + bob - 8 * reach;
      const wx = 178 + 72 * reach;
      const wy = 104 + bob - 18 * reach + wob;
      thickLine(px, 178, 104 + bob, ex, ey, 9, hoodie);
      thickLine(px, ex, ey, wx, wy, 8, hoodie);
      thickLine(px, 180, 108 + bob, ex, ey + 4, 2, hoodieShade);
      thickLine(px, ex, ey + 4, wx, wy + 3, 2, hoodieShade);
      px(wx - 4, wy - 5, 6, 10, hoodieShade);
      px(wx + 2, wy - 5, 10, 10, skin);
      px(wx + 2, wy + 2, 10, 3, skinShade);
      px(wx + 12, wy - 4, 14, 3, skin);
      px(wx + 12, wy - 2, 14, 1, skinShade);
      px(wx + 5, wy - 8, 4, 3, skin);
    } else if (pose === "recoil") {
      thickLine(px, 178, 104 + bob, 188, 82, 9, hoodie);
      thickLine(px, 188, 82, 172, hy + 18, 8, hoodie);
      px(160, hy + 9, 11, 11, skin);
      px(160, hy + 17, 11, 3, skinShade);
    } else if (pose === "smug") {
      px(118, 111 + bob, 64, 11, hoodieShade);
      px(122, 109 + bob, 56, 4, hoodie);
      px(124, 116 + bob, 8, 5, skin);
      px(168, 112 + bob, 8, 5, skin);
    } else {
      px(178, 104 + bob, 8, 26, hoodieShade);
    }
  }

  private paintFx(now: number, reduced: boolean): void {
    const g = this.fxCtx;
    g.clearRect(0, 0, LOW_W, LOW_H);
    const px = pixelPen(g);

    // Speed lines behind the stamp.
    const speedT = reduced ? null : progress(this.speed, now);
    if (speedT !== null) {
      const elapsed = (now - this.speed.start) / 1000;
      g.globalAlpha = 0.55 * (1 - speedT);
      for (const s of this.streaks) {
        const span = LOW_W + s.len + 40;
        const x = LOW_W - ((s.offset + elapsed * s.speed) % span);
        px(x, s.y, s.len, s.thick, s.color);
      }
      g.globalAlpha = 1;
    }

    // Ambient sweat: the closer to breaking, the faster it drips.
    if (!reduced && this.stress > 0.15 && now >= this.nextDropAt) {
      const [ax, ay] = this.headAnchor(now);
      this.drops.push({
        x: ax + (this.random() - 0.5) * 26,
        y: ay + (this.random() - 0.5) * 8,
        vx: (this.random() - 0.5) * 12,
        vy: 0,
        born: now,
        life: 1200 + this.random() * 400,
      });
      const interval = 1500 - 1250 * this.stress;
      this.nextDropAt = now + interval * (0.7 + this.random() * 0.6);
    }

    const accent = this.options.palette.accent;
    this.drops = this.drops.filter((d) => now - d.born < d.life);
    for (const d of this.drops) {
      const age = (now - d.born) / 1000;
      const x = d.x + d.vx * age;
      const y = d.y + d.vy * age + 0.5 * 90 * age * age;
      g.globalAlpha = clamp01(1 - (now - d.born) / d.life) * 0.95;
      drawDrop(px, x, y, accent);
    }
    g.globalAlpha = 1;

    // Static sweat bead for sprite scenes once the witness is rattled.
    if (this.spriteReady && this.options.sprite && this.stress > 0.3) {
      const [ax, ay] = this.headAnchor(now);
      const wobble = reduced ? 0 : Math.round(Math.sin(now / 300) * 0.8);
      drawDrop(px, ax + 9, ay - 4 + wobble, accent);
    }
  }

  private drawStamp(stamp: Stamp, now: number, reduced: boolean): void {
    const { ctx } = this;
    const elapsed = now - stamp.start;
    let scale = 1;
    let alpha = 1;
    if (reduced) {
      alpha = clamp01(elapsed / 120);
    } else if (elapsed < 150) {
      scale = 2.3 - 1.3 * easeOutCubic(elapsed / 150);
      alpha = clamp01(elapsed / 60);
    }
    if (Number.isFinite(stamp.duration)) {
      const fadeStart = stamp.duration - 200;
      if (elapsed > fadeStart) alpha *= clamp01(1 - (elapsed - fadeStart) / 200);
    }
    if (alpha <= 0) return;

    const size = Math.max(16, Math.round(this.height * stamp.sizeRatio));
    const font = this.options.displayFont?.trim() || DEFAULT_DISPLAY_FONT;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(this.width * stamp.cx, this.height * stamp.cy);
    ctx.rotate(stamp.rotation);
    ctx.scale(scale, scale);
    ctx.font = `800 ${size}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const textWidth = ctx.measureText(stamp.text).width;
    const shadow = Math.max(3, size * 0.08);

    if (stamp.burst) {
      const rx = textWidth / 2 + size * 0.6;
      const ry = size * 0.98;
      const spikes = 22;
      const rand = prng(stamp.text.length * 7919);
      const path = new Path2D();
      for (let i = 0; i < spikes * 2; i += 1) {
        const angle = (i / (spikes * 2)) * Math.PI * 2;
        const r = i % 2 === 0 ? 1 : 0.8 - rand() * 0.06;
        const x = Math.cos(angle) * rx * r;
        const y = Math.sin(angle) * ry * r;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      ctx.save();
      ctx.translate(shadow, shadow);
      ctx.fillStyle = INK;
      ctx.fill(path);
      ctx.restore();
      ctx.fillStyle = WHITE;
      ctx.fill(path);
      ctx.lineWidth = Math.max(2, size * 0.05);
      ctx.lineJoin = "miter";
      ctx.strokeStyle = INK;
      ctx.stroke(path);
    } else {
      const padX = size * 0.4;
      const boxW = textWidth + padX * 2;
      const boxH = size * 1.3;
      ctx.fillStyle = INK;
      ctx.fillRect(-boxW / 2 + shadow, -boxH / 2 + shadow, boxW, boxH);
      ctx.fillStyle = WHITE;
      ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
      ctx.lineWidth = Math.max(2, size * 0.06);
      ctx.strokeStyle = INK;
      ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
    }

    const baseline = size * 0.04;
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, size * 0.14);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.fillText(stamp.text, shadow * 0.6, baseline + shadow * 0.6);
    ctx.strokeText(stamp.text, 0, baseline);
    ctx.fillStyle = stamp.fill;
    ctx.fillText(stamp.text, 0, baseline);
    ctx.restore();
  }
}

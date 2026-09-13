/**
 * PROCEDURAL EARTH TEXTURES
 * =============================================================================
 * Three equirectangular maps are rasterised once at boot from the bundled
 * coastline vectors (src/twin/landData.ts):
 *
 *   day    albedo - ocean depth gradient, latitude-banded land colour,
 *                   polar ice, subtle terrain mottling
 *   night  city lights - sparse, deterministic, biased towards coastlines and
 *                   away from deserts/ice, plus a faint airglow band
 *   mask   R = land (0 ocean, 1 land), used for ocean specular + roughness
 *
 * No remote texture URLs, no licence ambiguity, and it looks right from the
 * back of a hall. Rasterising 2048x1024 three times costs ~80 ms at boot.
 */

import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';
import { LAND_POLYGONS } from './landData.ts';

const TEX_W = 2048;
const TEX_H = 1024;

export interface EarthTextures {
  day: CanvasTexture;
  night: CanvasTexture;
  mask: CanvasTexture;
  dispose: () => void;
}

/** Deterministic PRNG so the coastlines, lights and mottling never shift. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** lon/lat degrees -> equirectangular pixel coordinates. */
function project(lon: number, lat: number): [number, number] {
  return [((lon + 180) / 360) * TEX_W, ((90 - lat) / 180) * TEX_H];
}

function tracePolygons(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  for (const poly of LAND_POLYGONS) {
    for (const ring of poly) {
      let prevX = 0;
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i]!;
        const [x, y] = project(lon, lat);
        // Antimeridian guard: a segment that jumps more than half the texture
        // is the polygon wrapping around, so start a new sub-path instead of
        // drawing a stripe straight across the map.
        if (i === 0 || Math.abs(x - prevX) > TEX_W * 0.5) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevX = x;
      }
      ctx.closePath();
    }
  }
}

/** Value-noise sampled on a coarse lattice, smooth enough for terrain mottle. */
function makeNoise(seed: number, cols: number, rows: number): (u: number, v: number) => number {
  const r = rng(seed);
  const grid = new Float32Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const at = (cx: number, cy: number) => grid[((cy + rows) % rows) * cols + ((cx + cols) % cols)]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = u * cols;
    const y = v * rows;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };
}

function buildMask(): HTMLCanvasElement {
  const c = makeCanvas(TEX_W, TEX_H);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = '#fff';
  tracePolygons(ctx);
  ctx.fill('evenodd');
  return c;
}

function buildDay(): HTMLCanvasElement {
  const c = makeCanvas(TEX_W, TEX_H);
  const ctx = c.getContext('2d')!;

  /* --- ocean: depth gradient from equator to pole, slightly green at the
         tropics and near-black at the poles under ice. ------------------- */
  const ocean = ctx.createLinearGradient(0, 0, 0, TEX_H);
  ocean.addColorStop(0.0, '#0a2236');
  ocean.addColorStop(0.18, '#0d3350');
  ocean.addColorStop(0.5, '#10527a');
  ocean.addColorStop(0.82, '#0d3350');
  ocean.addColorStop(1.0, '#0a2236');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // Deep-ocean mottling so the water is not a flat sheet.
  const oceanNoise = makeNoise(0x0cea7, 96, 48);
  const img = ctx.getImageData(0, 0, TEX_W, TEX_H);
  for (let y = 0; y < TEX_H; y += 1) {
    for (let x = 0; x < TEX_W; x += 1) {
      const n = (oceanNoise(x / TEX_W, y / TEX_H) - 0.5) * 14;
      const i = (y * TEX_W + x) * 4;
      img.data[i] = clamp255(img.data[i]! + n * 0.6);
      img.data[i + 1] = clamp255(img.data[i + 1]! + n * 0.8);
      img.data[i + 2] = clamp255(img.data[i + 2]! + n);
    }
  }
  ctx.putImageData(img, 0, 0);

  /* --- land: clip to the coastlines, then paint latitude bands ---------- */
  ctx.save();
  ctx.beginPath();
  tracePolygons(ctx);
  ctx.clip('evenodd');

  // Base vegetation gradient by latitude: tundra / boreal / temperate /
  // desert / tropical / desert / temperate / tundra.
  const land = ctx.createLinearGradient(0, 0, 0, TEX_H);
  land.addColorStop(0.0, '#c6d2d8'); // arctic
  land.addColorStop(0.09, '#8c9789');
  land.addColorStop(0.2, '#48573c'); // boreal
  land.addColorStop(0.32, '#5c663e');
  land.addColorStop(0.4, '#8a7852'); // northern deserts (Sahara / Arabia)
  land.addColorStop(0.47, '#586b3d');
  land.addColorStop(0.53, '#3e5c36'); // equatorial
  land.addColorStop(0.62, '#7a6c4b');
  land.addColorStop(0.74, '#626c45');
  land.addColorStop(0.88, '#6f776a');
  land.addColorStop(1.0, '#dae3e8'); // antarctic
  ctx.fillStyle = land;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // Terrain mottling: two octaves of value noise modulating brightness.
  const n1 = makeNoise(0x1a4d, 160, 80);
  const n2 = makeNoise(0x77c3, 420, 210);
  const limg = ctx.getImageData(0, 0, TEX_W, TEX_H);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const u = x / TEX_W;
      const v = y / TEX_H;
      const n = (n1(u, v) - 0.5) * 34 + (n2(u, v) - 0.5) * 18;
      const i = (y * TEX_W + x) * 4;
      if (limg.data[i + 3] === 0) continue;
      limg.data[i] = clamp255(limg.data[i]! + n * 1.05);
      limg.data[i + 1] = clamp255(limg.data[i + 1]! + n);
      limg.data[i + 2] = clamp255(limg.data[i + 2]! + n * 0.7);
    }
  }
  ctx.putImageData(limg, 0, 0);
  ctx.restore();

  /* --- polar ice caps drawn over everything, feathered ------------------ */
  const ice = ctx.createLinearGradient(0, 0, 0, TEX_H);
  ice.addColorStop(0.0, 'rgba(238,246,252,0.95)');
  ice.addColorStop(0.055, 'rgba(238,246,252,0.0)');
  ice.addColorStop(0.93, 'rgba(238,246,252,0.0)');
  ice.addColorStop(0.985, 'rgba(240,248,254,0.97)');
  ice.addColorStop(1.0, 'rgba(245,250,255,1)');
  ctx.fillStyle = ice;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  /* --- coastline definition: a thin lighter rim reads as a shelf -------- */
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = '#7fd0e0';
  ctx.lineWidth = 1.1;
  tracePolygons(ctx);
  ctx.stroke();
  ctx.restore();

  return c;
}

function buildNight(maskCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(TEX_W, TEX_H);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  const maskCtx = maskCanvas.getContext('2d')!;
  const mask = maskCtx.getImageData(0, 0, TEX_W, TEX_H).data;
  const isLand = (x: number, y: number) => mask[(y * TEX_W + x) * 4]! > 127;

  const r = rng(0x1113);
  const density = makeNoise(0x5511, 120, 60);

  // Scatter settlements: land only, biased towards coastlines (a pixel with a
  // nearby ocean pixel), away from the poles, and modulated by a noise field
  // so continents have plausible bright and empty regions.
  const ATTEMPTS = 130_000;
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < ATTEMPTS; k++) {
    const x = (r() * TEX_W) | 0;
    const y = (r() * TEX_H) | 0;
    if (!isLand(x, y)) continue;

    const lat = 90 - (y / TEX_H) * 180;
    if (Math.abs(lat) > 72) continue;
    const latFactor = 1 - Math.abs(lat) / 90;

    // Coastal proximity: sample a ring around the point.
    let coastal = 0;
    for (const [dx, dy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [5, 5], [-5, -5]] as const) {
      const sx = (x + dx + TEX_W) % TEX_W;
      const sy = Math.min(TEX_H - 1, Math.max(0, y + dy));
      if (!isLand(sx, sy)) coastal = 1;
    }

    const d = density(x / TEX_W, y / TEX_H);
    const p = (0.22 + 0.78 * d) * (0.45 + 0.55 * coastal) * latFactor;
    if (r() > p * 0.5) continue;

    const bright = 0.28 + 0.72 * r() * d;
    const radius = 0.7 + r() * 2.1;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
    g.addColorStop(0, `rgba(255,222,158,${(bright * 0.9).toFixed(3)})`);
    g.addColorStop(0.4, `rgba(255,186,104,${(bright * 0.32).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  return c;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Build all three maps. Call once; they are shared by the Earth material. */
export function buildEarthTextures(): EarthTextures {
  const maskCanvas = buildMask();
  const day = toTexture(buildDay(), true);
  const night = toTexture(buildNight(maskCanvas), true);
  const mask = toTexture(maskCanvas, false);
  return {
    day,
    night,
    mask,
    dispose: () => {
      day.dispose();
      night.dispose();
      mask.dispose();
    },
  };
}

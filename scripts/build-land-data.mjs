#!/usr/bin/env node
/**
 * Bake Natural Earth coastlines into src/twin/landData.ts.
 *
 * WHY: the Earth in this scene must look convincing from a projector without
 * depending on a remote texture URL at presentation time, and without shipping
 * a large satellite image of uncertain licence. So we ship ~50 kB of coastline
 * polygons (public domain) and rasterise the day map, night-lights map and
 * ocean mask in the browser at boot (see src/twin/earthTexture.ts).
 *
 * SOURCE:  world-atlas land-110m.json (TopoJSON of Natural Earth 110m land)
 * LICENCE: Natural Earth is in the public domain; world-atlas is ISC licensed.
 *          https://www.naturalearthdata.com/about/terms-of-use/
 *          https://github.com/topojson/world-atlas
 *
 * Run:  node scripts/build-land-data.mjs
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'twin', 'landData.ts');
const URL_110M = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json';

/** Decode one TopoJSON arc into absolute [lon, lat] pairs. */
function decodeArc(arc, transform) {
  const [sx, sy] = transform.scale;
  const [tx, ty] = transform.translate;
  let x = 0;
  let y = 0;
  const out = [];
  for (const [dx, dy] of arc) {
    x += dx;
    y += dy;
    out.push([x * sx + tx, y * sy + ty]);
  }
  return out;
}

function ringFromArcIndexes(indexes, arcs) {
  const pts = [];
  for (const idx of indexes) {
    const reversed = idx < 0;
    const arc = arcs[reversed ? ~idx : idx];
    const seq = reversed ? arc.slice().reverse() : arc;
    // Drop the duplicated joining vertex.
    for (let i = pts.length === 0 ? 0 : 1; i < seq.length; i++) pts.push(seq[i]);
  }
  return pts;
}

const res = await fetch(URL_110M, { signal: AbortSignal.timeout(30000) });
if (!res.ok) throw new Error(`world-atlas fetch failed: HTTP ${res.status}`);
const topo = await res.json();

const arcs = topo.arcs.map((a) => decodeArc(a, topo.transform));
const geom = topo.objects.land;
const polygons = [];

function collect(g) {
  if (g.type === 'GeometryCollection') {
    g.geometries.forEach(collect);
  } else if (g.type === 'Polygon') {
    polygons.push(g.arcs.map((r) => ringFromArcIndexes(r, arcs)));
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.arcs) polygons.push(poly.map((r) => ringFromArcIndexes(r, arcs)));
  }
}
collect(geom);

// Quantise to 2 decimal places (~1.1 km at the equator - far finer than the
// texture resolution) and drop degenerate rings.
const round2 = (v) => Math.round(v * 100) / 100;
const cleaned = polygons
  .map((rings) =>
    rings
      .map((ring) => ring.map(([lon, lat]) => [round2(lon), round2(lat)]))
      .filter((ring) => ring.length >= 4),
  )
  .filter((rings) => rings.length > 0);

const vertexCount = cleaned.reduce((n, rings) => n + rings.reduce((m, r) => m + r.length, 0), 0);

const body = `/**
 * COASTLINE GEOMETRY (generated - do not edit by hand)
 * =============================================================================
 * Natural Earth 110m land polygons, used to rasterise the Earth's day map,
 * night-lights map and ocean mask in the browser at boot. Shipping vector
 * coastlines instead of a bitmap keeps the repository small, keeps the licence
 * unambiguous, and means the presentation never depends on a remote texture.
 *
 * SOURCE:  world-atlas land-110m.json (TopoJSON of Natural Earth 110m land)
 * LICENCE: Natural Earth data is public domain. world-atlas is ISC licensed.
 *          https://www.naturalearthdata.com/about/terms-of-use/
 *
 * Regenerate with:  node scripts/build-land-data.mjs
 * ${cleaned.length} polygons, ${vertexCount} vertices, generated ${new Date().toISOString()}
 */

/** Each polygon is a list of rings; each ring is a flat list of [lon, lat]. */
export type LandRing = readonly (readonly [number, number])[];
export type LandPolygon = readonly LandRing[];

export const LAND_POLYGONS: readonly LandPolygon[] = ${JSON.stringify(cleaned)};
`;

await writeFile(OUT, body, 'utf8');
console.log(`Wrote ${cleaned.length} polygons / ${vertexCount} vertices to ${OUT}`);

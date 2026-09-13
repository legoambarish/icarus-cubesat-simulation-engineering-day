#!/usr/bin/env node
/**
 * Regenerate public/fallback/orbital-data.json from CelesTrak.
 *
 * The bundled element sets are what the application uses when CelesTrak is
 * unreachable at presentation time. They are a *snapshot*, and the UI always
 * labels them FALLBACK - never LIVE. SGP4 accuracy degrades slowly away from
 * the epoch (a few km per day in LEO), so re-run this shortly before an
 * exhibition:
 *
 *     node scripts/refresh-fallback.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'fallback', 'orbital-data.json');

// Keep in sync with CURATED_OBJECTS in src/orbit/celestrak.ts.
const CATNRS = [
  25544, 48274, 20580, 25994, 27424, 43613, 36508, 43013, 25338, 49260, 40697,
  41335, 35932, 39444, 39446, 39417,
];

const REQUIRED = [
  'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
];

async function fetchOne(catnr) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catnr}&FORMAT=JSON`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${catnr}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body) || body.length === 0) throw new Error(`${catnr}: empty response`);
  const rec = body[0];
  for (const k of REQUIRED) {
    if (!(k in rec)) throw new Error(`${catnr}: missing ${k}`);
  }
  return rec;
}

const objects = [];
for (const catnr of CATNRS) {
  try {
    const rec = await fetchOne(catnr);
    objects.push(rec);
    console.log(`  ok  ${String(catnr).padStart(5)}  ${rec.OBJECT_NAME}`);
  } catch (err) {
    console.error(`  FAIL ${catnr}: ${err.message}`);
  }
}

if (objects.length === 0) {
  console.error('No element sets retrieved - leaving the existing fallback file alone.');
  process.exit(1);
}

const payload = {
  _comment:
    'Snapshot of public CelesTrak GP/OMM element sets, bundled so the digital twin still renders real orbits with no network. This data is a SNAPSHOT, not live telemetry - the UI labels it ORBIT DATA - FALLBACK. Regenerate with: node scripts/refresh-fallback.mjs',
  _source: 'https://celestrak.org/NORAD/elements/gp.php?CATNR=<id>&FORMAT=JSON',
  _license:
    'CelesTrak GP data is redistributed from public US Space Force orbital element sets. See https://celestrak.org/ for terms.',
  generated_utc: new Date().toISOString(),
  objects,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`\nWrote ${objects.length} element sets to ${OUT}`);

/**
 * BUNDLED FALLBACK ORBITAL ELEMENTS
 * =============================================================================
 * public/fallback/orbital-data.json holds a snapshot of the same CelesTrak OMM
 * records the live path fetches. It exists so the exhibition still shows real
 * orbits when the venue Wi-Fi does not work.
 *
 * This data is a SNAPSHOT. It is always surfaced as "ORBIT DATA - FALLBACK",
 * never as LIVE, and the object profile marks each record's origin. Refresh it
 * before a demo with `node scripts/refresh-fallback.mjs`.
 *
 * The file is fetched through import.meta.env.BASE_URL so it resolves
 * correctly under a GitHub Pages project path such as /cubesat-digital-twin/.
 */

import { CURATED_OBJECTS, validateOmm, type FetchedObject } from './celestrak.ts';

interface FallbackFile {
  generated_utc?: string;
  objects?: unknown;
}

let cached: FetchedObject[] | null = null;
let cachedGeneratedUtc: string | null = null;

/** ISO timestamp the bundled snapshot was taken, once it has been loaded. */
export function fallbackGeneratedUtc(): string | null {
  return cachedGeneratedUtc;
}

/**
 * Load and validate the bundled element sets. Each record is validated
 * independently; a corrupt entry is skipped, not fatal. Result is memoised for
 * the session.
 */
export async function loadFallbackCatalog(baseUrl: string): Promise<FetchedObject[]> {
  if (cached) return cached;
  try {
    const res = await fetch(`${baseUrl}fallback/orbital-data.json`, { cache: 'force-cache' });
    if (!res.ok) {
      console.warn(`[orbit] fallback element file returned HTTP ${res.status}`);
      cached = [];
      return cached;
    }
    const body = (await res.json()) as FallbackFile;
    cachedGeneratedUtc = typeof body.generated_utc === 'string' ? body.generated_utc : null;
    if (!Array.isArray(body.objects)) {
      cached = [];
      return cached;
    }

    const out: FetchedObject[] = [];
    for (const item of body.objects) {
      const raw = item as Record<string, unknown> | null;
      const catnr = Number(raw?.NORAD_CAT_ID);
      const entry = CURATED_OBJECTS.find((e) => e.catnr === catnr);
      if (!entry) continue;
      const v = validateOmm(item, entry, 'FALLBACK');
      if (v) out.push(v);
      else console.warn(`[orbit] fallback record ${catnr} failed validation - skipped`);
    }
    cached = out;
    return out;
  } catch (err) {
    console.warn('[orbit] fallback element file could not be loaded', err);
    cached = [];
    return cached;
  }
}

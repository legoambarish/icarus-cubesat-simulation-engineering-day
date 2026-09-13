/**
 * CELESTRAK GP / OMM CLIENT
 * =============================================================================
 * Real spacecraft in this scene are propagated from CURRENT public orbital
 * elements published by CelesTrak. Four things matter here.
 *
 * 1. FORMAT=JSON IS EXPLICIT. CelesTrak's GP endpoint now defaults to CSV. We
 *    ask for OMM JSON because it is structured, validatable field by field, and
 *    is what satellite.js recommends for new applications (json2satrec).
 *
 * 2. GROUP QUERIES, NOT SIXTEEN SINGLE-OBJECT QUERIES. CelesTrak's usage terms
 *    ask clients not to hammer the service with one request per object, and
 *    they enforce it: developing this application with per-object requests
 *    earned a 403 from their edge within an afternoon. The sixteen curated
 *    objects live in five groups, so five requests fetch the lot. Anything a
 *    group does not contain falls back to a single CATNR request, which is
 *    rare and self-correcting.
 *
 * 3. THE RESULT IS CACHED IN localStorage. Element sets are refreshed a few
 *    times a day, so a three-hour cache costs nothing in accuracy and means a
 *    page reload - during development, or between visitors at an exhibition -
 *    makes zero network requests. The cache stores the raw OMM records, and
 *    revalidation is by age only.
 *
 * 4. FAILURE IS NORMAL AND VISIBLE. Offline, DNS failure, CORS, timeout, a 403,
 *    an HTML error page: every one of them lands on the bundled element sets in
 *    public/fallback/orbital-data.json, and the UI says ORBIT DATA - FALLBACK.
 *    Bundled data is never described as live.
 *
 * Every record is validated independently, so one malformed object is dropped
 * rather than poisoning the catalogue.
 */

import type { OMMJsonObject } from 'satellite.js';
import type { ObjectKind, OrbitalRecord } from '../state/types.ts';
import { loadFallbackCatalog } from './fallback.ts';

const GP_ENDPOINT = 'https://celestrak.org/NORAD/elements/gp.php';

/** Milliseconds before a single request is abandoned. */
const REQUEST_TIMEOUT_MS = 8_000;
/**
 * Hard deadline on the whole live attempt.
 *
 * This is the number that matters at an exhibition. A blocked or rate-limited
 * CelesTrak does not refuse quickly: the 403 it returns carries no CORS
 * headers, so the browser reports "Failed to fetch" only after several
 * seconds. Five group requests run one after another is most of half a minute
 * staring at LOADING. So the requests run CONCURRENTLY and the whole attempt
 * is abandoned after this long, keeping whatever did arrive and filling the
 * rest from the bundled snapshot.
 */
const TOTAL_BUDGET_MS = 6_000;
/** How long a cached catalogue is considered fresh. */
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const CACHE_KEY = 'icarus.gp.cache.v1';

/** CelesTrak group files that between them contain every curated object. */
const GROUPS = ['stations', 'cubesat', 'science', 'resource', 'weather'] as const;

export interface CatalogEntry {
  id: string;
  name: string;
  catnr: number;
  kind: ObjectKind;
  /** One line shown in the object profile so the demo can explain the object. */
  blurb: string;
}

/**
 * Curated object list. Every catalogue number below was checked against
 * CelesTrak and is an on-orbit, actively tracked object. The renderer does not
 * care what is in this list - objects can be added or removed freely.
 */
export const CURATED_OBJECTS: readonly CatalogEntry[] = [
  { id: 'iss', name: 'ISS (ZARYA)', catnr: 25544, kind: 'station', blurb: 'International Space Station. ~420 km, 51.6 deg - the reference LEO object.' },
  { id: 'css', name: 'CSS (TIANHE)', catnr: 48274, kind: 'station', blurb: 'Chinese Space Station core module, 41.5 deg inclination.' },
  { id: 'hst', name: 'HUBBLE (HST)', catnr: 20580, kind: 'science', blurb: 'Hubble Space Telescope, 28.5 deg - launched from a low-inclination site.' },
  { id: 'terra', name: 'TERRA', catnr: 25994, kind: 'science', blurb: 'NASA Earth-observing flagship in a sun-synchronous morning orbit.' },
  { id: 'aqua', name: 'AQUA', catnr: 27424, kind: 'science', blurb: 'NASA Earth observatory, sun-synchronous afternoon crossing.' },
  { id: 'icesat2', name: 'ICESAT-2', catnr: 43613, kind: 'science', blurb: 'Laser altimeter measuring ice-sheet elevation, 92 deg inclination.' },
  { id: 'cryosat2', name: 'CRYOSAT-2', catnr: 36508, kind: 'science', blurb: 'ESA ice-thickness radar altimeter in a high-inclination drifting orbit.' },
  { id: 'noaa20', name: 'NOAA-20 (JPSS-1)', catnr: 43013, kind: 'weather', blurb: 'Polar-orbiting operational weather satellite.' },
  { id: 'noaa15', name: 'NOAA-15', catnr: 25338, kind: 'weather', blurb: 'Long-lived polar weather satellite, launched 1998.' },
  { id: 'landsat9', name: 'LANDSAT 9', catnr: 49260, kind: 'imaging', blurb: 'Land-imaging mission, 705 km sun-synchronous orbit.' },
  { id: 'sentinel2a', name: 'SENTINEL-2A', catnr: 40697, kind: 'imaging', blurb: 'Copernicus optical imaging mission.' },
  { id: 'sentinel3a', name: 'SENTINEL-3A', catnr: 41335, kind: 'science', blurb: 'Copernicus ocean and land monitoring mission.' },
  { id: 'swisscube', name: 'SWISSCUBE', catnr: 35932, kind: 'cubesat', blurb: '1U CubeSat built by EPFL students - on orbit since 2009.' },
  { id: 'funcube1', name: 'FUNCUBE-1 (AO-73)', catnr: 39444, kind: 'cubesat', blurb: '1U educational CubeSat with an amateur-radio transponder.' },
  { id: 'uwe3', name: 'UWE-3', catnr: 39446, kind: 'cubesat', blurb: 'University of Wuerzburg 1U CubeSat - an attitude-control technology demonstrator.' },
  { id: 'zacube1', name: 'ZACUBE-1', catnr: 39417, kind: 'cubesat', blurb: 'South African 1U CubeSat (TshepisoSat), CPUT student programme.' },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CURATED_OBJECTS.find((o) => o.id === id);
}

const BY_CATNR = new Map(CURATED_OBJECTS.map((o) => [o.catnr, o]));

/* ==========================================================================
 * Validation
 * ========================================================================== */

function finite(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Validate one OMM record. Returns null (and the caller drops it) rather than
 * throwing, so one bad object cannot take out the catalogue.
 */
export function validateOmm(
  raw: unknown,
  entry: CatalogEntry,
  origin: 'LIVE' | 'FALLBACK',
): { record: OrbitalRecord; omm: OMMJsonObject } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const name = typeof o.OBJECT_NAME === 'string' && o.OBJECT_NAME.trim() ? o.OBJECT_NAME.trim() : entry.name;
  const noradId = finite(o.NORAD_CAT_ID);
  const meanMotion = finite(o.MEAN_MOTION);
  const ecc = finite(o.ECCENTRICITY);
  const inc = finite(o.INCLINATION);
  const raan = finite(o.RA_OF_ASC_NODE);
  const argp = finite(o.ARG_OF_PERICENTER);
  const ma = finite(o.MEAN_ANOMALY);
  const bstar = finite(o.BSTAR);
  const epoch = typeof o.EPOCH === 'string' ? o.EPOCH : null;

  if (noradId === null || noradId !== entry.catnr) return null;
  if (epoch === null || Number.isNaN(Date.parse(epoch))) return null;
  if (meanMotion === null || meanMotion <= 0.5 || meanMotion > 20) return null; // LEO/MEO sanity
  if (ecc === null || ecc < 0 || ecc >= 1) return null;
  if (inc === null || inc < 0 || inc > 180) return null;
  if (raan === null || argp === null || ma === null || bstar === null) return null;

  return {
    record: {
      id: entry.id,
      name,
      noradId,
      kind: entry.kind,
      epoch,
      inclinationDeg: inc,
      meanMotionRevPerDay: meanMotion,
      eccentricity: ecc,
      origin,
    },
    omm: o as unknown as OMMJsonObject,
  };
}

/* ==========================================================================
 * Fetching
 * ========================================================================== */

export interface FetchedObject {
  record: OrbitalRecord;
  omm: OMMJsonObject;
}

export interface CatalogResult {
  objects: FetchedObject[];
  /** LIVE when everything came from CelesTrak, FALLBACK when nothing did. */
  source: 'LIVE' | 'FALLBACK' | 'MIXED';
  detail: string;
  liveCount: number;
  fallbackCount: number;
  /** True when the live half was served from the localStorage cache. */
  fromCache: boolean;
}

/** GET a GP query and return the decoded array, or null on any failure. */
async function fetchGp(query: string, signal?: AbortSignal): Promise<unknown[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    const res = await fetch(`${GP_ENDPOINT}?${query}&FORMAT=JSON`, {
      signal: ctrl.signal,
      cache: 'no-store',
      mode: 'cors',
    });
    if (!res.ok) {
      console.warn(`[orbit] CelesTrak ${query} returned HTTP ${res.status}`);
      return null;
    }
    // CelesTrak serves an HTML error page on some failures, with a 200.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : null;
  } catch (err) {
    console.warn(`[orbit] CelesTrak ${query} failed`, err);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/* ---------------------------------------------------------------- cache -- */

interface CacheShape {
  savedAt: number;
  records: unknown[];
}

function readCache(): unknown[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (typeof parsed?.savedAt !== 'number' || !Array.isArray(parsed.records)) return null;
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
    return parsed.records;
  } catch {
    // Private mode, quota, corrupt entry: the cache is an optimisation, not a
    // dependency. Losing it just means one more fetch.
    return null;
  }
}

function writeCache(records: unknown[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), records } satisfies CacheShape));
  } catch {
    /* ignore - see readCache */
  }
}

/** Drop the cached catalogue. Exposed for the refresh path and for tests. */
export function clearCatalogCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- assembly -- */

/** Pick the curated objects out of a pile of OMM records. */
function harvest(records: unknown[], into: Map<string, FetchedObject>): void {
  for (const raw of records) {
    const catnr = finite((raw as Record<string, unknown> | null)?.NORAD_CAT_ID);
    if (catnr === null) continue;
    const entry = BY_CATNR.get(catnr);
    if (!entry || into.has(entry.id)) continue;
    const v = validateOmm(raw, entry, 'LIVE');
    if (v) into.set(entry.id, v);
  }
}

/**
 * Fetch the curated catalogue.
 *
 * Order of attempts: cache, then the five group files, then individual CATNR
 * requests for whatever is still missing, then the bundled snapshot. The
 * returned `source` is what the ORBIT DATA indicator shows, and it never lies.
 */
export async function loadCatalog(baseUrl: string, signal?: AbortSignal): Promise<CatalogResult> {
  const live = new Map<string, FetchedObject>();
  let fromCache = false;

  /* ---- 1. cache ------------------------------------------------------- */
  const cached = readCache();
  if (cached) {
    harvest(cached, live);
    fromCache = live.size > 0;
  }

  /* ---- 2. group files, concurrently and under a deadline -------------- */
  if (!fromCache) {
    const deadline = AbortSignal.timeout(TOTAL_BUDGET_MS);
    const budget = signal ? AbortSignal.any([signal, deadline]) : deadline;

    // Promise.allSettled, not a loop: five requests that each fail slowly cost
    // one slow request, not five.
    const bodies = await Promise.allSettled(
      GROUPS.map((group) => fetchGp(`GROUP=${group}`, budget)),
    );
    for (const result of bodies) {
      if (result.status === 'fulfilled' && result.value) harvest(result.value, live);
    }

    /* ---- 3. anything a group did not carry ---------------------------
     * Only worth doing when a handful are missing and there is budget left.
     * If the whole service is unreachable this is skipped entirely rather
     * than adding sixteen more slow failures.                            */
    const missing = CURATED_OBJECTS.filter((e) => !live.has(e.id));
    if (live.size > 0 && missing.length > 0 && missing.length <= 6 && !budget.aborted) {
      const extra = await Promise.allSettled(
        missing.map(async (entry) => {
          const body = await fetchGp(`CATNR=${entry.catnr}`, budget);
          return body && body.length > 0 ? validateOmm(body[0], entry, 'LIVE') : null;
        }),
      );
      for (const result of extra) {
        if (result.status === 'fulfilled' && result.value) {
          live.set(result.value.record.id, result.value);
        }
      }
    }

    // Cache only the records we actually kept, not the whole group files.
    if (live.size > 0) writeCache([...live.values()].map((o) => o.omm));
  }

  /* ---- 4. bundled snapshot for the remainder -------------------------- */
  const stillMissing = CURATED_OBJECTS.filter((e) => !live.has(e.id));
  let fallbackUsed: FetchedObject[] = [];
  if (stillMissing.length > 0) {
    const fb = await loadFallbackCatalog(baseUrl);
    const fbById = new Map(fb.map((f) => [f.record.id, f]));
    fallbackUsed = stillMissing
      .map((e) => fbById.get(e.id))
      .filter((x): x is FetchedObject => Boolean(x));
  }

  const objects = [...live.values(), ...fallbackUsed].sort(
    (a, b) =>
      CURATED_OBJECTS.findIndex((e) => e.id === a.record.id)
      - CURATED_OBJECTS.findIndex((e) => e.id === b.record.id),
  );

  const liveCount = live.size;
  const fallbackCount = fallbackUsed.length;

  let source: CatalogResult['source'];
  let detail: string;
  if (liveCount > 0 && fallbackCount === 0) {
    source = 'LIVE';
    detail = fromCache
      ? `${liveCount} objects - CelesTrak OMM (cached)`
      : `${liveCount} objects from CelesTrak OMM`;
  } else if (liveCount > 0) {
    source = 'MIXED';
    detail = `${liveCount} live, ${fallbackCount} from bundled elements`;
  } else {
    source = 'FALLBACK';
    detail = `CelesTrak unreachable - ${fallbackCount} bundled element sets`;
  }

  return { objects, source, detail, liveCount, fallbackCount, fromCache };
}

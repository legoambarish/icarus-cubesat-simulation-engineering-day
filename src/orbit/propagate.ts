/**
 * SGP4 PROPAGATION OF REAL ORBITAL OBJECTS
 * =============================================================================
 * SGP4 is the standard analytical propagator that turns a published element
 * set (TLE / OMM) into a position and velocity at an arbitrary time. It is the
 * model the element sets were *fitted* with, which is why you must use SGP4
 * with them rather than plugging them into a Kepler two-body solver.
 *
 * What we use it for here: drawing where real spacecraft actually are,
 * propagated locally in the browser. We are not doing conjunction analysis - a
 * few km of error is invisible at this scale.
 *
 * CADENCE AND SMOOTHNESS
 * ----------------------
 * SGP4 is not run every frame. It is run at PROPAGATE_HZ into a pair of
 * keyframes (previous / next) and the renderer INTERPOLATES between them every
 * frame. That matters: the mission clock runs at 60x, so an object crosses a
 * visible arc between samples, and snapping to each sample makes the whole
 * catalogue stutter. Interpolating gives continuous motion at a fraction of
 * the propagation cost, which is exactly what the build manual asks for.
 *
 * The interpolation is a cubic Hermite using the SGP4 VELOCITY at each
 * keyframe as the tangent, so the path follows the orbit's curvature instead
 * of cutting the chord across it.
 */

import {
  json2satrec,
  propagate as sgp4Propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
  type OMMJsonObject,
  type SatRec,
} from 'satellite.js';
import type { OrbitalRecord, PropagatedState } from '../state/types.ts';
import type { FetchedObject } from './celestrak.ts';
import { EARTH_RADIUS_KM, type EciVec } from './frames.ts';

/** How often SGP4 is evaluated. Frames in between are interpolated. */
export const PROPAGATE_HZ = 5;

export interface Keyframe {
  /** Mission time this sample is valid at, ms. */
  timeMs: number;
  positionKm: EciVec;
  velocityKmS: EciVec;
}

export interface TrackedObject {
  record: OrbitalRecord;
  satrec: SatRec;
  /** Latest propagated state (the `next` keyframe), or null on failure. */
  state: PropagatedState | null;
  /** Interpolation keyframes. */
  prev: Keyframe | null;
  next: Keyframe | null;
  /** Smoothly interpolated position for the current frame. */
  renderPositionKm: EciVec;
  /** One full-orbit path in ECI km, computed once. */
  pathEciKm: EciVec[];
  /** Orbital period in minutes derived from the element set's mean motion. */
  periodMin: number;
  /** True once the propagator has failed - the object is dropped from the UI. */
  failed: boolean;
}

/** Build a satrec from a validated OMM record. Returns null if SGP4 rejects it. */
export function toSatrec(omm: OMMJsonObject): SatRec | null {
  try {
    const rec = json2satrec(omm);
    // error != 0 means SGP4 initialisation itself failed.
    return rec.error === 0 ? rec : null;
  } catch {
    return null;
  }
}

/** Propagate one satrec to a date. Returns null on any SGP4 error. */
export function propagateAt(satrec: SatRec, date: Date): PropagatedState | null {
  let pv;
  try {
    pv = sgp4Propagate(satrec, date);
  } catch {
    return null;
  }
  if (!pv || !pv.position || !pv.velocity) return null;

  const p = pv.position;
  const v = pv.velocity;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;

  const gmst = gstime(date);
  const geo = eciToGeodetic(p, gmst);
  const altitudeKm = geo.height;

  // Reject nonsense: decayed objects propagate to absurd or sub-surface values.
  if (!Number.isFinite(altitudeKm) || altitudeKm < -200 || altitudeKm > 200000) return null;

  return {
    positionEciKm: { x: p.x, y: p.y, z: p.z },
    velocityEciKmS: { x: v.x, y: v.y, z: v.z },
    altitudeKm,
    latitudeDeg: degreesLat(geo.latitude),
    longitudeDeg: degreesLong(geo.longitude),
    speedKmS: Math.hypot(v.x, v.y, v.z),
  };
}

/**
 * Advance one object's keyframes to `missionDate`, then interpolate.
 *
 * Called every frame. It only runs SGP4 when the current `next` keyframe has
 * been passed, so the actual propagation rate is PROPAGATE_HZ regardless of
 * how fast the display is running.
 */
export function updateTracked(obj: TrackedObject, missionDate: Date, stepMs: number): void {
  if (obj.failed) return;
  const nowMs = missionDate.getTime();

  // Prime both keyframes on the first call.
  if (!obj.next) {
    const s0 = propagateAt(obj.satrec, missionDate);
    if (!s0) {
      obj.failed = true;
      return;
    }
    obj.prev = { timeMs: nowMs, positionKm: s0.positionEciKm, velocityKmS: s0.velocityEciKmS };
    obj.next = obj.prev;
    obj.state = s0;
  }

  // Advance the window until `next` is ahead of the mission clock. The loop is
  // bounded so a large clock jump (a backgrounded tab) re-seeds instead of
  // grinding through thousands of steps.
  let guard = 0;
  while (obj.next && nowMs >= obj.next.timeMs && guard < 4) {
    guard++;
    const t: number = obj.next.timeMs + stepMs;
    const s = propagateAt(obj.satrec, new Date(t));
    if (!s) {
      obj.failed = true;
      return;
    }
    obj.prev = obj.next;
    obj.next = { timeMs: t, positionKm: s.positionEciKm, velocityKmS: s.velocityEciKmS };
    obj.state = s;
  }
  if (guard >= 4) {
    // Fell too far behind: re-seed rather than catching up sample by sample.
    const s = propagateAt(obj.satrec, missionDate);
    if (!s) {
      obj.failed = true;
      return;
    }
    obj.prev = { timeMs: nowMs, positionKm: s.positionEciKm, velocityKmS: s.velocityEciKmS };
    obj.next = obj.prev;
    obj.state = s;
  }

  hermite(obj, nowMs);
}

/**
 * Cubic Hermite interpolation between the two keyframes.
 *
 *   p(u) = h00*p0 + h10*T*v0 + h01*p1 + h11*T*v1
 *
 * Using the SGP4 velocities as tangents keeps the interpolated path on the
 * curve of the orbit; a straight lerp would visibly cut the corner at this
 * time scale.
 */
function hermite(obj: TrackedObject, nowMs: number): void {
  const a = obj.prev;
  const b = obj.next;
  if (!a || !b) return;

  const span = b.timeMs - a.timeMs;
  if (span <= 0) {
    obj.renderPositionKm.x = b.positionKm.x;
    obj.renderPositionKm.y = b.positionKm.y;
    obj.renderPositionKm.z = b.positionKm.z;
    return;
  }

  const u = Math.min(1, Math.max(0, (nowMs - a.timeMs) / span));
  const T = span / 1000; // tangent scale: velocities are km/s
  const u2 = u * u;
  const u3 = u2 * u;

  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  obj.renderPositionKm.x =
    h00 * a.positionKm.x + h10 * T * a.velocityKmS.x + h01 * b.positionKm.x + h11 * T * b.velocityKmS.x;
  obj.renderPositionKm.y =
    h00 * a.positionKm.y + h10 * T * a.velocityKmS.y + h01 * b.positionKm.y + h11 * T * b.velocityKmS.y;
  obj.renderPositionKm.z =
    h00 * a.positionKm.z + h10 * T * a.velocityKmS.z + h01 * b.positionKm.z + h11 * T * b.velocityKmS.z;
}

/**
 * Sample one complete orbit for the path line.
 *
 * The path is drawn in the *inertial* frame, so it is a closed ring that the
 * spacecraft actually follows; the Earth rotates underneath it. Sampling one
 * period from `from` is enough - SGP4's secular drift over 90 minutes is far
 * below one pixel at this scale.
 */
export function samplePath(satrec: SatRec, from: Date, periodMin: number, segments = 160): EciVec[] {
  const pts: EciVec[] = [];
  const stepMs = (periodMin * 60_000) / segments;
  for (let i = 0; i <= segments; i++) {
    const st = propagateAt(satrec, new Date(from.getTime() + i * stepMs));
    if (st) pts.push(st.positionEciKm);
  }
  return pts;
}

/** Orbital period in minutes from the OMM mean motion (revolutions per day). */
export function periodFromMeanMotion(revPerDay: number): number {
  return 1440 / revPerDay;
}

/**
 * Turn validated catalogue entries into tracked objects. Objects whose element
 * set SGP4 refuses, or that fail to propagate at t=now, are dropped here with a
 * console warning rather than being allowed to render a broken marker.
 */
export function buildTrackedObjects(objects: FetchedObject[], now: Date): TrackedObject[] {
  const out: TrackedObject[] = [];
  for (const item of objects) {
    const satrec = toSatrec(item.omm);
    if (!satrec) {
      console.warn(`[orbit] SGP4 rejected element set for ${item.record.name}`);
      continue;
    }
    const state = propagateAt(satrec, now);
    if (!state) {
      console.warn(`[orbit] ${item.record.name} failed to propagate - dropped`);
      continue;
    }
    const periodMin = periodFromMeanMotion(item.record.meanMotionRevPerDay);
    out.push({
      record: item.record,
      satrec,
      state,
      prev: null,
      next: null,
      renderPositionKm: { ...state.positionEciKm },
      periodMin,
      pathEciKm: samplePath(satrec, now, periodMin),
      failed: false,
    });
  }
  return out;
}

/** Apparent altitude used for the object list; falls back to the element set. */
export function altitudeOf(obj: TrackedObject): number {
  if (obj.state) return obj.state.altitudeKm;
  // a = (mu / n^2)^(1/3) from the mean motion, minus the Earth radius.
  const n = (obj.record.meanMotionRevPerDay * 2 * Math.PI) / 86400;
  const a = Math.cbrt(398600.4418 / (n * n));
  return a - EARTH_RADIUS_KM;
}

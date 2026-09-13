/**
 * COORDINATE FRAMES - the one and only place axes are converted
 * =============================================================================
 *
 * AUTHORITATIVE FRAME:  ECI (Earth-Centered Inertial, TEME as produced by SGP4)
 *   units          kilometres, kilometres/second
 *   +X             towards the vernal equinox in the equatorial plane
 *   +Y             90 deg east of +X in the equatorial plane
 *   +Z             towards the geographic north pole
 *   right-handed
 *
 * RENDER FRAME:  Three.js world space
 *   Three.js is Y-up, so the north pole has to become +Y. The conversion is a
 *   single pure rotation (determinant +1, handedness preserved):
 *
 *        three.x = +eci.x / KM_PER_SCENE_UNIT
 *        three.y = +eci.z / KM_PER_SCENE_UNIT
 *        three.z = -eci.y / KM_PER_SCENE_UNIT
 *
 * Because this is a rotation and not a reflection, angular quantities
 * (spin direction, orbit direction, attitude) survive unchanged. Every
 * position that enters the scene goes through sceneFromEci(); there are no
 * ad-hoc sign flips anywhere else in the renderer.
 *
 * SCALE: 1 scene unit = 1000 km, so Earth has radius 6.371 units. Spacecraft
 * *models* are drawn far larger than scale (a 1U CubeSat would be 1e-7 units)
 * and the UI says so - positions remain exact, only the marker size is
 * exaggerated.
 */

import { Vector3 } from 'three';

export const EARTH_RADIUS_KM = 6371;
export const MU_EARTH_KM3_S2 = 398600.4418;
export const KM_PER_SCENE_UNIT = 1000;

/** Earth's sidereal rotation rate, rad/s (used for the Earth mesh spin). */
export const EARTH_ROTATION_RAD_S = 7.2921159e-5;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export interface EciVec {
  x: number;
  y: number;
  z: number;
}

/** Convert an ECI position in km into Three.js world units. */
export function sceneFromEci(eci: EciVec, out = new Vector3()): Vector3 {
  return out.set(
    eci.x / KM_PER_SCENE_UNIT,
    eci.z / KM_PER_SCENE_UNIT,
    -eci.y / KM_PER_SCENE_UNIT,
  );
}

/** Convert kilometres of the same axis-independent quantity into scene units. */
export function unitsFromKm(km: number): number {
  return km / KM_PER_SCENE_UNIT;
}

export function kmFromUnits(units: number): number {
  return units * KM_PER_SCENE_UNIT;
}

/** Inverse of sceneFromEci - used by tests and by camera framing maths. */
export function eciFromScene(v: { x: number; y: number; z: number }): EciVec {
  return {
    x: v.x * KM_PER_SCENE_UNIT,
    y: -v.z * KM_PER_SCENE_UNIT,
    z: v.y * KM_PER_SCENE_UNIT,
  };
}

/**
 * Earth mesh rotation about the render frame's +Y axis.
 *
 * A rotation of the Earth by GMST about ECI +Z maps exactly onto a rotation by
 * the same angle about Three.js +Y under sceneFromEci (verified in
 * tests/frames.test.ts), which is why this is a one-liner and not a matrix.
 */
export function earthSpinFromGmst(gmstRad: number): number {
  return gmstRad;
}

/** Vector length in km. */
export function magnitude(v: EciVec): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalise(v: EciVec): EciVec {
  const m = magnitude(v) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

export function dot(a: EciVec, b: EciVec): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

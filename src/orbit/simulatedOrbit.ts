/**
 * SIMULATED ORBIT - the ICARUS 1U spacecraft
 * =============================================================================
 * ICARUS is NOT a real spacecraft and is NOT in orbit. It is a controlled
 * educational simulation: a circular orbit whose altitude and inclination the
 * visitor can change, with every displayed quantity derived from these
 * equations rather than hard-coded.
 *
 *   r = R_earth + h                     orbital radius            [km]
 *   v = sqrt(mu / r)                    circular speed            [km/s]
 *   T = 2*pi*sqrt(r^3 / mu)             orbital period            [s]
 *   n = sqrt(mu / r^3)                  mean motion               [rad/s]
 *
 * mu = 398600.4418 km^3/s^2, R_earth = 6371 km, eccentricity fixed at 0.
 *
 * Raising the altitude therefore ALWAYS increases r and T and decreases v.
 * The same three lines exist in fsw/src/main.c so the C OBC and the browser
 * simulator agree.
 */

import { DEG, EARTH_RADIUS_KM, MU_EARTH_KM3_S2, type EciVec } from './frames.ts';

export interface CircularOrbit {
  altitudeKm: number;
  radiusKm: number;
  velocityKmS: number;
  periodMin: number;
  meanMotionRadS: number;
}

/** Everything the UI needs about a circular orbit at a given altitude. */
export function orbitFromAltitude(altitudeKm: number): CircularOrbit {
  const radiusKm = EARTH_RADIUS_KM + altitudeKm;
  const velocityKmS = Math.sqrt(MU_EARTH_KM3_S2 / radiusKm);
  const periodS = 2 * Math.PI * Math.sqrt((radiusKm * radiusKm * radiusKm) / MU_EARTH_KM3_S2);
  return {
    altitudeKm,
    radiusKm,
    velocityKmS,
    periodMin: periodS / 60,
    meanMotionRadS: Math.sqrt(MU_EARTH_KM3_S2 / (radiusKm * radiusKm * radiusKm)),
  };
}

/**
 * Position on a circular orbit in the ECI frame.
 *
 * The orbit is built in its own plane and then rotated into place:
 *   1. point at true anomaly nu in the orbital plane  (x' = r cos nu, y' = r sin nu)
 *   2. rotate about X by the inclination i            (tilts the plane)
 *   3. rotate about Z by the RAAN                     (swings the ascending node)
 *
 * With i = 0 the orbit lies in the equatorial plane; with i = 90 deg it passes
 * over both poles. This is exactly the "generate a ring, rotate the ring"
 * model the build manual asks for, written out so it can be unit tested.
 */
export function eciFromOrbitAngle(
  radiusKm: number,
  trueAnomalyRad: number,
  inclinationDeg: number,
  raanDeg: number,
): EciVec {
  const i = inclinationDeg * DEG;
  const O = raanDeg * DEG;

  // In-plane position.
  const xp = radiusKm * Math.cos(trueAnomalyRad);
  const yp = radiusKm * Math.sin(trueAnomalyRad);

  // Rotate about X by inclination.
  const xi = xp;
  const yi = yp * Math.cos(i);
  const zi = yp * Math.sin(i);

  // Rotate about Z by RAAN.
  return {
    x: xi * Math.cos(O) - yi * Math.sin(O),
    y: xi * Math.sin(O) + yi * Math.cos(O),
    z: zi,
  };
}

/**
 * Inertial velocity vector for the same circular orbit, km/s.
 * d/dnu of the position above, scaled by the angular rate n.
 */
export function velocityEciFromOrbitAngle(
  radiusKm: number,
  trueAnomalyRad: number,
  inclinationDeg: number,
  raanDeg: number,
  meanMotionRadS: number,
): EciVec {
  const i = inclinationDeg * DEG;
  const O = raanDeg * DEG;
  const s = radiusKm * meanMotionRadS;

  const dxp = -s * Math.sin(trueAnomalyRad);
  const dyp = s * Math.cos(trueAnomalyRad);

  const xi = dxp;
  const yi = dyp * Math.cos(i);
  const zi = dyp * Math.sin(i);

  return {
    x: xi * Math.cos(O) - yi * Math.sin(O),
    y: xi * Math.sin(O) + yi * Math.cos(O),
    z: zi,
  };
}

/** Sample a full orbit as ECI points, for the orbit-path line geometry. */
export function sampleOrbitEci(
  radiusKm: number,
  inclinationDeg: number,
  raanDeg: number,
  segments = 180,
): EciVec[] {
  const pts: EciVec[] = [];
  for (let k = 0; k <= segments; k++) {
    pts.push(eciFromOrbitAngle(radiusKm, (k / segments) * Math.PI * 2, inclinationDeg, raanDeg));
  }
  return pts;
}

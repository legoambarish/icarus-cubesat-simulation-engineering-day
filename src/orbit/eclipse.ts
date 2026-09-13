/**
 * SUN DIRECTION AND ECLIPSE GEOMETRY
 * =============================================================================
 * Eclipse is NOT a toggle. It falls out of the geometry of where the Sun is,
 * where the Earth is and where the spacecraft is, which is what makes the
 * battery/thermal story provable during the demo: the state changes because
 * the spacecraft flew behind the Earth.
 *
 * Model: cylindrical shadow (the standard first-order approximation).
 *
 *   Let s = unit vector Earth -> Sun, and p = satellite position (ECI, km).
 *   Along-sun component      a = p . s
 *   Perpendicular distance   d = |p - a*s|
 *
 *   The satellite is eclipsed when it is on the far side of the Earth from
 *   the Sun (a < 0) AND inside the shadow cylinder (d < R_earth).
 *
 * The penumbra is ignored; over a 90-minute LEO orbit it lasts a few seconds
 * and adds nothing to the demonstration. A soft `illumination` ramp is
 * returned so solar power does not step discontinuously at the terminator.
 */

import { EARTH_RADIUS_KM, magnitude, normalise, dot, DEG, type EciVec } from './frames.ts';

/**
 * Low-precision Sun direction in the ECI frame (unit vector).
 *
 * Standard almanac series, accurate to roughly 0.01 degrees over this century -
 * far more than enough to decide which side of the Earth is lit.
 * Reference: Vallado, "Fundamentals of Astrodynamics and Applications",
 * Algorithm 29 (Sun position, low precision).
 */
export function sunDirectionEci(date: Date): EciVec {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0

  // Mean longitude and mean anomaly of the Sun, degrees.
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;

  // Ecliptic longitude (equation of centre applied to the mean longitude).
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;

  // Obliquity of the ecliptic.
  const eps = (23.439 - 0.0000004 * n) * DEG;

  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  };
}

export interface IlluminationState {
  /** True when the spacecraft is inside the Earth's shadow cylinder. */
  eclipse: boolean;
  /** 0 (full shadow) .. 1 (full sun), with a short ramp at the terminator. */
  illumination: number;
  /** Cosine of the angle between the Sun and the spacecraft position vector. */
  sunAngleCos: number;
}

/**
 * Decide whether a satellite at ECI position `posKm` is in sunlight.
 * `sunDir` must be a unit vector (use sunDirectionEci).
 */
export function illuminationAt(posKm: EciVec, sunDir: EciVec): IlluminationState {
  const r = magnitude(posKm);
  const s = normalise(sunDir);
  const along = dot(posKm, s);
  const sunAngleCos = r > 0 ? along / r : 1;

  if (along >= 0) {
    // Sunward hemisphere: always lit.
    return { eclipse: false, illumination: 1, sunAngleCos };
  }

  // Perpendicular distance from the Earth-Sun axis.
  const px = posKm.x - along * s.x;
  const py = posKm.y - along * s.y;
  const pz = posKm.z - along * s.z;
  const perp = Math.hypot(px, py, pz);

  // Ramp over a 120 km band so the power curve is continuous.
  const RAMP_KM = 120;
  if (perp >= EARTH_RADIUS_KM + RAMP_KM) return { eclipse: false, illumination: 1, sunAngleCos };
  if (perp <= EARTH_RADIUS_KM) return { eclipse: true, illumination: 0, sunAngleCos };

  const t = (perp - EARTH_RADIUS_KM) / RAMP_KM;
  return { eclipse: t < 0.5, illumination: t, sunAngleCos };
}

/**
 * Fraction of a circular orbit spent in eclipse, used for the "next
 * terminator crossing" readout and for sanity-checking the power budget.
 *
 * For a circular orbit and a cylindrical shadow:
 *
 *     f = (1/pi) * acos( sqrt(r^2 - Re^2) / (r * cos(beta)) )
 *
 * beta is the angle between the orbital plane and the Earth-Sun direction.
 * When |sin(beta)| >= Re/r the argument reaches 1, the orbit clears the
 * shadow cylinder entirely and the spacecraft is permanently sunlit.
 */
export function eclipseFraction(radiusKm: number, betaDeg: number): number {
  const cosBeta = Math.cos(betaDeg * DEG);
  if (cosBeta <= 1e-9) return 0;
  const num = Math.sqrt(Math.max(0, radiusKm * radiusKm - EARTH_RADIUS_KM * EARTH_RADIUS_KM));
  const arg = num / (radiusKm * cosBeta);
  if (arg >= 1) return 0; // fully sunlit orbit
  return Math.acos(arg) / Math.PI;
}

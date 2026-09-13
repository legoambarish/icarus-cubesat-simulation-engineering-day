/**
 * Orbital mechanics, coordinate frames and eclipse geometry.
 *
 * These are the numbers the exhibition claims are real, so they are checked
 * against closed-form values rather than against themselves.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import {
  EARTH_RADIUS_KM,
  MU_EARTH_KM3_S2,
  KM_PER_SCENE_UNIT,
  sceneFromEci,
  eciFromScene,
  unitsFromKm,
  earthSpinFromGmst,
  magnitude,
  normalise,
  dot,
} from '../src/orbit/frames.ts';
import {
  orbitFromAltitude,
  eciFromOrbitAngle,
  velocityEciFromOrbitAngle,
  sampleOrbitEci,
} from '../src/orbit/simulatedOrbit.ts';
import { eclipseFraction, illuminationAt, sunDirectionEci } from '../src/orbit/eclipse.ts';
import { periodFromMeanMotion } from '../src/orbit/propagate.ts';

describe('circular orbit equations', () => {
  it('reproduces the 500 km reference orbit', () => {
    const o = orbitFromAltitude(500);
    expect(o.radiusKm).toBeCloseTo(6871, 6);
    // v = sqrt(mu/r)
    expect(o.velocityKmS).toBeCloseTo(Math.sqrt(MU_EARTH_KM3_S2 / 6871), 9);
    expect(o.velocityKmS).toBeCloseTo(7.6166, 3);
    // T = 2*pi*sqrt(r^3/mu), in minutes
    expect(o.periodMin).toBeCloseTo(94.469, 2);
  });

  it('agrees with the ISS in the right ballpark', () => {
    // The ISS is near 420 km; its real period is a shade over 92 minutes.
    const o = orbitFromAltitude(420);
    expect(o.periodMin).toBeGreaterThan(92);
    expect(o.periodMin).toBeLessThan(93.5);
  });

  it('raises radius and period and lowers velocity when altitude increases', () => {
    const low = orbitFromAltitude(400);
    const high = orbitFromAltitude(900);
    expect(high.radiusKm).toBeGreaterThan(low.radiusKm);
    expect(high.periodMin).toBeGreaterThan(low.periodMin);
    expect(high.velocityKmS).toBeLessThan(low.velocityKmS);
  });

  it('is monotonic across the whole commandable altitude range', () => {
    let previous = orbitFromAltitude(200);
    for (let alt = 210; alt <= 2000; alt += 10) {
      const next = orbitFromAltitude(alt);
      expect(next.radiusKm).toBeGreaterThan(previous.radiusKm);
      expect(next.periodMin).toBeGreaterThan(previous.periodMin);
      expect(next.velocityKmS).toBeLessThan(previous.velocityKmS);
      previous = next;
    }
  });

  it('keeps mean motion consistent with the period', () => {
    for (const alt of [300, 500, 800, 1200]) {
      const o = orbitFromAltitude(alt);
      // n = 2*pi / T
      expect(o.meanMotionRadS).toBeCloseTo((2 * Math.PI) / (o.periodMin * 60), 10);
    }
  });

  it('converts mean motion back to a period', () => {
    // 15.5 rev/day is a typical LEO mean motion.
    expect(periodFromMeanMotion(15.5)).toBeCloseTo(1440 / 15.5, 9);
  });
});

describe('orbit ring geometry', () => {
  const r = 6871;

  it('stays on the sphere of the given radius at every anomaly', () => {
    for (const inc of [0, 28.5, 51.6, 90, 120]) {
      for (let k = 0; k < 24; k++) {
        const p = eciFromOrbitAngle(r, (k / 24) * Math.PI * 2, inc, 42);
        expect(magnitude(p)).toBeCloseTo(r, 6);
      }
    }
  });

  it('keeps an equatorial orbit in the equatorial plane', () => {
    for (let k = 0; k < 12; k++) {
      const p = eciFromOrbitAngle(r, (k / 12) * Math.PI * 2, 0, 0);
      expect(Math.abs(p.z)).toBeLessThan(1e-9);
    }
  });

  it('tilts the plane by the inclination', () => {
    // At 90 deg the orbit passes over the poles, so |z| must reach r.
    let maxZ = 0;
    for (let k = 0; k < 360; k++) {
      const p = eciFromOrbitAngle(r, (k / 360) * Math.PI * 2, 90, 0);
      maxZ = Math.max(maxZ, Math.abs(p.z));
    }
    expect(maxZ).toBeCloseTo(r, 3);
  });

  it('raises the maximum latitude monotonically with inclination', () => {
    const maxLat = (inc: number) => {
      let best = 0;
      for (let k = 0; k < 180; k++) {
        const p = eciFromOrbitAngle(r, (k / 180) * Math.PI * 2, inc, 17);
        best = Math.max(best, Math.abs(Math.asin(p.z / r)) * (180 / Math.PI));
      }
      return best;
    };
    expect(maxLat(30)).toBeCloseTo(30, 1);
    expect(maxLat(51.6)).toBeCloseTo(51.6, 1);
    expect(maxLat(80)).toBeGreaterThan(maxLat(51.6));
  });

  it('produces a velocity perpendicular to the position, of the right magnitude', () => {
    const o = orbitFromAltitude(500);
    for (let k = 0; k < 8; k++) {
      const nu = (k / 8) * Math.PI * 2;
      const p = eciFromOrbitAngle(o.radiusKm, nu, 51.6, 42);
      const v = velocityEciFromOrbitAngle(o.radiusKm, nu, 51.6, 42, o.meanMotionRadS);
      // Circular orbit: r . v = 0 and |v| = sqrt(mu/r).
      expect(Math.abs(dot(normalise(p), normalise(v)))).toBeLessThan(1e-9);
      expect(magnitude(v)).toBeCloseTo(o.velocityKmS, 6);
    }
  });

  it('samples a closed ring', () => {
    const pts = sampleOrbitEci(r, 51.6, 42, 64);
    expect(pts).toHaveLength(65);
    expect(pts[0]!.x).toBeCloseTo(pts[64]!.x, 6);
    expect(pts[0]!.y).toBeCloseTo(pts[64]!.y, 6);
    expect(pts[0]!.z).toBeCloseTo(pts[64]!.z, 6);
  });
});

describe('coordinate frames', () => {
  it('scales kilometres into scene units', () => {
    expect(unitsFromKm(KM_PER_SCENE_UNIT)).toBe(1);
    expect(unitsFromKm(EARTH_RADIUS_KM)).toBeCloseTo(6.371, 9);
  });

  it('maps ECI north to Three.js up', () => {
    const north = sceneFromEci({ x: 0, y: 0, z: 1000 });
    expect(north.x).toBeCloseTo(0, 12);
    expect(north.y).toBeCloseTo(1, 12);
    expect(north.z).toBeCloseTo(0, 12);
  });

  it('round-trips', () => {
    const eci = { x: 1234.5, y: -678.9, z: 4321.0 };
    const back = eciFromScene(sceneFromEci(eci));
    expect(back.x).toBeCloseTo(eci.x, 9);
    expect(back.y).toBeCloseTo(eci.y, 9);
    expect(back.z).toBeCloseTo(eci.z, 9);
  });

  it('is a rotation, not a reflection - it preserves handedness and length', () => {
    const a = sceneFromEci({ x: 1000, y: 0, z: 0 });
    const b = sceneFromEci({ x: 0, y: 1000, z: 0 });
    const c = sceneFromEci({ x: 0, y: 0, z: 1000 });
    // A right-handed ECI basis must stay right-handed: x cross y = z.
    const cross = new Vector3().copy(a).cross(b);
    expect(cross.x).toBeCloseTo(c.x, 9);
    expect(cross.y).toBeCloseTo(c.y, 9);
    expect(cross.z).toBeCloseTo(c.z, 9);

    const v = { x: 300, y: -400, z: 1200 };
    expect(sceneFromEci(v).length()).toBeCloseTo(magnitude(v) / KM_PER_SCENE_UNIT, 9);
  });

  it('turns a spin about ECI +Z into the same spin about render +Y', () => {
    // This is the identity the Earth mesh relies on: earth.rotation.y = gmst.
    const gmst = 0.7;
    const before = { x: 1000, y: 0, z: 0 };
    const rotatedEci = {
      x: before.x * Math.cos(gmst) - before.y * Math.sin(gmst),
      y: before.x * Math.sin(gmst) + before.y * Math.cos(gmst),
      z: before.z,
    };
    const viaEci = sceneFromEci(rotatedEci);
    const viaThree = sceneFromEci(before).applyAxisAngle(new Vector3(0, 1, 0), earthSpinFromGmst(gmst));
    expect(viaThree.x).toBeCloseTo(viaEci.x, 9);
    expect(viaThree.y).toBeCloseTo(viaEci.y, 9);
    expect(viaThree.z).toBeCloseTo(viaEci.z, 9);
  });
});

describe('eclipse geometry', () => {
  const sun = { x: 1, y: 0, z: 0 };
  const r = 6871;

  it('is lit on the sunward side', () => {
    const s = illuminationAt({ x: r, y: 0, z: 0 }, sun);
    expect(s.eclipse).toBe(false);
    expect(s.illumination).toBe(1);
  });

  it('is eclipsed directly behind the Earth', () => {
    const s = illuminationAt({ x: -r, y: 0, z: 0 }, sun);
    expect(s.eclipse).toBe(true);
    expect(s.illumination).toBe(0);
  });

  it('is lit when beside the Earth but past the limb', () => {
    // Anti-sunward, but far enough off-axis to miss the shadow cylinder.
    const s = illuminationAt({ x: -3000, y: EARTH_RADIUS_KM + 900, z: 0 }, sun);
    expect(s.eclipse).toBe(false);
  });

  it('never reports eclipse on the sunward hemisphere, at any offset', () => {
    for (let y = -20000; y <= 20000; y += 1000) {
      expect(illuminationAt({ x: 5000, y, z: 0 }, sun).eclipse).toBe(false);
    }
  });

  it('crosses the terminator exactly once per revolution, each way', () => {
    // Walk a full orbit and count transitions; a circular LEO orbit with the
    // Sun in its plane must have exactly one entry and one exit.
    let transitions = 0;
    let previous = illuminationAt(eciFromOrbitAngle(r, 0, 0, 0), sun).eclipse;
    for (let k = 1; k <= 720; k++) {
      const p = eciFromOrbitAngle(r, (k / 720) * Math.PI * 2, 0, 0);
      const now = illuminationAt(p, sun).eclipse;
      if (now !== previous) transitions++;
      previous = now;
    }
    expect(transitions).toBe(2);
  });

  it('matches the closed-form shadow fraction for a Sun-in-plane orbit', () => {
    // f = (1/pi) acos( sqrt(r^2 - Re^2) / r )  at beta = 0.
    const expected =
      Math.acos(Math.sqrt(r * r - EARTH_RADIUS_KM * EARTH_RADIUS_KM) / r) / Math.PI;
    expect(eclipseFraction(r, 0)).toBeCloseTo(expected, 9);
    // A 500 km orbit spends roughly 38 % of its period in shadow.
    expect(eclipseFraction(r, 0)).toBeGreaterThan(0.35);
    expect(eclipseFraction(r, 0)).toBeLessThan(0.4);
  });

  it('reports a fully sunlit orbit at a high beta angle', () => {
    // sin(beta) >= Re/r means the orbit clears the shadow cylinder entirely.
    const betaCritical = Math.asin(EARTH_RADIUS_KM / r) * (180 / Math.PI);
    expect(eclipseFraction(r, betaCritical + 2)).toBe(0);
    expect(eclipseFraction(r, 89)).toBe(0);
  });

  it('shrinks the eclipse as the beta angle grows', () => {
    expect(eclipseFraction(r, 30)).toBeLessThan(eclipseFraction(r, 0));
    expect(eclipseFraction(r, 50)).toBeLessThan(eclipseFraction(r, 30));
  });
});

describe('sun direction', () => {
  it('returns a unit vector', () => {
    for (const iso of ['2026-01-01T00:00:00Z', '2026-03-20T12:00:00Z', '2026-09-13T06:00:00Z']) {
      expect(magnitude(sunDirectionEci(new Date(iso)))).toBeCloseTo(1, 6);
    }
  });

  it('puts the Sun near the equator at the equinoxes and off it at the solstices', () => {
    // Declination = asin(z) for a unit vector in ECI.
    const decl = (iso: string) => Math.asin(sunDirectionEci(new Date(iso)).z) * (180 / Math.PI);
    expect(Math.abs(decl('2026-03-20T12:00:00Z'))).toBeLessThan(1.0);
    expect(decl('2026-06-21T12:00:00Z')).toBeGreaterThan(23.0);
    expect(decl('2026-12-21T12:00:00Z')).toBeLessThan(-23.0);
  });

  it('moves roughly one degree per day along the ecliptic', () => {
    const a = sunDirectionEci(new Date('2026-05-01T00:00:00Z'));
    const b = sunDirectionEci(new Date('2026-05-02T00:00:00Z'));
    const angleDeg = Math.acos(Math.min(1, dot(a, b))) * (180 / Math.PI);
    expect(angleDeg).toBeGreaterThan(0.9);
    expect(angleDeg).toBeLessThan(1.1);
  });
});

/**
 * BROWSER-FSW: attitude, ADCS, power, thermal, eclipse, faults and safe mode.
 *
 * These run the real simulator with a fixed seed and a fixed Sun direction, so
 * every assertion is about deterministic behaviour and not about luck.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import {
  BrowserFsw,
  SIM_STEP_S,
  THERMAL_LIMIT_C,
  THERMAL_RECOVER_C,
  BATTERY_CRITICAL_PCT,
  LOAD_NOMINAL_W,
  LOAD_SAFE_MODE_W,
  mulberry32,
} from '../src/fsw/browserFsw.ts';
import {
  attitudeErrorDeg,
  attitudeErrorVector,
  integrateQuaternion,
  quaternionFromRpyDeg,
  rpyDegFromQuaternion,
  wrap180,
  EULER_ORDER,
} from '../src/adcs/attitude.ts';
import { computeTorque, isSettled, KP, KD, MAX_TORQUE } from '../src/adcs/controller.ts';
import type { EciVec } from '../src/orbit/frames.ts';

/** Sun fixed on +X so eclipse depends only on where the spacecraft is. */
const FIXED_SUN = (): EciVec => ({ x: 1, y: 0, z: 0 });

/** Run the simulator for `seconds` of wall time at the fixed step. */
function run(fsw: BrowserFsw, seconds: number): void {
  const steps = Math.round(seconds / SIM_STEP_S);
  for (let i = 0; i < steps; i++) fsw.advance(SIM_STEP_S);
}

/** Run until `predicate` holds or the budget runs out. Returns seconds taken. */
function runUntil(fsw: BrowserFsw, seconds: number, predicate: () => boolean): number {
  const steps = Math.round(seconds / SIM_STEP_S);
  for (let i = 0; i < steps; i++) {
    fsw.advance(SIM_STEP_S);
    if (predicate()) return i * SIM_STEP_S;
  }
  return Number.POSITIVE_INFINITY;
}

function makeFsw(overrides = {}) {
  return new BrowserFsw({ seed: 12345, sunDirection: FIXED_SUN, timeScale: 60, ...overrides });
}

/* ========================================================================== */

describe('attitude representation', () => {
  it('round-trips roll/pitch/yaw through a quaternion', () => {
    for (const [r, p, y] of [
      [0, 0, 0],
      [20, 0, 0],
      [0, 35, 0],
      [0, 0, -70],
      [15, -25, 40],
      [-88, 12, 175],
    ] as const) {
      const q = quaternionFromRpyDeg(r, p, y);
      const back = rpyDegFromQuaternion(q);
      expect(back.rollDeg).toBeCloseTo(r, 6);
      expect(back.pitchDeg).toBeCloseTo(p, 6);
      expect(back.yawDeg).toBeCloseTo(y, 6);
    }
  });

  it('documents its Euler order', () => {
    expect(EULER_ORDER).toBe('ZYX');
  });

  it('reports zero error against itself and the full angle against a rotation', () => {
    const q = quaternionFromRpyDeg(12, -7, 30);
    expect(attitudeErrorDeg(q, q)).toBeCloseTo(0, 9);
    const rolled = quaternionFromRpyDeg(0, 0, 0);
    expect(attitudeErrorDeg(rolled, quaternionFromRpyDeg(40, 0, 0))).toBeCloseTo(40, 6);
    expect(attitudeErrorDeg(rolled, quaternionFromRpyDeg(0, 0, 90))).toBeCloseTo(90, 6);
  });

  it('always takes the short way round', () => {
    // 350 deg one way is 10 deg the other.
    const a = quaternionFromRpyDeg(0, 0, 0);
    const b = quaternionFromRpyDeg(350, 0, 0);
    expect(attitudeErrorDeg(a, b)).toBeCloseTo(10, 4);
    expect(attitudeErrorVector(a, b).length()).toBeCloseTo((10 * Math.PI) / 180, 4);
  });

  it('points the error vector from current towards target', () => {
    const current = quaternionFromRpyDeg(0, 0, 0);
    const target = quaternionFromRpyDeg(20, 0, 0);
    const e = attitudeErrorVector(current, target);
    // A pure roll error must lie on the body X axis, positive.
    expect(e.x).toBeGreaterThan(0);
    expect(Math.abs(e.y)).toBeLessThan(1e-9);
    expect(Math.abs(e.z)).toBeLessThan(1e-9);
    expect(e.length()).toBeCloseTo((20 * Math.PI) / 180, 9);
  });

  it('integrates a body rate into the expected rotation', () => {
    const q = new Quaternion();
    const omega = new Vector3((10 * Math.PI) / 180, 0, 0); // 10 deg/s about X
    for (let i = 0; i < 100; i++) integrateQuaternion(q, omega, 0.01, q); // 1 second
    expect(rpyDegFromQuaternion(q).rollDeg).toBeCloseTo(10, 1);
  });

  it('wraps angles onto (-180, 180]', () => {
    expect(wrap180(0)).toBe(0);
    expect(wrap180(190)).toBeCloseTo(-170, 9);
    expect(wrap180(-190)).toBeCloseTo(170, 9);
    expect(wrap180(540)).toBeCloseTo(180, 9);
  });
});

describe('ADCS control law', () => {
  it('produces a torque that opposes the error', () => {
    const current = quaternionFromRpyDeg(0, 0, 0);
    const target = quaternionFromRpyDeg(30, 0, 0);
    const c = computeTorque(current, target, new Vector3());
    // tau = Kp * e, so a positive roll error gives a positive roll torque.
    expect(c.torque.x).toBeGreaterThan(0);
    expect(c.torque.x).toBeCloseTo(KP * ((30 * Math.PI) / 180), 6);
  });

  it('damps an existing rate even with no pointing error', () => {
    const q = quaternionFromRpyDeg(0, 0, 0);
    const c = computeTorque(q, q, new Vector3(0.5, 0, 0));
    expect(c.torque.x).toBeCloseTo(-KD * 0.5, 9);
  });

  it('saturates at the actuator limit', () => {
    const current = quaternionFromRpyDeg(0, 0, 0);
    const target = quaternionFromRpyDeg(180, 0, 0);
    const c = computeTorque(current, target, new Vector3(-8, 0, 0));
    expect(c.saturated).toBe(true);
    expect(c.torque.length()).toBeCloseTo(MAX_TORQUE, 9);
    expect(c.demand).toBeGreaterThan(MAX_TORQUE);
  });

  it('calls a small error with a small rate settled', () => {
    expect(isSettled(0.001, new Vector3(0.001, 0, 0))).toBe(true);
    expect(isSettled(0.5, new Vector3())).toBe(false);
    expect(isSettled(0.001, new Vector3(1, 0, 0))).toBe(false);
  });
});

describe('deterministic PRNG', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 200; i++) expect(a()).toBe(b());
  });

  it('stays inside [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('telemetry packet production', () => {
  it('emits a complete, contract-shaped packet from the first snapshot', () => {
    const fsw = makeFsw();
    const { packet } = fsw.snapshot();
    expect(packet.telemetry_schema_version).toBe(2);
    expect(packet.source).toBe('BROWSER-FSW');
    expect(packet.satellite).toBe('ICARUS-1U');
    expect(Object.keys(packet.fault).sort()).toEqual(['active', 'code', 'message']);
    expect(packet.attitude.angular_velocity_deg_s).toHaveLength(3);
    expect(packet.orbit.altitude_km).toBeCloseTo(500, 6);
  });

  it('never emits a non-finite number, over a long run', () => {
    const fsw = makeFsw();
    for (let i = 0; i < 600; i++) {
      fsw.advance(SIM_STEP_S);
      const { packet } = fsw.snapshot();
      const numbers = [
        packet.timestamp,
        ...Object.values(packet.orbit),
        packet.attitude.roll_deg,
        packet.attitude.pitch_deg,
        packet.attitude.yaw_deg,
        packet.attitude.target_error_deg,
        ...packet.attitude.angular_velocity_deg_s,
        ...Object.values(packet.power),
        packet.thermal.temperature_c,
        packet.vibration.g,
      ];
      for (const n of numbers) expect(Number.isFinite(n)).toBe(true);
    }
  });

  it('is deterministic: the same seed gives the same numbers', () => {
    const a = makeFsw();
    const b = makeFsw();
    run(a, 30);
    run(b, 30);
    const pa = a.snapshot().packet;
    const pb = b.snapshot().packet;
    expect(pa.power.battery_pct).toBe(pb.power.battery_pct);
    expect(pa.thermal.temperature_c).toBe(pb.thermal.temperature_c);
    expect(pa.vibration.g).toBe(pb.vibration.g);
  });
});

describe('fixed-step clock', () => {
  it('consumes exactly one step per SIM_STEP_S of wall time', () => {
    const fsw = makeFsw();
    expect(fsw.advance(SIM_STEP_S)).toBe(1);
    expect(fsw.advance(SIM_STEP_S * 3)).toBe(3);
    expect(fsw.advance(SIM_STEP_S / 2)).toBe(0); // accumulates instead
  });

  it('does not fast-forward the mission after a long stall', () => {
    const fsw = makeFsw();
    // A backgrounded tab returning after a minute must not replay a minute.
    const steps = fsw.advance(60);
    expect(steps).toBeLessThanOrEqual(20);
  });

  it('reaches the same state regardless of frame rate', () => {
    const at30 = makeFsw();
    const at144 = makeFsw();
    // 6 seconds of wall time, delivered in different sized deltas.
    for (let i = 0; i < 180; i++) at30.advance(1 / 30);
    for (let i = 0; i < 864; i++) at144.advance(1 / 144);
    const a = at30.snapshot().packet;
    const b = at144.snapshot().packet;
    expect(a.thermal.temperature_c).toBeCloseTo(b.thermal.temperature_c, 6);
    expect(a.power.battery_pct).toBeCloseTo(b.power.battery_pct, 6);
  });
});

describe('eclipse drives power and thermal', () => {
  it('reports eclipse when the orbit carries the spacecraft behind the Earth', () => {
    const fsw = makeFsw();
    let sawSunlit = false;
    let sawEclipse = false;
    // One orbit at timeScale 60 is about 95 seconds of wall time.
    for (let i = 0; i < 1200; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      if (p.environment.eclipse) sawEclipse = true;
      else sawSunlit = true;
    }
    expect(sawSunlit).toBe(true);
    expect(sawEclipse).toBe(true);
  });

  it('drops solar input to zero in eclipse and restores it in sunlight', () => {
    const fsw = makeFsw();
    // Deep eclipse, not the terminator: the illumination ramps over a 120 km
    // band so the power curve is continuous, and the first sample flagged as
    // eclipsed is still half lit by design.
    let minEclipseSolar = Infinity;
    let maxSunlitSolar = -Infinity;
    for (let i = 0; i < 1600; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      if (p.environment.eclipse) minEclipseSolar = Math.min(minEclipseSolar, p.power.solar_w);
      else maxSunlitSolar = Math.max(maxSunlitSolar, p.power.solar_w);
    }
    expect(minEclipseSolar).toBeLessThan(0.01);
    expect(maxSunlitSolar).toBeGreaterThan(4);
  });

  it('reports the continuous illumination fraction that drives solar input', () => {
    const fsw = makeFsw();
    let sawDark = false;
    let sawFull = false;
    let sawRamp = false;
    for (let i = 0; i < 1600; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      const illumination = p.environment.illumination_pct;
      expect(illumination).toBeGreaterThanOrEqual(0);
      expect(illumination).toBeLessThanOrEqual(100);
      if (illumination === 0) sawDark = true;
      if (illumination === 100) sawFull = true;
      if (illumination > 0 && illumination < 100) sawRamp = true;
    }
    expect(sawDark).toBe(true);
    expect(sawFull).toBe(true);
    expect(sawRamp).toBe(true);
  });

  it('reduces solar generation with pointing error using projected area', () => {
    const fsw = makeFsw({ batteryPct: 84 });
    fsw.advance(SIM_STEP_S);
    const nominal = fsw.snapshot().packet.power.solar_w;
    fsw.setTargetAttitude(60, 0, 0);
    fsw.advance(SIM_STEP_S);
    const offPointed = fsw.snapshot().packet;
    expect(offPointed.attitude.target_error_deg).toBeGreaterThan(30);
    expect(offPointed.power.solar_w).toBeLessThan(nominal);
  });

  it('reverses the battery trend across the terminator', () => {
    const fsw = makeFsw();
    let chargingSeen = false;
    let dischargingSeen = false;
    let previous = fsw.snapshot().packet.power.battery_pct;
    for (let i = 0; i < 1600; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      const delta = p.power.battery_pct - previous;
      previous = p.power.battery_pct;
      if (p.power.battery_pct > 0.5 && p.power.battery_pct < 99.5) {
        if (p.environment.eclipse && delta < 0) dischargingSeen = true;
        if (!p.environment.eclipse && delta > 0) chargingSeen = true;
      }
    }
    expect(chargingSeen).toBe(true);
    expect(dischargingSeen).toBe(true);
  });

  it('keeps the battery inside 0..100 under a long run', () => {
    const fsw = makeFsw();
    for (let i = 0; i < 4000; i++) {
      fsw.advance(SIM_STEP_S);
      const b = fsw.snapshot().packet.power.battery_pct;
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(100);
    }
  });

  it('keeps the temperature bounded and moving with the illumination', () => {
    const fsw = makeFsw();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2400; i++) {
      fsw.advance(SIM_STEP_S);
      const t = fsw.snapshot().packet.thermal.temperature_c;
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    expect(min).toBeGreaterThan(-90);
    expect(max).toBeLessThan(60);
    // It must actually move: a constant temperature would be a broken model.
    expect(max - min).toBeGreaterThan(3);
  });

  it('keeps vibration bounded and non-negative', () => {
    const fsw = makeFsw();
    for (let i = 0; i < 2000; i++) {
      fsw.advance(SIM_STEP_S);
      const g = fsw.snapshot().packet.vibration.g;
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThan(0.5);
    }
  });
});

describe('attitude disturbance and ADCS recovery', () => {
  it('shows bounded nominal attitude motion from environmental torques', () => {
    const fsw = makeFsw();
    const samples: number[] = [];
    for (let i = 0; i < 600; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      samples.push(
        Math.abs(p.attitude.roll_deg)
        + Math.abs(p.attitude.pitch_deg)
        + Math.abs(p.attitude.yaw_deg),
      );
    }

    expect(Math.max(...samples)).toBeGreaterThan(0.2);
    expect(Math.max(...samples)).toBeLessThan(12);
    expect(fsw.snapshot().packet.attitude.target_error_deg).toBeLessThan(6);
  });

  it('walks the documented state sequence and drives the error back down', () => {
    const fsw = makeFsw();
    run(fsw, 2);
    fsw.injectAttitudeDisturbance();

    const states: string[] = [];
    let peakError = 0;
    for (let i = 0; i < 900; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      states.push(p.state);
      peakError = Math.max(peakError, p.attitude.target_error_deg);
      if (states.length > 60 && p.state === 'NOMINAL' && peakError > 8) break;
    }

    const seen = new Set(states);
    expect(peakError).toBeGreaterThan(8);
    expect(seen.has('DISTURBANCE')).toBe(true);
    expect(seen.has('ADCS_ACTIVE')).toBe(true);
    expect(seen.has('ERROR_DECREASING')).toBe(true);
    expect(states[states.length - 1]).toBe('NOMINAL');
    expect(fsw.snapshot().packet.attitude.target_error_deg).toBeLessThan(2);
  });

  it('leaves the orbit untouched while the attitude changes', () => {
    const fsw = makeFsw();
    const before = fsw.snapshot();
    fsw.injectAttitudeDisturbance();
    run(fsw, 20);
    const after = fsw.snapshot();
    expect(after.radiusKm).toBeCloseTo(before.radiusKm, 9);
    expect(after.inclinationDeg).toBeCloseTo(before.inclinationDeg, 9);
    expect(after.packet.orbit.altitude_km).toBeCloseTo(before.packet.orbit.altitude_km, 9);
    expect(after.packet.orbit.velocity_km_s).toBeCloseTo(before.packet.orbit.velocity_km_s, 9);
  });

  it('flies to a commanded attitude rather than snapping to it', () => {
    const fsw = makeFsw();
    fsw.setTargetAttitude(35, 0, 0);
    fsw.advance(SIM_STEP_S);
    // One step later it must still be short of the target: this is a
    // controller, not an assignment.
    expect(Math.abs(fsw.snapshot().packet.attitude.roll_deg)).toBeLessThan(5);
    const settled = runUntil(fsw, 60, () => fsw.snapshot().packet.attitude.target_error_deg < 1.5);
    expect(settled).toBeLessThan(60);
    expect(fsw.snapshot().packet.attitude.roll_deg).toBeCloseTo(35, 0);
  });

  it('raises the reported pointing error while the spacecraft is off target', () => {
    const fsw = makeFsw();
    fsw.setTargetAttitude(60, 0, 0);
    fsw.advance(SIM_STEP_S);
    expect(fsw.snapshot().packet.attitude.target_error_deg).toBeGreaterThan(30);
  });
});

describe('orbit commands', () => {
  it('changes radius, velocity and period together', () => {
    const fsw = makeFsw();
    const before = fsw.snapshot();
    fsw.setAltitude(600);
    fsw.advance(SIM_STEP_S);
    const after = fsw.snapshot();
    expect(after.radiusKm).toBeGreaterThan(before.radiusKm);
    expect(after.packet.orbit.velocity_km_s).toBeLessThan(before.packet.orbit.velocity_km_s);
    expect(after.packet.orbit.period_min).toBeGreaterThan(before.packet.orbit.period_min);
  });

  it('clamps commanded values to the safe range', () => {
    const fsw = makeFsw();
    fsw.setAltitude(999999);
    expect(fsw.snapshot().packet.orbit.altitude_km).toBeLessThanOrEqual(2000);
    fsw.setAltitude(-5);
    expect(fsw.snapshot().packet.orbit.altitude_km).toBeGreaterThanOrEqual(200);
    fsw.setInclination(400);
    expect(fsw.snapshot().packet.orbit.inclination_deg).toBeLessThanOrEqual(145);
  });

  it('tilts the orbital plane when the inclination changes', () => {
    const fsw = makeFsw({ inclinationDeg: 0 });
    fsw.advance(SIM_STEP_S);
    const flat = fsw.snapshot().positionEciKm;
    fsw.setInclination(80);
    let maxZ = 0;
    for (let i = 0; i < 400; i++) {
      fsw.advance(SIM_STEP_S);
      maxZ = Math.max(maxZ, Math.abs(fsw.snapshot().positionEciKm.z));
    }
    expect(Math.abs(flat.z)).toBeLessThan(1e-6);
    expect(maxZ).toBeGreaterThan(1000);
  });
});

describe('thermal anomaly and safe mode', () => {
  it('breaches the limit, sheds load, then recovers - repeatably', () => {
    const fsw = makeFsw();
    run(fsw, 2);

    for (let cycle = 0; cycle < 3; cycle++) {
      fsw.injectAnomaly('thermal');

      let peakTemp = -Infinity;
      let safeModeLoad: number | null = null;
      let sawSafeMode = false;
      let faultCode: string | null = null;
      let recovered = false;

      for (let i = 0; i < 3000; i++) {
        fsw.advance(SIM_STEP_S);
        const p = fsw.snapshot().packet;
        peakTemp = Math.max(peakTemp, p.thermal.temperature_c);
        if (p.fault.code) faultCode = p.fault.code;
        if (p.state === 'SAFE_MODE') {
          sawSafeMode = true;
          safeModeLoad = p.power.load_w;
        } else if (sawSafeMode && p.state === 'NOMINAL') {
          recovered = true;
          break;
        }
      }

      expect(peakTemp, `cycle ${cycle}`).toBeGreaterThan(THERMAL_LIMIT_C);
      expect(sawSafeMode, `cycle ${cycle}`).toBe(true);
      expect(faultCode, `cycle ${cycle}`).toBe('THERMAL_LIMIT');
      expect(safeModeLoad, `cycle ${cycle}`).toBeCloseTo(LOAD_SAFE_MODE_W, 6);
      expect(safeModeLoad!, `cycle ${cycle}`).toBeLessThan(LOAD_NOMINAL_W);
      expect(recovered, `cycle ${cycle}`).toBe(true);
      expect(fsw.snapshot().packet.thermal.temperature_c).toBeLessThan(THERMAL_RECOVER_C);
    }
  });

  it('raises the fault only once the threshold is actually crossed', () => {
    const fsw = makeFsw();
    fsw.injectAnomaly('thermal');
    // Immediately after injection the bus is still cold: no fault yet.
    fsw.advance(SIM_STEP_S);
    const early = fsw.snapshot().packet;
    expect(early.thermal.temperature_c).toBeLessThan(THERMAL_LIMIT_C);
    expect(early.fault.active).toBe(false);
  });

  it('reaches safe mode from a battery fault, with the right code', () => {
    const fsw = makeFsw();
    fsw.injectAnomaly('battery');
    let sawSafeMode = false;
    let faultCode: string | null = null;
    let minBattery = Infinity;
    for (let i = 0; i < 4000; i++) {
      fsw.advance(SIM_STEP_S);
      const p = fsw.snapshot().packet;
      minBattery = Math.min(minBattery, p.power.battery_pct);
      if (p.fault.code) faultCode = p.fault.code;
      if (p.state === 'SAFE_MODE') {
        sawSafeMode = true;
        break;
      }
    }
    expect(minBattery).toBeLessThanOrEqual(BATTERY_CRITICAL_PCT);
    expect(sawSafeMode).toBe(true);
    expect(faultCode).toBe('BATTERY_CRITICAL');
  });

  it('makes safe mode a real state change, not a label', () => {
    const fsw = makeFsw();
    fsw.injectAnomaly('thermal');
    runUntil(fsw, 400, () => fsw.snapshot().packet.state === 'SAFE_MODE');
    const p = fsw.snapshot().packet;
    expect(p.state).toBe('SAFE_MODE');
    // The load really is shed, which is what changes the battery integration.
    expect(p.power.load_w).toBeLessThan(LOAD_NOMINAL_W);
    expect(p.fault.active).toBe(true);
    expect(p.fault.message).toBeTruthy();
  });

  it('returns to nominal immediately on reset', () => {
    const fsw = makeFsw();
    fsw.injectAnomaly('thermal');
    runUntil(fsw, 400, () => fsw.snapshot().packet.state === 'SAFE_MODE');
    fsw.reset();
    fsw.advance(SIM_STEP_S);
    const p = fsw.snapshot().packet;
    expect(p.state).toBe('NOMINAL');
    expect(p.fault.active).toBe(false);
    expect(p.fault.code).toBeNull();
    expect(p.power.load_w).toBeCloseTo(LOAD_NOMINAL_W, 6);
    expect(p.thermal.temperature_c).toBeLessThan(THERMAL_RECOVER_C);
  });

  it('survives an anomaly injected while already in safe mode', () => {
    const fsw = makeFsw();
    fsw.injectAnomaly('thermal');
    runUntil(fsw, 400, () => fsw.snapshot().packet.state === 'SAFE_MODE');
    fsw.injectAnomaly('battery');
    fsw.injectAnomaly('thermal');
    run(fsw, 5);
    const p = fsw.snapshot().packet;
    expect(Number.isFinite(p.thermal.temperature_c)).toBe(true);
    expect(p.power.battery_pct).toBeGreaterThanOrEqual(0);
  });
});

describe('mission clock', () => {
  it('advances the mission clock faster than real time by exactly timeScale', () => {
    const fsw = makeFsw({ timeScale: 60 });
    const t0 = fsw.missionDate().getTime();
    run(fsw, 10);
    const elapsedMissionMs = fsw.missionDate().getTime() - t0;
    expect(elapsedMissionMs / 1000).toBeCloseTo(10 * 60, 1);
    expect(fsw.elapsedRealS()).toBeCloseTo(10, 6);
    expect(fsw.elapsedMissionS()).toBeCloseTo(600, 4);
  });

  it('reports the configured time scale', () => {
    expect(makeFsw({ timeScale: 30 }).timeScale()).toBe(30);
  });

  it('computes a beta angle inside +-90 degrees', () => {
    const fsw = makeFsw();
    for (let i = 0; i < 200; i++) {
      fsw.advance(SIM_STEP_S);
      const beta = fsw.betaAngleDeg();
      expect(beta).toBeGreaterThanOrEqual(-90.001);
      expect(beta).toBeLessThanOrEqual(90.001);
    }
  });
});

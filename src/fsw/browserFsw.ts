/**
 * BROWSER-FSW - deterministic in-browser flight-software simulator
 * =============================================================================
 * GitHub Pages cannot run a C process or a Python bridge, so the browser needs
 * its own Icarus-compatible simulator. This is NOT a placeholder: it models the
 * same subsystems as fsw/src/*.c with the same constants and produces the same
 * TelemetryPacket, so the rest of the application cannot tell which simulator
 * it is talking to.
 *
 * DETERMINISM
 * -----------
 *  * fixed 10 Hz simulation step, decoupled from render FPS
 *  * bounded catch-up (a backgrounded tab does not "fast-forward" the mission)
 *  * seeded PRNG for every noise source, so two runs of the same scenario
 *    produce the same numbers
 *
 * SUBSYSTEM MODELS (all bounded, no unbounded random walks)
 * --------------------------------------------------------
 *  orbit    circular: r = Re+h, v = sqrt(mu/r), T = 2pi sqrt(r^3/mu)
 *  eclipse  cylindrical Earth-shadow test against the true Sun direction
 *  solar    P = P_max * illumination * cos(pointing_error)
 *  battery  dB/dt = (P_solar - P_load) / E_capacity, clamped 0..100 %
 *  thermal  first order: dT/dt = (T_eq - T)/tau + Q_anomaly/C
 *  vibration baseline + deterministic noise + ADCS/anomaly excitation
 *  attitude quaternion integration + PD reaction-wheel controller
 *  disturbances bounded environmental torques continuously corrected by ADCS
 *  fault    threshold detection -> SAFE MODE -> load shedding -> recovery
 */

import { Quaternion, Vector3 } from 'three';
import {
  TELEMETRY_SCHEMA_VERSION,
  type AnomalyKind,
  type FaultCode,
  type FlightState,
  type TelemetryPacket,
} from '../state/types.ts';
import { orbitFromAltitude, eciFromOrbitAngle } from '../orbit/simulatedOrbit.ts';
import { illuminationAt, sunDirectionEci } from '../orbit/eclipse.ts';
import { normalise, dot, type EciVec } from '../orbit/frames.ts';
import {
  attitudeErrorDeg,
  degPerSec,
  quaternionFromRpyDeg,
  rpyDegFromQuaternion,
} from '../adcs/attitude.ts';
import { environmentalDisturbanceTorque, isSettled, stepAttitude } from '../adcs/controller.ts';

/* ==========================================================================
 * Constants - MIRRORED IN fsw/src/*.h. Change both or neither.
 * ========================================================================== */

export const SIM_STEP_S = 0.1; // 10 Hz simulation
export const TELEMETRY_HZ = 10; // one packet per simulation step

/**
 * TWO CLOCKS, AND WHY
 * -------------------
 * A 500 km orbit takes 94 minutes and a real CubeSat's thermal time constant is
 * tens of minutes. Neither fits in an exhibition. So the SLOW physics - orbit,
 * Sun geometry, battery energy budget, bus temperature - runs on a MISSION
 * CLOCK at `timeScale` times real time. One real minute is one simulated orbit,
 * and the sunlit/eclipse battery sawtooth and the temperature swing are both
 * visible inside it.
 *
 * The FAST physics - the ADCS control loop and the vibration channel - runs in
 * REAL seconds. A controller that settles in 15 mission-seconds would settle in
 * a quarter of a real second: correct, and completely unwatchable.
 *
 * Every value the HUD reports is still the true physical quantity; only the
 * rate at which the simulation is stepped differs, and the status strip says so.
 */

/**
 * Power, integrated on the MISSION clock. Sized so one orbit charges slightly
 * more than it discharges: the battery draws a visible sawtooth that trends
 * gently upward rather than pinning at 100 % or dying on the third orbit.
 *   sunlit  ~57 min at +4.0 W net  => +13.6 kJ  (+38 %)
 *   eclipse ~38 min at -5.4 W net  => -12.3 kJ  (-34 %)
 */
export const SOLAR_PEAK_W = 9.4;
export const LOAD_NOMINAL_W = 5.4;
export const LOAD_SAFE_MODE_W = 1.9;
export const LOAD_ADCS_EXTRA_W = 1.6;
/** Usable battery energy in joules (10 Wh => 36 kJ). */
export const BATTERY_ENERGY_J = 36_000;
/** Parasitic load injected by a battery fault, W. */
export const ANOMALY_LOAD_W = 18;

/**
 * Thermal, integrated on the MISSION clock. First-order relaxation towards an
 * equilibrium that follows the illumination.
 *
 * A FAULT IS MODELLED AS A SHIFT IN THAT EQUILIBRIUM, IN KELVIN - not as a heat
 * flux in watts. That is deliberate and it is the honest way to write it: a 1 kg
 * aluminium bus holds ~1200 J/K and radiates well under a watt per kelvin, so no
 * physically plausible fault power warms it 40 K in a minute. Quoting a made-up
 * wattage would look more rigorous and be less true. What the demonstration
 * needs is the SHAPE of the response - first order, bounded, right sign,
 * plausible time constant.
 */
export const T_EQ_SUNLIT_C = 26;
export const T_EQ_ECLIPSE_C = -8;
export const THERMAL_TAU_MISSION_S = 1200;
export const ANOMALY_EQ_OFFSET_C = 110;
export const ANOMALY_DECAY_MISSION_S = 2600;
/** Load shedding removes the fault's source, so it decays much faster. */
export const ANOMALY_DECAY_SAFE_MISSION_S = 400;

/** Fault thresholds - identical in the C OBC. */
export const THERMAL_LIMIT_C = 58;
export const THERMAL_RECOVER_C = 44;
export const BATTERY_CRITICAL_PCT = 12;
export const BATTERY_RECOVER_PCT = 26;
export const ATTITUDE_LIMIT_DEG = 75;

/** Vibration baseline and excitations, g RMS. */
export const VIB_BASELINE_G = 0.012;
export const VIB_NOISE_G = 0.006;
export const VIB_ADCS_G = 0.05;
export const VIB_ANOMALY_G = 0.09;

/** Minimum dwell in SAFE MODE before automatic recovery is allowed, seconds. */
export const SAFE_MODE_MIN_S = 12;
/** Minimum time reported as ADCS_ACTIVE before advancing to ERROR_DECREASING. */
export const ADCS_ACTIVE_MIN_S = 1.0;

/* ==========================================================================
 * Seeded PRNG - mulberry32. Small, fast, and repeatable across runs.
 * ========================================================================== */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==========================================================================
 * Simulator state
 * ========================================================================== */

export interface BrowserFswOptions {
  seed?: number;
  altitudeKm?: number;
  inclinationDeg?: number;
  /** Starting battery charge, %. */
  batteryPct?: number;
  /** Override the Sun direction (tests). Defaults to the real almanac. */
  sunDirection?: (date: Date) => EciVec;
  /**
   * Multiplies the orbital rate so a 94-minute orbit can be watched inside a
   * 90-second demo. Physics is unchanged - only the clock the orbit angle is
   * advanced against. Displayed period is always the true period.
   */
  timeScale?: number;
}

export interface FswSnapshot {
  packet: TelemetryPacket;
  /** ECI position of the simulated spacecraft, km. */
  positionEciKm: EciVec;
  /** Orbit ring parameters for the renderer. */
  radiusKm: number;
  inclinationDeg: number;
  raanDeg: number;
  trueAnomalyRad: number;
  /** 0..1 reaction-wheel activity, for the model animation. */
  wheelActivity: number;
  /** True while the ADCS control loop is closed. */
  adcsEngaged: boolean;
}

export class BrowserFsw {
  /* ---- orbit ---- */
  private altitudeKm: number;
  private inclinationDeg: number;
  private raanDeg = 42;
  private trueAnomaly = 0;

  /* ---- attitude ---- */
  private q = new Quaternion();
  private qTarget = new Quaternion();
  private omega = new Vector3();
  private adcsEnabled = true;
  private wheelActivity = 0;
  private attitudeErrorPeakDeg = 0;
  private readonly disturbanceTorque = new Vector3();

  /* ---- subsystems ---- */
  private batteryPct: number;
  private solarW = 0;
  private loadW = LOAD_NOMINAL_W;
  private temperatureC = 18;
  private vibrationG = VIB_BASELINE_G;
  /** Fault-induced shift of the thermal equilibrium, kelvin. */
  private anomalyOffsetC = 0;
  private eclipse = false;
  private illumination = 1;

  /* ---- fault / mode ---- */
  private state: FlightState = 'NOMINAL';
  private faultActive = false;
  private faultCode: FaultCode | null = null;
  private faultMessage: string | null = null;
  private safeModeSince = 0;
  private stateSince = 0;
  private batteryDrainBoost = 0;

  /* ---- clocks ---- */
  /** REAL elapsed seconds: state-machine dwells, ADCS and vibration. */
  private simTimeS = 0;
  /** Simulated seconds: orbit, Sun, power and thermal. */
  private missionElapsedS = 0;
  private wallEpochMs: number;
  private accumulatorS = 0;
  private rand: () => number;
  private noisePhase = 0;
  private readonly opts: Required<Omit<BrowserFswOptions, 'sunDirection'>> & {
    sunDirection: (d: Date) => EciVec;
  };

  constructor(options: BrowserFswOptions = {}) {
    this.opts = {
      seed: options.seed ?? 0x1CA2005,
      altitudeKm: options.altitudeKm ?? 500,
      inclinationDeg: options.inclinationDeg ?? 51.6,
      batteryPct: options.batteryPct ?? 84,
      timeScale: options.timeScale ?? 1,
      sunDirection: options.sunDirection ?? sunDirectionEci,
    };
    this.altitudeKm = this.opts.altitudeKm;
    this.inclinationDeg = this.opts.inclinationDeg;
    this.batteryPct = this.opts.batteryPct;
    this.rand = mulberry32(this.opts.seed);
    this.wallEpochMs = Date.now();
  }

  /* ---------------------------------------------------------------- commands */

  setAltitude(km: number): void {
    this.altitudeKm = Math.min(2000, Math.max(200, km));
  }

  setInclination(deg: number): void {
    this.inclinationDeg = Math.min(145, Math.max(0, deg));
  }

  /** Command a new target attitude. The controller flies to it; it does not snap. */
  setTargetAttitude(rollDeg: number, pitchDeg: number, yawDeg: number): void {
    quaternionFromRpyDeg(rollDeg, pitchDeg, yawDeg, this.qTarget);
  }

  /**
   * Inject an attitude disturbance: a bounded angular-rate impulse, exactly as
   * a micrometeoroid strike or a stuck thruster would look to the ADCS.
   * The controller is briefly disabled so the error is allowed to grow before
   * ADCS engages - that is what makes the recovery legible.
   */
  injectAttitudeDisturbance(): void {
    const mag = 8.0 * (Math.PI / 180); // deg/s -> rad/s
    this.omega.set(
      (this.rand() * 2 - 1) * mag,
      (this.rand() * 2 - 1) * mag,
      (this.rand() * 2 - 1) * mag,
    );
    // Guarantee a visible tumble even if all three draws came out small.
    if (this.omega.length() < mag * 0.8) this.omega.setLength(mag);
    this.attitudeErrorPeakDeg = 0;
    this.adcsEnabled = false;
    this.setState('DISTURBANCE');
  }

  /** Inject a thermal or battery anomaly. */
  injectAnomaly(kind: AnomalyKind = 'thermal'): void {
    if (kind === 'thermal') {
      // A stuck heater or a failed radiator: the bus equilibrium shifts up and
      // the thermal model relaxes towards the new, too-hot target.
      this.anomalyOffsetC = ANOMALY_EQ_OFFSET_C;
    } else {
      // A shorted load: an extra parasitic draw that empties the pack.
      this.batteryDrainBoost = ANOMALY_LOAD_W;
    }
    this.setState('ANOMALY');
  }

  /** Clear faults and return to nominal. Repeatable, no restart required. */
  reset(): void {
    this.anomalyOffsetC = 0;
    this.batteryDrainBoost = 0;
    this.faultActive = false;
    this.faultCode = null;
    this.faultMessage = null;
    this.loadW = LOAD_NOMINAL_W;
    this.adcsEnabled = true;
    this.omega.set(0, 0, 0);
    this.qTarget.identity();
    this.q.identity();
    this.attitudeErrorPeakDeg = 0;
    if (this.temperatureC > THERMAL_RECOVER_C) this.temperatureC = 30;
    if (this.batteryPct < BATTERY_RECOVER_PCT) this.batteryPct = 62;
    this.setState('NOMINAL');
  }

  /* ------------------------------------------------------------------- clock */

  /**
   * Advance the simulation by a wall-clock delta.
   *
   * The delta is accumulated and consumed in fixed SIM_STEP_S chunks so the
   * physics is identical whether the browser is running at 30 or 144 FPS.
   * Catch-up is capped at 20 steps (2 s) so returning to a backgrounded tab
   * does not replay ten minutes of mission in one frame.
   */
  advance(deltaSeconds: number): number {
    this.accumulatorS += Math.max(0, Math.min(deltaSeconds, 2));
    let steps = 0;
    while (this.accumulatorS >= SIM_STEP_S && steps < 20) {
      this.step(SIM_STEP_S);
      this.accumulatorS -= SIM_STEP_S;
      steps++;
    }
    if (steps === 20) this.accumulatorS = 0; // drop the backlog
    return steps;
  }

  /* --------------------------------------------------------------- main step */

  private step(dt: number): void {
    // dt is REAL seconds; dtMission is simulated seconds. See the two-clocks
    // note at the top of this file.
    const dtMission = dt * this.opts.timeScale;
    this.simTimeS += dt;
    this.missionElapsedS += dtMission;
    const orbit = orbitFromAltitude(this.altitudeKm);

    /* ---- 1. orbital position --------------------------------------------
     * True anomaly advances at the mean motion n = sqrt(mu/r^3). Every
     * displayed orbital quantity is the true physical value.               */
    this.trueAnomaly = (this.trueAnomaly + orbit.meanMotionRadS * dtMission) % (Math.PI * 2);
    const posEci = eciFromOrbitAngle(
      orbit.radiusKm,
      this.trueAnomaly,
      this.inclinationDeg,
      this.raanDeg,
    );

    /* ---- 2. environment: is the spacecraft in the Earth's shadow? -------- */
    const sunDir = this.opts.sunDirection(this.missionDate());
    const illum = illuminationAt(posEci, sunDir);
    this.eclipse = illum.eclipse;
    this.illumination = illum.illumination;

    /* ---- 3. attitude + ADCS --------------------------------------------- */
    const errDeg = attitudeErrorDeg(this.q, this.qTarget);
    const errRad = errDeg * (Math.PI / 180);
    if (errDeg > this.attitudeErrorPeakDeg) this.attitudeErrorPeakDeg = errDeg;

    // The controller is commanded on shortly after a disturbance is detected,
    // which produces the visible DISTURBANCE -> ADCS_ACTIVE transition.
    if (!this.adcsEnabled && this.state === 'DISTURBANCE' && this.simTimeS - this.stateSince > 1.4) {
      this.adcsEnabled = true;
      this.setState('ADCS_ACTIVE');
    }

    environmentalDisturbanceTorque(this.simTimeS, this.trueAnomaly, this.disturbanceTorque);
    const adcs = stepAttitude(
      this.q,
      this.qTarget,
      this.omega,
      dt,
      this.adcsEnabled,
      this.disturbanceTorque,
    );
    this.wheelActivity = this.wheelActivity * 0.85 + adcs.wheelActivity * 0.15;

    /* ---- 4. power -------------------------------------------------------
     * Solar generation couples to both eclipse geometry and attitude. A panel
     * produces its peak at normal incidence and follows the projected-area
     * cosine law as the spacecraft points away from the Sun.                    */
    const pointingEfficiency = Math.max(0, Math.cos(Math.min(errRad, Math.PI / 2)));
    this.solarW = SOLAR_PEAK_W * this.illumination * pointingEfficiency;

    const safeMode = this.state === 'SAFE_MODE';
    const adcsBusy = this.adcsEnabled && adcs.torqueMagnitude > 0.02;
    this.loadW = safeMode
      ? LOAD_SAFE_MODE_W
      : LOAD_NOMINAL_W
        + (adcsBusy ? LOAD_ADCS_EXTRA_W * this.wheelActivity : 0)
        + this.batteryDrainBoost;

    // dB/dt = (P_gen - P_load) / E_capacity, as a percentage.
    const netW = this.solarW - this.loadW;
    this.batteryPct = clamp(
      this.batteryPct + ((netW * dtMission) / BATTERY_ENERGY_J) * 100,
      0,
      100,
    );

    /* ---- 5. thermal -----------------------------------------------------
     * First-order lumped mass relaxing towards an equilibrium that follows the
     * illumination, shifted by any active fault.                            */
    const tEq = T_EQ_ECLIPSE_C + (T_EQ_SUNLIT_C - T_EQ_ECLIPSE_C) * this.illumination;
    const thermalTarget = tEq + this.anomalyOffsetC;
    this.temperatureC = clamp(
      this.temperatureC + ((thermalTarget - this.temperatureC) / THERMAL_TAU_MISSION_S) * dtMission,
      -90,
      160,
    );

    // The fault offset decays; load shedding removes its source, so SAFE MODE
    // clears it much faster. That is the causal chain the exhibit shows.
    if (this.anomalyOffsetC > 0) {
      const tau = safeMode ? ANOMALY_DECAY_SAFE_MISSION_S : ANOMALY_DECAY_MISSION_S;
      this.anomalyOffsetC = Math.max(0, this.anomalyOffsetC - (this.anomalyOffsetC / tau) * dtMission);
      if (this.anomalyOffsetC < 0.2) this.anomalyOffsetC = 0;
    }
    if (this.batteryDrainBoost > 0 && safeMode) {
      this.batteryDrainBoost = Math.max(
        0,
        this.batteryDrainBoost - (this.batteryDrainBoost / 200) * dtMission,
      );
      if (this.batteryDrainBoost < 0.2) this.batteryDrainBoost = 0;
    }

    /* ---- 6. vibration ---------------------------------------------------
     * Deterministic band-limited noise around a baseline, excited by wheel
     * activity and by the anomaly. No unbounded random walk.               */
    this.noisePhase += dt;
    const structural =
      0.45 * Math.sin(this.noisePhase * 2.1) + 0.3 * Math.sin(this.noisePhase * 5.7 + 1.1);
    const jitter = (this.rand() - 0.5) * 2;
    const target =
      VIB_BASELINE_G
      + VIB_NOISE_G * (0.6 * structural + 0.4 * jitter)
      + VIB_ADCS_G * this.wheelActivity
      + (this.anomalyOffsetC > 1 ? VIB_ANOMALY_G * (this.anomalyOffsetC / ANOMALY_EQ_OFFSET_C) : 0);
    // Low-pass so the readout is legible rather than flickering.
    this.vibrationG = Math.max(0, this.vibrationG + (target - this.vibrationG) * Math.min(1, dt * 4));

    /* ---- 7. fault logic + safe mode ------------------------------------- */
    this.updateFaults(errDeg);

    /* ---- 8. ADCS state machine ------------------------------------------ */
    this.updateAdcsState(
      attitudeErrorDeg(this.q, this.qTarget) * (Math.PI / 180),
      attitudeErrorDeg(this.q, this.qTarget),
    );
  }

  /**
   * Threshold detection and the SAFE MODE response.
   *
   * SAFE MODE is not a visual effect: it changes loadW, which changes the
   * battery integration, which changes the telemetry that the UI renders.
   */
  private updateFaults(errDeg: number): void {
    const overTemp = this.temperatureC > THERMAL_LIMIT_C;
    const lowBattery = this.batteryPct <= BATTERY_CRITICAL_PCT;
    const lostAttitude = errDeg > ATTITUDE_LIMIT_DEG;

    if (!this.faultActive && (overTemp || lowBattery)) {
      this.faultActive = true;
      if (overTemp) {
        this.faultCode = 'THERMAL_LIMIT';
        this.faultMessage = `Bus temperature ${this.temperatureC.toFixed(1)} C exceeded ${THERMAL_LIMIT_C} C limit`;
      } else {
        this.faultCode = 'BATTERY_CRITICAL';
        this.faultMessage = `Battery ${this.batteryPct.toFixed(1)} % below ${BATTERY_CRITICAL_PCT} % floor`;
      }
      this.enterSafeMode();
      return;
    }

    // Attitude loss is reported but does not by itself trigger safe mode -
    // the controller is given a chance to recover first.
    if (!this.faultActive && lostAttitude && this.state !== 'SAFE_MODE') {
      this.faultCode = 'ATTITUDE_ERROR';
      this.faultMessage = `Pointing error ${errDeg.toFixed(1)} deg exceeds ${ATTITUDE_LIMIT_DEG} deg`;
    } else if (!this.faultActive && !lostAttitude && this.faultCode === 'ATTITUDE_ERROR') {
      this.faultCode = null;
      this.faultMessage = null;
    }

    if (this.state === 'SAFE_MODE') {
      const dwell = this.simTimeS - this.safeModeSince;
      const thermalOk = this.temperatureC < THERMAL_RECOVER_C;
      const batteryOk = this.batteryPct > BATTERY_RECOVER_PCT;
      if (dwell > SAFE_MODE_MIN_S && thermalOk && batteryOk) {
        this.faultActive = false;
        this.faultCode = null;
        this.faultMessage = null;
        this.loadW = LOAD_NOMINAL_W;
        this.setState('RECOVERY');
      }
    } else if (this.state === 'RECOVERY' && this.simTimeS - this.stateSince > 4) {
      this.setState('NOMINAL');
    }
  }

  private enterSafeMode(): void {
    this.safeModeSince = this.simTimeS;
    this.loadW = LOAD_SAFE_MODE_W;
    // Safe attitude: return to the reference orientation and hold.
    this.qTarget.identity();
    this.adcsEnabled = true;
    this.setState('SAFE_MODE');
  }

  private updateAdcsState(errRad: number, errDeg: number): void {
    if (this.state === 'SAFE_MODE' || this.state === 'ANOMALY' || this.state === 'RECOVERY') return;

    if (this.state === 'ADCS_ACTIVE') {
      // ERROR_DECREASING means exactly what it says: the error has measurably
      // come down from its peak. Reporting it the instant the loop closes would
      // be a lie, and the minimum dwell keeps ADCS_ACTIVE on screen long enough
      // for a presenter to point at it.
      const settling = errDeg < 0.75 * this.attitudeErrorPeakDeg;
      if (this.simTimeS - this.stateSince > ADCS_ACTIVE_MIN_S && settling) {
        this.setState('ERROR_DECREASING');
      }
    } else if (this.state === 'ERROR_DECREASING' && isSettled(errRad, this.omega)) {
      this.attitudeErrorPeakDeg = 0;
      this.setState('NOMINAL');
    } else if (
      this.state === 'NOMINAL'
      && (errRad > 6 * (Math.PI / 180) || this.omega.length() > 0.05)
    ) {
      // A commanded attitude change also engages the loop - the same machinery
      // the disturbance uses, so a slider drag shows the controller working.
      this.attitudeErrorPeakDeg = errDeg;
      this.setState('ADCS_ACTIVE');
    }
  }

  private setState(s: FlightState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateSince = this.simTimeS;
  }

  /* ------------------------------------------------------------- telemetry */

  /** Current state as a fully formed, contract-compliant telemetry packet. */
  snapshot(): FswSnapshot {
    const orbit = orbitFromAltitude(this.altitudeKm);
    const rpy = rpyDegFromQuaternion(this.q);
    const posEci = eciFromOrbitAngle(
      orbit.radiusKm,
      this.trueAnomaly,
      this.inclinationDeg,
      this.raanDeg,
    );

    const packet: TelemetryPacket = {
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      timestamp: (this.wallEpochMs + this.simTimeS * 1000) / 1000,
      source: 'BROWSER-FSW',
      satellite: 'ICARUS-1U',
      orbit: {
        altitude_km: round(this.altitudeKm, 2),
        velocity_km_s: round(orbit.velocityKmS, 4),
        inclination_deg: round(this.inclinationDeg, 2),
        period_min: round(orbit.periodMin, 3),
      },
      attitude: {
        roll_deg: round(rpy.rollDeg, 2),
        pitch_deg: round(rpy.pitchDeg, 2),
        yaw_deg: round(rpy.yawDeg, 2),
        angular_velocity_deg_s: degPerSec(this.omega).map((v) => round(v, 3)) as [number, number, number],
        target_error_deg: round(attitudeErrorDeg(this.q, this.qTarget), 2),
      },
      power: {
        battery_pct: round(this.batteryPct, 2),
        solar_w: round(this.solarW, 3),
        load_w: round(this.loadW, 3),
      },
      thermal: { temperature_c: round(this.temperatureC, 2) },
      vibration: { g: round(this.vibrationG, 4) },
      environment: {
        eclipse: this.eclipse,
        illumination_pct: round(this.illumination * 100, 1),
      },
      fault: { active: this.faultActive, code: this.faultCode, message: this.faultMessage },
      state: this.state,
    };

    return {
      packet,
      positionEciKm: posEci,
      radiusKm: orbit.radiusKm,
      inclinationDeg: this.inclinationDeg,
      raanDeg: this.raanDeg,
      trueAnomalyRad: this.trueAnomaly,
      wheelActivity: this.wheelActivity,
      adcsEngaged: this.adcsEnabled && this.wheelActivity > 0.02,
    };
  }

  /**
   * The simulated mission date.
   *
   * This is the ONE clock the whole application runs on: the Sun direction,
   * the Earth's rotation (GMST) and the SGP4 propagation of real objects are
   * all evaluated at this instant, so nothing can drift out of sync. It runs
   * `timeScale` times faster than the wall clock, and the status strip shows
   * the rate so nobody mistakes it for real time.
   */
  missionDate(): Date {
    return new Date(this.wallEpochMs + this.missionElapsedS * 1000);
  }

  /** How much faster than real time the mission clock runs. */
  timeScale(): number {
    return this.opts.timeScale;
  }

  /** Sun direction used by the current step - the renderer lights the scene with it. */
  sunDirectionNow(): EciVec {
    return normalise(this.opts.sunDirection(this.missionDate()));
  }

  /** Angle between the orbital plane and the Sun (beta angle), degrees. */
  betaAngleDeg(): number {
    const i = this.inclinationDeg * (Math.PI / 180);
    const O = this.raanDeg * (Math.PI / 180);
    // Orbit normal for the ring built in simulatedOrbit.ts.
    const n = {
      x: Math.sin(i) * Math.sin(O),
      y: -Math.sin(i) * Math.cos(O),
      z: Math.cos(i),
    };
    const s = this.sunDirectionNow();
    return 90 - Math.acos(Math.max(-1, Math.min(1, dot(normalise(n), s)))) * (180 / Math.PI);
  }

  /** REAL seconds since this simulator started. */
  elapsedRealS(): number {
    return this.simTimeS;
  }

  /** SIMULATED seconds since this simulator started. */
  elapsedMissionS(): number {
    return this.missionElapsedS;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

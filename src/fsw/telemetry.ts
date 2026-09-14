/**
 * TELEMETRY VALIDATION + NORMALISATION
 * =============================================================================
 * Every packet that reaches application state passes through here first,
 * whether it came off the WebSocket (LOCAL-FSW) or out of the browser
 * simulator. A packet that fails validation is rejected and counted - it never
 * partially updates the HUD, because a half-applied packet is worse than a
 * stale one.
 *
 * Validation is deliberately structural + range based rather than "does it
 * parse": the C OBC is a separate program that can be edited by someone else,
 * and NaN sneaking into a Three.js transform corrupts the whole scene.
 */

import {
  TELEMETRY_SCHEMA_VERSION,
  FLIGHT_STATES,
  type FaultCode,
  type FlightState,
  type TelemetryPacket,
  type TelemetrySourceId,
} from '../state/types.ts';

export interface ValidationOk {
  ok: true;
  packet: TelemetryPacket;
}
export interface ValidationErr {
  ok: false;
  reason: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

/** Plausible engineering ranges. Outside these the packet is garbage. */
const RANGE = {
  altitude_km: [80, 60_000],
  velocity_km_s: [0, 20],
  inclination_deg: [0, 180],
  period_min: [40, 2000],
  angle_deg: [-720, 720],
  rate_deg_s: [-720, 720],
  error_deg: [0, 360],
  battery_pct: [0, 100],
  solar_w: [0, 200],
  load_w: [0, 200],
  temperature_c: [-200, 300],
  vibration_g: [0, 50],
  illumination_pct: [0, 100],
} as const;

const FAULT_CODES: readonly string[] = ['THERMAL_LIMIT', 'BATTERY_CRITICAL', 'ATTITUDE_ERROR'];
const SOURCES: readonly string[] = ['ICARUS-OBC', 'BROWSER-FSW'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Finite number inside [lo, hi]. Rejects NaN, Infinity, numeric strings. */
function num(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < lo || v > hi) return null;
  return v;
}

/**
 * Validate an arbitrary decoded JSON value and return a fully typed packet.
 *
 * Optional-but-known fields (load_w, period_min, angular rates, target error)
 * are back-filled with derived or neutral values rather than being allowed to
 * change the packet shape - the contract says shape is constant.
 */
export function validateTelemetryPacket(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, reason: 'packet is not a JSON object' };

  const version = typeof raw.telemetry_schema_version === 'number'
    ? raw.telemetry_schema_version
    : TELEMETRY_SCHEMA_VERSION;
  if (version !== TELEMETRY_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported telemetry_schema_version ${String(version)}` };
  }

  const timestamp = num(raw.timestamp, 0, 4e10);
  if (timestamp === null) return { ok: false, reason: 'timestamp missing or out of range' };

  const source = typeof raw.source === 'string' && SOURCES.includes(raw.source) ? (raw.source as TelemetrySourceId) : null;
  if (source === null) return { ok: false, reason: 'source missing or unknown' };

  const satellite = typeof raw.satellite === 'string' && raw.satellite.length > 0 && raw.satellite.length <= 64
    ? raw.satellite
    : null;
  if (satellite === null) return { ok: false, reason: 'satellite id missing' };

  /* ---- orbit ---------------------------------------------------------- */
  if (!isObject(raw.orbit)) return { ok: false, reason: 'orbit block missing' };
  const altitude_km = num(raw.orbit.altitude_km, ...RANGE.altitude_km);
  const velocity_km_s = num(raw.orbit.velocity_km_s, ...RANGE.velocity_km_s);
  const inclination_deg = num(raw.orbit.inclination_deg, ...RANGE.inclination_deg);
  if (altitude_km === null) return { ok: false, reason: 'orbit.altitude_km invalid' };
  if (velocity_km_s === null) return { ok: false, reason: 'orbit.velocity_km_s invalid' };
  if (inclination_deg === null) return { ok: false, reason: 'orbit.inclination_deg invalid' };
  // period is derivable, so a sender that omits it is tolerated.
  const period_min = num(raw.orbit.period_min, ...RANGE.period_min) ?? periodFromAltitude(altitude_km);

  /* ---- attitude ------------------------------------------------------- */
  if (!isObject(raw.attitude)) return { ok: false, reason: 'attitude block missing' };
  const roll_deg = num(raw.attitude.roll_deg, ...RANGE.angle_deg);
  const pitch_deg = num(raw.attitude.pitch_deg, ...RANGE.angle_deg);
  const yaw_deg = num(raw.attitude.yaw_deg, ...RANGE.angle_deg);
  if (roll_deg === null || pitch_deg === null || yaw_deg === null) {
    return { ok: false, reason: 'attitude roll/pitch/yaw invalid' };
  }
  const rates = raw.attitude.angular_velocity_deg_s;
  let angular_velocity_deg_s: [number, number, number] = [0, 0, 0];
  if (Array.isArray(rates) && rates.length === 3) {
    const r0 = num(rates[0], ...RANGE.rate_deg_s);
    const r1 = num(rates[1], ...RANGE.rate_deg_s);
    const r2 = num(rates[2], ...RANGE.rate_deg_s);
    if (r0 === null || r1 === null || r2 === null) {
      return { ok: false, reason: 'attitude.angular_velocity_deg_s invalid' };
    }
    angular_velocity_deg_s = [r0, r1, r2];
  }
  const target_error_deg = num(raw.attitude.target_error_deg, ...RANGE.error_deg) ?? 0;

  /* ---- power ---------------------------------------------------------- */
  if (!isObject(raw.power)) return { ok: false, reason: 'power block missing' };
  const battery_pct = num(raw.power.battery_pct, ...RANGE.battery_pct);
  const solar_w = num(raw.power.solar_w, ...RANGE.solar_w);
  if (battery_pct === null) return { ok: false, reason: 'power.battery_pct invalid' };
  if (solar_w === null) return { ok: false, reason: 'power.solar_w invalid' };
  const load_w = num(raw.power.load_w, ...RANGE.load_w) ?? 0;

  /* ---- thermal / vibration / environment ------------------------------ */
  if (!isObject(raw.thermal)) return { ok: false, reason: 'thermal block missing' };
  const temperature_c = num(raw.thermal.temperature_c, ...RANGE.temperature_c);
  if (temperature_c === null) return { ok: false, reason: 'thermal.temperature_c invalid' };

  if (!isObject(raw.vibration)) return { ok: false, reason: 'vibration block missing' };
  const vibration_g = num(raw.vibration.g, ...RANGE.vibration_g);
  if (vibration_g === null) return { ok: false, reason: 'vibration.g invalid' };

  if (!isObject(raw.environment)) return { ok: false, reason: 'environment block missing' };
  const eclipseRaw = raw.environment.eclipse;
  if (typeof eclipseRaw !== 'boolean' && eclipseRaw !== 0 && eclipseRaw !== 1) {
    return { ok: false, reason: 'environment.eclipse invalid' };
  }
  const eclipse = eclipseRaw === true || eclipseRaw === 1;
  const illumination_pct = num(raw.environment.illumination_pct, ...RANGE.illumination_pct);
  if (illumination_pct === null) {
    return { ok: false, reason: 'environment.illumination_pct invalid' };
  }

  /* ---- fault ---------------------------------------------------------- */
  let fault = { active: false, code: null as FaultCode | null, message: null as string | null };
  if (isObject(raw.fault)) {
    const a = raw.fault.active;
    const active = a === true || a === 1;
    const codeRaw = raw.fault.code;
    const code = typeof codeRaw === 'string' && FAULT_CODES.includes(codeRaw) ? (codeRaw as FaultCode) : null;
    const msgRaw = raw.fault.message;
    const message = typeof msgRaw === 'string' ? msgRaw.slice(0, 160) : null;
    fault = { active, code, message };
  }

  /* ---- state ---------------------------------------------------------- */
  const stateRaw = raw.state;
  if (typeof stateRaw !== 'string' || !FLIGHT_STATES.includes(stateRaw as FlightState)) {
    return { ok: false, reason: `state "${String(stateRaw)}" is not a known flight state` };
  }

  return {
    ok: true,
    packet: {
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      timestamp,
      source,
      satellite,
      orbit: { altitude_km, velocity_km_s, inclination_deg, period_min },
      attitude: { roll_deg, pitch_deg, yaw_deg, angular_velocity_deg_s, target_error_deg },
      power: { battery_pct, solar_w, load_w },
      thermal: { temperature_c },
      vibration: { g: vibration_g },
      environment: { eclipse, illumination_pct },
      fault,
      state: stateRaw as FlightState,
    },
  };
}

/** T = 2*pi*sqrt(r^3/mu) in minutes - used only to back-fill an absent field. */
function periodFromAltitude(altitudeKm: number): number {
  const r = 6371 + altitudeKm;
  return (2 * Math.PI * Math.sqrt((r * r * r) / 398600.4418)) / 60;
}

/**
 * A safe, obviously-idle packet used before the first real sample arrives so
 * the telemetry UI is never blank. state = BOOT makes the situation explicit.
 */
export function bootPacket(now = Date.now() / 1000): TelemetryPacket {
  return {
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    timestamp: now,
    source: 'BROWSER-FSW',
    satellite: 'ICARUS-1U',
    orbit: { altitude_km: 500, velocity_km_s: 7.6126, inclination_deg: 51.6, period_min: 94.62 },
    attitude: {
      roll_deg: 0,
      pitch_deg: 0,
      yaw_deg: 0,
      angular_velocity_deg_s: [0, 0, 0],
      target_error_deg: 0,
    },
    power: { battery_pct: 82, solar_w: 0, load_w: 0 },
    thermal: { temperature_c: 18 },
    vibration: { g: 0.01 },
    environment: { eclipse: false, illumination_pct: 100 },
    fault: { active: false, code: null, message: null },
    state: 'BOOT',
  };
}

/**
 * THE TELEMETRY CONTRACT
 * =============================================================================
 * This file is the single source of truth for the shape of a spacecraft
 * telemetry packet. Three independent implementations produce it:
 *
 *   1. fsw/src/*.c        the C "Icarus" OBC simulator (LOCAL-FSW)
 *   2. src/fsw/browserFsw.ts  the deterministic TypeScript simulator (BROWSER-FSW)
 *   3. bridge/bridge.py   validates + normalises whatever the C OBC emitted
 *
 * ...and three consume it: the 3D twin, the mission-control HUD and OpenMCT.
 *
 * RULES
 * -----
 *  * The packet shape never changes. A value that is unavailable is `null`,
 *    it is never omitted and the surrounding object is never dropped.
 *  * Units are SI-ish engineering units and are part of the field name:
 *    _km, _km_s, _deg, _deg_s, _pct, _w, _c, _min. Time is UNIX seconds (UTC).
 *  * If the shape ever has to change, bump TELEMETRY_SCHEMA_VERSION and teach
 *    validateTelemetryPacket() how to upgrade the old shape.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

/** Where a packet came from. Displayed to the user, never inferred later. */
export type TelemetrySourceId = 'ICARUS-OBC' | 'BROWSER-FSW';

/** Which simulator is currently authoritative for the HUD. */
export type FswMode = 'LOCAL-FSW' | 'BROWSER-FSW';

/**
 * Flight state machine. The ADCS demonstration walks
 *   NOMINAL -> DISTURBANCE -> ADCS_ACTIVE -> ERROR_DECREASING -> NOMINAL
 * and the fault demonstration walks
 *   NOMINAL -> ANOMALY -> SAFE_MODE -> RECOVERY -> NOMINAL
 */
export type FlightState =
  | 'BOOT'
  | 'NOMINAL'
  | 'DISTURBANCE'
  | 'ADCS_ACTIVE'
  | 'ERROR_DECREASING'
  | 'ANOMALY'
  | 'SAFE_MODE'
  | 'RECOVERY';

export const FLIGHT_STATES: readonly FlightState[] = [
  'BOOT',
  'NOMINAL',
  'DISTURBANCE',
  'ADCS_ACTIVE',
  'ERROR_DECREASING',
  'ANOMALY',
  'SAFE_MODE',
  'RECOVERY',
];

/** Fault codes raised by the onboard fault logic (C and TS use the same set). */
export type FaultCode = 'THERMAL_LIMIT' | 'BATTERY_CRITICAL' | 'ATTITUDE_ERROR';

export interface OrbitTelemetry {
  /** Altitude above the Earth reference sphere, km. */
  altitude_km: number;
  /** Inertial speed, km/s. */
  velocity_km_s: number;
  /** Orbital plane inclination, degrees. */
  inclination_deg: number;
  /** Orbital period, minutes. */
  period_min: number;
}

export interface AttitudeTelemetry {
  roll_deg: number;
  pitch_deg: number;
  yaw_deg: number;
  /** Body rates [wx, wy, wz] in deg/s. */
  angular_velocity_deg_s: [number, number, number];
  /** Total angle between the current and commanded attitude, degrees. */
  target_error_deg: number;
}

export interface PowerTelemetry {
  battery_pct: number;
  solar_w: number;
  load_w: number;
}

export interface ThermalTelemetry {
  temperature_c: number;
}

export interface VibrationTelemetry {
  g: number;
}

export interface EnvironmentTelemetry {
  eclipse: boolean;
}

export interface FaultTelemetry {
  active: boolean;
  code: FaultCode | null;
  message: string | null;
}

export interface TelemetryPacket {
  telemetry_schema_version: number;
  /** UNIX seconds, UTC. Fractional. */
  timestamp: number;
  source: TelemetrySourceId;
  satellite: string;
  orbit: OrbitTelemetry;
  attitude: AttitudeTelemetry;
  power: PowerTelemetry;
  thermal: ThermalTelemetry;
  vibration: VibrationTelemetry;
  environment: EnvironmentTelemetry;
  fault: FaultTelemetry;
  state: FlightState;
}

/* ==========================================================================
 * COMMANDS - the uplink half of the contract
 * ========================================================================== */

/**
 * Commands the browser may send. In BROWSER-FSW they are applied locally; in
 * LOCAL-FSW they are sent over the WebSocket to the Python bridge which
 * forwards them by UDP to the C OBC. The browser NEVER fakes a fault while
 * LOCAL-FSW is authoritative - the OBC's own telemetry has to prove it.
 *
 * The same whitelist is enforced in bridge/bridge.py and fsw/src/commands.c.
 */
export type CommandName =
  | 'inject_anomaly'
  | 'inject_attitude_disturbance'
  | 'reset'
  | 'set_altitude'
  | 'set_inclination'
  | 'set_attitude';

export type AnomalyKind = 'thermal' | 'battery';

export interface CommandMessage {
  type: 'command';
  command: CommandName;
  /** Which anomaly to inject (inject_anomaly only). */
  kind?: AnomalyKind;
  /** Numeric argument for set_altitude (km) / set_inclination (deg). */
  value?: number;
  /** Commanded attitude for set_attitude, degrees. */
  roll_deg?: number;
  pitch_deg?: number;
  yaw_deg?: number;
}

export const COMMAND_WHITELIST: readonly CommandName[] = [
  'inject_anomaly',
  'inject_attitude_disturbance',
  'reset',
  'set_altitude',
  'set_inclination',
  'set_attitude',
];

/* ==========================================================================
 * ORBITAL OBJECTS (the real-satellite layer, separate from ICARUS)
 * ========================================================================== */

export type ObjectKind = 'station' | 'cubesat' | 'science' | 'weather' | 'imaging' | 'icarus';

/** Where the orbital elements for the real-object layer came from. */
export type OrbitDataSource = 'LOADING' | 'LIVE' | 'FALLBACK' | 'MIXED';

/** A validated, normalised orbital element set ready for SGP4. */
export interface OrbitalRecord {
  /** Stable id used for selection. `icarus` for the simulated spacecraft. */
  id: string;
  name: string;
  noradId: number;
  kind: ObjectKind;
  /** ISO-8601 epoch of the element set. */
  epoch: string;
  inclinationDeg: number;
  meanMotionRevPerDay: number;
  eccentricity: number;
  /** 'LIVE' when it came from CelesTrak in this session, else 'FALLBACK'. */
  origin: 'LIVE' | 'FALLBACK';
}

/** Instantaneous propagated state of a real object, in km / km per second. */
export interface PropagatedState {
  positionEciKm: { x: number; y: number; z: number };
  velocityEciKmS: { x: number; y: number; z: number };
  altitudeKm: number;
  latitudeDeg: number;
  longitudeDeg: number;
  speedKmS: number;
}

/** What the object-profile panel shows for whichever object is selected. */
export interface ObjectProfile {
  id: string;
  name: string;
  kind: ObjectKind;
  /** "CelesTrak OMM - LIVE", "Fallback element set", "Simulated (ICARUS FSW)". */
  sourceLabel: string;
  origin: 'LIVE' | 'FALLBACK' | 'SIMULATED';
  noradId: number | null;
  altitudeKm: number | null;
  velocityKmS: number | null;
  inclinationDeg: number | null;
  periodMin: number | null;
  epoch: string | null;
}

/**
 * SELECTORS - derived values for the HUD
 * =============================================================================
 * The store holds raw state; this file turns it into exactly what the panels
 * render. Keeping the derivation here means a displayed number is either
 * straight out of the telemetry packet or is computed in one auditable place -
 * never invented inside a DOM update function.
 */

import { ICARUS_ID, type AppState } from './store.ts';
import type { FlightState, ObjectKind, ObjectProfile, TelemetryPacket } from './types.ts';
import { catalogEntry } from '../orbit/celestrak.ts';
import { altitudeOf, periodFromMeanMotion, type TrackedObject } from '../orbit/propagate.ts';

/** One row of the object list. */
export interface ObjectRow {
  id: string;
  name: string;
  kind: ObjectKind;
  altitudeKm: number;
  selected: boolean;
}

/** Everything the HUD needs for one frame that is not already in AppState. */
export interface HudViewModel {
  profile: ObjectProfile;
  rows: ObjectRow[];
  /** Sun-angle of the ICARUS orbital plane, degrees. */
  betaDeg: number;
  /** Seconds until the next sunlit/eclipse transition, or null if unknown. */
  nextTerminatorS: number | null;
  /** Fraction of the ICARUS orbit spent in eclipse, 0..1. */
  eclipseFraction: number;
  /** Mission-clock rate relative to real time. */
  timeScale: number;
}

/* ==========================================================================
 * Object profile
 * ========================================================================== */

export function icarusProfile(packet: TelemetryPacket): ObjectProfile {
  return {
    id: ICARUS_ID,
    name: 'ICARUS-1U',
    kind: 'icarus',
    sourceLabel:
      packet.source === 'ICARUS-OBC'
        ? 'Simulated spacecraft - Icarus C OBC'
        : 'Simulated spacecraft - Browser FSW',
    origin: 'SIMULATED',
    noradId: null,
    altitudeKm: packet.orbit.altitude_km,
    velocityKmS: packet.orbit.velocity_km_s,
    inclinationDeg: packet.orbit.inclination_deg,
    periodMin: packet.orbit.period_min,
    epoch: null,
  };
}

export function realObjectProfile(obj: TrackedObject): ObjectProfile {
  return {
    id: obj.record.id,
    name: obj.record.name,
    kind: obj.record.kind,
    sourceLabel:
      obj.record.origin === 'LIVE'
        ? 'CelesTrak OMM - propagated with SGP4'
        : 'Bundled element set - propagated with SGP4',
    origin: obj.record.origin,
    noradId: obj.record.noradId,
    altitudeKm: obj.state?.altitudeKm ?? altitudeOf(obj),
    velocityKmS: obj.state?.speedKmS ?? null,
    inclinationDeg: obj.record.inclinationDeg,
    periodMin: periodFromMeanMotion(obj.record.meanMotionRevPerDay),
    epoch: obj.record.epoch,
  };
}

/** One-line description of the selected object, for the profile footer. */
export function profileBlurb(profile: ObjectProfile): string {
  if (profile.id === ICARUS_ID) {
    return 'Educational 1U CubeSat simulation. ICARUS is not a real spacecraft and is not in orbit - its state comes from the flight-software simulator.';
  }
  return catalogEntry(profile.id)?.blurb ?? 'Public orbital element set propagated locally with SGP4.';
}

/* ==========================================================================
 * Object list
 * ========================================================================== */

export function objectRows(state: AppState, tracked: readonly TrackedObject[]): ObjectRow[] {
  const rows: ObjectRow[] = [
    {
      id: ICARUS_ID,
      name: 'ICARUS-1U (SIM)',
      kind: 'icarus',
      altitudeKm: state.telemetry.orbit.altitude_km,
      selected: state.selectedId === ICARUS_ID,
    },
  ];
  for (const obj of tracked) {
    rows.push({
      id: obj.record.id,
      name: obj.record.name,
      kind: obj.record.kind,
      altitudeKm: obj.state?.altitudeKm ?? altitudeOf(obj),
      selected: state.selectedId === obj.record.id,
    });
  }
  return rows;
}

/* ==========================================================================
 * Presentation helpers
 * ========================================================================== */

export type Severity = 'nominal' | 'busy' | 'warn' | 'crit';

export function flightStateSeverity(state: FlightState): Severity {
  switch (state) {
    case 'NOMINAL':
      return 'nominal';
    case 'BOOT':
    case 'ADCS_ACTIVE':
    case 'ERROR_DECREASING':
    case 'RECOVERY':
      return 'busy';
    case 'DISTURBANCE':
      return 'warn';
    case 'ANOMALY':
    case 'SAFE_MODE':
      return 'crit';
  }
}

export function batterySeverity(pct: number): Severity {
  if (pct <= 15) return 'crit';
  if (pct <= 35) return 'warn';
  return 'nominal';
}

export function temperatureSeverity(c: number): Severity {
  if (c > 55 || c < -30) return 'crit';
  if (c > 44 || c < -20) return 'warn';
  return 'nominal';
}

export function vibrationSeverity(g: number): Severity {
  if (g > 0.11) return 'crit';
  if (g > 0.055) return 'warn';
  return 'nominal';
}

export function attitudeErrorSeverity(deg: number): Severity {
  if (deg > 40) return 'crit';
  if (deg > 8) return 'warn';
  return 'nominal';
}

/** Human-readable flight state, e.g. ERROR_DECREASING -> "ERROR DECREASING". */
export function flightStateLabel(state: FlightState): string {
  return state.replace(/_/g, ' ');
}

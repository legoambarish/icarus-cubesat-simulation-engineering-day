/**
 * APPLICATION STORE
 * =============================================================================
 * A deliberately tiny observable store. Everything the HUD renders lives here,
 * and it is only ever written through the `update*` helpers below, so there is
 * exactly one place to look when a displayed number is wrong.
 *
 * The store does not compute physics. It holds the most recent *validated*
 * telemetry packet plus UI-level state (selection, link status, data source).
 */

import { bootPacket } from '../fsw/telemetry.ts';
import type {
  FswMode,
  ObjectKind,
  OrbitDataSource,
  OrbitalRecord,
  TelemetryPacket,
} from './types.ts';

export type LinkStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'DISABLED';

export interface AlertEntry {
  id: number;
  severity: 'info' | 'warn' | 'critical';
  code: string;
  message: string;
  /** UNIX seconds. */
  at: number;
}

export interface SimControls {
  altitudeKm: number;
  inclinationDeg: number;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

export interface AppState {
  /** Latest validated telemetry, whatever produced it. Never null. */
  telemetry: TelemetryPacket;
  /** Which simulator the HUD is currently showing. */
  fswMode: FswMode;
  /** State of the optional local WebSocket bridge. */
  linkStatus: LinkStatus;
  /** Seconds since the last accepted LOCAL-FSW packet, or null if never. */
  lastLocalPacketAgeS: number | null;

  /** Provenance of the real-satellite element sets. */
  orbitDataSource: OrbitDataSource;
  orbitDataDetail: string;
  /** Real objects propagated with SGP4 (does not include ICARUS). */
  records: OrbitalRecord[];

  /** Currently selected object id; 'icarus' for the simulated spacecraft. */
  selectedId: string;
  hoveredId: string | null;

  /** Commanded orbit + attitude, mirrored from the authoritative simulator. */
  controls: SimControls;

  /** Most recent alerts, newest first, capped. */
  alerts: AlertEntry[];

  /** Mission clock (UTC). Driven by the render loop, not by wall-clock reads. */
  missionTimeMs: number;
  /** Seconds since the twin started. */
  elapsedS: number;

  audioEnabled: boolean;
  /** Render statistics, refreshed about once a second. */
  fps: number;
  drawCalls: number;
}

export const ICARUS_ID = 'icarus';

export const DEFAULT_CONTROLS: SimControls = {
  altitudeKm: 500,
  inclinationDeg: 51.6,
  rollDeg: 0,
  pitchDeg: 0,
  yawDeg: 0,
};

type Listener = (state: AppState) => void;

let alertSeq = 1;

const state: AppState = {
  telemetry: bootPacket(),
  fswMode: 'BROWSER-FSW',
  linkStatus: 'CONNECTING',
  lastLocalPacketAgeS: null,
  orbitDataSource: 'LOADING',
  orbitDataDetail: 'Requesting current element sets',
  records: [],
  selectedId: ICARUS_ID,
  hoveredId: null,
  controls: { ...DEFAULT_CONTROLS },
  alerts: [],
  missionTimeMs: Date.now(),
  elapsedS: 0,
  audioEnabled: false,
  fps: 0,
  drawCalls: 0,
};

const listeners = new Set<Listener>();

/** Read-only view of the current state. Do not mutate the returned object. */
export function getState(): Readonly<AppState> {
  return state;
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 * The callback fires once immediately with the current state.
 */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

let notifyScheduled = false;
/**
 * Notify listeners. Coalesced to one call per animation frame so a 10 Hz
 * telemetry stream plus slider drags cannot thrash the DOM.
 */
function notify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  const flush = () => {
    notifyScheduled = false;
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('[store] listener threw', err);
      }
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/** Force listeners to run now (used by the render loop for the clock strip). */
export function flushNow(): void {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('[store] listener threw', err);
    }
  }
}

/* ==========================================================================
 * Writers
 * ========================================================================== */

export function setTelemetry(packet: TelemetryPacket): void {
  state.telemetry = packet;
  notify();
}

export function setFswMode(mode: FswMode): void {
  if (state.fswMode === mode) return;
  state.fswMode = mode;
  notify();
}

export function setLinkStatus(status: LinkStatus, lastPacketAgeS: number | null = null): void {
  if (state.linkStatus === status && state.lastLocalPacketAgeS === lastPacketAgeS) return;
  state.linkStatus = status;
  state.lastLocalPacketAgeS = lastPacketAgeS;
  notify();
}

export function setOrbitData(
  records: OrbitalRecord[],
  source: OrbitDataSource,
  detail: string,
): void {
  state.records = records;
  state.orbitDataSource = source;
  state.orbitDataDetail = detail;
  notify();
}

export function setSelected(id: string): void {
  if (state.selectedId === id) return;
  state.selectedId = id;
  notify();
}

export function setHovered(id: string | null): void {
  if (state.hoveredId === id) return;
  state.hoveredId = id;
  notify();
}

export function setControls(patch: Partial<SimControls>): void {
  Object.assign(state.controls, patch);
  notify();
}

export function setAudioEnabled(on: boolean): void {
  state.audioEnabled = on;
  notify();
}

export function setClock(missionTimeMs: number, elapsedS: number): void {
  state.missionTimeMs = missionTimeMs;
  state.elapsedS = elapsedS;
  // Deliberately no notify(): the clock strip is redrawn by the render loop.
}

export function setRenderStats(fps: number, drawCalls: number): void {
  state.fps = fps;
  state.drawCalls = drawCalls;
}

export function pushAlert(
  severity: AlertEntry['severity'],
  code: string,
  message: string,
  at = Date.now() / 1000,
): AlertEntry {
  const entry: AlertEntry = { id: alertSeq++, severity, code, message, at };
  state.alerts = [entry, ...state.alerts].slice(0, 12);
  notify();
  return entry;
}

export function objectKindOf(id: string, records: OrbitalRecord[]): ObjectKind {
  if (id === ICARUS_ID) return 'icarus';
  return records.find((r) => r.id === id)?.kind ?? 'science';
}

/**
 * COMMAND ROUTING - one call site, two very different destinations
 * =============================================================================
 * This is the piece the build manual leaves underspecified, and getting it
 * right is what makes the LOCAL-FSW demonstration honest:
 *
 *   BROWSER-FSW active
 *       command -> BrowserFsw method -> next packet reflects it
 *
 *   LOCAL-FSW active
 *       command -> WebSocket -> Python bridge -> UDP :5006 -> C OBC
 *       and then we WAIT. The browser does NOT apply the fault locally. The
 *       C OBC's own telemetry is the proof that the command arrived.
 *
 * If the uplink fails while LOCAL-FSW is authoritative, the user is told the
 * command was not delivered rather than being shown a fake response.
 */

import { COMMAND_WHITELIST, type AnomalyKind, type CommandMessage, type CommandName } from '../state/types.ts';
import type { BrowserFsw } from './browserFsw.ts';
import type { LocalFswLink } from './websocket.ts';

export type CommandOutcome =
  | { ok: true; route: 'BROWSER-FSW' }
  | { ok: true; route: 'LOCAL-FSW' }
  | { ok: false; reason: string };

export interface CommandRouterDeps {
  browserFsw: BrowserFsw;
  /** Resolved lazily: the link is constructed after the router in main.ts. */
  getLink: () => LocalFswLink | null;
  /** Whether LOCAL-FSW currently owns the telemetry stream. */
  isLocalAuthoritative: () => boolean;
}

/** Reject anything not on the shared whitelist before it can leave the tab. */
export function isAllowedCommand(name: string): name is CommandName {
  return (COMMAND_WHITELIST as readonly string[]).includes(name);
}

/** Range-check numeric command arguments. Same limits as fsw/src/commands.c. */
export function validateCommand(cmd: CommandMessage): string | null {
  if (cmd.type !== 'command') return 'message type must be "command"';
  if (!isAllowedCommand(cmd.command)) return `command "${cmd.command}" is not whitelisted`;

  switch (cmd.command) {
    case 'inject_anomaly':
      if (cmd.kind !== undefined && cmd.kind !== 'thermal' && cmd.kind !== 'battery') {
        return 'inject_anomaly kind must be "thermal" or "battery"';
      }
      return null;
    case 'set_altitude':
      if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) return 'set_altitude needs a numeric value';
      if (cmd.value < 200 || cmd.value > 2000) return 'set_altitude out of range 200..2000 km';
      return null;
    case 'set_inclination':
      if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) return 'set_inclination needs a numeric value';
      if (cmd.value < 0 || cmd.value > 145) return 'set_inclination out of range 0..145 deg';
      return null;
    case 'set_attitude': {
      for (const k of ['roll_deg', 'pitch_deg', 'yaw_deg'] as const) {
        const v = cmd[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) return `set_attitude needs a numeric ${k}`;
        if (v < -180 || v > 180) return `set_attitude ${k} out of range -180..180`;
      }
      return null;
    }
    case 'inject_attitude_disturbance':
    case 'reset':
      return null;
  }
}

export class CommandRouter {
  private readonly deps: CommandRouterDeps;

  constructor(deps: CommandRouterDeps) {
    this.deps = deps;
  }

  /**
   * Route one command. Returns which simulator actually took it so the caller
   * can word the UI feedback truthfully.
   */
  dispatch(cmd: CommandMessage): CommandOutcome {
    const problem = validateCommand(cmd);
    if (problem) return { ok: false, reason: problem };

    if (this.deps.isLocalAuthoritative()) {
      const link = this.deps.getLink();
      if (!link) return { ok: false, reason: 'no local link' };
      const sent = link.send(cmd);
      if (!sent) return { ok: false, reason: 'uplink closed - command not delivered to the OBC' };
      // Deliberately nothing else. The OBC's telemetry is the acknowledgement.
      return { ok: true, route: 'LOCAL-FSW' };
    }

    this.applyLocally(cmd);
    return { ok: true, route: 'BROWSER-FSW' };
  }

  /** Apply a validated command to the in-browser simulator. */
  private applyLocally(cmd: CommandMessage): void {
    const fsw = this.deps.browserFsw;
    switch (cmd.command) {
      case 'inject_anomaly':
        fsw.injectAnomaly((cmd.kind ?? 'thermal') as AnomalyKind);
        break;
      case 'inject_attitude_disturbance':
        fsw.injectAttitudeDisturbance();
        break;
      case 'reset':
        fsw.reset();
        break;
      case 'set_altitude':
        fsw.setAltitude(cmd.value as number);
        break;
      case 'set_inclination':
        fsw.setInclination(cmd.value as number);
        break;
      case 'set_attitude':
        fsw.setTargetAttitude(cmd.roll_deg as number, cmd.pitch_deg as number, cmd.yaw_deg as number);
        break;
    }
  }
}

/* Convenience builders so call sites cannot mistype a command name. */
export const cmd = {
  injectAnomaly: (kind: AnomalyKind = 'thermal'): CommandMessage => ({ type: 'command', command: 'inject_anomaly', kind }),
  injectDisturbance: (): CommandMessage => ({ type: 'command', command: 'inject_attitude_disturbance' }),
  reset: (): CommandMessage => ({ type: 'command', command: 'reset' }),
  setAltitude: (km: number): CommandMessage => ({ type: 'command', command: 'set_altitude', value: km }),
  setInclination: (deg: number): CommandMessage => ({ type: 'command', command: 'set_inclination', value: deg }),
  setAttitude: (roll: number, pitch: number, yaw: number): CommandMessage => ({
    type: 'command',
    command: 'set_attitude',
    roll_deg: roll,
    pitch_deg: pitch,
    yaw_deg: yaw,
  }),
};

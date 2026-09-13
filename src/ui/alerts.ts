/**
 * MASTER CAUTION BANNER + SAFE-MODE FRAME
 * =============================================================================
 * The banner is driven by the FAULT STATE in the telemetry packet, never by the
 * button that was pressed. In LOCAL-FSW that distinction is the whole point:
 * pressing "inject anomaly" sends a command to the C OBC, and the banner only
 * appears once the OBC's own telemetry reports the fault.
 *
 * Motion drives the DOM transition because a banner that slides in on an ease
 * is noticeably more legible on a projector than one that pops.
 */

import { animate } from 'motion';
import type { FlightState, TelemetryPacket } from '../state/types.ts';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface AlertSystem {
  /** Show a transient banner. holdMs = 0 keeps it up until something clears it. */
  show: (severity: AlertSeverity, title: string, description: string, holdMs?: number) => void;
  hide: () => void;
  /** Called on every telemetry update; drives the banner + safe-mode frame. */
  sync: (packet: TelemetryPacket, onEnter: (state: FlightState) => void) => void;
}

export function createAlertSystem(bannerEl: HTMLElement, safeFrameEl: HTMLElement): AlertSystem {
  const title = bannerEl.querySelector('.ttl') as HTMLElement;
  const desc = bannerEl.querySelector('.dsc') as HTMLElement;

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let visible = false;
  let lastState: FlightState | null = null;
  let lastFaultCode: string | null = null;

  const hide = () => {
    if (!visible) return;
    visible = false;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    animate(
      bannerEl,
      { transform: ['translate(-50%, 0%)', 'translate(-50%, -120%)'] },
      { duration: 0.32, ease: [0.4, 0, 0.9, 0.5] },
    );
  };

  const show: AlertSystem['show'] = (severity, ttl, description, holdMs = 5200) => {
    bannerEl.className = severity === 'critical' ? '' : severity;
    title.textContent = ttl;
    desc.textContent = description;

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (!visible) {
      visible = true;
      animate(
        bannerEl,
        { transform: ['translate(-50%, -120%)', 'translate(-50%, 0%)'] },
        { duration: 0.42, ease: [0.22, 0.61, 0.36, 1] },
      );
    }
    if (holdMs > 0) hideTimer = setTimeout(hide, holdMs);
  };

  return {
    show,
    hide,

    sync: (packet, onEnter) => {
      const s = packet.state;
      const faultCode = packet.fault.active ? packet.fault.code : null;

      // The frame follows the state exactly - it is a readout, not a mood.
      safeFrameEl.classList.toggle('on', s === 'SAFE_MODE');

      if (faultCode !== lastFaultCode) {
        lastFaultCode = faultCode;
        if (faultCode) {
          show(
            'critical',
            faultCode.replace(/_/g, ' '),
            packet.fault.message ?? 'Onboard fault detected',
            0, // stays up until the fault clears
          );
        } else {
          hide();
        }
      }

      if (s !== lastState) {
        const previous = lastState;
        lastState = s;
        onEnter(s);

        switch (s) {
          case 'SAFE_MODE':
            show(
              'critical',
              'SAFE MODE',
              'Non-essential loads shed - spacecraft holding reference attitude',
              0,
            );
            break;
          case 'DISTURBANCE':
            show('warn', 'ATTITUDE DISTURBANCE', 'Body rates above threshold - ADCS arming', 3200);
            break;
          case 'ADCS_ACTIVE':
            show('info', 'ADCS ACTIVE', 'Reaction wheel commanded - closing the pointing error', 3200);
            break;
          case 'RECOVERY':
            show('info', 'RECOVERY', 'Fault cleared - restoring nominal loads', 3600);
            break;
          case 'NOMINAL':
            if (previous === 'RECOVERY' || previous === 'ERROR_DECREASING') {
              show('info', 'NOMINAL', 'All subsystems within limits', 2800);
            } else if (previous !== null && previous !== 'BOOT') {
              hide();
            }
            break;
          default:
            break;
        }
      }
    },
  };
}

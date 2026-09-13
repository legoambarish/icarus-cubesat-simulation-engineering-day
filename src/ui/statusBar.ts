/**
 * STATUS STRIP
 * =============================================================================
 * One line, read left to right, with the flight state pinned to a MODE PLATE at
 * the far left so it is always in the same place - the way a real console keeps
 * its master mode annunciator fixed.
 *
 * Then: the mission clock, the clock rate (said out loud, because it is not
 * real time), elapsed, the illumination state, the countdown to the next
 * terminator crossing, the beta angle, the honesty note, and the renderer.
 *
 * This is the one panel updated every frame rather than on store changes,
 * because the clock has to tick smoothly.
 */

import type { AppState } from '../state/store.ts';
import { flightStateLabel, flightStateSeverity } from '../state/selectors.ts';
import { el, fmt, fmtDuration, fmtUtc, setStateClass, setText } from './dom.ts';

export interface StatusBarExtras {
  /** Seconds to the next sunlit/eclipse transition, null if not computable. */
  nextTerminatorS: number | null;
  /** Sun angle on the ICARUS orbital plane, degrees. */
  betaDeg: number;
  /** How much faster than real time the mission clock runs. */
  timeScale: number;
}

export interface StatusBar {
  root: HTMLElement;
  update: (state: AppState, extras: StatusBarExtras) => void;
}

function seg(key: string, optional = false): { root: HTMLElement; value: HTMLElement } {
  const value = el('span', { class: 'v' }, ['--']);
  return {
    root: el('div', { class: optional ? 'seg opt' : 'seg' }, [
      el('span', { class: 'k' }, [key]),
      value,
    ]),
    value,
  };
}

export function createStatusBar(): StatusBar {
  const mode = el('div', { id: 'strip-mode' }, ['BOOT']);

  const utc = seg('Sim UTC');
  const rate = seg('Rate');
  const met = seg('Elapsed', true);
  const env = seg('Env');
  const next = seg('Terminator', true);
  const beta = seg('Beta', true);
  const perf = seg('Render', true);
  perf.root.classList.add('right');

  const note = el('div', { class: 'note' }, [
    'ICARUS is a simulation - real objects are propagated from public orbital elements with SGP4',
  ]);

  const root = el('footer', { id: 'status-strip' }, [
    mode,
    utc.root,
    rate.root,
    met.root,
    env.root,
    next.root,
    beta.root,
    note,
    perf.root,
  ]);

  return {
    root,
    update: (s, extras) => {
      const sev = flightStateSeverity(s.telemetry.state);
      setStateClass(mode, '', sev === 'nominal' ? '' : sev);
      mode.id = 'strip-mode';
      setText(mode, flightStateLabel(s.telemetry.state));

      setText(utc.value, fmtUtc(s.missionTimeMs));

      // The mission clock is deliberately faster than real time so a 94-minute
      // orbit fits inside a demo. Saying so here is the honest alternative to
      // quietly showing a clock that is not the wall clock.
      setStateClass(rate.value, 'v', 'accent');
      setText(rate.value, `x${extras.timeScale.toFixed(0)} REAL`);

      setText(met.value, fmtDuration(s.elapsedS));

      const eclipse = s.telemetry.environment.eclipse;
      setStateClass(env.value, 'v', eclipse ? 'warn' : 'nominal');
      setText(env.value, eclipse ? 'ECLIPSE' : 'SUNLIT');

      setText(
        next.value,
        extras.nextTerminatorS === null ? '--' : `T-${fmtDuration(extras.nextTerminatorS)}`,
      );
      setText(beta.value, `${fmt(extras.betaDeg, 1)} deg`);
      setText(perf.value, `${Math.round(s.fps)} FPS - ${s.drawCalls} DC`);
    },
  };
}

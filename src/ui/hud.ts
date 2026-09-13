/**
 * HUD ASSEMBLY
 * =============================================================================
 * Builds the two instrument columns plus the status strip, and owns the only
 * subscription to the store. Individual panels never read the store themselves,
 * which keeps the update order deterministic and makes it obvious where a
 * displayed value came from.
 *
 * Layout (see styles/app.css):
 *   left  column   identity + orbit-data status + FSW link status
 *                  ... spacer ...
 *                  selected object
 *   right column   view controls
 *                  object register (the only panel that flexes)
 *                  ICARUS telemetry + command deck
 *   bottom strip   mode plate, mission clock, environment, renderer
 */

import { animate } from 'motion';
import { subscribe, type AppState } from '../state/store.ts';
import type { HudViewModel } from '../state/selectors.ts';
import { corners, el, setText } from './dom.ts';
import { createObjectProfilePanel } from './objectProfile.ts';
import { createTelemetryPanel, type TelemetryHandlers } from './telemetryPanel.ts';
import { createViewControls, type ViewControlHandlers } from './controls.ts';
import { createStatusBar } from './statusBar.ts';

export interface HudHandlers extends TelemetryHandlers, ViewControlHandlers {}

export interface Hud {
  /** Called every frame with the derived view model. */
  render: (view: HudViewModel) => void;
  /** Push a telemetry-rate sample into the traces. */
  sample: (temperatureC: number, vibrationG: number) => void;
  syncControls: (altitudeKm: number, inclinationDeg: number, rollDeg: number) => void;
  dispose: () => void;
}

export function createHud(container: HTMLElement, handlers: HudHandlers): Hud {
  /* ------------------------------------------------ identity plate ------ */
  const orbitLamp = el('span', { class: 'lamp' });
  const orbitValue = el('span', { class: 'v' }, ['CHECKING']);
  const orbitCount = el('span', { class: 'aux' }, ['']);
  const orbitDetail = el('div', { class: 'status-detail' }, ['']);

  const fswLamp = el('span', { class: 'lamp' });
  const fswValue = el('span', { class: 'v' }, ['SIMULATED']);
  const fswRate = el('span', { class: 'aux' }, ['10 Hz']);
  const fswDetail = el('div', { class: 'status-detail' }, ['']);

  const identity = el('section', { class: 'plate', id: 'identity' }, [
    corners(),
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark' }, ['ICARUS']),
      el('span', { class: 'brand-bar' }),
      el('span', { class: 'brand-sub' }, ['Digital', el('br'), 'Twin']),
    ]),
    el('div', { class: 'brand-note' }, ['CubeSat ground-segment visualisation']),
    el('div', { class: 'brand-hr' }),
    el('div', { class: 'status-rows' }, [
      el('div', { class: 'status-block' }, [
        el('div', { class: 'status-row' }, [
          orbitLamp,
          el('span', { class: 'label k' }, ['Orbit data']),
          orbitValue,
          el('div', { class: 'rule' }),
          orbitCount,
        ]),
        orbitDetail,
      ]),
      el('div', { class: 'status-block' }, [
        el('div', { class: 'status-row' }, [
          fswLamp,
          el('span', { class: 'label k' }, ['FSW link']),
          fswValue,
          el('div', { class: 'rule' }),
          fswRate,
        ]),
        fswDetail,
      ]),
    ]),
  ]);

  /* ------------------------------------------------------------- panels - */
  const viewControls = createViewControls(handlers);
  const profile = createObjectProfilePanel();
  const telemetry = createTelemetryPanel(handlers);
  const statusBar = createStatusBar();

  const leftCol = el('div', { class: 'hud-col hud-col-left' }, [
    identity,
    el('div', { class: 'hud-spacer' }),
    profile.root,
  ]);
  const rightCol = el('div', { class: 'hud-col hud-col-right' }, [
    viewControls.root,
    viewControls.list,
    telemetry.root,
  ]);

  container.replaceChildren(
    el('div', { id: 'hud-main' }, [leftCol, rightCol]),
    statusBar.root,
  );

  /*
   * Entry animation: plates fade up once, staggered.
   *
   * It is PURE POLISH, and it is written so that it can never cost visibility.
   * An opacity keyframe starting at 0 writes an inline opacity:0 immediately;
   * if the animation then never advances - a tab backgrounded mid-load pauses
   * requestAnimationFrame, which is exactly what happens when someone opens
   * the exhibit and switches away while it loads - the panels stay invisible
   * for ever. That was a real failure on the deployed site.
   *
   * So: skip the animation entirely when the document is hidden or the user
   * prefers reduced motion, and in every case clear the inline styles on a
   * timer, which guarantees a visible resting state whatever the animation did.
   */
  const panels = [
    identity,
    viewControls.root,
    viewControls.list,
    profile.root,
    telemetry.root,
    statusBar.root,
  ];

  const revealPanels = () => {
    for (const node of panels) {
      node.style.removeProperty('opacity');
      node.style.removeProperty('transform');
    }
  };

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!document.hidden && !reduceMotion) {
    panels.forEach((node, i) => {
      animate(
        node,
        { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] },
        { duration: 0.48, delay: 0.1 + i * 0.07, ease: [0.22, 0.61, 0.36, 1] },
      );
    });
    setTimeout(revealPanels, 1400);
  }
  // If the tab is hidden now and shown later, the animation never ran - make
  // sure nothing is left stuck invisible.
  document.addEventListener('visibilitychange', revealPanels, { once: true });

  /* -------------------------------------------------------- store binding */
  let latest: AppState | null = null;
  const unsubscribe = subscribe((state) => {
    latest = state;
    updateIdentity(state);
    telemetry.update(state);
  });

  function updateIdentity(state: AppState): void {
    /* ORBIT DATA - never describes bundled data as live. */
    switch (state.orbitDataSource) {
      case 'LIVE':
        orbitLamp.className = 'lamp nominal';
        orbitValue.className = 'v nominal';
        setText(orbitValue, 'LIVE');
        break;
      case 'MIXED':
        orbitLamp.className = 'lamp warn';
        orbitValue.className = 'v warn';
        setText(orbitValue, 'PARTIAL');
        break;
      case 'FALLBACK':
        orbitLamp.className = 'lamp warn';
        orbitValue.className = 'v warn';
        setText(orbitValue, 'FALLBACK');
        break;
      default:
        orbitLamp.className = 'lamp pulse accent';
        orbitValue.className = 'v accent';
        setText(orbitValue, 'LOADING');
    }
    setText(orbitCount, state.records.length > 0 ? `${state.records.length} OBJ` : '');
    setText(orbitDetail, state.orbitDataDetail);

    /* FSW LINK */
    if (state.fswMode === 'LOCAL-FSW') {
      fswLamp.className = 'lamp accent';
      fswValue.className = 'v accent';
      setText(fswValue, 'LOCAL');
      setText(fswDetail, 'Icarus C OBC - UDP 5005 - WS 8082');
    } else {
      fswLamp.className = state.linkStatus === 'CONNECTING' ? 'lamp pulse nominal' : 'lamp nominal';
      fswValue.className = 'v nominal';
      setText(fswValue, 'SIMULATED');
      setText(
        fswDetail,
        state.linkStatus === 'CONNECTING'
          ? 'Browser FSW - probing local bridge'
          : 'Browser FSW - deterministic in-browser simulator',
      );
    }
  }

  return {
    render: (view) => {
      if (!latest) return;
      profile.update(view.profile);
      viewControls.update(latest, view.rows);
      statusBar.update(latest, {
        nextTerminatorS: view.nextTerminatorS,
        betaDeg: view.betaDeg,
        timeScale: view.timeScale,
      });
    },
    sample: telemetry.sample,
    syncControls: telemetry.syncControls,
    dispose: () => {
      unsubscribe();
      container.replaceChildren();
    },
  };
}

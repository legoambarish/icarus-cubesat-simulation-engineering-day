/**
 * VIEW CONTROLS + OBJECT REGISTER
 * =============================================================================
 * Camera reset, focus-on-ICARUS, sound, and the tracked-object register.
 *
 * The register is numbered like a real catalogue listing, and it doubles as the
 * demo's navigation: it is the fastest way to select the ISS in front of an
 * audience without hunting for an 18-pixel mark on a projector.
 */

import type { AppState } from '../state/store.ts';
import type { ObjectRow } from '../state/selectors.ts';
import { KIND_COLORS } from '../twin/satellites.ts';
import { corners, el, fmt, ICONS, icon, setText } from './dom.ts';

export interface ViewControlHandlers {
  onResetView: () => void;
  onFocusIcarus: () => void;
  onToggleAudio: () => void;
  onSelect: (id: string) => void;
}

export interface ViewControls {
  /** The button row - top of the right-hand HUD column. */
  root: HTMLElement;
  /** The register - the only panel allowed to flex vertically. */
  list: HTMLElement;
  update: (state: AppState, rows: ObjectRow[]) => void;
}

export function createViewControls(handlers: ViewControlHandlers): ViewControls {
  const btnIcarus = el('button', { class: 'btn', type: 'button', title: 'Frame the simulated CubeSat' }, [
    icon(ICONS.target),
    'Icarus',
  ]);
  const btnReset = el('button', { class: 'btn', type: 'button', title: 'Wide Earth view' }, [
    icon(ICONS.reset),
    'Reset view',
  ]);
  const btnAudio = el('button', { class: 'btn', type: 'button', title: 'Toggle interface sound' }, [
    icon(ICONS.mute),
    'Audio',
  ]);

  btnIcarus.addEventListener('click', handlers.onFocusIcarus);
  btnReset.addEventListener('click', handlers.onResetView);
  btnAudio.addEventListener('click', handlers.onToggleAudio);

  const root = el('div', { id: 'view-controls' }, [btnIcarus, btnReset, btnAudio]);

  const listBody = el('div', { class: 'obj-scroll' });
  const listCount = el('span', { class: 'spark-val', style: 'width:auto' }, ['0']);

  const list = el('section', { class: 'plate', id: 'object-list' }, [
    corners(),
    el('header', { class: 'plate-head' }, [
      el('span', { class: 'key' }),
      el('span', { class: 'head-title' }, ['Object register']),
      el('div', { class: 'spacer' }),
      listCount,
    ]),
    listBody,
  ]);

  /* Rows are created once and then only mutated - rebuilding this list every
     frame would fight the scroll position and the hover state. */
  const rowNodes = new Map<string, { root: HTMLButtonElement; alt: HTMLElement }>();
  let lastSignature = '';
  let lastAudio: boolean | null = null;

  return {
    root,
    list,

    update: (state, rows) => {
      if (lastAudio !== state.audioEnabled) {
        lastAudio = state.audioEnabled;
        btnAudio.classList.toggle('on', state.audioEnabled);
        btnAudio.replaceChildren(icon(state.audioEnabled ? ICONS.sound : ICONS.mute), 'Audio');
      }
      btnIcarus.classList.toggle('on', state.selectedId === 'icarus');

      const signature = rows.map((r) => r.id).join(',');
      if (signature !== lastSignature) {
        lastSignature = signature;
        rowNodes.clear();
        listBody.replaceChildren(
          ...rows.map((r, i) => {
            const swatch = el('span', { class: 'swatch' });
            swatch.style.background = `#${KIND_COLORS[r.kind].toString(16).padStart(6, '0')}`;
            const alt = el('span', { class: 'alt' }, ['--']);
            const btn = el('button', { class: 'obj-item', type: 'button' }, [
              el('span', { class: 'idx' }, [String(i).padStart(2, '0')]),
              swatch,
              el('span', { class: 'nm' }, [r.name]),
              alt,
              el('span', { class: 'uni' }, ['km']),
            ]);
            btn.addEventListener('click', () => handlers.onSelect(r.id));
            rowNodes.set(r.id, { root: btn, alt });
            return btn;
          }),
        );
        setText(listCount, String(rows.length));
      }

      for (const r of rows) {
        const node = rowNodes.get(r.id);
        if (!node) continue;
        node.root.classList.toggle('selected', r.selected);
        setText(node.alt, fmt(r.altitudeKm, 0));
      }
    },
  };
}

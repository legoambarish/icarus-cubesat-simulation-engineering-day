/**
 * SELECTED OBJECT PLATE
 * =============================================================================
 * Shows what is selected and WHERE ITS NUMBERS COME FROM. The provenance tag is
 * not decoration: a visitor must be able to tell at a glance whether they are
 * looking at a real spacecraft propagated from currently published elements,
 * the same object propagated from a bundled snapshot, or the simulated ICARUS
 * CubeSat, which is not in orbit at all.
 */

import type { ObjectProfile } from '../state/types.ts';
import { profileBlurb } from '../state/selectors.ts';
import { corners, el, fmt, readout, setText } from './dom.ts';

export interface ObjectProfilePanel {
  root: HTMLElement;
  update: (profile: ObjectProfile) => void;
}

export function createObjectProfilePanel(): ObjectProfilePanel {
  const name = el('div', { class: 'profile-name' }, ['--']);
  const kind = el('div', { class: 'profile-kind' }, ['--']);
  const tag = el('span', { class: 'tag' }, ['--']);
  const key = el('span', { class: 'key nominal' });

  const altitude = readout('Altitude', { cellClass: 'kv' });
  const velocity = readout('Velocity', { cellClass: 'kv' });
  const inclination = readout('Inclination', { cellClass: 'kv' });
  const period = readout('Period', { cellClass: 'kv' });

  const foot = el('div', { class: 'profile-foot' });

  const root = el('section', { class: 'plate', id: 'object-profile' }, [
    corners(),
    el('header', { class: 'plate-head' }, [
      key,
      el('div', { class: 'profile-title' }, [name, kind]),
      el('div', { class: 'spacer' }),
      tag,
    ]),
    el('div', { class: 'plate-body' }, [
      el('div', { class: 'kv-grid' }, [altitude.root, velocity.root, inclination.root, period.root]),
      foot,
    ]),
  ]);

  let lastId = '';

  return {
    root,
    update: (p) => {
      setText(name, p.name);
      setText(kind, kindText(p.kind));

      if (p.origin === 'LIVE') {
        tag.className = 'tag live';
        setText(tag, 'Live elements');
        key.className = 'key';
      } else if (p.origin === 'FALLBACK') {
        tag.className = 'tag fallback';
        setText(tag, 'Fallback elements');
        key.className = 'key warn';
      } else {
        tag.className = 'tag sim';
        setText(tag, 'Simulated');
        key.className = 'key nominal';
      }

      altitude.setValue(fmt(p.altitudeKm, 1), 'km');
      velocity.setValue(fmt(p.velocityKmS, 3), 'km/s');
      inclination.setValue(fmt(p.inclinationDeg, 2), 'deg');
      period.setValue(fmt(p.periodMin, 2), 'min');

      // The footer changes rarely; only rebuild it when the selection changes.
      if (p.id !== lastId) {
        lastId = p.id;
        foot.replaceChildren(
          el('div', {}, [
            el('b', {}, [p.noradId !== null ? `NORAD ${p.noradId} - ` : '']),
            p.sourceLabel,
          ]),
          el('div', { style: 'margin-top:5px' }, [profileBlurb(p)]),
          ...(p.epoch
            ? [
                el('div', { style: 'margin-top:5px' }, [
                  `Element epoch ${p.epoch.replace('T', ' ').slice(0, 19)}Z`,
                ]),
              ]
            : []),
        );
      }
    },
  };
}

function kindText(kind: ObjectProfile['kind']): string {
  switch (kind) {
    case 'station':
      return 'Crewed space station';
    case 'cubesat':
      return 'CubeSat';
    case 'science':
      return 'Science / observation';
    case 'weather':
      return 'Weather satellite';
    case 'imaging':
      return 'Earth imaging';
    case 'icarus':
      return 'Simulated 1U CubeSat';
  }
}

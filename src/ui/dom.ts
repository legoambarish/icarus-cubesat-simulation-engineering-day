/**
 * DOM helpers for the instrument system.
 *
 * The HUD is built in TypeScript rather than written as static HTML so that
 * every element displaying a number has exactly one owner, and so the panels
 * can be reasoned about in isolation. No framework: the update path is a
 * handful of textContent writes per frame, far cheaper than any diffing.
 */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

/**
 * A plate: hairline rule, ink wash, and four corner ticks.
 *
 * The top two ticks come from the element's own ::before/::after; the bottom
 * two need a child, because one element only has two pseudo-elements. That
 * child is what `corners()` returns, and every plate must contain one.
 */
export function corners(): HTMLElement {
  return el('i', { class: 'corners', 'aria-hidden': 'true' });
}

/** Build a plate with the standard head/body structure. */
export function plate(
  opts: { id?: string; class?: string; keyClass?: string; title: string; head?: (Node | string)[] },
  body: (Node | string)[],
): { root: HTMLElement; head: HTMLElement; key: HTMLElement; bodyEl: HTMLElement } {
  const key = el('span', { class: opts.keyClass ? `key ${opts.keyClass}` : 'key' });
  const head = el('header', { class: 'plate-head' }, [
    key,
    el('span', { class: 'head-title' }, [opts.title]),
    ...(opts.head ?? []),
  ]);
  const bodyEl = el('div', { class: 'plate-body' }, body);
  const root = el(
    'section',
    { class: opts.class ? `plate ${opts.class}` : 'plate', id: opts.id },
    [corners(), head, bodyEl],
  );
  return { root, head, key, bodyEl };
}

/** Inline SVG icon on a 16px grid, stroked. No icon-font dependency. */
export function icon(path: string, cls = 'btn-icon'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

export const ICONS = {
  reset: 'M8 2.6a5.4 5.4 0 1 0 5.1 3.6M13.4 2.1v4.1H9.3',
  target: 'M8 1.4v2.4M8 12.2v2.4M1.4 8h2.4M12.2 8h2.4M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4Z',
  sound: 'M3.2 6.2h2.2L8.4 3.6v8.8L5.4 9.8H3.2zM11 5.8a3.2 3.2 0 0 1 0 4.4M13 4a5.8 5.8 0 0 1 0 8',
  mute: 'M3.2 6.2h2.2L8.4 3.6v8.8L5.4 9.8H3.2zM11 6.4l3.2 3.2M14.2 6.4 11 9.6',
  warn: 'M8 2.2 14.4 13H1.6zM8 6.6v3.1M8 11.5h.01',
  wave: 'M1.4 8h2l1.6-4.4L7.4 12l1.9-4h5.3',
  power: 'M8 2v5.4M4.6 4.1a5 5 0 1 0 6.8 0',
} as const;

/** Set textContent only when it actually changed - avoids layout thrash. */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Swap a single state class out of a fixed set. */
export function setStateClass(node: HTMLElement, base: string, state: string): void {
  const next = state ? `${base} ${state}` : base;
  if (node.className !== next) node.className = next;
}

/** Fixed-width numeric formatting for telemetry readouts. */
export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

/** Signed formatting, used for angles and rates. */
export function fmtSigned(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const s = value.toFixed(digits);
  return value >= 0 && !s.startsWith('-') ? `+${s}` : s;
}

/** HH:MM:SS from seconds. */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** UTC clock string, e.g. "2026-09-13 11:42:07Z". */
export function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
  );
}

/**
 * A readout: a label above a mono value with its unit in a dimmer suffix.
 * Returns the value node so the caller can update it without a query.
 */
export function readout(
  label: string,
  opts: { size?: 'big' | 'sm' | ''; cellClass?: string } = {},
): { root: HTMLElement; value: HTMLElement; setValue: (text: string, unit?: string) => void } {
  const sizeClass = opts.size ? ` ${opts.size}` : '';
  const value = el('div', { class: `value${sizeClass}` }, ['--']);
  const root = el('div', { class: opts.cellClass ?? 'tm-cell' }, [
    el('div', { class: 'label' }, [label]),
    value,
  ]);

  let unitNode: HTMLElement | null = null;
  const setValue = (text: string, unit?: string) => {
    if (unit === undefined) {
      if (unitNode) {
        unitNode = null;
        value.replaceChildren(text);
      } else {
        setText(value, text);
      }
      return;
    }
    if (!unitNode) {
      unitNode = el('span', { class: 'unit' }, [unit]);
      value.replaceChildren(text, unitNode);
      return;
    }
    const first = value.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      if (first.textContent !== text) first.textContent = text;
    } else {
      value.replaceChildren(text, unitNode);
    }
    if (unitNode.textContent !== unit) unitNode.textContent = unit;
  };

  return { root, value, setValue };
}

/**
 * A vertical scale tape with graduations and an index bug.
 *
 * This is the avionics idiom, not a progress bar: the bug overhangs both edges
 * of the tape and the graduations stay put, so the eye reads a POSITION on a
 * fixed scale rather than a length. `limitPct` draws a red limit line.
 */
export function tape(opts: { graduations?: number[]; limitPct?: number } = {}): {
  root: HTMLElement;
  set: (pct: number, severity: 'nominal' | 'warn' | 'crit' | 'accent') => void;
} {
  const fill = el('i', { class: 'fill' });
  const bug = el('i', { class: 'bug' });
  const kids: (Node | string)[] = [fill, bug];

  for (const g of opts.graduations ?? [25, 50, 75]) {
    const line = el('i', { class: 'grad' });
    line.style.bottom = `${g}%`;
    kids.push(line);
  }
  if (opts.limitPct !== undefined) {
    const lim = el('i', { class: 'limit' });
    lim.style.bottom = `${opts.limitPct}%`;
    kids.push(lim);
  }

  const root = el('div', { class: 'tape' }, kids);

  const COLORS: Record<string, string> = {
    nominal: 'var(--c-nominal)',
    warn: 'var(--c-warn)',
    crit: 'var(--c-critical)',
    accent: 'var(--c-accent)',
  };

  return {
    root,
    set: (pct, severity) => {
      const p = Math.max(0, Math.min(100, pct));
      fill.style.height = `${p.toFixed(1)}%`;
      bug.style.bottom = `${p.toFixed(1)}%`;
      root.style.setProperty('--tape-c', COLORS[severity] ?? COLORS.nominal!);
      setStateClass(root, 'tape', severity === 'crit' ? 'crit' : severity === 'warn' ? 'warn' : '');
    },
  };
}

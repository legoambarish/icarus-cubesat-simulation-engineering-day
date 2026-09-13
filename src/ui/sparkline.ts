/**
 * GRATICULE TRACE
 * =============================================================================
 * A 120-sample rolling trend on a graticule: a dotted mid-rule and three
 * vertical divisions, with the trace drawn over them. That framing is what
 * separates an instrument trace from a decorative sparkline - the divisions
 * give the eye something to measure against, and a flat trace still reads as a
 * chart rather than a stray line.
 *
 * A limit line can be pinned at a value (the thermal limit), so a breach is
 * visible as the trace crossing a marked threshold rather than as a number
 * turning red somewhere else on the panel.
 *
 * Samples arrive at telemetry rate (10 Hz) and the path is rebuilt on push;
 * 120 points is cheaper than any canvas setup and stays crisp on a projector.
 */

const SAMPLES = 120;
const VIEW_W = 240;
const VIEW_H = 30;
const NS = 'http://www.w3.org/2000/svg';

export interface SparklineOptions {
  min: number;
  max: number;
  color: string;
  /** Draw a limit line at this value. */
  limit?: number;
  /** Auto-expand the range when a sample falls outside it. Default true. */
  autoRange?: boolean;
}

export interface Sparkline {
  svg: SVGSVGElement;
  push: (value: number) => void;
  clear: () => void;
}

export function createSparkline(opts: SparklineOptions): Sparkline {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  // Graticule field.
  const field = document.createElementNS(NS, 'rect');
  field.setAttribute('width', String(VIEW_W));
  field.setAttribute('height', String(VIEW_H));
  field.setAttribute('fill', 'rgba(123,227,255,0.03)');
  svg.append(field);

  for (const x of [VIEW_W * 0.25, VIEW_W * 0.5, VIEW_W * 0.75]) {
    const div = document.createElementNS(NS, 'line');
    div.setAttribute('x1', String(x));
    div.setAttribute('x2', String(x));
    div.setAttribute('y1', '0');
    div.setAttribute('y2', String(VIEW_H));
    div.setAttribute('stroke', 'rgba(123,227,255,0.08)');
    div.setAttribute('stroke-width', '0.5');
    svg.append(div);
  }

  const mid = document.createElementNS(NS, 'line');
  mid.setAttribute('x1', '0');
  mid.setAttribute('x2', String(VIEW_W));
  mid.setAttribute('y1', String(VIEW_H / 2));
  mid.setAttribute('y2', String(VIEW_H / 2));
  mid.setAttribute('stroke', 'rgba(123,227,255,0.12)');
  mid.setAttribute('stroke-width', '0.5');
  mid.setAttribute('stroke-dasharray', '2 4');
  svg.append(mid);

  const limitLine = document.createElementNS(NS, 'line');
  limitLine.setAttribute('x1', '0');
  limitLine.setAttribute('x2', String(VIEW_W));
  limitLine.setAttribute('stroke', 'rgba(255,77,79,0.55)');
  limitLine.setAttribute('stroke-width', '0.8');
  limitLine.setAttribute('stroke-dasharray', '3 3');
  if (opts.limit !== undefined) svg.append(limitLine);

  const fill = document.createElementNS(NS, 'path');
  fill.setAttribute('fill', opts.color);
  fill.setAttribute('opacity', '0.09');
  svg.append(fill);

  const line = document.createElementNS(NS, 'path');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', opts.color);
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);

  const values: number[] = [];
  let lo = opts.min;
  let hi = opts.max;
  const autoRange = opts.autoRange ?? true;

  const yFor = (v: number) => {
    const span = hi - lo || 1;
    const norm = Math.max(0, Math.min(1, (v - lo) / span));
    return VIEW_H - 2 - norm * (VIEW_H - 4);
  };

  const render = () => {
    if (opts.limit !== undefined) limitLine.setAttribute('y1', yFor(opts.limit).toFixed(2));
    if (opts.limit !== undefined) limitLine.setAttribute('y2', yFor(opts.limit).toFixed(2));

    if (values.length < 2) {
      line.setAttribute('d', '');
      fill.setAttribute('d', '');
      return;
    }
    const stepX = VIEW_W / (SAMPLES - 1);
    let d = '';
    for (let i = 0; i < values.length; i++) {
      // Right-aligned: the newest sample is always at the right edge.
      const x = VIEW_W - (values.length - 1 - i) * stepX;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${yFor(values[i]!).toFixed(2)}`;
    }
    line.setAttribute('d', d);
    const firstX = VIEW_W - (values.length - 1) * stepX;
    fill.setAttribute('d', `${d}L${VIEW_W} ${VIEW_H}L${firstX.toFixed(2)} ${VIEW_H}Z`);
  };

  return {
    svg,
    push: (value) => {
      if (!Number.isFinite(value)) return;
      values.push(value);
      if (values.length > SAMPLES) values.shift();
      if (autoRange) {
        if (value < lo) lo = value - Math.abs(value) * 0.05 - 1;
        if (value > hi) hi = value + Math.abs(value) * 0.05 + 1;
      }
      render();
    },
    clear: () => {
      values.length = 0;
      lo = opts.min;
      hi = opts.max;
      render();
    },
  };
}

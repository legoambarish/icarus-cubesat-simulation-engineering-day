/**
 * OBJECT PICKING
 * =============================================================================
 * Satellites are tiny compared with the Earth, so a strict mesh raycast would
 * make them almost impossible to click. Instead we pick in SCREEN SPACE:
 * project every object to NDC, keep the ones in front of the camera and inside
 * a generous pixel radius, and choose the nearest to the cursor (breaking ties
 * towards the closer object).
 *
 * This also gives us hover for free, which drives the cursor change and the
 * floating name label.
 */

import { Vector3, type PerspectiveCamera } from 'three';

/** Pick radius in CSS pixels. Deliberately generous for a projector + mouse. */
const PICK_RADIUS_PX = 26;

export interface Pickable {
  id: string;
  /** Position in RENDER space. */
  position: Vector3;
}

export interface PickResult {
  id: string;
  /** Distance from the cursor in pixels. */
  distancePx: number;
  /** Screen position, useful for placing the hover label. */
  screenX: number;
  screenY: number;
}

const _v = new Vector3();

/**
 * Find the object nearest to (clientX, clientY).
 * Returns null when nothing is within the pick radius.
 */
export function pick(
  objects: readonly Pickable[],
  camera: PerspectiveCamera,
  clientX: number,
  clientY: number,
  viewportW: number,
  viewportH: number,
  radiusPx = PICK_RADIUS_PX,
): PickResult | null {
  let best: PickResult | null = null;
  let bestDepth = Infinity;

  for (const obj of objects) {
    _v.copy(obj.position).project(camera);
    // z outside [-1, 1] means behind the camera or beyond the far plane.
    if (_v.z < -1 || _v.z > 1) continue;

    const sx = (_v.x * 0.5 + 0.5) * viewportW;
    const sy = (-_v.y * 0.5 + 0.5) * viewportH;
    const d = Math.hypot(sx - clientX, sy - clientY);
    if (d > radiusPx) continue;

    // Prefer the closest to the cursor; if two are equally close, prefer the
    // one nearer the camera.
    if (!best || d < best.distancePx - 2 || (Math.abs(d - best.distancePx) <= 2 && _v.z < bestDepth)) {
      best = { id: obj.id, distancePx: d, screenX: sx, screenY: sy };
      bestDepth = _v.z;
    }
  }

  return best;
}

/** Project a world position to CSS pixel coordinates (for HUD labels). */
export function projectToScreen(
  position: Vector3,
  camera: PerspectiveCamera,
  viewportW: number,
  viewportH: number,
): { x: number; y: number; visible: boolean } {
  _v.copy(position).project(camera);
  return {
    x: (_v.x * 0.5 + 0.5) * viewportW,
    y: (-_v.y * 0.5 + 0.5) * viewportH,
    visible: _v.z >= -1 && _v.z <= 1,
  };
}

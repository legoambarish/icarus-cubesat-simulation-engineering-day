/**
 * ORBIT PATH LINES
 * =============================================================================
 * Two kinds of line live here:
 *
 *   1. REAL orbits - one closed ring per catalogue object, sampled once from
 *      SGP4 over a full period. These do not change, so their geometry is
 *      uploaded once and never touched again.
 *
 *   2. The ICARUS orbit - rebuilt whenever the visitor changes altitude or
 *      inclination, which is the whole point of the interaction. One
 *      pre-allocated buffer is rewritten in place rather than re-allocating a
 *      geometry on every slider frame.
 *
 * Each ring is one LineLoop with its own thin additive material, which keeps
 * highlight/dim behaviour simple and still costs only ~16 draw calls in total.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
} from 'three';
import { sceneFromEci, type EciVec } from '../orbit/frames.ts';
import type { ObjectKind } from '../state/types.ts';
import { KIND_COLORS } from './satellites.ts';

/** Vertex count for the ICARUS ring. 180 is smooth at any zoom we allow. */
export const ICARUS_SEGMENTS = 180;

const BASE_OPACITY = 0.22;
const SELECTED_OPACITY = 0.75;

interface Entry {
  id: string;
  kind: ObjectKind;
  line: LineLoop;
  material: LineBasicMaterial;
}

/** Collection of every real object's orbit ring. */
export class OrbitLineSet {
  readonly group = new Group();
  private readonly entries: Entry[] = [];
  private densityScale = 1;
  private selectedId: string | null = null;

  constructor() {
    this.group.name = 'OrbitLines';
  }

  /** Add one real object's orbit, sampled in ECI kilometres. */
  add(id: string, kind: ObjectKind, pathEciKm: readonly EciVec[]): void {
    if (pathEciKm.length < 8) return;

    const positions = new Float32Array(pathEciKm.length * 3);
    for (let i = 0; i < pathEciKm.length; i++) {
      const p = sceneFromEci(pathEciKm[i]!);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));

    const material = new LineBasicMaterial({
      color: KIND_COLORS[kind],
      transparent: true,
      opacity: BASE_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    const line = new LineLoop(geometry, material);
    line.name = `Orbit:${id}`;
    line.frustumCulled = false;
    line.renderOrder = 2;

    this.group.add(line);
    this.entries.push({ id, kind, line, material });
    this.applyStyles();
  }

  /** Highlight one object's orbit; everything else dims back to the base. */
  setSelected(id: string | null): void {
    this.selectedId = id;
    this.applyStyles();
  }

  /**
   * Performance lever #2 (after pixel ratio): fade the orbit lines rather than
   * removing them, so the scene still reads as "orbital traffic".
   */
  setDensity(level: 'full' | 'reduced'): void {
    this.densityScale = level === 'full' ? 1 : 0.45;
    this.applyStyles();
  }

  private applyStyles(): void {
    for (const e of this.entries) {
      const selected = e.id === this.selectedId;
      e.material.opacity = (selected ? SELECTED_OPACITY : BASE_OPACITY) * this.densityScale;
      e.material.color.setHex(KIND_COLORS[e.kind]);
      if (selected) e.material.color.lerp(new Color(0xffffff), 0.3);
    }
  }

  dispose(): void {
    for (const e of this.entries) {
      e.line.geometry.dispose();
      e.material.dispose();
    }
    this.entries.length = 0;
    this.group.clear();
  }
}

/* ==========================================================================
 * ICARUS orbit ring - rebuilt on demand
 * ========================================================================== */

export interface IcarusOrbitLine {
  line: Line;
  /** Rewrite the ring for a new radius / inclination / RAAN. */
  rebuild: (points: readonly EciVec[]) => void;
  setActive: (active: boolean) => void;
  dispose: () => void;
}

export function createIcarusOrbitLine(): IcarusOrbitLine {
  // Pre-allocated for ICARUS_SEGMENTS + 1 points so rebuild() never reallocates.
  const positions = new Float32Array((ICARUS_SEGMENTS + 1) * 3);
  const geometry = new BufferGeometry();
  const attr = new BufferAttribute(positions, 3);
  attr.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  geometry.setDrawRange(0, 0);

  const material = new LineBasicMaterial({
    color: KIND_COLORS.icarus,
    transparent: true,
    opacity: 0.6,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  const line = new Line(geometry, material);
  line.name = 'Orbit:icarus';
  line.frustumCulled = false;
  line.renderOrder = 2;

  return {
    line,
    rebuild: (points) => {
      const n = Math.min(points.length, ICARUS_SEGMENTS + 1);
      for (let i = 0; i < n; i++) {
        const p = sceneFromEci(points[i]!);
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
      }
      geometry.setDrawRange(0, n);
      attr.needsUpdate = true;
      geometry.computeBoundingSphere();
    },
    setActive: (active) => {
      material.opacity = active ? 0.88 : 0.5;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

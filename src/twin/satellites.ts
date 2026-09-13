/**
 * SPACECRAFT MARKS
 * =============================================================================
 * A satellite is a point of light seen from hundreds of kilometres away.
 * Drawing it as a small solid polyhedron is both wrong and ugly: at marker size
 * it reads as a blocky chip, and it has to be lit, scaled and depth-sorted.
 *
 * So every object in the catalogue is ONE camera-facing point sprite, drawn
 * entirely in the fragment shader:
 *
 *   * a hot, near-white core
 *   * a soft halo in the object's class colour
 *   * four thin diffraction spikes, the way a bright point looks through any
 *     real optic - this is what makes it read as "spacecraft" and not "dot"
 *   * a broken ring plus ticks on the selected object only
 *
 * One Points object, one draw call, one geometry: the whole catalogue costs
 * about as much as a single quad. Sizes are in SCREEN PIXELS, so a satellite
 * is equally legible from the wide Earth view and from a close pass, with none
 * of the distance-scaling guesswork a mesh needs.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { ObjectKind } from '../state/types.ts';

export const KIND_COLORS: Record<ObjectKind, number> = {
  station: 0xffd479,
  cubesat: 0x8f7dff,
  science: 0x7be3ff,
  weather: 0x58c0a8,
  imaging: 0xf28fb4,
  icarus: 0x3fd68c,
};

const vertexShader = /* glsl */ `
  attribute float size;
  attribute float flags;      // 0 = normal, 1 = hovered, 2 = selected
  uniform float pixelRatio;
  varying vec3 vColor;
  varying float vFlags;

  void main() {
    vColor = color;
    vFlags = flags;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pixelRatio;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vFlags;

  void main() {
    vec2 p = (gl_PointCoord - 0.5) * 2.0;   // -1 .. 1 across the sprite
    float r = length(p);
    if (r > 1.0) discard;

    // Core: small and hot, biased to white so it reads as a light source.
    float core = smoothstep(0.17, 0.0, r);

    // Halo: wide and soft, carrying the object-class colour.
    float halo = pow(max(0.0, 1.0 - r), 3.0) * 0.5;

    // Diffraction spikes - the giveaway that this is a bright point seen
    // through an optic. Narrow, axis-aligned, falling off with radius.
    float ax = abs(p.x);
    float ay = abs(p.y);
    float spikeH = pow(max(0.0, 1.0 - ay / 0.05), 2.0) * pow(max(0.0, 1.0 - ax), 2.2);
    float spikeV = pow(max(0.0, 1.0 - ax / 0.05), 2.0) * pow(max(0.0, 1.0 - ay), 2.2);
    float spikes = clamp(spikeH + spikeV, 0.0, 1.0) * 0.45;

    float a = clamp(core + halo + spikes, 0.0, 1.0);
    vec3 rgb = mix(vColor, vec3(1.0), core * 0.85);

    // Selection: a ring broken at the axes, plus four ticks further out.
    // Only on the selected object, so the scene stays quiet.
    if (vFlags > 1.5) {
      float axis = min(ax, ay) / max(r, 0.0001);
      float ring = smoothstep(0.03, 0.0, abs(r - 0.66)) * smoothstep(0.10, 0.26, axis);
      float outer = max(ax, ay) / max(r, 0.0001);
      float tick = smoothstep(0.04, 0.0, abs(r - 0.90)) * smoothstep(0.97, 0.999, outer);
      float deco = clamp(ring + tick, 0.0, 1.0);
      a = clamp(a + deco * 0.85, 0.0, 1.0);
      rgb = mix(rgb, vec3(1.0), deco * 0.45);
    } else if (vFlags > 0.5) {
      float ring = smoothstep(0.028, 0.0, abs(r - 0.72));
      a = clamp(a + ring * 0.4, 0.0, 1.0);
    }

    gl_FragColor = vec4(rgb, a);
  }
`;

export interface SatelliteMarkers {
  points: Points;
  /** Update every marker. Positions are in RENDER space. */
  update: (
    positions: readonly Vector3[],
    kinds: readonly ObjectKind[],
    selectedIndex: number,
    hoveredIndex: number,
  ) => void;
  dispose: () => void;
}

/** Marker diameters in CSS pixels. */
const SIZE_BASE = 18;
const SIZE_HOVER = 26;
const SIZE_SELECTED = 44;

export function createSatelliteMarkers(capacity: number, pixelRatio = 1): SatelliteMarkers {
  const geometry = new BufferGeometry();
  const posAttr = new Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  const colAttr = new Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  const sizeAttr = new Float32BufferAttribute(new Float32Array(capacity), 1);
  const flagAttr = new Float32BufferAttribute(new Float32Array(capacity), 1);
  for (const a of [posAttr, colAttr, sizeAttr, flagAttr]) a.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('color', colAttr);
  geometry.setAttribute('size', sizeAttr);
  geometry.setAttribute('flags', flagAttr);
  geometry.setDrawRange(0, 0);

  const material = new ShaderMaterial({
    uniforms: { pixelRatio: { value: pixelRatio } },
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  const points = new Points(geometry, material);
  points.name = 'SpacecraftMarks';
  points.frustumCulled = false;
  points.renderOrder = 3;

  const color = new Color();
  const white = new Color(0xffffff);

  return {
    points,
    update: (positions, kinds, selectedIndex, hoveredIndex) => {
      const n = Math.min(positions.length, capacity);
      geometry.setDrawRange(0, n);

      for (let i = 0; i < n; i++) {
        const p = positions[i]!;
        posAttr.setXYZ(i, p.x, p.y, p.z);

        color.setHex(KIND_COLORS[kinds[i] ?? 'science']);
        if (i === selectedIndex) color.lerp(white, 0.3);
        colAttr.setXYZ(i, color.r, color.g, color.b);

        sizeAttr.setX(
          i,
          i === selectedIndex ? SIZE_SELECTED : i === hoveredIndex ? SIZE_HOVER : SIZE_BASE,
        );
        flagAttr.setX(i, i === selectedIndex ? 2 : i === hoveredIndex ? 1 : 0);
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      flagAttr.needsUpdate = true;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

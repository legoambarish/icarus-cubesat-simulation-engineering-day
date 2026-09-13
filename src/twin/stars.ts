/**
 * STAR FIELD
 * =============================================================================
 * One Points object, one draw call, a bounded count. Not thousands of meshes.
 *
 * Stars are distributed uniformly on a sphere shell well outside everything
 * else in the scene, with a realistic-ish brightness distribution (many faint,
 * few bright) and slight colour variation from blue-white to amber. A small
 * per-star twinkle phase is animated in the vertex shader so the field is
 * alive without ever drawing attention to itself.
 *
 * The positions are generated from a fixed seed, so the sky is identical on
 * every run - useful when comparing screenshots during UI work.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
} from 'three';

export const STAR_COUNT = 4200;
const SHELL_RADIUS = 300;

const vertexShader = /* glsl */ `
  attribute float size;
  attribute float phase;
  uniform float time;
  uniform float pixelRatio;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = color;
    // Slow, shallow twinkle. Amplitude is deliberately small.
    vAlpha = 0.72 + 0.28 * sin(time * 0.55 + phase * 6.2831);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * pixelRatio;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // Round, soft-edged point sprite - no texture needed.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    float a = smoothstep(1.0, 0.0, r);
    a *= a;
    gl_FragColor = vec4(vColor, a * vAlpha);
  }
`;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StarField {
  points: Points;
  update: (elapsedS: number) => void;
  dispose: () => void;
}

export function createStars(count = STAR_COUNT, pixelRatio = 1): StarField {
  const r = rng(0x5747A5);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Uniform on a sphere: z uniform in [-1,1], theta uniform in [0,2pi).
    const z = r() * 2 - 1;
    const theta = r() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    positions[i * 3] = Math.cos(theta) * s * SHELL_RADIUS;
    positions[i * 3 + 1] = z * SHELL_RADIUS;
    positions[i * 3 + 2] = Math.sin(theta) * s * SHELL_RADIUS;

    // Brightness: heavily weighted towards faint. x^3 gives a believable
    // distribution where only a handful of stars dominate.
    const mag = r();
    const bright = 0.28 + 0.72 * mag * mag * mag;

    // Colour temperature: mostly blue-white, a minority warm.
    const warm = r();
    const cr = warm > 0.78 ? 1.0 : 0.82 + 0.18 * warm;
    const cg = warm > 0.78 ? 0.86 + 0.1 * r() : 0.88 + 0.12 * warm;
    const cb = warm > 0.78 ? 0.7 : 1.0;
    colors[i * 3] = cr * bright;
    colors[i * 3 + 1] = cg * bright;
    colors[i * 3 + 2] = cb * bright;

    sizes[i] = 0.9 + mag * mag * 3.6;
    phases[i] = r();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('size', new Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('phase', new Float32BufferAttribute(phases, 1));

  const material = new ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      pixelRatio: { value: pixelRatio },
    },
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });

  const points = new Points(geometry, material);
  points.name = 'Stars';
  points.frustumCulled = false;
  points.renderOrder = -1; // drawn first, behind everything

  return {
    points,
    update: (elapsedS) => {
      material.uniforms.time!.value = elapsedS;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

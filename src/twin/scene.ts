/**
 * RENDERER + SCENE ROOT
 * =============================================================================
 * Three.js WebGLRenderer requires WebGL 2. If the context cannot be created we
 * show a readable diagnostic rather than a black page (see index.html #fatal).
 *
 * Scene units: 1 unit = 1000 km (see orbit/frames.ts). The camera's near/far
 * planes are chosen so that a 0.02-unit CubeSat and a 60-unit-wide star shell
 * both stay in range without z-fighting.
 */

import {
  ACESFilmicToneMapping,
  Color,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

export interface SceneContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Call on every resize; also called once at construction. */
  resize: () => void;
  dispose: () => void;
}

export class WebGL2UnavailableError extends Error {}

/** Cap the device pixel ratio: a 4K projector at DPR 2 is 4x the fill cost. */
const MAX_PIXEL_RATIO = 1.75;

export function createSceneContext(canvas: HTMLCanvasElement): SceneContext {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      logarithmicDepthBuffer: false,
    });
  } catch (err) {
    throw new WebGL2UnavailableError(String(err));
  }

  // Three r15x+ is WebGL2-only; a context without it will not have been created.
  const gl = renderer.getContext();
  if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
    throw new WebGL2UnavailableError('WebGL 2 rendering context unavailable');
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x04070c, 1);
  renderer.autoClear = true;

  const scene = new Scene();
  scene.background = new Color(0x04070c);

  const camera = new PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.01, 400);
  camera.position.set(0, 8, 26);
  camera.lookAt(0, 0, 0);

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(w, h, false);
  };
  resize();

  window.addEventListener('resize', resize);

  return {
    renderer,
    scene,
    camera,
    canvas,
    resize,
    dispose: () => {
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}

/**
 * Reduce the pixel ratio when the frame rate will not hold up. Called by the
 * performance governor in main.ts - the first thing to give up is resolution,
 * never telemetry legibility.
 */
export function degradePixelRatio(renderer: WebGLRenderer): boolean {
  const current = renderer.getPixelRatio();
  if (current <= 1) return false;
  renderer.setPixelRatio(Math.max(1, current - 0.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  return true;
}

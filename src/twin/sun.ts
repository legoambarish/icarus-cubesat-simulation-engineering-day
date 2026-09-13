/**
 * SUN
 * =============================================================================
 * Three things share one name here:
 *
 *   1. a DirectionalLight that gives the scene its single light direction, and
 *      therefore the Earth's terminator and the CubeSat's lit faces;
 *   2. a bright disc with a chromatic corona, so the audience can see where
 *      the light is coming from;
 *   3. a screen-space glare sprite - bloom plus four diffraction spikes - which
 *      is what actually makes it read as a SUN rather than a yellow ball.
 *
 * The glare is drawn as a single point sprite sized in CSS pixels, so it keeps
 * its presence at any camera distance without the disc itself having to be
 * absurdly large. It is the cheapest possible stand-in for a bloom pass: one
 * quad, no render targets, no post-processing chain to destabilise the scene.
 *
 * The direction is the real Sun direction from the mission clock (see
 * orbit/eclipse.ts - sunDirectionEci), converted once through sceneFromEci.
 * That is what makes the eclipse in the telemetry agree with what is on screen.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { sceneFromEci, type EciVec } from '../orbit/frames.ts';

/** Distance at which the Sun is parked, in scene units (1 unit = 1000 km). */
const SUN_DISTANCE = 190;
const SUN_CORE_RADIUS = 5.2;

/* ==========================================================================
 * Corona: a back-face shell around the disc, brightest at the rim.
 * ========================================================================== */

const coronaVertex = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const coronaFragment = /* glsl */ `
  uniform vec3 innerColor;
  uniform vec3 outerColor;
  uniform float intensity;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  void main() {
    vec3 V = normalize(-vViewPos);
    float f = clamp(1.0 - abs(dot(normalize(vNormalV), V)), 0.0, 1.0);
    // Two falloffs stacked: a tight hot rim and a wide warm bloom.
    float tight = pow(f, 5.0);
    float wide  = pow(f, 1.6) * 0.45;
    float a = (tight + wide) * intensity;
    vec3 rgb = mix(outerColor, innerColor, tight);
    gl_FragColor = vec4(rgb * a, a);
  }
`;

/* ==========================================================================
 * Glare: one screen-space sprite - bloom, spikes and a faint halo ring.
 * ========================================================================== */

const glareVertex = /* glsl */ `
  uniform float size;
  uniform float pixelRatio;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pixelRatio;
  }
`;

const glareFragment = /* glsl */ `
  precision highp float;
  uniform vec3 coreColor;
  uniform vec3 glowColor;
  uniform float intensity;

  void main() {
    vec2 p = (gl_PointCoord - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    // Broad bloom.
    float bloom = pow(max(0.0, 1.0 - r), 3.2) * 0.55;

    // Four long diffraction spikes, two long and two short - asymmetry reads
    // as a real optic rather than a symmetrical star stamp.
    float ax = abs(p.x);
    float ay = abs(p.y);
    float spikeH = pow(max(0.0, 1.0 - ay / 0.030), 2.0) * pow(max(0.0, 1.0 - ax), 1.6);
    float spikeV = pow(max(0.0, 1.0 - ax / 0.024), 2.0) * pow(max(0.0, 1.0 - ay), 2.1) * 0.75;
    float spikes = clamp(spikeH + spikeV, 0.0, 1.0) * 0.62;

    // A faint ghost ring, the sort a lens flare leaves behind.
    float ring = smoothstep(0.05, 0.0, abs(r - 0.58)) * 0.10;

    float a = clamp(bloom + spikes + ring, 0.0, 1.0) * intensity;
    vec3 rgb = mix(glowColor, coreColor, clamp(bloom * 2.2 + spikes, 0.0, 1.0));
    gl_FragColor = vec4(rgb, a);
  }
`;

export interface SunObject {
  group: Group;
  light: DirectionalLight;
  /** Current unit direction Earth -> Sun in RENDER space. */
  direction: Vector3;
  /** Feed the ECI Sun direction; everything else follows. */
  setDirectionEci: (eci: EciVec) => void;
  /**
   * How much of the Sun the camera can actually see, 0..1.
   *
   * The glare CANNOT be occluded by the depth buffer. It is a point sprite:
   * every pixel of the quad shares the single depth of its centre vertex, so
   * a 400-pixel sprite whose centre happens to sit just off the Earth's disc
   * passes the depth test in one piece and paints straight over the planet.
   * The caller therefore does the occlusion test itself (a ray/sphere
   * intersection against the Earth) and passes the result here.
   */
  setGlareVisibility: (visible: number) => void;
  dispose: () => void;
}

export function createSun(pixelRatio = 1): SunObject {
  const group = new Group();
  group.name = 'Sun';

  /* ---- the disc ------------------------------------------------------- */
  const coreGeo = new SphereGeometry(SUN_CORE_RADIUS, 40, 28);
  const coreMat = new MeshBasicMaterial({ color: new Color(0xfff6e2), fog: false, toneMapped: false });
  const core = new Mesh(coreGeo, coreMat);
  core.renderOrder = 2;

  /* ---- corona --------------------------------------------------------- */
  const coronaGeo = new SphereGeometry(SUN_CORE_RADIUS * 3.4, 40, 28);
  const coronaMat = new ShaderMaterial({
    uniforms: {
      innerColor: { value: new Color(0xffe8b0) },
      outerColor: { value: new Color(0xff9b3d) },
      intensity: { value: 1.15 },
    },
    vertexShader: coronaVertex,
    fragmentShader: coronaFragment,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const corona = new Mesh(coronaGeo, coronaMat);
  corona.renderOrder = 2;

  /* ---- screen-space glare --------------------------------------------- */
  const glareGeo = new BufferGeometry();
  glareGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
  const glareMat = new ShaderMaterial({
    uniforms: {
      size: { value: 430 },
      pixelRatio: { value: pixelRatio },
      coreColor: { value: new Color(0xfffdf4) },
      glowColor: { value: new Color(0xffb257) },
      intensity: { value: 0.92 },
    },
    vertexShader: glareVertex,
    fragmentShader: glareFragment,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    // Depth-tested, so the Earth occludes it. A real lens flare does bleed
    // around an occluder, but a 500-pixel additive sprite painting over the
    // planet washes out the terminator - the single most informative thing on
    // screen - so correctness wins over the flourish here.
    depthTest: true,
    toneMapped: false,
  });
  const glare = new Points(glareGeo, glareMat);
  glare.frustumCulled = false;
  glare.renderOrder = 6;

  group.add(core, corona, glare);

  /* ---- the light ------------------------------------------------------- */
  // Directional, so only its direction matters; parking it at the billboard
  // keeps "where the light comes from" and "where the Sun is drawn" impossible
  // to get out of sync.
  const light = new DirectionalLight(0xfff2e0, 3.1);
  light.position.set(SUN_DISTANCE, 0, 0);
  light.target.position.set(0, 0, 0);

  const direction = new Vector3(1, 0, 0);
  const tmp = new Vector3();
  const GLARE_INTENSITY = 0.92;
  let glareVisibility = 1;

  return {
    group,
    light,
    direction,
    setDirectionEci: (eci) => {
      sceneFromEci(eci, tmp).normalize();
      direction.copy(tmp);
      group.position.copy(tmp).multiplyScalar(SUN_DISTANCE);
      light.position.copy(group.position);
    },
    setGlareVisibility: (visible) => {
      const v = visible < 0 ? 0 : visible > 1 ? 1 : visible;
      if (Math.abs(v - glareVisibility) < 0.002) return;
      glareVisibility = v;
      glareMat.uniforms.intensity!.value = GLARE_INTENSITY * v;
      glare.visible = v > 0.004;
      // The disc and corona are ordinary geometry, so the depth buffer already
      // hides them correctly; only the sprite needs help.
    },
    dispose: () => {
      coreGeo.dispose();
      coreMat.dispose();
      coronaGeo.dispose();
      coronaMat.dispose();
      glareGeo.dispose();
      glareMat.dispose();
    },
  };
}

/**
 * ICARUS - procedural 1U CubeSat model
 * =============================================================================
 * Built from primitives rather than an external CAD file: no asset pipeline, no
 * licence question, and it loads instantly.
 *
 * HIERARCHY (attitude is applied to the ROOT and nothing else)
 *
 *   CubeSatRoot                <- quaternion from the ADCS state goes here
 *     Body                     structural chassis
 *       Rails         x4       the 1U corner rails, anodised aluminium
 *       FacePanels    x6       recessed panels
 *       SolarCells    x4       near-black cells on the four side faces
 *       Antenna                a short monopole + base
 *       StatusLight            green nominal / amber ADCS / red safe mode
 *     ReactionWheel            spins locally; NOT part of the attitude chain
 *
 * SCALE: a real 1U is 0.1 m, which at 1 scene unit = 1000 km would be 1e-10
 * units - invisible. The model is drawn at MODEL_SIZE units (~180 km across)
 * so the audience can see it. Its POSITION is exact; only its size is
 * exaggerated, and the UI says so.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  type Material,
} from 'three';

/** Edge length of the drawn cube, in scene units (1 unit = 1000 km). */
export const MODEL_SIZE = 0.185;

export type CubeSatVisualState = 'nominal' | 'adcs' | 'safe';

export interface CubeSatModel {
  /** Attach to the scene; position is set by the caller each frame. */
  root: Group;
  /** Apply the ADCS quaternion to THIS node only. */
  attitudeRoot: Group;
  /** Advance local animation (wheel spin, status light, cutaway fade). */
  update: (dtSeconds: number, wheelActivity: number) => void;
  /**
   * Crossfade between the beacon and the model.
   *
   * A 1U CubeSat drawn at true scale would be 1e-7 scene units. Even at the
   * exaggerated MODEL_SIZE it is only a few pixels from the wide Earth view, so
   * far away we draw a bright beacon (findable) and close up we draw the model
   * (informative). Pass the camera-to-spacecraft distance in scene units.
   */
  setCameraDistance: (distance: number, selected: boolean) => void;
  setVisualState: (state: CubeSatVisualState) => void;
  /** Briefly make the chassis translucent to reveal the reaction wheel. */
  revealInternals: (seconds: number) => void;
  dispose: () => void;
}

export function createCubeSat(): CubeSatModel {
  const root = new Group();
  root.name = 'CubeSatRoot';

  const attitudeRoot = new Group();
  attitudeRoot.name = 'CubeSatAttitude';
  root.add(attitudeRoot);

  const S = MODEL_SIZE;
  const disposables: (Material | { dispose(): void })[] = [];
  const track = <T extends Material | { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  /* ---- materials (shared - one instance per look, not per mesh) --------- */
  const matChassis = track(new MeshStandardMaterial({
    color: 0x9aa6b2,
    metalness: 0.82,
    roughness: 0.42,
  }));
  const matRail = track(new MeshStandardMaterial({
    color: 0xd8dde3,
    metalness: 0.95,
    roughness: 0.22,
  }));
  const matPanel = track(new MeshStandardMaterial({
    color: 0x2c3542,
    metalness: 0.45,
    roughness: 0.62,
  }));
  const matCell = track(new MeshStandardMaterial({
    color: 0x0d1b2e,
    metalness: 0.35,
    roughness: 0.28,
    emissive: new Color(0x061423),
    emissiveIntensity: 0.5,
  }));
  const matAntenna = track(new MeshStandardMaterial({
    color: 0xc9d3dd,
    metalness: 0.9,
    roughness: 0.3,
  }));
  const matWheel = track(new MeshStandardMaterial({
    color: 0x5fd8ff,
    metalness: 0.6,
    roughness: 0.3,
    emissive: new Color(0x1d6a86),
    emissiveIntensity: 0.85,
  }));
  const matStatus = track(new MeshStandardMaterial({
    color: 0x4ce2a4,
    emissive: new Color(0x4ce2a4),
    emissiveIntensity: 2.4,
    roughness: 0.4,
  }));

  const body = new Group();
  body.name = 'Body';
  attitudeRoot.add(body);

  /* ---- chassis: a slightly inset cube so the rails stand proud ---------- */
  const chassisGeo = track(new BoxGeometry(S * 0.9, S * 0.9, S * 0.9));
  const chassis = new Mesh(chassisGeo, matChassis);
  chassis.name = 'Chassis';
  body.add(chassis);

  /* ---- four corner rails along the +Z (stack) axis ---------------------- */
  const railGeo = track(new BoxGeometry(S * 0.11, S * 0.11, S));
  const railOffset = S * 0.445;
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const rail = new Mesh(railGeo, matRail);
    rail.position.set(sx * railOffset, sy * railOffset, 0);
    rail.name = 'Rail';
    body.add(rail);
  }

  /* ---- recessed face panels on all six faces --------------------------- */
  const panelGeoXY = track(new BoxGeometry(S * 0.78, S * 0.78, S * 0.03));
  const panelGeoXZ = track(new BoxGeometry(S * 0.78, S * 0.03, S * 0.78));
  const panelGeoYZ = track(new BoxGeometry(S * 0.03, S * 0.78, S * 0.78));
  const faceZ = S * 0.462;
  for (const s of [1, -1]) {
    const p = new Mesh(panelGeoXY, matPanel);
    p.position.z = s * faceZ;
    p.name = 'FacePanel';
    body.add(p);
  }

  /* ---- solar cells on the four side faces ------------------------------ */
  const cellGeoXZ = track(new BoxGeometry(S * 0.74, S * 0.022, S * 0.74));
  const cellGeoYZ = track(new BoxGeometry(S * 0.022, S * 0.74, S * 0.74));
  for (const s of [1, -1]) {
    const base = new Mesh(panelGeoXZ, matPanel);
    base.position.y = s * faceZ;
    body.add(base);
    const cell = new Mesh(cellGeoXZ, matCell);
    cell.position.y = s * (faceZ + S * 0.022);
    cell.name = 'SolarCells';
    body.add(cell);
  }
  for (const s of [1, -1]) {
    const base = new Mesh(panelGeoYZ, matPanel);
    base.position.x = s * faceZ;
    body.add(base);
    const cell = new Mesh(cellGeoYZ, matCell);
    cell.position.x = s * (faceZ + S * 0.022);
    cell.name = 'SolarCells';
    body.add(cell);
  }

  /* ---- antenna: a base puck plus a short monopole ---------------------- */
  const antBaseGeo = track(new CylinderGeometry(S * 0.07, S * 0.07, S * 0.05, 14));
  const antBase = new Mesh(antBaseGeo, matAntenna);
  antBase.position.set(0, 0, faceZ + S * 0.025);
  antBase.rotation.x = Math.PI / 2;
  body.add(antBase);

  const antGeo = track(new CylinderGeometry(S * 0.012, S * 0.012, S * 0.62, 8));
  const antenna = new Mesh(antGeo, matAntenna);
  antenna.name = 'Antenna';
  antenna.position.set(0, 0, faceZ + S * 0.34);
  antenna.rotation.x = Math.PI / 2;
  body.add(antenna);

  const antTipGeo = track(new SphereGeometry(S * 0.026, 10, 8));
  const antTip = new Mesh(antTipGeo, matAntenna);
  antTip.position.set(0, 0, faceZ + S * 0.65);
  body.add(antTip);

  /* ---- status light on the -Z face ------------------------------------- */
  const statusGeo = track(new SphereGeometry(S * 0.035, 12, 10));
  const statusLight = new Mesh(statusGeo, matStatus);
  statusLight.position.set(S * 0.25, S * 0.25, -(faceZ + S * 0.01));
  statusLight.name = 'StatusLight';
  body.add(statusLight);

  /* ---- internal reaction wheel -----------------------------------------
   * Sits inside the chassis, spins about the body +Z axis. It is a CHILD of
   * the attitude root (so it moves with the spacecraft) but its own rotation
   * is purely local animation - it never feeds back into attitude.        */
  const wheelGroup = new Group();
  wheelGroup.name = 'ReactionWheel';
  const wheelGeo = track(new CylinderGeometry(S * 0.29, S * 0.29, S * 0.075, 26));
  const wheel = new Mesh(wheelGeo, matWheel);
  wheel.rotation.x = Math.PI / 2;
  wheelGroup.add(wheel);

  const wheelRimGeo = track(new TorusGeometry(S * 0.29, S * 0.022, 8, 28));
  const wheelRim = new Mesh(wheelRimGeo, matWheel);
  wheelGroup.add(wheelRim);

  // Spokes make the rotation legible - a smooth disc looks static.
  const spokeGeo = track(new BoxGeometry(S * 0.5, S * 0.022, S * 0.03));
  for (let i = 0; i < 3; i++) {
    const spoke = new Mesh(spokeGeo, matWheel);
    spoke.rotation.z = (i * Math.PI) / 3;
    wheelGroup.add(spoke);
  }
  wheelGroup.visible = false; // only shown during the cutaway
  attitudeRoot.add(wheelGroup);

  /* ---- beacon ----------------------------------------------------------
   * One additive point that marks where ICARUS is from across the scene.
   * Sized in screen pixels, so it stays findable at any zoom level.       */
  const beaconGeo = new BufferGeometry();
  beaconGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
  const beaconMat = new ShaderMaterial({
    uniforms: {
      size: { value: 22 },
      alpha: { value: 1 },
      tint: { value: new Color(0x4ce2a4) },
    },
    vertexShader: /* glsl */ `
      uniform float size;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float alpha;
      uniform vec3 tint;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d) * 2.0;
        // Bright core plus a soft halo - reads as a spacecraft beacon rather
        // than a blurry dot.
        float core = smoothstep(0.34, 0.0, r);
        float halo = smoothstep(1.0, 0.18, r) * 0.42;
        float a = (core + halo) * alpha;
        if (a < 0.002) discard;
        gl_FragColor = vec4(tint, a);
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  disposables.push(beaconGeo, beaconMat);
  const beacon = new Points(beaconGeo, beaconMat);
  beacon.name = 'IcarusBeacon';
  beacon.frustumCulled = false;
  beacon.renderOrder = 4;
  root.add(beacon);

  /* ---- animation state -------------------------------------------------- */
  let wheelAngle = 0;
  let wheelRate = 0;
  let cutawayRemaining = 0;
  let chassisOpacity = 1;
  let visualState: CubeSatVisualState = 'nominal';

  const chassisMaterials = [matChassis, matPanel, matRail, matCell];
  for (const m of chassisMaterials) m.transparent = false;

  const STATUS_COLORS: Record<CubeSatVisualState, number> = {
    nominal: 0x4ce2a4,
    adcs: 0x5fd8ff,
    safe: 0xff5a5f,
  };

  return {
    root,
    attitudeRoot,

    update: (dt, wheelActivity) => {
      // Wheel speed tracks the controller's torque demand with some inertia,
      // and idles at a low bias speed so it is never frozen.
      const targetRate = 2.2 + wheelActivity * 26;
      wheelRate += (targetRate - wheelRate) * Math.min(1, dt * 3);
      wheelAngle = (wheelAngle + wheelRate * dt) % (Math.PI * 2);
      wheelGroup.rotation.z = wheelAngle;

      // Antenna gets a tiny sway so the model is never completely still.
      antenna.rotation.z = Math.sin(wheelAngle * 0.12) * 0.02;

      // Status light pulse.
      const pulse = visualState === 'safe' ? 1.4 + Math.sin(wheelAngle * 2.4) * 1.0 : 2.4;
      matStatus.emissiveIntensity = pulse;

      // Cutaway fade in / out.
      if (cutawayRemaining > 0) {
        cutawayRemaining -= dt;
        chassisOpacity += (0.24 - chassisOpacity) * Math.min(1, dt * 4);
        wheelGroup.visible = true;
      } else if (chassisOpacity < 0.999) {
        chassisOpacity += (1 - chassisOpacity) * Math.min(1, dt * 3);
        if (chassisOpacity > 0.985) {
          chassisOpacity = 1;
          wheelGroup.visible = false;
        }
      }

      const transparent = chassisOpacity < 0.999;
      for (const m of chassisMaterials) {
        if (m.transparent !== transparent) {
          m.transparent = transparent;
          m.depthWrite = !transparent;
          m.needsUpdate = true;
        }
        m.opacity = chassisOpacity;
      }
    },

    setCameraDistance: (distance, selected) => {
      // Model fades in between 3.4 and 2.0 units (3400 -> 2000 km); the beacon
      // fades out over the same band so exactly one of them is ever prominent.
      const modelIn = clamp01((3.4 - distance) / 1.4);
      attitudeRoot.visible = modelIn > 0.01;
      attitudeRoot.scale.setScalar(0.55 + 0.45 * modelIn);

      beaconMat.uniforms.alpha!.value = 1 - modelIn * 0.85;
      beaconMat.uniforms.size!.value = selected ? 30 : 20;
      (beaconMat.uniforms.tint!.value as Color).setHex(
        visualState === 'safe' ? 0xff5a5f : visualState === 'adcs' ? 0x5fd8ff : 0x4ce2a4,
      );
    },

    setVisualState: (s) => {
      if (visualState === s) return;
      visualState = s;
      const c = STATUS_COLORS[s];
      matStatus.color.setHex(c);
      matStatus.emissive.setHex(c);
      // In safe mode the spacecraft goes visibly "cold": cells stop glowing.
      matCell.emissiveIntensity = s === 'safe' ? 0.05 : 0.5;
      matWheel.emissiveIntensity = s === 'adcs' ? 1.5 : 0.85;
    },

    revealInternals: (seconds) => {
      cutawayRemaining = Math.max(cutawayRemaining, seconds);
    },

    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

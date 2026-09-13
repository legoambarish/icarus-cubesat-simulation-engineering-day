/**
 * CAMERA CONTROLLER
 * =============================================================================
 * A purpose-built orbit controller rather than three's OrbitControls example
 * module, because this scene needs three behaviours that are awkward to bolt on:
 *
 *   1. IDLE DRIFT - when nobody has touched anything for a few seconds the
 *      camera resumes a very slow azimuth crawl, so the exhibit looks alive
 *      with no visitor present.
 *   2. USER OVERRIDE - any pointer or wheel input cancels the drift instantly
 *      and it only comes back after IDLE_RESUME_S of quiet. The auto camera
 *      must never fight the person holding the mouse.
 *   3. FOCUS TRANSITIONS - selecting an object smoothly retargets and reframes
 *      using critically damped interpolation, and the target keeps tracking the
 *      object afterwards as it moves along its orbit.
 *
 * Spherical coordinates (radius, azimuth theta, polar phi) around a target
 * point; nothing here touches the ECI frame.
 */

import { MathUtils, PerspectiveCamera, Spherical, Vector3 } from 'three';

/**
 * Default stand-off distance for the wide Earth view, in scene units.
 * At fov 38 deg this puts the whole globe plus the LEO orbit shell inside the
 * frame with margin, so the HUD panels never crowd the planet.
 */
export const WIDE_VIEW_RADIUS = 33;
const MIN_RADIUS = 6.75; // just above the Earth's surface (6.371 units)
const MAX_RADIUS = 90;
const IDLE_RESUME_S = 6;
const IDLE_RATE_RAD_S = 0.0165; // ~one revolution every 6.3 minutes
const ZOOM_STEP = 1.12;

export interface CameraController {
  /**
   * `followTarget` is only honoured while the controller is in FOLLOW mode,
   * which focus() turns on and reset() turns off. Without that distinction the
   * camera would latch onto the default selection at startup and swing the
   * Earth off-centre before anyone has touched anything.
   */
  update: (dtSeconds: number, followTarget: Vector3 | null) => void;
  /** Smoothly move to look at a point from `radius` away, and follow it. */
  focus: (target: Vector3, radius: number) => void;
  /** Return to the wide Earth view and stop following. */
  reset: () => void;
  /** Point the camera so the sunlit limb faces the viewer. */
  frameSunlitSide: (sunDirection: Vector3) => void;
  /** True while a focus transition is still running. */
  isTransitioning: () => boolean;
  /** Seconds since the last user input. */
  idleFor: () => number;
  dispose: () => void;
}

export function createCameraController(
  camera: PerspectiveCamera,
  domElement: HTMLElement,
): CameraController {
  /* ---- current state ---- */
  const spherical = new Spherical(WIDE_VIEW_RADIUS, Math.PI / 2 - 0.30, 0.6);
  const target = new Vector3(0, 0, 0);

  /* ---- interpolation goals ---- */
  const goalSpherical = spherical.clone();
  const goalTarget = target.clone();
  let transitioning = false;
  let following = false;

  let idleS = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let activePointer: number | null = null;
  const pinch = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  const noteInput = () => {
    idleS = 0;
    transitioning = false;
  };

  /* ---------------------------------------------------------------- input */

  const onPointerDown = (ev: PointerEvent) => {
    pinch.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch.size === 2) {
      const [a, b] = [...pinch.values()];
      pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      dragging = false;
      return;
    }
    if (activePointer !== null) return;
    activePointer = ev.pointerId;
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    domElement.classList.add('dragging');
    domElement.setPointerCapture?.(ev.pointerId);
    noteInput();
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (pinch.has(ev.pointerId)) pinch.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (pinch.size === 2) {
      const [a, b] = [...pinch.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDistance > 0) {
        goalSpherical.radius = MathUtils.clamp(
          goalSpherical.radius * (pinchDistance / d),
          MIN_RADIUS,
          MAX_RADIUS,
        );
      }
      pinchDistance = d;
      noteInput();
      return;
    }

    if (!dragging || ev.pointerId !== activePointer) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;

    // Rotation rate scales with the field of view so zoomed-in dragging is not
    // hypersensitive.
    const rate = 0.0042 * (camera.fov / 38);
    goalSpherical.theta -= dx * rate;
    goalSpherical.phi = MathUtils.clamp(goalSpherical.phi - dy * rate, 0.08, Math.PI - 0.08);
    noteInput();
  };

  const endPointer = (ev: PointerEvent) => {
    pinch.delete(ev.pointerId);
    if (pinch.size < 2) pinchDistance = 0;
    if (ev.pointerId !== activePointer) return;
    activePointer = null;
    dragging = false;
    domElement.classList.remove('dragging');
    domElement.releasePointerCapture?.(ev.pointerId);
  };

  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const factor = ev.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    goalSpherical.radius = MathUtils.clamp(goalSpherical.radius * factor, MIN_RADIUS, MAX_RADIUS);
    noteInput();
  };

  domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  domElement.addEventListener('wheel', onWheel, { passive: false });

  /* --------------------------------------------------------------- update */

  const tmp = new Vector3();

  /**
   * Frame-rate independent exponential smoothing.
   * factor = 1 - exp(-rate * dt) converges at the same speed at 30 or 144 FPS.
   */
  const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

  return {
    update: (dt, followTarget) => {
      idleS += dt;

      // Keep the goal target locked to the followed object as it moves - but
      // only once the user has actually asked to follow something.
      if (following && followTarget) goalTarget.copy(followTarget);

      // Idle drift, only when nothing is being transitioned or dragged.
      if (idleS > IDLE_RESUME_S && !dragging && !transitioning) {
        goalSpherical.theta += IDLE_RATE_RAD_S * dt;
      }

      const kFast = smooth(transitioning ? 3.1 : 9.0, dt);
      spherical.radius += (goalSpherical.radius - spherical.radius) * kFast;
      spherical.phi += (goalSpherical.phi - spherical.phi) * kFast;

      // Interpolate azimuth the short way round.
      let dTheta = goalSpherical.theta - spherical.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      spherical.theta += dTheta * kFast;

      target.lerp(goalTarget, smooth(transitioning ? 3.4 : 7.5, dt));

      if (
        transitioning
        && Math.abs(goalSpherical.radius - spherical.radius) < 0.03
        && target.distanceTo(goalTarget) < 0.03
      ) {
        transitioning = false;
      }

      spherical.makeSafe();
      camera.position.copy(tmp.setFromSpherical(spherical).add(target));
      camera.lookAt(target);
    },

    focus: (t, radius) => {
      following = true;
      goalTarget.copy(t);
      goalSpherical.radius = MathUtils.clamp(radius, MIN_RADIUS, MAX_RADIUS);
      // Nudge the elevation towards a pleasant three-quarter view.
      goalSpherical.phi = MathUtils.clamp(goalSpherical.phi * 0.6 + 1.16 * 0.4, 0.3, Math.PI - 0.3);
      transitioning = true;
      idleS = 0;
    },

    reset: () => {
      following = false;
      goalTarget.set(0, 0, 0);
      goalSpherical.radius = WIDE_VIEW_RADIUS;
      goalSpherical.phi = Math.PI / 2 - 0.30;
      transitioning = true;
      idleS = 0;
    },

    /**
     * Put the camera where the Earth reads best: three-quarters lit, with the
     * terminator running down the frame rather than the night side facing us.
     * Called once at startup so the exhibit looks right with no interaction.
     */
    frameSunlitSide: (sunDirection) => {
      if (following) return;
      // Azimuth of the Sun in the render frame's XZ plane, offset by ~38 deg so
      // we see both the lit face and a slice of the terminator.
      const sunTheta = Math.atan2(sunDirection.x, sunDirection.z);
      goalSpherical.theta = sunTheta + 0.66;
      spherical.theta = goalSpherical.theta;
      const sunPhi = Math.acos(MathUtils.clamp(sunDirection.y, -1, 1));
      goalSpherical.phi = MathUtils.clamp(sunPhi * 0.55 + (Math.PI / 2) * 0.45, 0.55, Math.PI - 0.55);
      spherical.phi = goalSpherical.phi;
    },

    isTransitioning: () => transitioning,
    idleFor: () => idleS,

    dispose: () => {
      domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
      domElement.removeEventListener('wheel', onWheel);
    },
  };
}

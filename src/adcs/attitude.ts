/**
 * ATTITUDE REPRESENTATION
 * =============================================================================
 * The visitor manipulates roll / pitch / yaw because those are intuitive.
 * Internally the spacecraft orientation is a QUATERNION, for two reasons:
 *
 *   * no gimbal lock - Euler angles degenerate when pitch approaches +-90 deg
 *   * clean integration - attitude is advanced by integrating body rates,
 *     which is natural in quaternion form and awkward in Euler form
 *
 * ROTATION ORDER (documented once, used everywhere)
 * -------------------------------------------------
 *   Three.js Euler order 'ZYX', i.e. the rotations are applied
 *       yaw about body +Z, then pitch about body +Y, then roll about body +X.
 *   Equivalently R = Rz(yaw) * Ry(pitch) * Rx(roll).
 *
 * BODY AXES
 * ---------
 *   +X  "forward"  along the velocity vector (roll axis)
 *   +Y  "right"                              (pitch axis)
 *   +Z  "up"       nominally nadir-opposite  (yaw axis)
 *
 * Attitude NEVER affects the orbital path. The only couplings between
 * orientation and the rest of the spacecraft are physical ones: solar array
 * illumination and the ADCS control loop.
 */

import { Euler, Quaternion, Vector3 } from 'three';

export const EULER_ORDER = 'ZYX' as const;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface AttitudeState {
  /** Current orientation, body -> inertial. */
  quaternion: Quaternion;
  /** Commanded orientation. */
  target: Quaternion;
  /** Body rates, rad/s, expressed in the body frame. */
  omega: Vector3;
}

/** roll/pitch/yaw in degrees -> quaternion, using the documented ZYX order. */
export function quaternionFromRpyDeg(rollDeg: number, pitchDeg: number, yawDeg: number, out = new Quaternion()): Quaternion {
  return out.setFromEuler(new Euler(rollDeg * D2R, pitchDeg * D2R, yawDeg * D2R, EULER_ORDER));
}

/** quaternion -> roll/pitch/yaw in degrees, inverse of the above. */
export function rpyDegFromQuaternion(q: Quaternion): { rollDeg: number; pitchDeg: number; yawDeg: number } {
  const e = new Euler().setFromQuaternion(q, EULER_ORDER);
  return { rollDeg: e.x * R2D, pitchDeg: e.y * R2D, yawDeg: e.z * R2D };
}

/**
 * Attitude error as a rotation vector, in the BODY frame.
 *
 * q_err = q_current^-1 * q_target describes the rotation that still has to be
 * applied (expressed in body axes) to reach the target. Writing q_err as
 * (w, v) with a unit axis n and angle theta:  v = n sin(theta/2), w = cos(theta/2).
 * For small errors the rotation vector is therefore ~ 2*v, and the sign of w is
 * forced positive so we always take the short way round (a quaternion and its
 * negation are the same rotation).
 *
 * Returned vector points FROM current TOWARDS target, so the control torque is
 * +Kp * error (see controller.ts).
 */
export function attitudeErrorVector(current: Quaternion, target: Quaternion, out = new Vector3()): Vector3 {
  const qe = current.clone().invert().multiply(target);
  if (qe.w < 0) {
    qe.x = -qe.x;
    qe.y = -qe.y;
    qe.z = -qe.z;
    qe.w = -qe.w;
  }
  const sinHalf = Math.hypot(qe.x, qe.y, qe.z);
  if (sinHalf < 1e-9) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(sinHalf, qe.w); // 0 .. pi
  return out.set(qe.x / sinHalf, qe.y / sinHalf, qe.z / sinHalf).multiplyScalar(angle);
}

/**
 * Total pointing error between two orientations, degrees (0..180).
 *
 * Uses atan2(|v|, |w|) rather than acos(|w|). They are equal in exact
 * arithmetic, but acos is ill-conditioned near its argument reaching 1 - which
 * is precisely the case that matters here, a spacecraft almost on target. With
 * acos, a settled attitude reports a few microdegrees of phantom error; atan2
 * is well-conditioned across the whole range and reports zero.
 */
export function attitudeErrorDeg(current: Quaternion, target: Quaternion): number {
  const qe = current.clone().invert().multiply(target);
  const sinHalf = Math.hypot(qe.x, qe.y, qe.z);
  return 2 * Math.atan2(sinHalf, Math.abs(qe.w)) * R2D;
}

/**
 * Advance an orientation by a body angular rate over dt.
 *
 *   q_dot = 0.5 * q (x) (0, omega)
 *
 * with omega in the BODY frame. First-order integration plus renormalisation
 * is plenty at a 10 Hz simulation step and matches what the C OBC does.
 */
export function integrateQuaternion(q: Quaternion, omegaRadS: Vector3, dt: number, out = new Quaternion()): Quaternion {
  const dq = new Quaternion(omegaRadS.x * dt * 0.5, omegaRadS.y * dt * 0.5, omegaRadS.z * dt * 0.5, 1);
  out.copy(q).multiply(dq).normalize();
  return out;
}

export function degPerSec(v: Vector3): [number, number, number] {
  return [v.x * R2D, v.y * R2D, v.z * R2D];
}

export function wrap180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (Object.is(d, -180)) d = 180;
  return d;
}

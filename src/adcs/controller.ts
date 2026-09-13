/**
 * ADCS - a bounded educational feedback controller
 * =============================================================================
 * NOT flight software. This is the smallest model that demonstrates a real
 * closed loop: measure the error, apply a corrective torque proportional to it,
 * damp the resulting rate, saturate the actuator, watch the error decay.
 *
 *   tau = Kp * e  -  Kd * omega            (e points current -> target)
 *   |tau| clamped to MAX_TORQUE            (a reaction wheel cannot do more)
 *   omega_dot = tau / I                    (rigid body, diagonal inertia)
 *
 * The build manual writes this as tau = -Kp*error - Kd*omega with the error
 * measured target -> current; attitudeErrorVector() returns current -> target,
 * so the sign on the proportional term is positive here. Same controller.
 *
 * Kp/Kd are tuned for a visibly *underdamped-but-settling* response: the
 * visitor should see the error overshoot slightly and then converge in roughly
 * 12-20 seconds, which reads well from across a room.
 *
 * What a flight-qualified implementation would add: real sensors (sun sensor,
 * magnetometer, gyro) with noise and bias, an attitude estimator (EKF/QUEST),
 * actuator models with momentum build-up and magnetorquer desaturation,
 * disturbance torques (gravity gradient, aerodynamic, solar pressure, residual
 * dipole), and rigorous stability margins.
 */

import { Quaternion, Vector3 } from 'three';
import { attitudeErrorVector, integrateQuaternion } from './attitude.ts';

/** Proportional gain [N.m per rad of error]. */
export const KP = 0.9;
/** Derivative (rate damping) gain [N.m per rad/s]. */
export const KD = 0.35;
/** Reaction-wheel torque authority [N.m], scaled for the demo timescale. */
export const MAX_TORQUE = 2.0;
/**
 * Effective moment of inertia, kg.m^2.
 *
 * With a PD law the 2 % settling time is ts = 8*I/Kd, independent of Kp - so I
 * is chosen to give ts ~ 15 s, long enough to narrate and short enough to hold
 * an audience. A real 1U is about 0.002 kg.m^2; at that inertia this controller
 * would settle in 50 ms and there would be nothing to see. The damping ratio
 * that falls out is ~0.23, so the response visibly overshoots and then
 * converges, which is the point of showing it at all.
 */
export const INERTIA = 0.66;
/** Body rate below which the loop is considered settled [rad/s]. */
export const SETTLED_RATE_RAD_S = 0.35 * (Math.PI / 180);
/** Pointing error below which the loop is considered settled [rad]. */
export const SETTLED_ERROR_RAD = 0.6 * (Math.PI / 180);

export interface ControlOutput {
  /** Applied torque after saturation, body frame, N.m. */
  torque: Vector3;
  /** Magnitude of the un-saturated demand, used for the wheel indicator. */
  demand: number;
  /** True while the actuator is saturated. */
  saturated: boolean;
}

const _err = new Vector3();
const _tmp = new Vector3();

/** One PD control evaluation. Pure function of (attitude, target, rate). */
export function computeTorque(
  current: Quaternion,
  target: Quaternion,
  omegaRadS: Vector3,
  out: ControlOutput = { torque: new Vector3(), demand: 0, saturated: false },
): ControlOutput {
  attitudeErrorVector(current, target, _err);

  // tau = Kp*e - Kd*omega
  out.torque.copy(_err).multiplyScalar(KP).add(_tmp.copy(omegaRadS).multiplyScalar(-KD));

  const demand = out.torque.length();
  out.demand = demand;
  out.saturated = demand > MAX_TORQUE;
  if (out.saturated) out.torque.multiplyScalar(MAX_TORQUE / demand);
  return out;
}

export interface AdcsStepResult {
  torqueMagnitude: number;
  saturated: boolean;
  /** Reaction-wheel speed proxy, 0..1, for the visual indicator. */
  wheelActivity: number;
}

/**
 * Advance attitude one fixed step.
 *
 * `enabled` is false in SAFE MODE hold-down periods and while the spacecraft is
 * tumbling from a disturbance before the controller is commanded on - that is
 * what makes the ADCS engagement visible rather than instantaneous.
 */
export function stepAttitude(
  q: Quaternion,
  target: Quaternion,
  omegaRadS: Vector3,
  dt: number,
  enabled: boolean,
): AdcsStepResult {
  let torqueMagnitude = 0;
  let saturated = false;

  if (enabled) {
    const c = computeTorque(q, target, omegaRadS);
    torqueMagnitude = c.torque.length();
    saturated = c.saturated;
    // omega += (tau / I) * dt
    omegaRadS.addScaledVector(c.torque, dt / INERTIA);
  } else {
    // Free drift with a very small residual damping so an un-commanded
    // spacecraft does not spin for ever (aero drag + eddy currents, loosely).
    omegaRadS.multiplyScalar(Math.max(0, 1 - 0.02 * dt));
  }

  integrateQuaternion(q, omegaRadS, dt, q);

  return {
    torqueMagnitude,
    saturated,
    wheelActivity: Math.min(1, torqueMagnitude / MAX_TORQUE),
  };
}

/** True when both the pointing error and the body rate are small. */
export function isSettled(errorRad: number, omegaRadS: Vector3): boolean {
  return errorRad < SETTLED_ERROR_RAD && omegaRadS.length() < SETTLED_RATE_RAD_S;
}

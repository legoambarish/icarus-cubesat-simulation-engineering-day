/*
 * adcs.h - attitude determination and control (educational model)
 */
#ifndef ICARUS_ADCS_H
#define ICARUS_ADCS_H

#include "icarus.h"

/*
 * PD reaction-wheel controller:
 *
 *   e     = rotation vector from the current attitude to the target (body frame)
 *   tau   = Kp * e - Kd * omega,  saturated at ADCS_MAX_TORQUE
 *   omega += (tau / I) * dt
 *   q     += 0.5 * q (x) (0, omega) * dt,  then renormalised
 *
 * NOT flight-qualified: no sensors, no estimator, no momentum management, no
 * disturbance torques. It demonstrates a closed loop, nothing more.
 */
void adcs_update(IcarusState *s, double dt);

/* Apply a bounded angular-rate impulse and open the loop briefly, so the
 * pointing error is visibly allowed to grow before the controller engages. */
void adcs_inject_disturbance(IcarusState *s);

/* Command a new target attitude from roll/pitch/yaw in degrees (ZYX order). */
void adcs_set_target_rpy(IcarusState *s, double roll_deg, double pitch_deg, double yaw_deg);

/* Current roll/pitch/yaw of the spacecraft, degrees (ZYX order). */
void adcs_current_rpy(const IcarusState *s, double *roll_deg, double *pitch_deg, double *yaw_deg);

#endif

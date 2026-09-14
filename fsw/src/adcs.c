/*
 * adcs.c - attitude determination and control
 * ============================================================================
 * NOT FLIGHT SOFTWARE. This is the smallest model that demonstrates a real
 * closed loop: measure the error, apply a corrective torque proportional to
 * it, damp the resulting rate, saturate the actuator, watch the error decay.
 *
 * REPRESENTATION
 *   Orientation is a quaternion (x, y, z, w), body to inertial. Euler angles
 *   are derived only for display, in ZYX order (yaw about body +Z, then pitch
 *   about +Y, then roll about +X), matching src/adcs/attitude.ts.
 *
 *   Quaternions are used rather than chained Euler angles because Euler
 *   representations degenerate when pitch approaches +/-90 deg, and because
 *   integrating body rates is natural in quaternion form.
 *
 * CONTROL LAW
 *   e     = rotation vector from current to target, expressed in body axes
 *   tau   = Kp * e - Kd * omega          (saturated at ADCS_MAX_TORQUE)
 *   omega += (tau / I) * dt
 *   q     += 0.5 * q (x) (0, omega) * dt, renormalised
 *
 * WHAT A FLIGHT IMPLEMENTATION WOULD ADD
 *   real sensors with noise and bias (sun sensor, magnetometer, gyro), an
 *   attitude estimator (EKF or QUEST), actuator models with momentum build-up
 *   and magnetorquer desaturation, separate models for each disturbance
 *   source, and proper stability margins. This demo uses one bounded aggregate
 *   disturbance torque so nominal attitude remains observable on the display.
 */

#include "adcs.h"

#include <math.h>

/* q = a (x) b, Hamilton product, components ordered (x, y, z, w). */
static void quat_mul(const double a[4], const double b[4], double out[4])
{
    double x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
    double y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
    double z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
    double w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
}

static void quat_conj(const double q[4], double out[4])
{
    out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3];
}

static void quat_normalise(double q[4])
{
    double n = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (n < 1e-12) { q[0] = q[1] = q[2] = 0.0; q[3] = 1.0; return; }
    q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
}

/*
 * Rotation vector from `current` to `target`, in BODY axes.
 *
 * q_err = current^-1 (x) target. Writing q_err as (n*sin(theta/2), cos(theta/2)),
 * the rotation vector is n*theta. The sign of w is forced positive so the
 * controller always takes the short way round - a quaternion and its negation
 * are the same rotation, but not the same error vector.
 */
static void attitude_error_vector(const double current[4], const double target[4], double out[3])
{
    double inv[4], qe[4], sin_half, angle, scale;

    quat_conj(current, inv);       /* unit quaternion: conjugate == inverse */
    quat_mul(inv, target, qe);

    if (qe[3] < 0.0) {
        qe[0] = -qe[0]; qe[1] = -qe[1]; qe[2] = -qe[2]; qe[3] = -qe[3];
    }

    sin_half = sqrt(qe[0] * qe[0] + qe[1] * qe[1] + qe[2] * qe[2]);
    if (sin_half < 1e-9) { out[0] = out[1] = out[2] = 0.0; return; }

    angle = 2.0 * atan2(sin_half, qe[3]);   /* 0 .. pi */
    scale = angle / sin_half;
    out[0] = qe[0] * scale;
    out[1] = qe[1] * scale;
    out[2] = qe[2] * scale;
}

static double attitude_error_angle_deg(const double current[4], const double target[4])
{
    double inv[4], qe[4], w;
    quat_conj(current, inv);
    quat_mul(inv, target, qe);
    w = fabs(qe[3]);
    if (w > 1.0) w = 1.0;
    return 2.0 * acos(w) * RAD2DEG;
}

/* Bounded aggregate of environmental torques, scaled for the exhibit. */
static void environmental_disturbance_torque(const IcarusState *s, double out[3])
{
    double t = s->t_s;
    double phase = s->true_anomaly_rad;

    out[0] = ENV_TORQUE_X_NM * sin(phase + 0.35)
           + ENV_TORQUE_FAST_X_NM * sin(t * 0.37);
    out[1] = ENV_TORQUE_Y_NM * cos(phase * 1.17 - 0.8)
           + ENV_TORQUE_FAST_Y_NM * cos(t * 0.29);
    out[2] = ENV_TORQUE_Z_NM * sin(phase * 0.83 + 1.7)
           + ENV_TORQUE_FAST_Z_NM * sin(t * 0.47);
}

void adcs_set_target_rpy(IcarusState *s, double roll_deg, double pitch_deg, double yaw_deg)
{
    /* ZYX: R = Rz(yaw) * Ry(pitch) * Rx(roll). */
    double cr = cos(roll_deg  * DEG2RAD * 0.5), sr = sin(roll_deg  * DEG2RAD * 0.5);
    double cp = cos(pitch_deg * DEG2RAD * 0.5), sp = sin(pitch_deg * DEG2RAD * 0.5);
    double cy = cos(yaw_deg   * DEG2RAD * 0.5), sy = sin(yaw_deg   * DEG2RAD * 0.5);

    s->q_target[0] = sr * cp * cy - cr * sp * sy;
    s->q_target[1] = cr * sp * cy + sr * cp * sy;
    s->q_target[2] = cr * cp * sy - sr * sp * cy;
    s->q_target[3] = cr * cp * cy + sr * sp * sy;
    quat_normalise(s->q_target);
}

void adcs_current_rpy(const IcarusState *s, double *roll_deg, double *pitch_deg, double *yaw_deg)
{
    /* Inverse of the ZYX composition above. */
    const double x = s->q[0], y = s->q[1], z = s->q[2], w = s->q[3];

    double sinp = 2.0 * (w * y - z * x);
    if (sinp > 1.0) sinp = 1.0;
    if (sinp < -1.0) sinp = -1.0;

    *roll_deg  = atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y)) * RAD2DEG;
    *pitch_deg = asin(sinp) * RAD2DEG;
    *yaw_deg   = atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)) * RAD2DEG;
}

void adcs_inject_disturbance(IcarusState *s)
{
    double mag = DISTURBANCE_RATE_DEG_S * DEG2RAD;
    double len;
    int i;

    s->attitude_error_peak_deg = 0.0;

    for (i = 0; i < 3; i++) {
        s->omega_rad_s[i] = (icarus_rand(s) * 2.0 - 1.0) * mag;
    }

    /* Guarantee a visible tumble even if all three draws came out small. */
    len = sqrt(s->omega_rad_s[0] * s->omega_rad_s[0]
             + s->omega_rad_s[1] * s->omega_rad_s[1]
             + s->omega_rad_s[2] * s->omega_rad_s[2]);
    if (len < mag * 0.8 && len > 1e-9) {
        double k = mag / len;
        s->omega_rad_s[0] *= k;
        s->omega_rad_s[1] *= k;
        s->omega_rad_s[2] *= k;
    } else if (len <= 1e-9) {
        s->omega_rad_s[0] = mag;
    }

    /* Open the loop briefly so the error is allowed to grow. Without this the
     * controller cancels the impulse before anyone can see it happen. */
    s->adcs_enabled = 0;
    icarus_set_state(s, STATE_DISTURBANCE);
}

void adcs_update(IcarusState *s, double dt)
{
    double err_vec[3], torque[3], disturbance[3], demand, dq[4], qn[4];
    double error_rad, omega_len;
    int i;

    s->attitude_error_deg = attitude_error_angle_deg(s->q, s->q_target);
    error_rad = s->attitude_error_deg * DEG2RAD;
    if (s->attitude_error_deg > s->attitude_error_peak_deg) {
        s->attitude_error_peak_deg = s->attitude_error_deg;
    }

    /* Re-close the loop a beat after the disturbance: this is the visible
     * DISTURBANCE -> ADCS_ACTIVE transition on the ground display. */
    if (!s->adcs_enabled && s->state == STATE_DISTURBANCE
        && (s->t_s - s->state_since_s) > 1.4) {
        s->adcs_enabled = 1;
        icarus_set_state(s, STATE_ADCS_ACTIVE);
    }

    environmental_disturbance_torque(s, disturbance);

    if (s->adcs_enabled) {
        attitude_error_vector(s->q, s->q_target, err_vec);

        for (i = 0; i < 3; i++) {
            torque[i] = ADCS_KP * err_vec[i] - ADCS_KD * s->omega_rad_s[i];
        }

        /* Actuator saturation - a reaction wheel cannot produce more. */
        demand = sqrt(torque[0] * torque[0] + torque[1] * torque[1] + torque[2] * torque[2]);
        if (demand > ADCS_MAX_TORQUE) {
            double k = ADCS_MAX_TORQUE / demand;
            for (i = 0; i < 3; i++) torque[i] *= k;
            demand = ADCS_MAX_TORQUE;
        }

        /* Rigid body, diagonal inertia: omega_dot = tau / I. */
        for (i = 0; i < 3; i++) {
            s->omega_rad_s[i] += (torque[i] / ADCS_INERTIA) * dt;
            /* Environmental torque acts on the body, not the wheel. */
            s->omega_rad_s[i] += (disturbance[i] / ADCS_INERTIA) * dt;
        }

        s->wheel_activity += (icarus_clamp(demand / ADCS_MAX_TORQUE, 0.0, 1.0)
                              - s->wheel_activity) * 0.15;
    } else {
        /* Free drift with a trace of damping, so an uncommanded spacecraft
         * does not tumble for ever (aerodynamic torque and eddy currents,
         * loosely). */
        double decay = 1.0 - 0.02 * dt;
        if (decay < 0.0) decay = 0.0;
        for (i = 0; i < 3; i++) s->omega_rad_s[i] *= decay;
        s->wheel_activity *= 0.85;
    }

    /* q_dot = 0.5 * q (x) (0, omega) - first order, then renormalise. */
    dq[0] = s->omega_rad_s[0] * dt * 0.5;
    dq[1] = s->omega_rad_s[1] * dt * 0.5;
    dq[2] = s->omega_rad_s[2] * dt * 0.5;
    dq[3] = 1.0;
    quat_mul(s->q, dq, qn);
    for (i = 0; i < 4; i++) s->q[i] = qn[i];
    quat_normalise(s->q);

    s->attitude_error_deg = attitude_error_angle_deg(s->q, s->q_target);
    error_rad = s->attitude_error_deg * DEG2RAD;
    if (s->attitude_error_deg > s->attitude_error_peak_deg) {
        s->attitude_error_peak_deg = s->attitude_error_deg;
    }
    omega_len = sqrt(s->omega_rad_s[0] * s->omega_rad_s[0]
                   + s->omega_rad_s[1] * s->omega_rad_s[1]
                   + s->omega_rad_s[2] * s->omega_rad_s[2]);

    /* ---- state machine -------------------------------------------------
     * Fault handling owns SAFE_MODE / ANOMALY / RECOVERY; this only drives the
     * attitude half of the sequence.                                       */
    if (s->state == STATE_SAFE_MODE || s->state == STATE_ANOMALY
        || s->state == STATE_RECOVERY) {
        return;
    }

    if (s->state == STATE_ADCS_ACTIVE) {
        /*
         * ERROR_DECREASING means exactly what it says: the error has come down
         * measurably from its peak. Reporting it the instant the loop closes
         * would be a lie, and a minimum dwell keeps ADCS_ACTIVE on screen long
         * enough for a presenter to point at it.
         */
        int settling = s->attitude_error_deg < 0.75 * s->attitude_error_peak_deg;
        if ((s->t_s - s->state_since_s) > ADCS_ACTIVE_MIN_S && settling) {
            icarus_set_state(s, STATE_ERROR_DECREASING);
        }
    } else if (s->state == STATE_ERROR_DECREASING
               && error_rad < ADCS_SETTLED_ERROR_RAD
               && omega_len < ADCS_SETTLED_RATE_RAD_S) {
        s->attitude_error_peak_deg = 0.0;
        icarus_set_state(s, STATE_NOMINAL);
    } else if (s->state == STATE_NOMINAL
               && (error_rad > 6.0 * DEG2RAD || omega_len > 0.05)) {
        /* A commanded attitude change engages the same loop, so a slider drag
         * on the ground shows the controller doing real work. */
        s->attitude_error_peak_deg = s->attitude_error_deg;
        icarus_set_state(s, STATE_ADCS_ACTIVE);
    }
}

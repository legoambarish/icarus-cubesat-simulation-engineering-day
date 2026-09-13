/*
 * icarus.c - shared state helpers
 * ============================================================================
 * Orbit element derivation, the deterministic PRNG, and the small enum-to-name
 * tables the telemetry serialiser needs.
 */

#include "icarus.h"

#include <math.h>
#include <string.h>
#include <time.h>

void icarus_update_orbit_elements(IcarusState *s)
{
    /*
     * Circular orbit, eccentricity fixed at zero:
     *     r = Re + h
     *     v = sqrt(mu / r)
     *     T = 2*pi*sqrt(r^3 / mu)
     *     n = sqrt(mu / r^3)
     * Raising the altitude therefore always increases r and T and decreases v.
     */
    s->radius_km       = EARTH_RADIUS_KM + s->altitude_km;
    s->velocity_km_s   = sqrt(MU_EARTH_KM3_S2 / s->radius_km);
    s->period_min      = 2.0 * PI * sqrt((s->radius_km * s->radius_km * s->radius_km)
                                         / MU_EARTH_KM3_S2) / 60.0;
    s->mean_motion_rad_s = sqrt(MU_EARTH_KM3_S2
                                / (s->radius_km * s->radius_km * s->radius_km));
}

void icarus_init(IcarusState *s, uint32_t seed)
{
    memset(s, 0, sizeof(*s));

    s->t_s          = 0.0;
    s->epoch_unix_s = (double) time(NULL);

    /* Representative LEO reference orbit - NOT a real mission. */
    s->altitude_km      = 500.0;
    s->inclination_deg  = 51.6;
    s->raan_deg         = 42.0;
    s->true_anomaly_rad = 0.0;
    icarus_update_orbit_elements(s);

    /* Identity attitude, zero body rates, controller closed. */
    s->q[0] = 0.0; s->q[1] = 0.0; s->q[2] = 0.0; s->q[3] = 1.0;
    s->q_target[0] = 0.0; s->q_target[1] = 0.0; s->q_target[2] = 0.0; s->q_target[3] = 1.0;
    s->adcs_enabled = 1;

    s->battery_pct   = 84.0;
    s->load_w        = LOAD_NOMINAL_W;
    s->temperature_c = 18.0;
    s->vibration_g   = VIB_BASELINE_G;

    s->state       = STATE_NOMINAL;
    s->fault_code  = FAULT_NONE;
    s->fault_message[0] = '\0';

    s->rng = seed;
}

void icarus_reset(IcarusState *s)
{
    s->anomaly_offset_c     = 0.0;
    s->battery_drain_boost  = 0.0;
    s->fault_active         = 0;
    s->fault_code           = FAULT_NONE;
    s->fault_message[0]     = '\0';
    s->load_w               = LOAD_NOMINAL_W;
    s->adcs_enabled         = 1;

    s->omega_rad_s[0] = s->omega_rad_s[1] = s->omega_rad_s[2] = 0.0;
    s->q[0] = s->q[1] = s->q[2] = 0.0; s->q[3] = 1.0;
    s->q_target[0] = s->q_target[1] = s->q_target[2] = 0.0; s->q_target[3] = 1.0;
    s->attitude_error_deg = 0.0;
    s->attitude_error_peak_deg = 0.0;

    /* Bring the bus back inside limits so the demo can be repeated at once. */
    if (s->temperature_c > THERMAL_RECOVER_C) s->temperature_c = 30.0;
    if (s->battery_pct < BATTERY_RECOVER_PCT) s->battery_pct = 62.0;

    icarus_set_state(s, STATE_NOMINAL);
}

void icarus_set_state(IcarusState *s, FlightState next)
{
    if (s->state == next) return;
    s->state = next;
    s->state_since_s = s->t_s;
}

const char *flight_state_name(FlightState s)
{
    switch (s) {
        case STATE_BOOT:             return "BOOT";
        case STATE_NOMINAL:          return "NOMINAL";
        case STATE_DISTURBANCE:      return "DISTURBANCE";
        case STATE_ADCS_ACTIVE:      return "ADCS_ACTIVE";
        case STATE_ERROR_DECREASING: return "ERROR_DECREASING";
        case STATE_ANOMALY:          return "ANOMALY";
        case STATE_SAFE_MODE:        return "SAFE_MODE";
        case STATE_RECOVERY:         return "RECOVERY";
    }
    return "NOMINAL";
}

const char *fault_code_name(FaultCode c)
{
    switch (c) {
        case FAULT_THERMAL_LIMIT:    return "THERMAL_LIMIT";
        case FAULT_BATTERY_CRITICAL: return "BATTERY_CRITICAL";
        case FAULT_ATTITUDE_ERROR:   return "ATTITUDE_ERROR";
        case FAULT_NONE:             break;
    }
    return NULL;
}

double icarus_rand(IcarusState *s)
{
    /*
     * mulberry32. Chosen because it is four lines, has no state beyond a
     * uint32_t, and is bit-identical to the JavaScript implementation in
     * src/fsw/browserFsw.ts - so the same seed gives the same noise in both
     * simulators, which is what makes "the C and browser versions agree"
     * something you can actually check.
     */
    uint32_t z;
    s->rng += 0x6D2B79F5u;
    z = s->rng;
    z = (z ^ (z >> 15)) * (z | 1u);
    z ^= z + (z ^ (z >> 7)) * (z | 61u);
    return (double) ((z ^ (z >> 14)) >> 0) / 4294967296.0;
}

double icarus_clamp(double v, double lo, double hi)
{
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/*
 * power.c - electrical power subsystem
 * ============================================================================
 * Three quantities, one integration.
 *
 *   GENERATION
 *     P_solar = P_peak * illumination * pointing_efficiency
 *
 *     `illumination` comes from the eclipse geometry in main.c: 1 in full sun,
 *     0 in the Earth's shadow, with a short ramp at the terminator so the
 *     power curve is continuous.
 *
 *     `pointing_efficiency` couples the arrays to the attitude. An off-pointed
 *     spacecraft sees less Sun. It is bounded to [0.35, 1] so a tumble degrades
 *     generation without killing it - the telemetry stays readable, and the
 *     relationship is still visible on screen.
 *
 *   LOAD
 *     nominal, plus the ADCS draw while the wheel is working, plus any
 *     parasitic load from an injected battery fault - unless SAFE MODE has
 *     shed the non-essential load, in which case the shed value wins.
 *
 *   STORAGE
 *     dSoC/dt = (P_solar - P_load) / E_capacity, clamped to 0..100 %.
 *     Integrated on the MISSION clock, so one real minute covers one simulated
 *     orbit and the sunlit/eclipse sawtooth is actually visible.
 *
 * That clamp is important: without it a long eclipse drives the state of
 * charge negative and every downstream threshold becomes meaningless.
 */

#include "power.h"

#include <math.h>

void power_update(IcarusState *s, double dt_mission)
{
    double error_rad, pointing_efficiency, net_w, delta_pct;

    /* ---- generation ---------------------------------------------------- */
    error_rad = s->attitude_error_deg * DEG2RAD;
    if (error_rad > PI / 2.0) error_rad = PI / 2.0;
    pointing_efficiency = 0.35 + 0.65 * cos(error_rad);

    s->solar_w = SOLAR_PEAK_W * s->illumination * pointing_efficiency;

    /* ---- load ----------------------------------------------------------- */
    if (s->state == STATE_SAFE_MODE) {
        /* Load shedding is the whole point of safe mode: the spacecraft turns
         * off everything that is not needed to stay alive and communicate. */
        s->load_w = LOAD_SAFE_MODE_W;
    } else {
        double adcs_draw = (s->adcs_enabled && s->wheel_activity > 0.01)
                           ? LOAD_ADCS_EXTRA_W * s->wheel_activity
                           : 0.0;
        s->load_w = LOAD_NOMINAL_W + adcs_draw + s->battery_drain_boost;
    }

    /* ---- storage -------------------------------------------------------- */
    net_w     = s->solar_w - s->load_w;
    delta_pct = (net_w * dt_mission / BATTERY_ENERGY_J) * 100.0;
    s->battery_pct = icarus_clamp(s->battery_pct + delta_pct, 0.0, 100.0);
}

/*
 * anomaly.c - fault detection and the SAFE MODE response
 * ============================================================================
 * Two thresholds, one response, one recovery path.
 *
 *   if (T > THERMAL_LIMIT_C || SoC <= BATTERY_CRITICAL_PCT) -> SAFE MODE
 *
 * SAFE MODE is NOT a display state. Entering it:
 *   * sheds the non-essential load (power.c then integrates a smaller drain)
 *   * commands the reference attitude and holds it
 *   * speeds up the decay of any injected fault heat (thermal.c)
 *
 * so the recovery you see on the ground display is the consequence of the
 * spacecraft's own behaviour, not an animation.
 *
 * Recovery is automatic once the bus is back inside limits AND the minimum
 * dwell has elapsed, which keeps the demonstration repeatable without a
 * restart. A `reset` command short-circuits it for the impatient presenter.
 */

#include "anomaly.h"

#include <stdio.h>

static void enter_safe_mode(IcarusState *s)
{
    s->safe_mode_since_s = s->t_s;
    s->load_w = LOAD_SAFE_MODE_W;

    /* Safe attitude: return to the reference orientation and hold it. */
    s->q_target[0] = 0.0; s->q_target[1] = 0.0; s->q_target[2] = 0.0; s->q_target[3] = 1.0;
    s->adcs_enabled = 1;

    icarus_set_state(s, STATE_SAFE_MODE);
}

void anomaly_inject(IcarusState *s, AnomalyKind kind)
{
    if (kind == ANOMALY_THERMAL) {
        /* A stuck heater or a failed radiator: the bus equilibrium shifts up
         * and the thermal model relaxes towards the new, too-hot target. */
        s->anomaly_offset_c = ANOMALY_EQ_OFFSET_C;
    } else {
        /* A shorted load: an extra parasitic draw that empties the pack. */
        s->battery_drain_boost = ANOMALY_LOAD_W;
    }
    icarus_set_state(s, STATE_ANOMALY);
}

void anomaly_update(IcarusState *s, double dt)
{
    int over_temp, low_battery, lost_attitude;
    double dwell;

    (void) dt; /* thresholds are level-triggered, not rate-based */

    over_temp     = s->temperature_c > THERMAL_LIMIT_C;
    low_battery   = s->battery_pct <= BATTERY_CRITICAL_PCT;
    lost_attitude = s->attitude_error_deg > ATTITUDE_LIMIT_DEG;

    /* ---- detection ------------------------------------------------------ */
    if (!s->fault_active && (over_temp || low_battery)) {
        s->fault_active = 1;
        if (over_temp) {
            s->fault_code = FAULT_THERMAL_LIMIT;
            snprintf(s->fault_message, sizeof(s->fault_message),
                     "Bus temperature %.1f C exceeded %.0f C limit",
                     s->temperature_c, (double) THERMAL_LIMIT_C);
        } else {
            s->fault_code = FAULT_BATTERY_CRITICAL;
            snprintf(s->fault_message, sizeof(s->fault_message),
                     "Battery %.1f %% below %.0f %% floor",
                     s->battery_pct, (double) BATTERY_CRITICAL_PCT);
        }
        enter_safe_mode(s);
        return;
    }

    /*
     * Attitude loss is REPORTED but does not by itself trigger safe mode - the
     * controller is given the chance to recover first, which is the behaviour
     * the ADCS demonstration relies on.
     */
    if (!s->fault_active && lost_attitude && s->state != STATE_SAFE_MODE) {
        s->fault_code = FAULT_ATTITUDE_ERROR;
        snprintf(s->fault_message, sizeof(s->fault_message),
                 "Pointing error %.1f deg exceeds %.0f deg",
                 s->attitude_error_deg, (double) ATTITUDE_LIMIT_DEG);
    } else if (!s->fault_active && !lost_attitude && s->fault_code == FAULT_ATTITUDE_ERROR) {
        s->fault_code = FAULT_NONE;
        s->fault_message[0] = '\0';
    }

    /* ---- recovery ------------------------------------------------------- */
    if (s->state == STATE_SAFE_MODE) {
        dwell = s->t_s - s->safe_mode_since_s;
        if (dwell > SAFE_MODE_MIN_S
            && s->temperature_c < THERMAL_RECOVER_C
            && s->battery_pct > BATTERY_RECOVER_PCT) {
            s->fault_active = 0;
            s->fault_code = FAULT_NONE;
            s->fault_message[0] = '\0';
            s->load_w = LOAD_NOMINAL_W;
            icarus_set_state(s, STATE_RECOVERY);
        }
    } else if (s->state == STATE_RECOVERY && (s->t_s - s->state_since_s) > 4.0) {
        icarus_set_state(s, STATE_NOMINAL);
    }
}

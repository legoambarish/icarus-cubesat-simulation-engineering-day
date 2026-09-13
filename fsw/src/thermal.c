/*
 * thermal.c - bus thermal model
 * ============================================================================
 *   dT/dt = (T_eq + T_fault - T) / tau
 *
 * One lumped mass, one time constant, integrated on the MISSION clock (see the
 * two-clocks note in icarus.h). T_eq is interpolated between the eclipse and
 * sunlit equilibria using the illumination fraction, so the temperature follows
 * the ORBIT: it rises after sunrise and falls after entering the shadow,
 * without anything telling it to.
 *
 * A FAULT IS AN EQUILIBRIUM OFFSET IN KELVIN, NOT A HEAT FLUX IN WATTS.
 * A 1 kg aluminium bus holds roughly 1200 J/K and sheds well under a watt per
 * kelvin, so no plausible fault power warms it 40 K in a minute. Quoting a
 * wattage would look more rigorous and be less true. What matters for the
 * demonstration is the SHAPE of the response - first order, bounded, right
 * sign, plausible time constant - and that is what this is.
 *
 * The offset decays on its own, and decays much faster once SAFE MODE has shed
 * the load feeding it. That is the causal chain the exhibit shows:
 *
 *     anomaly -> temperature rises -> threshold breached -> SAFE MODE
 *     -> load shed -> offset decays faster -> temperature falls -> recovery
 *
 * NOT a high-fidelity thermal model: no node network, no view factors, no
 * material properties, no solar absorptivity.
 */

#include "thermal.h"

void thermal_update(IcarusState *s, double dt_mission)
{
    double t_eq, target, tau;

    /* Equilibrium follows the illumination, not a schedule. */
    t_eq = T_EQ_ECLIPSE_C + (T_EQ_SUNLIT_C - T_EQ_ECLIPSE_C) * s->illumination;
    target = t_eq + s->anomaly_offset_c;

    s->temperature_c += ((target - s->temperature_c) / THERMAL_TAU_MISSION_S) * dt_mission;

    /* Hard bounds: a runaway temperature would make every threshold below
     * meaningless, and no real bus would survive outside this range anyway. */
    s->temperature_c = icarus_clamp(s->temperature_c, -90.0, 160.0);

    /* The fault offset decays; load shedding removes its source. */
    if (s->anomaly_offset_c > 0.0) {
        tau = (s->state == STATE_SAFE_MODE)
              ? ANOMALY_DECAY_SAFE_MISSION_S
              : ANOMALY_DECAY_MISSION_S;
        s->anomaly_offset_c -= (s->anomaly_offset_c / tau) * dt_mission;
        if (s->anomaly_offset_c < 0.2) s->anomaly_offset_c = 0.0;
    }

    /* A battery fault's parasitic load is likewise cleared by load shedding. */
    if (s->battery_drain_boost > 0.0 && s->state == STATE_SAFE_MODE) {
        s->battery_drain_boost -= (s->battery_drain_boost / 200.0) * dt_mission;
        if (s->battery_drain_boost < 0.2) s->battery_drain_boost = 0.0;
    }
}

/*
 * vibration.c - structural vibration channel
 * ============================================================================
 * A real CubeSat's accelerometers see a low background from thermal snap,
 * reaction-wheel imbalance and residual structural modes. This reproduces the
 * shape of that signal without pretending to model it:
 *
 *   target = baseline
 *          + noise  * (structural tones + uniform jitter)
 *          + wheel  * reaction-wheel activity
 *          + fault  * anomaly severity
 *
 * The two sine terms give it the character of a couple of structural modes
 * rather than white hiss; the jitter comes from the seeded PRNG so the trace
 * is repeatable. Everything is then low-pass filtered towards `target`, which
 * keeps the number on screen readable from across a room.
 *
 * Bounded by construction - there is no integrator here, so it cannot drift.
 */

#include "vibration.h"

#include <math.h>

void vibration_update(IcarusState *s, double dt)
{
    double structural, jitter, target, k;

    s->noise_phase += dt;

    structural = 0.45 * sin(s->noise_phase * 2.1)
               + 0.30 * sin(s->noise_phase * 5.7 + 1.1);
    jitter     = (icarus_rand(s) - 0.5) * 2.0;

    target  = VIB_BASELINE_G;
    target += VIB_NOISE_G * (0.6 * structural + 0.4 * jitter);
    target += VIB_ADCS_G * s->wheel_activity;
    if (s->anomaly_offset_c > 1.0) {
        target += VIB_ANOMALY_G * (s->anomaly_offset_c / ANOMALY_EQ_OFFSET_C);
    }

    /* First-order low pass, frame-rate independent. */
    k = dt * 4.0;
    if (k > 1.0) k = 1.0;
    s->vibration_g += (target - s->vibration_g) * k;
    if (s->vibration_g < 0.0) s->vibration_g = 0.0;
}

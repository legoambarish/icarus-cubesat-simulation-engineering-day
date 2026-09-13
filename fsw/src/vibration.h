/*
 * vibration.h - structural vibration channel
 */
#ifndef ICARUS_VIBRATION_H
#define ICARUS_VIBRATION_H

#include "icarus.h"

/*
 * Deterministic band-limited noise around a baseline, excited by reaction-wheel
 * activity and by an active anomaly. Low-pass filtered so the readout is
 * legible from a distance rather than flickering, and bounded - there is no
 * unbounded random walk here.
 */
void vibration_update(IcarusState *s, double dt);

#endif

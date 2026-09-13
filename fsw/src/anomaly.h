/*
 * anomaly.h - fault detection and the SAFE MODE response
 */
#ifndef ICARUS_ANOMALY_H
#define ICARUS_ANOMALY_H

#include "icarus.h"

/*
 * Threshold detection, safe-mode entry and automatic recovery.
 *
 * SAFE MODE is not a display state: entering it sets load_w to the shed value,
 * which changes the battery integration in power.c, which changes the telemetry
 * the ground sees. That is the whole point of the demonstration.
 */
void anomaly_update(IcarusState *s, double dt);

/* Inject a fault. Thermal adds heat; battery adds a parasitic load. */
void anomaly_inject(IcarusState *s, AnomalyKind kind);

#endif

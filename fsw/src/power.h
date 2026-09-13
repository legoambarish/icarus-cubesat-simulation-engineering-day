/*
 * power.h - electrical power subsystem
 */
#ifndef ICARUS_POWER_H
#define ICARUS_POWER_H

#include "icarus.h"

/*
 * Update solar generation, bus load and battery state of charge.
 *
 *   P_solar  = P_peak * illumination * pointing_efficiency
 *   P_load   = nominal (+ ADCS draw) (+ anomaly draw), or the shed safe-mode load
 *   dSoC/dt  = (P_solar - P_load) / E_capacity,  clamped to 0..100 %
 *
 * `dt_mission` is in MISSION seconds (see the two-clocks note in icarus.h):
 * the energy budget is scaled with the orbit so one real minute covers one
 * simulated orbit and the charge/discharge sawtooth is visible.
 */
void power_update(IcarusState *s, double dt_mission);

#endif

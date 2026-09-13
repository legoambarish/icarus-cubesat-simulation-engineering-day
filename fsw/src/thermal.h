/*
 * thermal.h - bus thermal model
 */
#ifndef ICARUS_THERMAL_H
#define ICARUS_THERMAL_H

#include "icarus.h"

/*
 * First-order lumped thermal mass, integrated on the MISSION clock:
 *
 *   dT/dt = (T_eq + T_fault - T) / tau
 *
 * T_eq interpolates between the eclipse and sunlit equilibria with the
 * illumination fraction, so the temperature trend follows the orbit rather
 * than a timer. A fault shifts the equilibrium in kelvin and that shift
 * decays, faster once SAFE MODE has shed the load feeding it.
 *
 * NOT a high-fidelity thermal model: no node network, no radiative view
 * factors, no material properties. A bounded first-order response with the
 * right sign and a plausible time constant.
 */
void thermal_update(IcarusState *s, double dt_mission);

#endif

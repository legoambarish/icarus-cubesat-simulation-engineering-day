/*
 * icarus.h - shared spacecraft state and constants for the Icarus OBC
 * ============================================================================
 * The Icarus OBC is a DETERMINISTIC TELEMETRY DEMONSTRATOR. It is not flight
 * software: there is no scheduler, no watchdog, no redundancy, no FDIR beyond
 * two thresholds. What it does do is model a 1U CubeSat's subsystems well
 * enough that the numbers on the mission-control screen are physically
 * coherent, and emit them as JSON over UDP.
 *
 * EVERY CONSTANT BELOW IS MIRRORED IN src/fsw/browserFsw.ts.
 * The browser simulator is the GitHub Pages substitute for this program, and
 * the two must produce approximately the same behaviour for the same scenario.
 * If you change a number here, change it there too.
 *
 * Units: km, km/s, degrees, seconds, watts, celsius, g.
 */

#ifndef ICARUS_H
#define ICARUS_H

#include <stdint.h>

/* ---- schema ------------------------------------------------------------ */
#define TELEMETRY_SCHEMA_VERSION 2
#define SATELLITE_ID             "ICARUS-1U"
#define TELEMETRY_SOURCE         "ICARUS-OBC"

/* ---- physics ----------------------------------------------------------- */
#define MU_EARTH_KM3_S2   398600.4418   /* standard gravitational parameter  */
#define EARTH_RADIUS_KM   6371.0
#define PI                3.14159265358979323846
#define DEG2RAD           (PI / 180.0)
#define RAD2DEG           (180.0 / PI)

/* ---- simulation cadence ------------------------------------------------ */
#define SIM_STEP_S        0.1          /* 10 Hz physics                      */
#define TELEMETRY_HZ      10.0         /* 10 Hz downlink (every sim step)    */

/*
 * TWO CLOCKS, AND WHY
 * -------------------
 * A 500 km orbit takes 94 minutes and a real CubeSat's thermal time constant
 * is tens of minutes. Neither fits in an exhibition. So the SLOW physics -
 * orbit, Sun geometry, battery energy budget, bus temperature - runs on a
 * MISSION CLOCK at this multiple of real time. One real minute is one
 * simulated orbit, and the sunlit/eclipse battery sawtooth and the temperature
 * swing are both visible inside it.
 *
 * The FAST physics - the ADCS control loop and the vibration channel - runs in
 * REAL seconds. A controller that settles in 15 mission-seconds would settle
 * in a quarter of a real second: correct, and completely unwatchable.
 *
 * Everything the ground display reports is still the true physical value; only
 * the rate at which the simulation is stepped differs, and the HUD says so.
 */
#define ORBIT_TIME_SCALE  60.0

/* ---- power (integrated on the MISSION clock) ----------------------------
 * Sized so one orbit charges slightly more than it discharges: the battery
 * draws a visible sawtooth that trends gently upward rather than either
 * pinning at 100 % or dying on the third orbit.
 *   sunlit  ~57 min at +4.0 W net  => +13.6 kJ  (+38 %)
 *   eclipse ~38 min at -5.4 W net  => -12.3 kJ  (-34 %)
 */
#define SOLAR_PEAK_W        9.4
#define LOAD_NOMINAL_W      5.4
#define LOAD_SAFE_MODE_W    1.9
#define LOAD_ADCS_EXTRA_W   1.6
#define BATTERY_ENERGY_J    36000.0    /* 10 Wh usable                       */
/* Parasitic load injected by a battery fault, W. Drains a full pack to the
 * critical floor in about half a minute of real time. */
#define ANOMALY_LOAD_W      18.0

/* ---- thermal (integrated on the MISSION clock) --------------------------
 * First-order relaxation towards an equilibrium that follows the illumination.
 *
 * A FAULT IS MODELLED AS A SHIFT IN THAT EQUILIBRIUM, IN KELVIN - not as a
 * heat flux in watts. That is deliberate and it is the honest way to write
 * this: a 1 kg aluminium bus has a heat capacity near 1200 J/K and radiates
 * well under a watt per kelvin, so no physically plausible fault power warms
 * it 40 K in a minute. Quoting a made-up wattage would look more rigorous and
 * be less true. The response shape - first order, bounded, with the right sign
 * and a plausible time constant - is what the demonstration needs.
 */
#define T_EQ_SUNLIT_C            26.0
#define T_EQ_ECLIPSE_C          (-8.0)
#define THERMAL_TAU_MISSION_S    1200.0   /* 20 min mission = 20 s real      */
/* Equilibrium offset applied by a thermal fault, kelvin. Large enough that the
 * limit is breached whether the fault starts in sunlight or in eclipse. */
#define ANOMALY_EQ_OFFSET_C      110.0
#define ANOMALY_DECAY_MISSION_S  2600.0
/* Load shedding removes the fault's source, so it decays much faster. */
#define ANOMALY_DECAY_SAFE_MISSION_S 400.0

/* ---- vibration --------------------------------------------------------- */
#define VIB_BASELINE_G  0.012
#define VIB_NOISE_G     0.006
#define VIB_ADCS_G      0.05
#define VIB_ANOMALY_G   0.09

/* ---- fault thresholds -------------------------------------------------- */
#define THERMAL_LIMIT_C       58.0
#define THERMAL_RECOVER_C     44.0
#define BATTERY_CRITICAL_PCT  12.0
#define BATTERY_RECOVER_PCT   26.0
#define ATTITUDE_LIMIT_DEG    75.0
#define SAFE_MODE_MIN_S       12.0

/* ---- ADCS -------------------------------------------------------------- */
#define ADCS_KP          0.9           /* N.m per rad of pointing error      */
#define ADCS_KD          0.35          /* N.m per rad/s of body rate         */
#define ADCS_MAX_TORQUE  2.0           /* reaction-wheel saturation, N.m     */
/*
 * Effective inertia. With a PD law the 2 % settling time is ts = 8*I/Kd,
 * independent of Kp - so I is chosen to give ts ~ 15 s, which is long enough
 * to narrate and short enough to hold an audience. A real 1U is ~0.002 kg.m^2;
 * at that inertia this controller would settle in 50 ms and there would be
 * nothing to see. Damping ratio here is ~0.23, so the response visibly
 * overshoots and then converges, which is the point.
 */
#define ADCS_INERTIA     0.66          /* kg.m^2, tuned for demo pacing      */
/* Minimum time the loop is reported as ADCS_ACTIVE before it can advance to
 * ERROR_DECREASING, so the transition is actually visible on the ground. */
#define ADCS_ACTIVE_MIN_S 1.0
#define ADCS_SETTLED_ERROR_RAD  (0.6 * DEG2RAD)
#define ADCS_SETTLED_RATE_RAD_S (0.35 * DEG2RAD)
#define DISTURBANCE_RATE_DEG_S  8.0
#define ENV_TORQUE_X_NM         0.018
#define ENV_TORQUE_Y_NM         0.014
#define ENV_TORQUE_Z_NM         0.011
#define ENV_TORQUE_FAST_X_NM    0.004
#define ENV_TORQUE_FAST_Y_NM    0.003
#define ENV_TORQUE_FAST_Z_NM    0.003

/* ---- limits on commanded values (same as fsw/commands.ts) -------------- */
#define ALT_MIN_KM   200.0
#define ALT_MAX_KM   2000.0
#define INC_MIN_DEG  0.0
#define INC_MAX_DEG  145.0

/* ========================================================================= */

typedef enum {
    STATE_BOOT = 0,
    STATE_NOMINAL,
    STATE_DISTURBANCE,
    STATE_ADCS_ACTIVE,
    STATE_ERROR_DECREASING,
    STATE_ANOMALY,
    STATE_SAFE_MODE,
    STATE_RECOVERY
} FlightState;

typedef enum {
    FAULT_NONE = 0,
    FAULT_THERMAL_LIMIT,
    FAULT_BATTERY_CRITICAL,
    FAULT_ATTITUDE_ERROR
} FaultCode;

typedef enum {
    ANOMALY_THERMAL = 0,
    ANOMALY_BATTERY
} AnomalyKind;

/*
 * The complete spacecraft state. One struct, passed by pointer to every
 * subsystem update function - there are no globals, so the whole simulation
 * can be reasoned about (and unit tested) from this one object.
 */
typedef struct {
    /* ---- clocks ---- */
    double t_s;              /* REAL elapsed seconds since boot             */
    double mission_elapsed_s;/* simulated seconds (t_s * ORBIT_TIME_SCALE)  */
    double epoch_unix_s;     /* UNIX time when the OBC booted               */

    /* ---- orbit (circular, eccentricity fixed at 0) ---- */
    double altitude_km;
    double inclination_deg;
    double raan_deg;
    double true_anomaly_rad;
    double radius_km;        /* derived: Re + h                             */
    double velocity_km_s;    /* derived: sqrt(mu/r)                         */
    double period_min;       /* derived: 2*pi*sqrt(r^3/mu)                  */
    double mean_motion_rad_s;/* derived: sqrt(mu/r^3)                       */
    double pos_eci_km[3];

    /* ---- environment ---- */
    int    eclipse;          /* 1 while inside the Earth's shadow cylinder  */
    double illumination;     /* 0..1, soft ramp at the terminator           */

    /* ---- attitude (quaternion x,y,z,w - body to inertial) ---- */
    double q[4];
    double q_target[4];
    double omega_rad_s[3];   /* body rates                                  */
    double attitude_error_deg;
    double attitude_error_peak_deg; /* peak since the last disturbance      */
    double wheel_activity;   /* 0..1, reaction-wheel torque fraction        */
    int    adcs_enabled;

    /* ---- power ---- */
    double battery_pct;
    double solar_w;
    double load_w;
    double battery_drain_boost;  /* extra load from a battery anomaly, W    */

    /* ---- thermal ---- */
    double temperature_c;
    double anomaly_offset_c; /* fault-induced equilibrium shift, kelvin     */

    /* ---- vibration ---- */
    double vibration_g;
    double noise_phase;

    /* ---- fault / mode ---- */
    int         fault_active;
    FaultCode   fault_code;
    char        fault_message[160];
    FlightState state;
    double      state_since_s;
    double      safe_mode_since_s;

    /* ---- deterministic PRNG ---- */
    uint32_t rng;
} IcarusState;

/* Initialise to the nominal 500 km / 51.6 deg reference orbit. */
void icarus_init(IcarusState *s, uint32_t seed);

/* Clear faults and return to nominal. Safe to call at any time. */
void icarus_reset(IcarusState *s);

/* Recompute r, v, T and n from the current altitude. */
void icarus_update_orbit_elements(IcarusState *s);

/* Set the flight state and stamp the transition time. */
void icarus_set_state(IcarusState *s, FlightState next);

const char *flight_state_name(FlightState s);
const char *fault_code_name(FaultCode c);

/* mulberry32 - the same generator the browser simulator uses, so identical
 * seeds produce identical noise sequences in both implementations. */
double icarus_rand(IcarusState *s);

double icarus_clamp(double v, double lo, double hi);

#endif /* ICARUS_H */

/*
 * main.c - the Icarus OBC: clock, orbit, environment and the control loop
 * ============================================================================
 * WHAT THIS PROGRAM IS
 *   A deterministic spacecraft telemetry demonstrator. It models a 1U CubeSat's
 *   orbit, illumination, power, thermal, vibration and attitude subsystems at
 *   10 Hz, runs simple fault logic over them, and emits normalised JSON
 *   telemetry over UDP for the Python bridge to forward to the digital twin.
 *
 * WHAT THIS PROGRAM IS NOT
 *   Flight software. There is no RTOS, no task scheduler, no watchdog, no
 *   memory protection, no redundancy, no CCSDS packetisation, no error
 *   detection and correction, and the FDIR is two thresholds. Those omissions
 *   are deliberate: a new OBC team member should be able to read this file end
 *   to end in one sitting.
 *
 * THE LOOP
 *   main owns the clock. Every SIM_STEP_S (0.1 s) it:
 *     1. drains the command uplink
 *     2. advances the orbit and recomputes the illumination geometry
 *     3. updates attitude/ADCS, power, thermal and vibration
 *     4. runs the fault logic
 *     5. serialises and transmits one telemetry packet
 *
 *   Steps are FIXED SIZE and the loop sleeps to keep real time. The simulation
 *   result therefore does not depend on how fast the host machine is.
 *
 * TWO CLOCKS
 *   The SLOW physics - orbit, Sun geometry, battery energy budget, bus
 *   temperature - advances at ORBIT_TIME_SCALE x real time, so a 94-minute
 *   orbit and a 20-minute thermal time constant both fit in an exhibition.
 *   The FAST physics - the ADCS control loop and the vibration channel - runs
 *   in REAL seconds, because a controller that settles in 15 mission-seconds
 *   would settle in a quarter of a real second and there would be nothing to
 *   watch. See the two-clocks note in icarus.h. The ground display states the
 *   clock rate out loud.
 *
 * USAGE
 *   icarus [--telemetry-host H] [--telemetry-port P] [--command-host H]
 *          [--command-port P] [--seed N] [--quiet]
 *
 *   Environment variables ICARUS_TELEMETRY_HOST / _PORT and
 *   ICARUS_COMMAND_HOST / _PORT are used when the flag is absent.
 */

#include "icarus.h"
#include "adcs.h"
#include "anomaly.h"
#include "commands.h"
#include "power.h"
#include "telemetry.h"
#include "thermal.h"
#include "vibration.h"
#include "platform.h"

#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define DEFAULT_TELEMETRY_HOST "127.0.0.1"
#define DEFAULT_TELEMETRY_PORT 5005
#define DEFAULT_COMMAND_HOST   "127.0.0.1"
#define DEFAULT_COMMAND_PORT   5006

static volatile sig_atomic_t g_running = 1;

static void on_signal(int sig)
{
    (void) sig;
    g_running = 0;
}

/* ==========================================================================
 * Orbit and environment
 *
 * These live in main.c because main owns the clock and the environment is a
 * function of time alone - there is no "environment subsystem" on a real
 * spacecraft, only the universe the spacecraft is flying through.
 * ========================================================================== */

/*
 * ECI position on a circular orbit.
 *
 *   1. place the point in the orbital plane at the true anomaly
 *   2. rotate about X by the inclination (tilts the plane)
 *   3. rotate about Z by the RAAN (swings the ascending node)
 *
 * Identical to eciFromOrbitAngle() in src/orbit/simulatedOrbit.ts.
 */
static void orbit_position_eci(const IcarusState *s, double out[3])
{
    double i = s->inclination_deg * DEG2RAD;
    double O = s->raan_deg * DEG2RAD;
    double xp = s->radius_km * cos(s->true_anomaly_rad);
    double yp = s->radius_km * sin(s->true_anomaly_rad);

    double xi = xp;
    double yi = yp * cos(i);
    double zi = yp * sin(i);

    out[0] = xi * cos(O) - yi * sin(O);
    out[1] = xi * sin(O) + yi * cos(O);
    out[2] = zi;
}

/*
 * Low-precision Sun direction in ECI (unit vector).
 * Vallado, "Fundamentals of Astrodynamics and Applications", Algorithm 29.
 * Accurate to ~0.01 deg - far more than enough to decide which side of the
 * Earth is lit. Identical to sunDirectionEci() in src/orbit/eclipse.ts.
 */
static void sun_direction_eci(double unix_seconds, double out[3])
{
    double jd     = unix_seconds / 86400.0 + 2440587.5;
    double n      = jd - 2451545.0;                     /* days since J2000   */
    double L      = fmod(280.46 + 0.9856474 * n, 360.0);
    double g      = fmod(357.528 + 0.9856003 * n, 360.0) * DEG2RAD;
    double lambda = (L + 1.915 * sin(g) + 0.020 * sin(2.0 * g)) * DEG2RAD;
    double eps    = (23.439 - 0.0000004 * n) * DEG2RAD;

    out[0] = cos(lambda);
    out[1] = cos(eps) * sin(lambda);
    out[2] = sin(eps) * sin(lambda);
}

/*
 * Cylindrical Earth-shadow test.
 *
 *   a = p . s          component of the position along the Earth-Sun axis
 *   d = |p - a*s|      perpendicular distance from that axis
 *
 * Eclipsed when the spacecraft is on the far side (a < 0) AND inside the
 * shadow cylinder (d < Re). A 120 km ramp keeps the power curve continuous at
 * the terminator. The penumbra is ignored: in LEO it lasts a few seconds.
 *
 * This is what makes eclipse a CONSEQUENCE of the orbit rather than a toggle.
 */
static void environment_update(IcarusState *s)
{
    const double RAMP_KM = 120.0;
    double sun[3], along, perp, px, py, pz, t;

    orbit_position_eci(s, s->pos_eci_km);

    /* Sun geometry advances on the same mission clock as the orbit. */
    sun_direction_eci(s->epoch_unix_s + s->mission_elapsed_s, sun);

    along = s->pos_eci_km[0] * sun[0]
          + s->pos_eci_km[1] * sun[1]
          + s->pos_eci_km[2] * sun[2];

    if (along >= 0.0) {                 /* sunward hemisphere - always lit */
        s->eclipse = 0;
        s->illumination = 1.0;
        return;
    }

    px = s->pos_eci_km[0] - along * sun[0];
    py = s->pos_eci_km[1] - along * sun[1];
    pz = s->pos_eci_km[2] - along * sun[2];
    perp = sqrt(px * px + py * py + pz * pz);

    if (perp >= EARTH_RADIUS_KM + RAMP_KM) {
        s->eclipse = 0;
        s->illumination = 1.0;
    } else if (perp <= EARTH_RADIUS_KM) {
        s->eclipse = 1;
        s->illumination = 0.0;
    } else {
        t = (perp - EARTH_RADIUS_KM) / RAMP_KM;
        s->eclipse = (t < 0.5) ? 1 : 0;
        s->illumination = t;
    }
}

/* ==========================================================================
 * Configuration
 * ========================================================================== */

typedef struct {
    const char *telemetry_host;
    int         telemetry_port;
    const char *command_host;
    int         command_port;
    unsigned    seed;
    int         quiet;
} Config;

static const char *env_or(const char *name, const char *fallback)
{
    const char *v = getenv(name);
    return (v != NULL && v[0] != '\0') ? v : fallback;
}

static int env_int_or(const char *name, int fallback)
{
    const char *v = getenv(name);
    if (v == NULL || v[0] == '\0') return fallback;
    return atoi(v);
}

static void usage(const char *argv0)
{
    printf(
        "Icarus OBC simulator\n\n"
        "Usage: %s [options]\n\n"
        "  --telemetry-host H   telemetry destination (default %s)\n"
        "  --telemetry-port P   telemetry destination port (default %d)\n"
        "  --command-host H     address to bind for commands (default %s)\n"
        "  --command-port P     command port (default %d)\n"
        "  --seed N             PRNG seed for repeatable noise (default 30023429)\n"
        "  --quiet              suppress the periodic status line\n"
        "  --help               this message\n\n"
        "Environment: ICARUS_TELEMETRY_HOST/_PORT, ICARUS_COMMAND_HOST/_PORT\n",
        argv0, DEFAULT_TELEMETRY_HOST, DEFAULT_TELEMETRY_PORT,
        DEFAULT_COMMAND_HOST, DEFAULT_COMMAND_PORT);
}

static int parse_args(int argc, char **argv, Config *cfg)
{
    cfg->telemetry_host = env_or("ICARUS_TELEMETRY_HOST", DEFAULT_TELEMETRY_HOST);
    cfg->telemetry_port = env_int_or("ICARUS_TELEMETRY_PORT", DEFAULT_TELEMETRY_PORT);
    cfg->command_host   = env_or("ICARUS_COMMAND_HOST", DEFAULT_COMMAND_HOST);
    cfg->command_port   = env_int_or("ICARUS_COMMAND_PORT", DEFAULT_COMMAND_PORT);
    cfg->seed           = (unsigned) env_int_or("ICARUS_SEED", 30023429);
    cfg->quiet          = 0;

    for (int i = 1; i < argc; i++) {
        int has_next = (i + 1) < argc;
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            usage(argv[0]);
            return 1;
        } else if (strcmp(argv[i], "--quiet") == 0) {
            cfg->quiet = 1;
        } else if (strcmp(argv[i], "--telemetry-host") == 0 && has_next) {
            cfg->telemetry_host = argv[++i];
        } else if (strcmp(argv[i], "--telemetry-port") == 0 && has_next) {
            cfg->telemetry_port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--command-host") == 0 && has_next) {
            cfg->command_host = argv[++i];
        } else if (strcmp(argv[i], "--command-port") == 0 && has_next) {
            cfg->command_port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--seed") == 0 && has_next) {
            cfg->seed = (unsigned) strtoul(argv[++i], NULL, 10);
        } else {
            fprintf(stderr, "Unknown or incomplete option: %s\n\n", argv[i]);
            usage(argv[0]);
            return -1;
        }
    }
    return 0;
}

/* ==========================================================================
 * Main
 * ========================================================================== */

int main(int argc, char **argv)
{
    Config cfg;
    IcarusState state;
    char packet[TELEMETRY_BUFFER_BYTES];
    long packets_sent = 0, send_failures = 0;
    double next_status_s = 5.0;
    int rc;

    rc = parse_args(argc, argv, &cfg);
    if (rc != 0) return rc > 0 ? 0 : 2;

    signal(SIGINT, on_signal);
#ifdef SIGTERM
    signal(SIGTERM, on_signal);
#endif

    icarus_init(&state, cfg.seed);

    if (telemetry_open(cfg.telemetry_host, cfg.telemetry_port) != 0) return 3;
    if (commands_open(cfg.command_host, cfg.command_port) != 0) {
        telemetry_close();
        return 4;
    }

    printf("ICARUS OBC simulator - deterministic telemetry demonstrator\n");
    printf("  telemetry -> udp://%s:%d  at %.0f Hz\n",
           cfg.telemetry_host, cfg.telemetry_port, (double) TELEMETRY_HZ);
    printf("  commands  <- udp://%s:%d\n", cfg.command_host, cfg.command_port);
    printf("  orbit     %.0f km, %.1f deg, T = %.2f min, v = %.4f km/s\n",
           state.altitude_km, state.inclination_deg, state.period_min, state.velocity_km_s);
    printf("  clock     orbit/power/thermal at x%.0f real time; ADCS at x1\n",
           (double) ORBIT_TIME_SCALE);
    printf("  seed      %u\n", cfg.seed);
    printf("Ctrl-C to stop.\n\n");
    fflush(stdout);

    while (g_running) {
        /*
         * TWO CLOCKS (see icarus.h):
         *   dt          REAL seconds - the ADCS loop, the vibration channel and
         *               every state-machine dwell are timed with this.
         *   dt_mission  simulated seconds - the orbit, the Sun geometry, the
         *               energy budget and the bus temperature use this, so a
         *               94-minute orbit and a 20-minute thermal time constant
         *               both fit inside a demonstration.
         */
        const double dt = SIM_STEP_S;
        const double dt_mission = dt * ORBIT_TIME_SCALE;

        /* --- 1. uplink --------------------------------------------------- */
        commands_poll(&state);

        /* --- 2. clocks and orbit -----------------------------------------
         * True anomaly advances at the mean motion n = sqrt(mu/r^3). Every
         * REPORTED orbital quantity is the true physical value.            */
        state.t_s += dt;
        state.mission_elapsed_s += dt_mission;
        state.true_anomaly_rad += state.mean_motion_rad_s * dt_mission;
        if (state.true_anomaly_rad > 2.0 * PI) state.true_anomaly_rad -= 2.0 * PI;

        /* --- 3. environment ---------------------------------------------- */
        environment_update(&state);

        /* --- 4. subsystems ----------------------------------------------- */
        adcs_update(&state, dt);              /* real time  */
        power_update(&state, dt_mission);     /* mission time */
        thermal_update(&state, dt_mission);   /* mission time */
        vibration_update(&state, dt);         /* real time  */

        /* --- 5. fault logic ---------------------------------------------- */
        anomaly_update(&state, dt);

        /* --- 6. downlink -------------------------------------------------- */
        if (telemetry_serialize(&state, packet, sizeof(packet)) > 0) {
            if (telemetry_send(packet, (int) strlen(packet)) == 0) packets_sent++;
            else send_failures++;
        }

        /* --- 7. status line ---------------------------------------------- */
        if (!cfg.quiet && state.t_s >= next_status_s) {
            next_status_s += 5.0;
            printf("[t=%7.1fs] %-16s bat %5.1f%%  solar %5.2fW  load %5.2fW  "
                   "T %6.1fC  vib %.3fg  %s  err %5.1fdeg  tx %ld (fail %ld)  "
                   "cmd %ld/%ld\n",
                   state.t_s, flight_state_name(state.state),
                   state.battery_pct, state.solar_w, state.load_w,
                   state.temperature_c, state.vibration_g,
                   state.eclipse ? "ECLIPSE" : "SUNLIT ",
                   state.attitude_error_deg,
                   packets_sent, send_failures,
                   commands_accepted_count(), commands_rejected_count());
            fflush(stdout);
        }

        /*
         * Real-time pacing. A production implementation would compensate for
         * the work done in this iteration; at 10 Hz with microseconds of work
         * per step, sleeping the full period is within a fraction of a percent
         * and is far easier to read.
         */
        icarus_sleep_ms((long) (dt * 1000.0));
    }

    printf("\nShutting down. %ld packets sent, %ld send failures, "
           "%ld commands accepted, %ld rejected.\n",
           packets_sent, send_failures,
           commands_accepted_count(), commands_rejected_count());

    commands_close();
    telemetry_close();
    return 0;
}

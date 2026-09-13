/*
 * commands.c - the uplink
 * ============================================================================
 * The OBC binds a second UDP socket and accepts a small, fixed set of JSON
 * commands forwarded by the Python bridge:
 *
 *   {"type":"command","command":"inject_anomaly","kind":"thermal"}
 *   {"type":"command","command":"inject_attitude_disturbance"}
 *   {"type":"command","command":"reset"}
 *   {"type":"command","command":"set_altitude","value":700}
 *   {"type":"command","command":"set_inclination","value":72}
 *   {"type":"command","command":"set_attitude","roll_deg":20,"pitch_deg":0,"yaw_deg":0}
 *
 * WHITELIST: anything whose command name is not in COMMANDS below is counted
 * and dropped. Numeric arguments are range-checked against the same limits the
 * browser and the bridge enforce, so a malformed or hostile packet cannot put
 * the simulation into a nonsense state.
 *
 * JSON PARSING: this is a hand-written scanner, not a JSON library. The command
 * grammar is six messages with at most three numeric fields, the socket is
 * bound to loopback, and pulling in a parser dependency for that would make the
 * program harder for a new team member to read and build. It looks for the key
 * it wants and reads the value after the colon; unknown fields are ignored.
 */

#include "commands.h"
#include "adcs.h"
#include "anomaly.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CMD_BUFFER_BYTES 512

static icarus_socket_t g_sock = ICARUS_INVALID_SOCKET;
static int  g_open = 0;
static long g_accepted = 0;
static long g_rejected = 0;

/* The whitelist. Keep in step with src/state/types.ts and bridge/bridge.py. */
static const char *const COMMANDS[] = {
    "inject_anomaly",
    "inject_attitude_disturbance",
    "reset",
    "set_altitude",
    "set_inclination",
    "set_attitude",
    NULL
};

static int is_whitelisted(const char *name)
{
    for (int i = 0; COMMANDS[i] != NULL; i++) {
        if (strcmp(COMMANDS[i], name) == 0) return 1;
    }
    return 0;
}

/*
 * Find "key" : <value> and return a pointer just past the colon, or NULL.
 *
 * The quoted key is matched exactly, so "kind" does not match "kindof". The
 * search then CONTINUES past any match that is not followed by a colon,
 * because such a match was a string *value*, not a key. That case is not
 * hypothetical: every command packet contains {"type":"command", ...}, so a
 * naive first-match search for the key "command" lands on the value of "type"
 * and the command silently never runs.
 */
static const char *find_value(const char *json, const char *key)
{
    char pattern[64];
    const char *p = json;
    size_t pattern_len;

    if (snprintf(pattern, sizeof(pattern), "\"%s\"", key) >= (int) sizeof(pattern)) return NULL;
    pattern_len = strlen(pattern);

    for (;;) {
        const char *q;
        p = strstr(p, pattern);
        if (p == NULL) return NULL;

        q = p + pattern_len;
        while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r') q++;
        if (*q == ':') {
            q++;
            while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r') q++;
            return q;
        }
        p += pattern_len;   /* that was a value, not a key - keep looking */
    }
}

/* Read a quoted string value into `out`. Returns 1 on success. */
static int read_string(const char *json, const char *key, char *out, size_t out_len)
{
    const char *p = find_value(json, key);
    size_t i = 0;

    if (p == NULL || *p != '"') return 0;
    p++;
    while (*p != '"' && *p != '\0' && i + 1 < out_len) out[i++] = *p++;
    out[i] = '\0';
    return *p == '"';
}

/* Read a numeric value. Returns 1 on success. */
static int read_number(const char *json, const char *key, double *out)
{
    const char *p = find_value(json, key);
    char *end;
    double v;

    if (p == NULL) return 0;
    v = strtod(p, &end);
    if (end == p) return 0;
    *out = v;
    return 1;
}

int commands_open(const char *host, int port)
{
    struct sockaddr_in addr;

    if (icarus_net_start() != 0) {
        fprintf(stderr, "[commands] socket layer init failed\n");
        return -1;
    }

    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_sock == ICARUS_INVALID_SOCKET) {
        fprintf(stderr, "[commands] socket() failed\n");
        return -1;
    }

    if (icarus_resolve(host, port, &addr) != 0) {
        fprintf(stderr, "[commands] bad bind address '%s:%d'\n", host, port);
        icarus_close_socket(g_sock);
        g_sock = ICARUS_INVALID_SOCKET;
        return -1;
    }

    if (bind(g_sock, (struct sockaddr *) &addr, sizeof(addr)) != 0) {
        fprintf(stderr, "[commands] bind to %s:%d failed - is another OBC running?\n", host, port);
        icarus_close_socket(g_sock);
        g_sock = ICARUS_INVALID_SOCKET;
        return -1;
    }

    /* Non-blocking: the simulation loop must never stall waiting for uplink. */
    if (icarus_set_nonblocking(g_sock) != 0) {
        fprintf(stderr, "[commands] could not set non-blocking mode\n");
        icarus_close_socket(g_sock);
        g_sock = ICARUS_INVALID_SOCKET;
        return -1;
    }

    g_open = 1;
    return 0;
}

static void apply_command(IcarusState *s, const char *json, const char *name)
{
    double value;
    char kind[32];

    if (strcmp(name, "reset") == 0) {
        icarus_reset(s);
        printf("[commands] reset\n");

    } else if (strcmp(name, "inject_attitude_disturbance") == 0) {
        adcs_inject_disturbance(s);
        printf("[commands] attitude disturbance injected\n");

    } else if (strcmp(name, "inject_anomaly") == 0) {
        AnomalyKind k = ANOMALY_THERMAL;
        if (read_string(json, "kind", kind, sizeof(kind))) {
            if (strcmp(kind, "battery") == 0) k = ANOMALY_BATTERY;
            else if (strcmp(kind, "thermal") != 0) {
                g_rejected++;
                printf("[commands] rejected inject_anomaly: unknown kind '%s'\n", kind);
                return;
            }
        }
        anomaly_inject(s, k);
        printf("[commands] %s anomaly injected\n", k == ANOMALY_BATTERY ? "battery" : "thermal");

    } else if (strcmp(name, "set_altitude") == 0) {
        if (!read_number(json, "value", &value) || value < ALT_MIN_KM || value > ALT_MAX_KM) {
            g_rejected++;
            printf("[commands] rejected set_altitude: value out of range\n");
            return;
        }
        s->altitude_km = value;
        icarus_update_orbit_elements(s);
        printf("[commands] altitude -> %.1f km (v %.4f km/s, T %.2f min)\n",
               s->altitude_km, s->velocity_km_s, s->period_min);

    } else if (strcmp(name, "set_inclination") == 0) {
        if (!read_number(json, "value", &value) || value < INC_MIN_DEG || value > INC_MAX_DEG) {
            g_rejected++;
            printf("[commands] rejected set_inclination: value out of range\n");
            return;
        }
        s->inclination_deg = value;
        printf("[commands] inclination -> %.2f deg\n", s->inclination_deg);

    } else if (strcmp(name, "set_attitude") == 0) {
        double roll, pitch, yaw;
        if (!read_number(json, "roll_deg", &roll)
            || !read_number(json, "pitch_deg", &pitch)
            || !read_number(json, "yaw_deg", &yaw)) {
            g_rejected++;
            printf("[commands] rejected set_attitude: missing angle\n");
            return;
        }
        if (roll < -180.0 || roll > 180.0 || pitch < -180.0 || pitch > 180.0
            || yaw < -180.0 || yaw > 180.0) {
            g_rejected++;
            printf("[commands] rejected set_attitude: angle out of range\n");
            return;
        }
        adcs_set_target_rpy(s, roll, pitch, yaw);
        printf("[commands] target attitude -> %.1f / %.1f / %.1f deg\n", roll, pitch, yaw);

    } else {
        g_rejected++;
        return;
    }

    g_accepted++;
}

int commands_poll(IcarusState *s)
{
    char buf[CMD_BUFFER_BYTES];
    char name[64];
    int applied = 0;

    if (!g_open) return 0;

    /* Drain everything queued this tick; a non-blocking recvfrom returns
     * "would block" when the queue is empty, which is the normal exit. */
    for (;;) {
        int n = (int) recvfrom(g_sock, buf, sizeof(buf) - 1, 0, NULL, NULL);
        if (n <= 0) {
            if (n < 0 && !icarus_would_block()) {
                /* A genuine socket error - report once and keep flying. */
                fprintf(stderr, "[commands] recvfrom error\n");
            }
            break;
        }
        buf[n] = '\0';

        if (!read_string(buf, "command", name, sizeof(name))) {
            g_rejected++;
            printf("[commands] rejected packet: no command field\n");
            continue;
        }
        if (!is_whitelisted(name)) {
            g_rejected++;
            printf("[commands] rejected '%s': not whitelisted\n", name);
            continue;
        }

        apply_command(s, buf, name);
        applied++;
    }

    return applied;
}

void commands_close(void)
{
    if (g_sock != ICARUS_INVALID_SOCKET) icarus_close_socket(g_sock);
    g_sock = ICARUS_INVALID_SOCKET;
    g_open = 0;
}

long commands_accepted_count(void) { return g_accepted; }
long commands_rejected_count(void) { return g_rejected; }

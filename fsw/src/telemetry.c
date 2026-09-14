/*
 * telemetry.c - JSON serialisation and the UDP downlink
 * ============================================================================
 * WHY JSON: it is self-describing, a human can read a packet capture without a
 * decoder, and the Python bridge and the browser both parse it for free. A
 * real spacecraft would use a packed binary format (CCSDS space packets) for
 * bandwidth reasons - here the whole packet is under 700 bytes at 10 Hz, which
 * is 7 kB/s on loopback. Not a problem worth optimising.
 *
 * WHY UDP: the two processes are on the same machine and the data is a
 * continuous stream of "here is my state right now". Losing one sample out of
 * ten is invisible; waiting for a retransmission of a stale sample is worse
 * than useless. There is no back-pressure and no head-of-line blocking, and
 * the OBC never blocks on a ground station that has gone away.
 *
 * PACKET SHAPE IS CONSTANT. An unavailable value is written as `null` and the
 * surrounding object is still emitted - see src/state/types.ts.
 */

#include "telemetry.h"
#include "adcs.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>

static icarus_socket_t g_sock = ICARUS_INVALID_SOCKET;
static struct sockaddr_in g_dest;
static int g_open = 0;

int telemetry_open(const char *host, int port)
{
    if (icarus_net_start() != 0) {
        fprintf(stderr, "[telemetry] socket layer init failed\n");
        return -1;
    }

    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_sock == ICARUS_INVALID_SOCKET) {
        fprintf(stderr, "[telemetry] socket() failed\n");
        return -1;
    }

    if (icarus_resolve(host, port, &g_dest) != 0) {
        fprintf(stderr, "[telemetry] bad destination '%s:%d'\n", host, port);
        icarus_close_socket(g_sock);
        g_sock = ICARUS_INVALID_SOCKET;
        return -1;
    }

    g_open = 1;
    return 0;
}

int telemetry_send(const char *buf, int len)
{
    int sent;
    if (!g_open) return -1;

    sent = (int) sendto(g_sock, buf, (size_t) len, 0,
                        (struct sockaddr *) &g_dest, sizeof(g_dest));

    /*
     * A failed send is NOT fatal. If nothing is listening on the telemetry
     * port, some platforms return ICMP-port-unreachable as an error on the
     * next send. The spacecraft does not stop flying because the ground
     * station went away, and neither does this simulator.
     */
    return sent == len ? 0 : -1;
}

void telemetry_close(void)
{
    if (g_sock != ICARUS_INVALID_SOCKET) icarus_close_socket(g_sock);
    g_sock = ICARUS_INVALID_SOCKET;
    g_open = 0;
    icarus_net_stop();
}

/* Escape the few characters that can legally appear in a fault message. */
static void json_escape(const char *in, char *out, size_t out_len)
{
    size_t o = 0;
    for (size_t i = 0; in[i] != '\0' && o + 2 < out_len; i++) {
        unsigned char c = (unsigned char) in[i];
        if (c == '"' || c == '\\') {
            out[o++] = '\\';
            out[o++] = (char) c;
        } else if (c < 0x20) {
            out[o++] = ' ';
        } else {
            out[o++] = (char) c;
        }
    }
    out[o] = '\0';
}

int telemetry_serialize(const IcarusState *s, char *buf, int buf_len)
{
    double roll, pitch, yaw;
    double timestamp;
    const char *fault_code;
    char message[sizeof(s->fault_message) * 2];
    char fault_block[sizeof(message) + 96];
    int n;

    adcs_current_rpy(s, &roll, &pitch, &yaw);

    /* UNIX seconds, UTC - the same clock the browser and OpenMCT plot on. */
    timestamp = s->epoch_unix_s + s->t_s;

    fault_code = fault_code_name(s->fault_code);
    if (fault_code == NULL) {
        snprintf(fault_block, sizeof(fault_block),
                 "\"active\":%s,\"code\":null,\"message\":null",
                 s->fault_active ? "true" : "false");
    } else {
        json_escape(s->fault_message, message, sizeof(message));
        snprintf(fault_block, sizeof(fault_block),
                 "\"active\":%s,\"code\":\"%s\",\"message\":\"%s\"",
                 s->fault_active ? "true" : "false", fault_code, message);
    }

    n = snprintf(
        buf, (size_t) buf_len,
        "{"
        "\"telemetry_schema_version\":%d,"
        "\"timestamp\":%.3f,"
        "\"source\":\"%s\","
        "\"satellite\":\"%s\","
        "\"orbit\":{"
            "\"altitude_km\":%.2f,"
            "\"velocity_km_s\":%.4f,"
            "\"inclination_deg\":%.2f,"
            "\"period_min\":%.3f"
        "},"
        "\"attitude\":{"
            "\"roll_deg\":%.2f,"
            "\"pitch_deg\":%.2f,"
            "\"yaw_deg\":%.2f,"
            "\"angular_velocity_deg_s\":[%.3f,%.3f,%.3f],"
            "\"target_error_deg\":%.2f"
        "},"
        "\"power\":{"
            "\"battery_pct\":%.2f,"
            "\"solar_w\":%.3f,"
            "\"load_w\":%.3f"
        "},"
        "\"thermal\":{\"temperature_c\":%.2f},"
        "\"vibration\":{\"g\":%.4f},"
        "\"environment\":{\"eclipse\":%s,\"illumination_pct\":%.1f},"
        "\"fault\":{%s},"
        "\"state\":\"%s\""
        "}",
        TELEMETRY_SCHEMA_VERSION,
        timestamp,
        TELEMETRY_SOURCE,
        SATELLITE_ID,
        s->altitude_km, s->velocity_km_s, s->inclination_deg, s->period_min,
        roll, pitch, yaw,
        s->omega_rad_s[0] * RAD2DEG, s->omega_rad_s[1] * RAD2DEG, s->omega_rad_s[2] * RAD2DEG,
        s->attitude_error_deg,
        s->battery_pct, s->solar_w, s->load_w,
        s->temperature_c,
        s->vibration_g,
        s->eclipse ? "true" : "false", s->illumination * 100.0,
        fault_block,
        flight_state_name(s->state));

    if (n < 0 || n >= buf_len) return -1;
    return n;
}

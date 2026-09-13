/*
 * telemetry.h - JSON serialisation and the UDP downlink
 */
#ifndef ICARUS_TELEMETRY_H
#define ICARUS_TELEMETRY_H

#include "icarus.h"

/* Large enough for the fixed-shape packet plus a 160-character fault message. */
#define TELEMETRY_BUFFER_BYTES 1400

/*
 * Serialise the state into the telemetry contract defined in
 * src/state/types.ts. The packet SHAPE is constant: an unavailable value is
 * written as null, never omitted, and no block is ever dropped.
 *
 * Returns the number of bytes written (excluding the terminator), or -1.
 */
int telemetry_serialize(const IcarusState *s, char *buf, int buf_len);

/* Open the downlink socket. Returns 0 on success. */
int telemetry_open(const char *host, int port);

/* Send one packet. Returns 0 on success; failures are non-fatal by design -
 * losing the ground link must not stop the spacecraft simulation. */
int telemetry_send(const char *buf, int len);

void telemetry_close(void);

#endif

/*
 * commands.h - the uplink: whitelisted commands over UDP
 */
#ifndef ICARUS_COMMANDS_H
#define ICARUS_COMMANDS_H

#include "icarus.h"

/*
 * The OBC binds a second UDP socket and accepts a small, fixed set of JSON
 * commands forwarded by the Python bridge. Anything not on the whitelist is
 * counted and dropped.
 *
 * The whitelist is identical in three places - keep them in step:
 *   src/state/types.ts   COMMAND_WHITELIST
 *   bridge/bridge.py     ALLOWED_COMMANDS
 *   fsw/src/commands.c   this file
 */
int  commands_open(const char *host, int port);

/* Non-blocking: drain and apply every command waiting on the socket.
 * Returns the number of commands accepted this call. */
int  commands_poll(IcarusState *s);

void commands_close(void);

/* Counters for the periodic status line. */
long commands_accepted_count(void);
long commands_rejected_count(void);

#endif

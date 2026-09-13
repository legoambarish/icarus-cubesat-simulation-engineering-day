/*
 * platform.h - the only place this program knows what OS it is on
 * ============================================================================
 * Winsock and BSD sockets differ in four small ways (init/teardown, the socket
 * handle type, the close call, and how you set a socket non-blocking). Rather
 * than sprinkle #ifdefs through telemetry.c and commands.c, they are collected
 * here.
 *
 * Nothing else in the OBC is platform dependent - the physics is plain C99.
 */

#ifndef ICARUS_PLATFORM_H
#define ICARUS_PLATFORM_H

#include <string.h>

/* Not every translation unit needs every helper below; they are static by
 * intent, so silence the resulting "defined but not used" warnings. */
#if defined(__GNUC__) || defined(__clang__)
  #define ICARUS_MAYBE_UNUSED __attribute__((unused))
#else
  #define ICARUS_MAYBE_UNUSED
#endif

#ifdef _WIN32

  /*
   * inet_pton() is Vista-era API. Without this the Windows headers hide its
   * declaration, the compiler falls back to an implicit int-returning
   * function, and the address is silently parsed by something that is not
   * inet_pton. It links, it runs, and it is undefined behaviour - MSVC rejects
   * it outright. Declare the target Windows version before any header.
   */
  #ifndef _WIN32_WINNT
    #define _WIN32_WINNT 0x0601   /* Windows 7 */
  #endif
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  #include <stdio.h>

  typedef SOCKET icarus_socket_t;
  #define ICARUS_INVALID_SOCKET INVALID_SOCKET
  #define icarus_close_socket(s) closesocket(s)
  #define icarus_sleep_ms(ms)    Sleep((DWORD)(ms))

  static ICARUS_MAYBE_UNUSED int icarus_net_start(void)
  {
      WSADATA wsa;
      return WSAStartup(MAKEWORD(2, 2), &wsa) == 0 ? 0 : -1;
  }

  static ICARUS_MAYBE_UNUSED void icarus_net_stop(void) { WSACleanup(); }

  static ICARUS_MAYBE_UNUSED int icarus_set_nonblocking(icarus_socket_t s)
  {
      u_long mode = 1;
      return ioctlsocket(s, FIONBIO, &mode) == 0 ? 0 : -1;
  }

  static ICARUS_MAYBE_UNUSED int icarus_would_block(void)
  {
      return WSAGetLastError() == WSAEWOULDBLOCK;
  }

#else /* POSIX */

  #include <arpa/inet.h>
  #include <errno.h>
  #include <fcntl.h>
  #include <netdb.h>
  #include <netinet/in.h>
  #include <stdio.h>
  #include <sys/socket.h>
  #include <sys/types.h>
  #include <time.h>
  #include <unistd.h>

  typedef int icarus_socket_t;
  #define ICARUS_INVALID_SOCKET (-1)
  #define icarus_close_socket(s) close(s)

  static ICARUS_MAYBE_UNUSED int icarus_net_start(void) { return 0; }
  static ICARUS_MAYBE_UNUSED void icarus_net_stop(void) { }

  static ICARUS_MAYBE_UNUSED void icarus_sleep_ms(long ms)
  {
      struct timespec ts;
      ts.tv_sec  = ms / 1000;
      ts.tv_nsec = (ms % 1000) * 1000000L;
      nanosleep(&ts, NULL);
  }

  static ICARUS_MAYBE_UNUSED int icarus_set_nonblocking(icarus_socket_t s)
  {
      int flags = fcntl(s, F_GETFL, 0);
      if (flags < 0) return -1;
      return fcntl(s, F_SETFL, flags | O_NONBLOCK) == 0 ? 0 : -1;
  }

  static ICARUS_MAYBE_UNUSED int icarus_would_block(void)
  {
      return errno == EAGAIN || errno == EWOULDBLOCK;
  }

#endif

/*
 * Resolve "host:port" into an IPv4 socket address.
 *
 * getaddrinfo() rather than inet_pton() for three reasons: it is the one
 * spelling that is identical on Winsock and POSIX; it accepts HOSTNAMES, so
 * --telemetry-host localhost works and not only 127.0.0.1; and inet_pton is
 * hidden by MinGW's headers under -std=c99, which sets __STRICT_ANSI__ and
 * would leave it as an implicit declaration - it links, it appears to work,
 * and it is undefined behaviour.
 *
 * Returns 0 on success.
 */
static ICARUS_MAYBE_UNUSED int icarus_resolve(const char *host, int port, struct sockaddr_in *out)
{
    struct addrinfo hints;
    struct addrinfo *res = NULL;
    char port_text[16];
    int rc;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;        /* IPv4 only - the OBC speaks IPv4 UDP */
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_protocol = IPPROTO_UDP;

    snprintf(port_text, sizeof(port_text), "%d", port);

    rc = getaddrinfo(host, port_text, &hints, &res);
    if (rc != 0 || res == NULL) {
        fprintf(stderr, "[net] cannot resolve '%s:%d'\n", host, port);
        return -1;
    }

    memcpy(out, res->ai_addr, sizeof(struct sockaddr_in));
    freeaddrinfo(res);
    return 0;
}

#endif /* ICARUS_PLATFORM_H */

#!/usr/bin/env python3
"""
ICARUS TELEMETRY BRIDGE  -  UDP <-> WebSocket
=============================================================================

    Icarus C OBC  --UDP :5005-->  bridge  --WebSocket :8082-->  digital twin
                  <--UDP :5006--         <--WebSocket--         + OpenMCT

WHY THIS PROCESS EXISTS
    A browser cannot open a UDP socket. The C OBC speaks UDP because it is a
    local, lossy-tolerant, fire-and-forget telemetry stream where a dropped
    sample is invisible and a retransmitted stale sample is worse than useless.
    The browser needs a WebSocket. This is the adapter between the two, and it
    is the only place that knows about both.

WHAT IT GUARANTEES
    * Nothing malformed reaches a client. Every packet is decoded, shape- and
      range-checked against the same contract as src/state/types.ts, and
      rejected with a counted reason if it fails.
    * Only whitelisted commands go the other way, with their arguments range
      checked, so a browser tab (or anything else that connects) cannot put the
      OBC into a nonsense state.
    * A client that disappears mid-send never takes the bridge down, and never
      blocks the other clients.
    * It binds to LOOPBACK by default. This is an exhibition tool on a laptop,
      not a service; --host 0.0.0.0 is available and is an explicit choice.

RUN
    python bridge/bridge.py
    python bridge/bridge.py --ws-port 8082 --telemetry-port 5005 --command-port 5006
    python bridge/bridge.py --verbose          # log every rejected packet

    Environment: ICARUS_WS_HOST/_PORT, ICARUS_TELEMETRY_PORT, ICARUS_COMMAND_PORT,
    ICARUS_COMMAND_HOST.

Requires Python 3.11+ and websockets >= 13 (the asyncio server API).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Final

try:
    # websockets >= 13. The legacy `websockets.serve` still exists but is
    # deprecated; this is the supported asyncio implementation.
    from websockets.asyncio.server import ServerConnection, serve
except ImportError:  # pragma: no cover - dependency guidance, not logic
    sys.stderr.write(
        "\n  The 'websockets' package (>= 13) is required.\n"
        "  Install it with:  pip install -r bridge/requirements.txt\n\n"
    )
    raise

LOG = logging.getLogger("icarus.bridge")

# --------------------------------------------------------------------------
# The telemetry contract. Mirrors src/state/types.ts and fsw/src/telemetry.c.
# --------------------------------------------------------------------------

TELEMETRY_SCHEMA_VERSION: Final = 2

KNOWN_STATES: Final = frozenset(
    {
        "BOOT",
        "NOMINAL",
        "DISTURBANCE",
        "ADCS_ACTIVE",
        "ERROR_DECREASING",
        "ANOMALY",
        "SAFE_MODE",
        "RECOVERY",
    }
)
KNOWN_FAULTS: Final = frozenset({"THERMAL_LIMIT", "BATTERY_CRITICAL", "ATTITUDE_ERROR"})
KNOWN_SOURCES: Final = frozenset({"ICARUS-OBC", "BROWSER-FSW"})

# Plausible engineering ranges. Outside these the packet is garbage, and a NaN
# reaching a Three.js transform corrupts the whole scene, so this is not
# paranoia - it is the cheapest place to stop it.
RANGES: Final[dict[str, tuple[float, float]]] = {
    "orbit.altitude_km": (80.0, 60_000.0),
    "orbit.velocity_km_s": (0.0, 20.0),
    "orbit.inclination_deg": (0.0, 180.0),
    "orbit.period_min": (40.0, 2000.0),
    "attitude.roll_deg": (-720.0, 720.0),
    "attitude.pitch_deg": (-720.0, 720.0),
    "attitude.yaw_deg": (-720.0, 720.0),
    "attitude.target_error_deg": (0.0, 360.0),
    "power.battery_pct": (0.0, 100.0),
    "power.solar_w": (0.0, 200.0),
    "power.load_w": (0.0, 200.0),
    "thermal.temperature_c": (-200.0, 300.0),
    "vibration.g": (0.0, 50.0),
    "environment.illumination_pct": (0.0, 100.0),
}

# The command whitelist. Keep in step with src/state/types.ts
# (COMMAND_WHITELIST) and fsw/src/commands.c (COMMANDS).
ALLOWED_COMMANDS: Final[dict[str, dict[str, Any]]] = {
    "inject_anomaly": {"kind": {"thermal", "battery"}},
    "inject_attitude_disturbance": {},
    "reset": {},
    "set_altitude": {"value": (200.0, 2000.0)},
    "set_inclination": {"value": (0.0, 145.0)},
    "set_attitude": {
        "roll_deg": (-180.0, 180.0),
        "pitch_deg": (-180.0, 180.0),
        "yaw_deg": (-180.0, 180.0),
    },
}

MAX_PACKET_BYTES: Final = 8192
MAX_COMMAND_BYTES: Final = 2048


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def _num(container: dict[str, Any], key: str, path: str) -> float | None:
    """A finite number inside its declared range, or None."""
    value = container.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        return None
    lo, hi = RANGES[path]
    if not (lo <= value <= hi):
        return None
    return value


def validate_packet(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """
    Validate and normalise one decoded telemetry packet.

    Returns (packet, "") on success or (None, reason) on rejection. Optional
    fields are back-filled rather than omitted, because the contract says the
    packet SHAPE is constant: a missing value becomes null or a derived value,
    never an absent key.
    """
    if not isinstance(raw, dict):
        return None, "not a JSON object"

    version = raw.get("telemetry_schema_version", TELEMETRY_SCHEMA_VERSION)
    if version != TELEMETRY_SCHEMA_VERSION:
        return None, f"unsupported schema version {version!r}"

    timestamp = raw.get("timestamp")
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
        return None, "timestamp missing or not a number"
    timestamp = float(timestamp)
    if not (0 <= timestamp <= 4e10):
        return None, "timestamp out of range"

    source = raw.get("source")
    if source not in KNOWN_SOURCES:
        return None, f"unknown source {source!r}"

    satellite = raw.get("satellite")
    if not isinstance(satellite, str) or not 0 < len(satellite) <= 64:
        return None, "satellite id missing or too long"

    state = raw.get("state")
    if state not in KNOWN_STATES:
        return None, f"unknown flight state {state!r}"

    # ---- orbit ----------------------------------------------------------
    orbit_in = raw.get("orbit")
    if not isinstance(orbit_in, dict):
        return None, "orbit block missing"
    altitude = _num(orbit_in, "altitude_km", "orbit.altitude_km")
    velocity = _num(orbit_in, "velocity_km_s", "orbit.velocity_km_s")
    inclination = _num(orbit_in, "inclination_deg", "orbit.inclination_deg")
    if altitude is None:
        return None, "orbit.altitude_km invalid"
    if velocity is None:
        return None, "orbit.velocity_km_s invalid"
    if inclination is None:
        return None, "orbit.inclination_deg invalid"
    period = _num(orbit_in, "period_min", "orbit.period_min")
    if period is None:
        # Derivable, so a sender that omits it is tolerated: T = 2pi sqrt(r^3/mu)
        r = 6371.0 + altitude
        period = 2 * 3.141592653589793 * ((r**3) / 398600.4418) ** 0.5 / 60.0

    # ---- attitude -------------------------------------------------------
    att_in = raw.get("attitude")
    if not isinstance(att_in, dict):
        return None, "attitude block missing"
    roll = _num(att_in, "roll_deg", "attitude.roll_deg")
    pitch = _num(att_in, "pitch_deg", "attitude.pitch_deg")
    yaw = _num(att_in, "yaw_deg", "attitude.yaw_deg")
    if roll is None or pitch is None or yaw is None:
        return None, "attitude roll/pitch/yaw invalid"

    rates_in = att_in.get("angular_velocity_deg_s")
    rates: list[float] = [0.0, 0.0, 0.0]
    if isinstance(rates_in, list) and len(rates_in) == 3:
        out: list[float] = []
        for component in rates_in:
            if isinstance(component, bool) or not isinstance(component, (int, float)):
                return None, "attitude.angular_velocity_deg_s invalid"
            component = float(component)
            if component != component or not (-720.0 <= component <= 720.0):
                return None, "attitude.angular_velocity_deg_s out of range"
            out.append(component)
        rates = out

    target_error = _num(att_in, "target_error_deg", "attitude.target_error_deg")
    if target_error is None:
        target_error = 0.0

    # ---- power / thermal / vibration / environment ----------------------
    power_in = raw.get("power")
    if not isinstance(power_in, dict):
        return None, "power block missing"
    battery = _num(power_in, "battery_pct", "power.battery_pct")
    solar = _num(power_in, "solar_w", "power.solar_w")
    if battery is None:
        return None, "power.battery_pct invalid"
    if solar is None:
        return None, "power.solar_w invalid"
    load = _num(power_in, "load_w", "power.load_w")
    if load is None:
        load = 0.0

    thermal_in = raw.get("thermal")
    if not isinstance(thermal_in, dict):
        return None, "thermal block missing"
    temperature = _num(thermal_in, "temperature_c", "thermal.temperature_c")
    if temperature is None:
        return None, "thermal.temperature_c invalid"

    vib_in = raw.get("vibration")
    if not isinstance(vib_in, dict):
        return None, "vibration block missing"
    vibration = _num(vib_in, "g", "vibration.g")
    if vibration is None:
        return None, "vibration.g invalid"

    env_in = raw.get("environment")
    if not isinstance(env_in, dict):
        return None, "environment block missing"
    eclipse_raw = env_in.get("eclipse")
    if not isinstance(eclipse_raw, bool) and eclipse_raw not in (0, 1):
        return None, "environment.eclipse invalid"
    illumination_pct = _num(env_in, "illumination_pct", "environment.illumination_pct")
    if illumination_pct is None:
        return None, "environment.illumination_pct invalid"

    # ---- fault ----------------------------------------------------------
    fault_in = raw.get("fault")
    fault = {"active": False, "code": None, "message": None}
    if isinstance(fault_in, dict):
        code = fault_in.get("code")
        message = fault_in.get("message")
        fault = {
            "active": bool(fault_in.get("active")),
            "code": code if code in KNOWN_FAULTS else None,
            "message": message[:160] if isinstance(message, str) else None,
        }

    return (
        {
            "telemetry_schema_version": TELEMETRY_SCHEMA_VERSION,
            "timestamp": timestamp,
            "source": source,
            "satellite": satellite,
            "orbit": {
                "altitude_km": altitude,
                "velocity_km_s": velocity,
                "inclination_deg": inclination,
                "period_min": period,
            },
            "attitude": {
                "roll_deg": roll,
                "pitch_deg": pitch,
                "yaw_deg": yaw,
                "angular_velocity_deg_s": rates,
                "target_error_deg": target_error,
            },
            "power": {"battery_pct": battery, "solar_w": solar, "load_w": load},
            "thermal": {"temperature_c": temperature},
            "vibration": {"g": vibration},
            "environment": {
                "eclipse": bool(eclipse_raw),
                "illumination_pct": illumination_pct,
            },
            "fault": fault,
            "state": state,
        },
        "",
    )


def validate_command(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """
    Whitelist and range-check one command from a WebSocket client.

    Returns (command, "") or (None, reason). Only the fields the command
    declares are forwarded, so a client cannot smuggle extra keys through to
    the OBC's parser.
    """
    if not isinstance(raw, dict):
        return None, "not a JSON object"
    if raw.get("type") != "command":
        return None, "type must be 'command'"

    name = raw.get("command")
    if not isinstance(name, str) or name not in ALLOWED_COMMANDS:
        return None, f"command {name!r} is not whitelisted"

    spec = ALLOWED_COMMANDS[name]
    out: dict[str, Any] = {"type": "command", "command": name}

    for field_name, rule in spec.items():
        value = raw.get(field_name)

        if isinstance(rule, set):  # an enum, e.g. inject_anomaly kind
            if value is None:
                continue  # optional; the OBC applies its own default
            if value not in rule:
                return None, f"{name}.{field_name} must be one of {sorted(rule)}"
            out[field_name] = value
            continue

        lo, hi = rule  # a numeric range
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, f"{name}.{field_name} must be a number"
        value = float(value)
        if value != value or not (lo <= value <= hi):
            return None, f"{name}.{field_name} out of range {lo}..{hi}"
        out[field_name] = value

    return out, ""


# --------------------------------------------------------------------------
# Bridge
# --------------------------------------------------------------------------


@dataclass
class Stats:
    """Health counters. Invaluable when something is wrong at an exhibition."""

    accepted: int = 0
    malformed: int = 0
    commands_forwarded: int = 0
    commands_rejected: int = 0
    last_packet_at: float | None = None
    started_at: float = field(default_factory=time.monotonic)
    reject_reasons: dict[str, int] = field(default_factory=dict)

    def note_rejection(self, reason: str) -> None:
        self.malformed += 1
        self.reject_reasons[reason] = self.reject_reasons.get(reason, 0) + 1


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.clients: set[ServerConnection] = set()
        self.stats = Stats()
        self._command_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    # ---- WebSocket -------------------------------------------------------

    async def handle_client(self, websocket: ServerConnection) -> None:
        """One connected consumer: the digital twin, OpenMCT, or both."""
        self.clients.add(websocket)
        peer = getattr(websocket, "remote_address", None)
        LOG.info("client connected (%s) - %d now connected", peer, len(self.clients))
        try:
            async for message in websocket:
                await self._on_client_message(websocket, message)
        except Exception as exc:  # a client vanishing is routine, not an error
            LOG.debug("client read ended: %s", exc)
        finally:
            self.clients.discard(websocket)
            LOG.info("client disconnected - %d now connected", len(self.clients))

    async def _on_client_message(self, websocket: ServerConnection, message: Any) -> None:
        if isinstance(message, (bytes, bytearray)):
            message = message.decode("utf-8", errors="replace")
        if not isinstance(message, str) or len(message) > MAX_COMMAND_BYTES:
            self.stats.commands_rejected += 1
            return

        try:
            decoded = json.loads(message)
        except json.JSONDecodeError:
            self.stats.commands_rejected += 1
            LOG.warning("command rejected: not JSON")
            return

        command, reason = validate_command(decoded)
        if command is None:
            self.stats.commands_rejected += 1
            LOG.warning("command rejected: %s", reason)
            await self._safe_send(websocket, json.dumps({"type": "status", "error": reason}))
            return

        payload = json.dumps(command).encode("utf-8")
        try:
            self._command_sock.sendto(payload, (self.args.command_host, self.args.command_port))
            self.stats.commands_forwarded += 1
            LOG.info("command -> OBC: %s", command)
        except OSError as exc:
            # The OBC may not be running. Say so rather than pretending.
            LOG.error("command could not be delivered: %s", exc)
            await self._safe_send(
                websocket, json.dumps({"type": "status", "error": f"uplink failed: {exc}"})
            )

    async def _safe_send(self, websocket: ServerConnection, payload: str) -> bool:
        try:
            await websocket.send(payload)
            return True
        except Exception:
            return False

    async def broadcast(self, payload: str) -> None:
        """
        Send to every client, dropping the ones that have gone away.

        Sends run concurrently so one slow consumer cannot delay the others,
        and every failure is swallowed: a client disconnecting mid-send is the
        normal way a browser tab closes, not an error condition.
        """
        if not self.clients:
            return
        targets = list(self.clients)
        results = await asyncio.gather(
            *(self._safe_send(ws, payload) for ws in targets), return_exceptions=True
        )
        for ws, ok in zip(targets, results):
            if ok is not True:
                self.clients.discard(ws)

    # ---- UDP telemetry ---------------------------------------------------

    async def telemetry_loop(self) -> None:
        """
        Receive, validate and forward OBC telemetry.

        A blocking socket read is run in a worker thread rather than with an
        asyncio datagram endpoint: it is a handful of lines, it behaves
        identically on Windows and POSIX, and at 10 Hz the overhead is
        irrelevant. asyncio.DatagramProtocol would be the choice at real rates.
        """
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((self.args.host, self.args.telemetry_port))
        except OSError as exc:
            LOG.error(
                "cannot bind UDP %s:%d (%s) - is another bridge already running?",
                self.args.host,
                self.args.telemetry_port,
                exc,
            )
            raise
        sock.settimeout(0.5)

        LOG.info("listening for OBC telemetry on udp://%s:%d", self.args.host, self.args.telemetry_port)
        loop = asyncio.get_running_loop()

        while True:
            try:
                data = await loop.run_in_executor(None, self._recv, sock)
            except asyncio.CancelledError:
                sock.close()
                raise
            if data is None:
                continue  # timeout: just loop, so cancellation stays responsive

            try:
                decoded = json.loads(data.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                self.stats.note_rejection(f"undecodable: {type(exc).__name__}")
                if self.args.verbose:
                    LOG.warning("rejected packet: %s", exc)
                continue

            packet, reason = validate_packet(decoded)
            if packet is None:
                self.stats.note_rejection(reason)
                if self.args.verbose:
                    LOG.warning("rejected packet: %s", reason)
                continue

            self.stats.accepted += 1
            self.stats.last_packet_at = time.monotonic()
            await self.broadcast(json.dumps(packet))

    @staticmethod
    def _recv(sock: socket.socket) -> bytes | None:
        try:
            data, _addr = sock.recvfrom(MAX_PACKET_BYTES)
            return data
        except socket.timeout:
            return None
        except OSError:
            return None

    # ---- health ----------------------------------------------------------

    async def health_loop(self) -> None:
        """One status line every few seconds. The first thing to look at."""
        while True:
            await asyncio.sleep(self.args.status_interval)
            age = (
                "never"
                if self.stats.last_packet_at is None
                else f"{time.monotonic() - self.stats.last_packet_at:.1f}s ago"
            )
            worst = ""
            if self.stats.reject_reasons:
                reason, count = max(self.stats.reject_reasons.items(), key=lambda kv: kv[1])
                worst = f"  worst-reject={reason!r} x{count}"
            LOG.info(
                "accepted=%d malformed=%d clients=%d last-packet=%s cmd-fwd=%d cmd-rej=%d%s",
                self.stats.accepted,
                self.stats.malformed,
                len(self.clients),
                age,
                self.stats.commands_forwarded,
                self.stats.commands_rejected,
                worst,
            )

    # ---- run -------------------------------------------------------------

    async def run(self) -> None:
        async with serve(self.handle_client, self.args.ws_host, self.args.ws_port) as server:
            LOG.info("WebSocket server on ws://%s:%d", self.args.ws_host, self.args.ws_port)
            LOG.info("commands forwarded to udp://%s:%d", self.args.command_host, self.args.command_port)
            LOG.info("ready - start the OBC and open the digital twin")
            tasks = [
                asyncio.create_task(self.telemetry_loop(), name="telemetry"),
                asyncio.create_task(self.health_loop(), name="health"),
            ]
            try:
                await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    task.cancel()
                server.close()
                self._command_sock.close()


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bridge Icarus OBC telemetry from UDP to WebSocket, and commands back.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("ICARUS_BIND_HOST", "127.0.0.1"),
        help="address to bind the telemetry UDP socket to (loopback by default)",
    )
    parser.add_argument("--telemetry-port", type=int, default=_env_int("ICARUS_TELEMETRY_PORT", 5005))
    parser.add_argument(
        "--command-host",
        default=os.environ.get("ICARUS_COMMAND_HOST", "127.0.0.1"),
        help="address of the OBC's command socket",
    )
    parser.add_argument("--command-port", type=int, default=_env_int("ICARUS_COMMAND_PORT", 5006))
    parser.add_argument(
        "--ws-host",
        default=os.environ.get("ICARUS_WS_HOST", "127.0.0.1"),
        help="address to serve WebSocket clients on (loopback by default)",
    )
    parser.add_argument("--ws-port", type=int, default=_env_int("ICARUS_WS_PORT", 8082))
    parser.add_argument("--status-interval", type=float, default=5.0, help="seconds between health lines")
    parser.add_argument("--verbose", action="store_true", help="log every rejected packet")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.ws_host not in ("127.0.0.1", "localhost", "::1"):
        LOG.warning(
            "serving WebSocket on %s - this exposes the bridge beyond this machine. "
            "There is no authentication; only do this on a trusted network.",
            args.ws_host,
        )

    bridge = Bridge(args)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        LOG.info(
            "stopped. accepted=%d malformed=%d commands=%d",
            bridge.stats.accepted,
            bridge.stats.malformed,
            bridge.stats.commands_forwarded,
        )
    except OSError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

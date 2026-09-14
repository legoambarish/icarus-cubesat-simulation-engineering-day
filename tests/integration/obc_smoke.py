#!/usr/bin/env python3
"""
Icarus C OBC - end-to-end behavioural check (no bridge involved).

Starts the compiled OBC, listens on the telemetry UDP port, sends commands to
the command UDP port, and asserts that the spacecraft actually behaves:

    1.  packet shape matches the telemetry contract
    2.  the circular-orbit equations hold
    3.  telemetry arrives at 5-10 Hz
    4.  raising the altitude raises r and T and lowers v
    5.  inclination is commandable
    6.  the command whitelist and range checks reject bad input
    7.  an attitude disturbance is detected and the ADCS drives the error down
    8.  a thermal anomaly breaches the limit, SAFE MODE sheds load, it recovers
    9.  a battery anomaly also reaches SAFE MODE, with the right fault code
    10. reset is repeatable

Usage:
    python tests/integration/obc_smoke.py [path-to-icarus-binary]

Exit code 0 = everything passed.
"""

from __future__ import annotations

import json
import math
import os
import socket
import subprocess
import sys
import time

TM_PORT = int(os.environ.get("ICARUS_TELEMETRY_PORT", "5105"))
CMD_PORT = int(os.environ.get("ICARUS_COMMAND_PORT", "5106"))
HOST = "127.0.0.1"

MU = 398600.4418
RE = 6371.0

REQUIRED_FIELDS = [
    "telemetry_schema_version", "timestamp", "source", "satellite", "orbit",
    "attitude", "power", "thermal", "vibration", "environment", "fault", "state",
]
KNOWN_STATES = {
    "BOOT", "NOMINAL", "DISTURBANCE", "ADCS_ACTIVE", "ERROR_DECREASING",
    "ANOMALY", "SAFE_MODE", "RECOVERY",
}

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))
    if not ok:
        failures.append(name)


def main() -> int:
    binary = sys.argv[1] if len(sys.argv) > 1 else (
        "./icarus.exe" if os.name == "nt" else "./icarus"
    )
    cwd = os.environ.get("ICARUS_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "fsw"))

    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind((HOST, TM_PORT))
    rx.settimeout(5.0)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    proc = subprocess.Popen(
        [binary, "--quiet",
         "--telemetry-port", str(TM_PORT),
         "--command-port", str(CMD_PORT)],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    time.sleep(0.8)
    if proc.poll() is not None:
        print("OBC exited immediately:\n" + (proc.stdout.read() if proc.stdout else ""))
        return 2

    def recv() -> dict:
        data, _ = rx.recvfrom(4096)
        return json.loads(data.decode())

    def send(cmd: dict) -> None:
        tx.sendto(json.dumps(cmd).encode(), (HOST, CMD_PORT))

    def settle(n: int = 6) -> dict:
        p = recv()
        for _ in range(n):
            p = recv()
        return p

    try:
        print("\n== 1. packet shape and schema ==")
        p = recv()
        check("all top-level fields present", all(k in p for k in REQUIRED_FIELDS),
              ",".join(sorted(set(REQUIRED_FIELDS) - set(p))) or "ok")
        check("schema version is 2", p["telemetry_schema_version"] == 2)
        check("source is ICARUS-OBC", p["source"] == "ICARUS-OBC", str(p["source"]))
        check("satellite is ICARUS-1U", p["satellite"] == "ICARUS-1U")
        check("state is a known flight state", p["state"] in KNOWN_STATES, str(p["state"]))
        check("fault block keeps its shape", set(p["fault"]) == {"active", "code", "message"})
        check("angular_velocity_deg_s is a 3-vector",
              isinstance(p["attitude"]["angular_velocity_deg_s"], list)
              and len(p["attitude"]["angular_velocity_deg_s"]) == 3)
        check("load_w is reported", isinstance(p["power"].get("load_w"), (int, float)))
        check("illumination_pct is reported",
              isinstance(p["environment"].get("illumination_pct"), (int, float))
              and 0 <= p["environment"]["illumination_pct"] <= 100)

        print("\n== 2. circular-orbit equations at the 500 km reference ==")
        o = p["orbit"]
        r = RE + o["altitude_km"]
        v_exp = math.sqrt(MU / r)
        t_exp = 2 * math.pi * math.sqrt(r ** 3 / MU) / 60
        check("altitude is 500 km", abs(o["altitude_km"] - 500.0) < 1e-6, str(o["altitude_km"]))
        check("v = sqrt(mu/r)", abs(o["velocity_km_s"] - v_exp) < 1e-3,
              f'{o["velocity_km_s"]:.4f} vs {v_exp:.4f}')
        check("T = 2*pi*sqrt(r^3/mu)", abs(o["period_min"] - t_exp) < 1e-2,
              f'{o["period_min"]:.3f} vs {t_exp:.3f}')

        print("\n== 3. telemetry rate ==")
        # Drain first: packets queued while the checks above ran would be
        # delivered instantly and inflate the measured rate.
        rx.settimeout(0.05)
        try:
            while True:
                rx.recvfrom(4096)
        except (socket.timeout, TimeoutError):
            pass
        rx.settimeout(5.0)
        t0 = time.time()
        for _ in range(30):
            recv()
        hz = 30 / (time.time() - t0)
        check("wall-clock rate is 5-12 Hz", 5.0 <= hz <= 12.5, f"{hz:.1f} Hz")

        print("\n== 4. set_altitude -> coupled r / v / T change ==")
        send({"type": "command", "command": "set_altitude", "value": 800})
        q = settle(8)
        r2 = RE + 800.0
        check("altitude is now 800 km", abs(q["orbit"]["altitude_km"] - 800.0) < 1e-6,
              str(q["orbit"]["altitude_km"]))
        check("velocity DECREASED", q["orbit"]["velocity_km_s"] < o["velocity_km_s"],
              f'{o["velocity_km_s"]:.4f} -> {q["orbit"]["velocity_km_s"]:.4f}')
        check("period INCREASED", q["orbit"]["period_min"] > o["period_min"],
              f'{o["period_min"]:.2f} -> {q["orbit"]["period_min"]:.2f}')
        check("velocity still equals sqrt(mu/r)",
              abs(q["orbit"]["velocity_km_s"] - math.sqrt(MU / r2)) < 1e-3)

        print("\n== 5. set_inclination ==")
        send({"type": "command", "command": "set_inclination", "value": 72})
        q = settle()
        check("inclination is now 72 deg", abs(q["orbit"]["inclination_deg"] - 72.0) < 1e-6,
              str(q["orbit"]["inclination_deg"]))

        print("\n== 6. whitelist and range checks ==")
        send({"type": "command", "command": "self_destruct"})
        tx.sendto(b"not json at all", (HOST, CMD_PORT))
        tx.sendto(b'{"type":"command"}', (HOST, CMD_PORT))
        send({"type": "command", "command": "set_altitude", "value": 99999})
        send({"type": "command", "command": "set_inclination", "value": -40})
        q = settle()
        check("altitude unchanged by an out-of-range command",
              abs(q["orbit"]["altitude_km"] - 800.0) < 1e-6, str(q["orbit"]["altitude_km"]))
        check("inclination unchanged by an out-of-range command",
              abs(q["orbit"]["inclination_deg"] - 72.0) < 1e-6, str(q["orbit"]["inclination_deg"]))
        check("OBC still transmitting after garbage input", q["state"] in KNOWN_STATES)

        print("\n== 7. attitude disturbance -> ADCS recovery ==")
        send({"type": "command", "command": "inject_attitude_disturbance"})
        states, errs, peak = [], [], 0.0
        deadline = time.time() + 40
        while time.time() < deadline:
            q = recv()
            states.append(q["state"])
            errs.append(q["attitude"]["target_error_deg"])
            peak = max(peak, q["attitude"]["target_error_deg"])
            if len(states) > 15 and q["state"] == "NOMINAL" and peak > 10 \
               and q["attitude"]["target_error_deg"] < 1.5:
                break
        seen = sorted(set(states))
        check("pointing error rose above 10 deg", peak > 10.0, f"peak {peak:.1f} deg")
        check("DISTURBANCE state was reported", "DISTURBANCE" in states, str(seen))
        check("ADCS_ACTIVE state was reported", "ADCS_ACTIVE" in states, str(seen))
        check("ERROR_DECREASING state was reported", "ERROR_DECREASING" in states, str(seen))
        check("error decayed below 2 deg", errs[-1] < 2.0, f"final {errs[-1]:.2f} deg")
        check("returned to NOMINAL", states[-1] == "NOMINAL", states[-1])

        print("\n== 8. thermal anomaly -> SAFE MODE -> recovery ==")
        nominal_load = q["power"]["load_w"]
        send({"type": "command", "command": "inject_anomaly", "kind": "thermal"})
        temps, states, codes = [], [], []
        safe_load = None
        saw_safe = False
        deadline = time.time() + 120
        while time.time() < deadline:
            q = recv()
            temps.append(q["thermal"]["temperature_c"])
            states.append(q["state"])
            codes.append(q["fault"]["code"])
            if q["state"] == "SAFE_MODE":
                saw_safe = True
                safe_load = q["power"]["load_w"]
            elif saw_safe and q["state"] == "NOMINAL":
                break
        check("temperature exceeded the 58 C limit", max(temps) > 58.0, f"peak {max(temps):.1f} C")
        check("SAFE_MODE was entered", saw_safe, str(sorted(set(states))))
        check("fault code was THERMAL_LIMIT", "THERMAL_LIMIT" in codes,
              str(sorted({c for c in codes if c})))
        check("non-essential load was SHED", safe_load is not None and safe_load < nominal_load,
              f"{nominal_load:.2f} W -> {safe_load} W")
        check("recovered to NOMINAL", states[-1] == "NOMINAL", states[-1])
        check("temperature fell back below 44 C", temps[-1] < 44.0, f"final {temps[-1]:.1f} C")

        print("\n== 9. battery anomaly -> SAFE MODE ==")
        send({"type": "command", "command": "reset"})
        settle()
        send({"type": "command", "command": "inject_anomaly", "kind": "battery"})
        bats, states, codes = [], [], []
        saw_safe = False
        deadline = time.time() + 180
        while time.time() < deadline:
            q = recv()
            bats.append(q["power"]["battery_pct"])
            states.append(q["state"])
            codes.append(q["fault"]["code"])
            if q["state"] == "SAFE_MODE":
                saw_safe = True
                break
        check("battery drained to the critical floor", min(bats) <= 12.0, f"min {min(bats):.1f} %")
        check("SAFE_MODE was entered from a battery fault", saw_safe, str(sorted(set(states))))
        check("fault code was BATTERY_CRITICAL", "BATTERY_CRITICAL" in codes,
              str(sorted({c for c in codes if c})))

        print("\n== 10. reset is repeatable ==")
        ok_all = True
        for i in range(3):
            send({"type": "command", "command": "reset"})
            q = settle(8)
            good = q["state"] == "NOMINAL" and q["fault"]["active"] is False
            ok_all = ok_all and good
            print(f"    cycle {i + 1}: state={q['state']:<10} fault={q['fault']['active']} "
                  f"bat={q['power']['battery_pct']:.1f}%  T={q['thermal']['temperature_c']:.1f}C")
        check("three reset cycles all returned to NOMINAL with no active fault", ok_all)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        rx.close()
        tx.close()

    print("\n" + "=" * 64)
    if failures:
        print(f"FAILED ({len(failures)}): " + ", ".join(failures))
        return 1
    print("ALL C OBC CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())

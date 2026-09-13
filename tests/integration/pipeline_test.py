#!/usr/bin/env python3
"""
FULL LOCAL-FSW PIPELINE TEST

    Icarus C OBC  --UDP-->  bridge  --WebSocket-->  this test
                  <--UDP--          <--WebSocket--

Starts the real OBC binary and the real bridge, connects as a WebSocket client
exactly the way the browser does, and checks the whole path end to end:

    1.  telemetry arrives over the WebSocket and matches the contract
    2.  a malformed UDP packet is rejected by the bridge and never reaches a
        client, and the bridge keeps running
    3.  a non-whitelisted command is refused by the bridge and never reaches
        the OBC
    4.  a whitelisted command travels browser -> bridge -> UDP -> OBC, and the
        OBC's OWN telemetry proves it arrived
    5.  an anomaly command drives the real OBC into SAFE MODE and back
    6.  two clients both receive the stream, and one disconnecting does not
        disturb the other
    7.  killing the OBC stops the stream without killing the bridge

Usage:
    python tests/integration/pipeline_test.py [path-to-icarus-binary]
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
FSW_DIR = os.path.join(REPO, "fsw")
BRIDGE = os.path.join(REPO, "bridge", "bridge.py")

TM_PORT = 5205
CMD_PORT = 5206
WS_PORT = 8282
HOST = "127.0.0.1"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))
    if not ok:
        failures.append(name)


def default_binary() -> str:
    exe = os.path.join(FSW_DIR, "icarus.exe")
    return os.path.abspath(exe if os.path.exists(exe) else os.path.join(FSW_DIR, "icarus"))


async def read_packet(ws, timeout: float = 6.0) -> dict:
    """Next TELEMETRY frame, skipping the bridge's own status frames."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic())
        msg = json.loads(raw)
        if msg.get("type") == "status":
            continue
        return msg
    raise TimeoutError("no telemetry frame")


async def drain(ws, n: int = 6) -> dict:
    packet = await read_packet(ws)
    for _ in range(n):
        packet = await read_packet(ws)
    return packet


async def main() -> int:
    from websockets.asyncio.client import connect

    # Resolve to an absolute path BEFORE anything changes directory: the OBC is
    # launched with cwd=fsw/, so a path like ./fsw/icarus given relative to the
    # repository root would be looked up as fsw/fsw/icarus.
    binary = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else default_binary()
    if not os.path.exists(binary):
        print(f"OBC binary not found at {binary}. Build it first (see fsw/README.md).")
        return 2

    print(f"OBC    : {binary}")
    print(f"bridge : {BRIDGE}")

    bridge_proc = subprocess.Popen(
        [sys.executable, BRIDGE,
         "--telemetry-port", str(TM_PORT),
         "--command-port", str(CMD_PORT),
         "--ws-port", str(WS_PORT),
         "--status-interval", "30"],
        cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    await asyncio.sleep(1.5)
    if bridge_proc.poll() is not None:
        print("bridge exited immediately:\n" + (bridge_proc.stdout.read() if bridge_proc.stdout else ""))
        return 2

    obc_proc = subprocess.Popen(
        [binary, "--quiet", "--telemetry-port", str(TM_PORT), "--command-port", str(CMD_PORT)],
        cwd=FSW_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    await asyncio.sleep(1.0)

    raw_udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        async with connect(f"ws://{HOST}:{WS_PORT}") as ws:

            print("\n== 1. telemetry reaches a WebSocket client ==")
            packet = await read_packet(ws)
            check("packet received over the WebSocket", isinstance(packet, dict))
            check("source is the C OBC", packet.get("source") == "ICARUS-OBC", str(packet.get("source")))
            check("schema version is 1", packet.get("telemetry_schema_version") == 1)
            check(
                "every contract block is present",
                all(k in packet for k in
                    ("orbit", "attitude", "power", "thermal", "vibration", "environment", "fault", "state")),
            )
            check(
                "bridge back-filled period_min",
                isinstance(packet["orbit"].get("period_min"), (int, float)),
                f"{packet['orbit'].get('period_min'):.2f} min",
            )

            print("\n== 2. malformed UDP is rejected and never forwarded ==")
            bad_payloads = [
                b"this is not json",
                b"{}",
                json.dumps({"telemetry_schema_version": 99, "timestamp": 1}).encode(),
                json.dumps({**packet, "power": {"battery_pct": 9999, "solar_w": 1}}).encode(),
                json.dumps({**packet, "state": "PARTY_MODE"}).encode(),
                json.dumps({**packet, "thermal": {"temperature_c": float("1e9")}}).encode(),
            ]
            for payload in bad_payloads:
                raw_udp.sendto(payload, (HOST, TM_PORT))
            await asyncio.sleep(0.6)

            # Everything that arrives must still be a valid OBC packet: none of
            # the rubbish above may have been passed through.
            leaked = False
            for _ in range(10):
                p = await read_packet(ws)
                if p.get("state") == "PARTY_MODE" or p["power"]["battery_pct"] > 100:
                    leaked = True
            check("no malformed packet reached the client", not leaked)
            check("bridge still alive after garbage", bridge_proc.poll() is None)
            check("OBC still alive after garbage", obc_proc.poll() is None)

            print("\n== 3. non-whitelisted commands are refused by the bridge ==")
            before = await drain(ws, 4)
            await ws.send(json.dumps({"type": "command", "command": "self_destruct"}))
            await ws.send(json.dumps({"type": "command", "command": "set_altitude", "value": 99999}))
            await ws.send("not json at all")
            await asyncio.sleep(0.8)
            after = await drain(ws, 6)
            check(
                "altitude unchanged by refused commands",
                abs(after["orbit"]["altitude_km"] - before["orbit"]["altitude_km"]) < 1e-6,
                f'{before["orbit"]["altitude_km"]} -> {after["orbit"]["altitude_km"]}',
            )
            check("bridge still alive", bridge_proc.poll() is None)

            print("\n== 4. a real command crosses the whole path ==")
            await ws.send(json.dumps({"type": "command", "command": "set_altitude", "value": 900}))
            await asyncio.sleep(1.0)
            moved = await drain(ws, 8)
            check(
                "OBC telemetry reports the new altitude",
                abs(moved["orbit"]["altitude_km"] - 900.0) < 1e-6,
                f'{moved["orbit"]["altitude_km"]} km',
            )
            check(
                "velocity fell, as the physics requires",
                moved["orbit"]["velocity_km_s"] < before["orbit"]["velocity_km_s"],
                f'{before["orbit"]["velocity_km_s"]:.4f} -> {moved["orbit"]["velocity_km_s"]:.4f}',
            )
            check(
                "period rose, as the physics requires",
                moved["orbit"]["period_min"] > before["orbit"]["period_min"],
                f'{before["orbit"]["period_min"]:.2f} -> {moved["orbit"]["period_min"]:.2f}',
            )

            print("\n== 5. an anomaly command drives the real OBC into SAFE MODE ==")
            await ws.send(json.dumps({"type": "command", "command": "inject_anomaly", "kind": "thermal"}))
            states, temps, codes = [], [], []
            saw_safe = False
            safe_load = None
            nominal_load = moved["power"]["load_w"]
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                p = await read_packet(ws)
                states.append(p["state"])
                temps.append(p["thermal"]["temperature_c"])
                codes.append(p["fault"]["code"])
                if p["state"] == "SAFE_MODE":
                    saw_safe = True
                    safe_load = p["power"]["load_w"]
                elif saw_safe and p["state"] == "NOMINAL":
                    break
            check("temperature crossed the 58 C limit", max(temps) > 58.0, f"peak {max(temps):.1f} C")
            check("SAFE MODE was reported by the OBC", saw_safe, str(sorted(set(states))))
            check("fault code was THERMAL_LIMIT", "THERMAL_LIMIT" in codes)
            check(
                "load was shed in safe mode",
                safe_load is not None and safe_load < nominal_load,
                f"{nominal_load:.2f} W -> {safe_load} W",
            )
            check("recovered to NOMINAL", states[-1] == "NOMINAL", states[-1])

            print("\n== 6. two clients, and one leaving does not disturb the other ==")
            async with connect(f"ws://{HOST}:{WS_PORT}") as ws2:
                a = await read_packet(ws)
                b = await read_packet(ws2)
                check("both clients receive telemetry", a["source"] == b["source"] == "ICARUS-OBC")
            await asyncio.sleep(0.5)
            still = await read_packet(ws)
            check("first client unaffected by the second disconnecting", still["source"] == "ICARUS-OBC")
            check("bridge still alive after a client left", bridge_proc.poll() is None)

            print("\n== 7. killing the OBC stops the stream but not the bridge ==")
            obc_proc.terminate()
            try:
                obc_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                obc_proc.kill()
            await asyncio.sleep(1.0)
            # Drain whatever was already queued, then expect silence.
            try:
                while True:
                    await asyncio.wait_for(ws.recv(), timeout=0.4)
            except (TimeoutError, asyncio.TimeoutError):
                pass
            silent = False
            try:
                await asyncio.wait_for(ws.recv(), timeout=2.0)
            except (TimeoutError, asyncio.TimeoutError):
                silent = True
            check("telemetry stopped when the OBC stopped", silent)
            check("bridge survived the OBC dying", bridge_proc.poll() is None)

    finally:
        raw_udp.close()
        for proc in (obc_proc, bridge_proc):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    bridge_log = bridge_proc.stdout.read() if bridge_proc.stdout else ""
    rejected = "malformed=" in bridge_log
    print("\n== bridge log ==")
    for line in bridge_log.strip().splitlines()[-6:]:
        print("   " + line)
    check("bridge logged its health counters", rejected or "accepted=" in bridge_log)

    print("\n" + "=" * 64)
    if failures:
        print(f"FAILED ({len(failures)}): " + ", ".join(failures))
        return 1
    print("FULL PIPELINE PASSED  (C OBC -> UDP -> bridge -> WebSocket -> client)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

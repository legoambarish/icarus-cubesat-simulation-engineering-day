# ICARUS — CubeSat Digital Twin + Flight-Software Simulator

An interactive 3D mission-control visualisation built for an Engineers' Day exhibition.

It shows **real spacecraft** — the ISS, Hubble, NOAA, Sentinel, four student CubeSats and
more — at their actual positions, propagated locally from current public orbital elements.
Alongside them flies **ICARUS**, a *simulated* 1U CubeSat whose telemetry comes from a
flight-software simulator you can drive: change its orbit, tumble it and watch the attitude
controller recover, inject a thermal fault and watch it enter safe mode and come back.

> **ICARUS is not a real spacecraft and is not in orbit.** It is a controlled educational
> simulation. Everything in this document and in the interface is careful about that
> distinction — see [What this is not](#what-this-is-not).

---

## Contents

- [What you are looking at](#what-you-are-looking-at)
- [Architecture](#architecture)
- [Concepts, if this is your first OBC project](#concepts-if-this-is-your-first-obc-project)
- [Running it](#running-it)
- [The telemetry contract](#the-telemetry-contract)
- [The command path](#the-command-path)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Ports and environment variables](#ports-and-environment-variables)
- [The 90-second demonstration](#the-90-second-demonstration)
- [What this is not](#what-this-is-not)
- [Licences and credits](#licences-and-credits)

---

## What you are looking at

| On screen | Where it comes from |
|---|---|
| The Earth, its atmosphere, the day/night terminator | Procedural — rasterised in the browser from bundled coastline vectors |
| The Sun's position and the terminator's angle | Real Sun direction from the mission clock |
| ISS, Hubble, NOAA-20, SwissCube… | **Current public orbital elements** from CelesTrak, propagated locally with SGP4 |
| ICARUS-1U and its telemetry | **A simulation** — either the browser's flight-software simulator or the C OBC |
| Battery, temperature, vibration, attitude, safe mode | The simulated spacecraft's own state, never invented by the UI |

Two status indicators in the top-left never lie about provenance:

- `ORBIT DATA · LIVE` or `· FALLBACK` — whether the real-satellite elements came from
  CelesTrak just now, or from the snapshot bundled with the site.
- `FSW LINK · SIMULATED` or `· LOCAL` — whether ICARUS telemetry is coming from the browser
  simulator or from the C OBC over the UDP/WebSocket bridge.

---

## Architecture

There are two ways telemetry reaches the screen, and the front-end cannot tell them apart.

**Exhibition / engineering mode** — the full pipeline:

```
  ┌─────────────────┐
  │  Icarus C OBC   │   fsw/          10 Hz simulation, 10 Hz downlink
  │  (a C program)  │
  └────────┬────────┘
           │  UDP :5005   JSON telemetry
           ▼
  ┌─────────────────┐
  │ Python bridge   │   bridge/       validates, normalises, broadcasts
  └────────┬────────┘
           │  WebSocket :8082
           ▼
  ┌─────────────────┐     ┌──────────────────┐
  │  Digital twin   │     │     Open MCT     │   openmct/
  │  (the browser)  │     │ engineering view │
  └─────────────────┘     └──────────────────┘
```

**Public mode** — what GitHub Pages serves:

```
  ┌─────────────────┐
  │   Browser-FSW   │   src/fsw/browserFsw.ts
  │  (TypeScript)   │   the same subsystem models, in the browser
  └────────┬────────┘
           │  the SAME TelemetryPacket shape
           ▼
  ┌─────────────────┐
  │  Digital twin   │
  └─────────────────┘
```

The browser starts in **Browser-FSW immediately** — it never waits for a backend. It dials
the local bridge in the background and switches to **Local-FSW** only after receiving a
*valid* telemetry packet. If local telemetry stops, it falls back again after a short grace
period. The telemetry panel is never blank.

---

## Concepts, if this is your first OBC project

**What is an OBC?** The On-Board Computer: the computer that flies the spacecraft. It reads
sensors, runs the control loops, manages power and thermal, decides when something has gone
wrong, and packages up a picture of its own state to send to the ground. `fsw/` is a small,
readable stand-in for one.

**What is telemetry?** The stream of measurements a spacecraft sends down: "battery 83 %,
temperature 17 °C, I am in sunlight, I am nominal." It is how the ground knows anything at
all. Here one telemetry packet is one JSON object, ten times a second.

**What does the C simulator actually do?** Every 100 ms it advances a model of the
spacecraft — where it is in its orbit, whether the Earth is between it and the Sun, how much
power the arrays make, how the battery and the bus temperature respond, what the attitude
controller is doing — then checks two fault thresholds, then serialises the result as JSON
and sends it. That is genuinely most of what a simple OBC's telemetry task does.

**Why UDP between the OBC and the bridge?** Because it is a continuous stream of "here is my
state *right now*" on one machine. Losing one sample out of ten is invisible; waiting for a
retransmission of a sample that is already stale is worse than useless. UDP has no
back-pressure, no head-of-line blocking, and the OBC never blocks because the ground station
went away. Real spacecraft links are lossy one-way streams for the same reason.

**Why WebSocket to the browser?** Because a browser cannot open a UDP socket. The bridge
exists to translate, and it is the one process that knows about both.

**Why does Browser-FSW exist?** GitHub Pages serves static files. It cannot run a C program
or a Python process. So that the public demo is a complete experience and not a broken one,
the browser carries its own simulator implementing the same telemetry contract. It is not a
mock: it models the same subsystems with the same constants.

**What is SGP4?** The standard analytical propagator that turns a published element set
(TLE or OMM) into a position and velocity at a given time. Element sets are *fitted* using
SGP4, so you must propagate them with SGP4 — feeding them to a textbook two-body solver
gives wrong answers. Here it is used purely for visualisation: drawing where real spacecraft
are. A few kilometres of error is invisible at this scale.

**What does "safe mode" mean here?** When the onboard fault logic sees the bus temperature
above its limit or the battery below its floor, it sheds every non-essential load, commands
a known reference attitude and holds it until things are back inside limits. In this project
that is a *real state change*, not a screen effect: entering safe mode changes `load_w`,
which changes the battery integration, which changes the telemetry the ground sees. Real
safe modes do more (fault isolation, autonomy levels, ground-commanded recovery), but the
shape is right.

---

## Running it

### Just the digital twin (no backend needed)

```bash
npm ci
npm run dev
```

Open the URL it prints. That is the whole public experience: real orbits, the simulated
CubeSat, telemetry, anomaly and recovery. Everything below is optional.

### Production build

```bash
npm run build
npm run preview
```

To check it the way **GitHub Pages** will actually serve it, under a repository sub-path:

```bash
BASE_PATH=/cubesat-digital-twin/ npm run build
node scripts/serve-pages.mjs
```

That serves `dist/` at `http://127.0.0.1:4173/cubesat-digital-twin/` and returns 404 for
everything outside it — which is what catches an asset accidentally referenced from the
domain root. `npm run preview` serves at the root and hides exactly that bug.

> On Windows, run the `BASE_PATH=...` build from **PowerShell or cmd**, not Git Bash. Git
> Bash rewrites a leading `/` into a Windows path, and you will silently get asset URLs like
> `/Program Files/Git/cubesat-digital-twin/assets/…`.
>
> ```powershell
> $env:BASE_PATH = "/cubesat-digital-twin/"; npx vite build
> ```

### The full LOCAL-FSW pipeline

Three terminals.

**Terminal 1 — the bridge**

```bash
python -m pip install -r bridge/requirements.txt
python bridge/bridge.py
```

**Terminal 2 — the C OBC**

```bash
make -C fsw
./fsw/icarus
```

On Windows, `fsw\icarus.exe`. See [Troubleshooting](#troubleshooting) if you have no C
compiler — you do not need one to run the digital twin.

**Terminal 3 — the front-end**

```bash
npm run dev
```

Within a second or two the top-left indicator changes from `FSW LINK · SIMULATED` to
`FSW LINK · LOCAL`. Stop the OBC with Ctrl-C and it goes back to `SIMULATED` on its own.

### Open MCT (optional engineering view)

```bash
cd openmct
npm install      # downloads Open MCT itself, kept out of the main build
npm start
```

Open `http://127.0.0.1:8080`, expand **ICARUS-1U** in the tree and click any measurement to
plot it live. It subscribes to the same bridge, so the plots and the exhibition screen are
looking at one stream from one source. Open MCT is **not** part of the public build.

---

## The telemetry contract

One schema, defined once in [`src/state/types.ts`](src/state/types.ts) and implemented three
times — the C OBC, the browser simulator, and the bridge's validator.

```json
{
  "telemetry_schema_version": 1,
  "timestamp": 1757940000.25,
  "source": "ICARUS-OBC",
  "satellite": "ICARUS-1U",
  "orbit":       { "altitude_km": 500.0, "velocity_km_s": 7.6166,
                   "inclination_deg": 51.6, "period_min": 94.469 },
  "attitude":    { "roll_deg": 0.2, "pitch_deg": -0.4, "yaw_deg": 3.1,
                   "angular_velocity_deg_s": [0.01, -0.02, 0.0],
                   "target_error_deg": 3.13 },
  "power":       { "battery_pct": 82.4, "solar_w": 8.18, "load_w": 5.4 },
  "thermal":     { "temperature_c": 28.4 },
  "vibration":   { "g": 0.012 },
  "environment": { "eclipse": false },
  "fault":       { "active": false, "code": null, "message": null },
  "state":       "NOMINAL"
}
```

Rules that are enforced, not just documented:

- **The shape never changes.** A value that is unavailable is `null`; it is never omitted and
  the surrounding block is never dropped.
- **Units are in the field names** — `_km`, `_km_s`, `_deg`, `_pct`, `_w`, `_c`, `_min`.
  Time is UNIX seconds, UTC.
- **Nothing reaches application state unvalidated.** Every packet is shape- *and* range-
  checked on the way in. A `NaN` that reaches a 3D transform corrupts the whole scene, so the
  cheapest place to stop it is at the door.
- **If the shape must change,** bump `telemetry_schema_version` and teach the validator to
  upgrade the old one.

Flight states: `BOOT · NOMINAL · DISTURBANCE · ADCS_ACTIVE · ERROR_DECREASING · ANOMALY ·
SAFE_MODE · RECOVERY`. Fault codes: `THERMAL_LIMIT · BATTERY_CRITICAL · ATTITUDE_ERROR`.

---

## The command path

This is the part the original specification left open, and getting it right is what makes
the local demonstration honest.

**In Browser-FSW**, a button applies the command to the browser simulator directly.

**In Local-FSW**, the browser does **not** fake the effect locally:

```
  button  →  WebSocket  →  bridge  →  UDP :5006  →  C OBC
                                                      │
                          the OBC's next telemetry ◄──┘   ← this is the proof
```

The C OBC is authoritative. If the uplink fails, the interface says the command was not
delivered rather than showing a response that did not happen.

The whitelist is identical in three places and all three range-check the arguments:
[`src/state/types.ts`](src/state/types.ts), [`bridge/bridge.py`](bridge/bridge.py),
[`fsw/src/commands.c`](fsw/src/commands.c).

```json
{"type": "command", "command": "inject_anomaly", "kind": "thermal"}
{"type": "command", "command": "inject_attitude_disturbance"}
{"type": "command", "command": "reset"}
{"type": "command", "command": "set_altitude",    "value": 700}
{"type": "command", "command": "set_inclination", "value": 72}
{"type": "command", "command": "set_attitude", "roll_deg": 20, "pitch_deg": 0, "yaw_deg": 0}
```

---

## Repository layout

```
src/                    the browser application (the only thing deployed)
  main.ts               boot order, the render loop, the one mission clock
  state/                the telemetry contract, the store, derived view values
  orbit/                frames, SGP4, CelesTrak, eclipse geometry, ICARUS's orbit
  twin/                 Earth, atmosphere, Sun, stars, CubeSat, marks, camera
  fsw/                  Browser-FSW, telemetry validation, WebSocket link, commands
  adcs/                 quaternion attitude and the PD controller
  ui/                   the instrument plates
  audio/                Web Audio cues
  styles/               design tokens and the instrument system

fsw/                    the Icarus C OBC        (local tool, not deployed)
bridge/                 the Python bridge       (local tool, not deployed)
openmct/                the engineering view    (local tool, not deployed)
design/                 the design canvas this interface was drawn from
tests/                  unit tests + the integration tests
scripts/                data refresh and the Pages-style static server
public/fallback/        bundled orbital elements for when CelesTrak is unreachable
```

Two conventions worth knowing before you change anything:

- **`src/orbit/frames.ts` owns every axis conversion.** Physical state is kilometres,
  km/s and UTC in the ECI frame; it becomes Three.js scene units in exactly one function.
  There are no ad-hoc sign flips anywhere else in the renderer.
- **`src/state/types.ts` owns the contract.** If a number appears on screen, it came from a
  validated packet or from a selector — never from a DOM update function inventing one.

---

## Testing

```bash
npm run typecheck        # strict TypeScript, no emit
npm run test             # 132 unit tests: orbits, frames, eclipse, FSW, validation
make -C fsw && python tests/integration/obc_smoke.py      # the C OBC, end to end
python tests/integration/pipeline_test.py                 # C → UDP → bridge → WebSocket
```

The unit tests check the physics against closed-form values rather than against themselves:
`v = √(μ/r)`, `T = 2π√(r³/μ)`, the shadow-fraction formula, the Sun's declination at the
solstices, that the ECI→render transform is a rotation and not a reflection.

The two integration tests start the **real** binaries and assert on real behaviour: that a
command crosses the whole path and the OBC's own telemetry proves it; that malformed UDP is
rejected and never forwarded; that a thermal fault reaches safe mode, sheds load and
recovers; that killing the OBC stops the stream without killing the bridge.

CI runs all of it on every push, including building the C OBC with `-Werror`.

---

## Deployment

Push to `main`. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) type-checks,
runs the unit tests, builds and behaviour-tests the C OBC, runs the full pipeline test,
builds the site with `BASE_PATH=/<repository-name>/`, asserts the base path is exactly right,
and deploys to GitHub Pages.

In the repository settings, set **Pages → Source → GitHub Actions**.

The base path is derived from the repository name, so renaming the repository needs no code
change. Only the browser application is deployed; the C, Python and Open MCT components stay
local by design.

---

## Troubleshooting

**"I have no C compiler."** You do not need one. `npm run dev` gives you the entire
experience through Browser-FSW. If you do want the C OBC:

- **Linux/macOS** — `make -C fsw` (gcc or clang, both fine)
- **Windows, MSYS2/MinGW** — install `mingw-w64-ucrt-x86_64-gcc make`, then `make` from the
  UCRT64 shell
- **Windows, Visual Studio** — run `fsw\build-msvc.bat` from a Developer Command Prompt
- **Any machine with Docker** — `docker run --rm -v "$PWD/fsw:/w" -w /w gcc:13 make`

**`ModuleNotFoundError: No module named 'websockets'`** — `python -m pip install -r
bridge/requirements.txt`. Needs websockets ≥ 13 for the asyncio server API.

**The link never turns `LOCAL`.** Check in order: is the bridge running and does its log say
`accepted=` with a rising number (if not, the OBC is not sending); is the OBC pointed at the
same port (`--telemetry-port`); is anything else already bound to 8082. The front-end retries
with backoff for ever, so fixing the backend is enough — no reload needed.

**`ORBIT DATA · FALLBACK` when you are online.** CelesTrak rate-limits aggressive clients,
and returns `403` for a while if you trip it. The app handles this correctly — bundled
elements, honestly labelled — and it caches results for three hours so normal use never gets
close. If you are developing against it, that cache is in `localStorage` under
`icarus.gp.cache.v1`. Refresh the bundled snapshot with `node scripts/refresh-fallback.mjs`.

**"WebGL 2 unavailable."** Three.js needs WebGL 2. Use a current Chrome, Edge or Firefox,
enable hardware acceleration, and check `chrome://gpu` for a blocked driver. The app shows a
readable diagnostic rather than a blank page.

**Assets 404 on GitHub Pages.** The build was made without the right `BASE_PATH`, or on
Windows Git Bash mangled it. Test locally with `node scripts/serve-pages.mjs`, which
reproduces the sub-path exactly.

**The scene is frozen but the page is alive.** Browsers pause `requestAnimationFrame` in
background tabs. Bring the tab to the front. (The simulation resumes with a bounded
catch-up, so it does not fast-forward.)

**Open MCT is blank.** Run `npm install` inside `openmct/` first — the 404 page tells you if
that is it. It must be served over HTTP; opening `index.html` from disk breaks its modules.

---

## Ports and environment variables

| Port | Direction | Purpose |
|---|---|---|
| `5005` | C OBC → bridge | telemetry, UDP |
| `5006` | bridge → C OBC | commands, UDP |
| `8082` | bridge → browser | telemetry + commands, WebSocket |
| `8080` | Open MCT | local engineering view |
| `5173` | Vite dev server | the digital twin |
| `4173` | `scripts/serve-pages.mjs` | the production build at its Pages sub-path |

Everything binds to **loopback** by default.

| Variable | Used by | Default |
|---|---|---|
| `ICARUS_TELEMETRY_HOST` / `_PORT` | C OBC, bridge | `127.0.0.1` / `5005` |
| `ICARUS_COMMAND_HOST` / `_PORT` | C OBC, bridge | `127.0.0.1` / `5006` |
| `ICARUS_WS_HOST` / `ICARUS_WS_PORT` | bridge | `127.0.0.1` / `8082` |
| `ICARUS_SEED` | C OBC | `30023429` |
| `VITE_BRIDGE_URL` | front-end build | `ws://127.0.0.1:8082` |
| `BASE_PATH` | front-end build | `/` |

The front-end also accepts `?bridge=ws://host:port` at run time, and so does Open MCT — handy
when the bridge runs on a different machine from the projector.

---

## The 90-second demonstration

1. Open on the wide Earth view. Real orbital traffic is already moving.
2. Select **ISS** from the object register. Point out that its position is propagated
   locally, right now, from currently published orbital elements — not an animation.
3. Select **ICARUS**. Say clearly that this one is a simulation.
4. Raise the altitude. Radius grows, velocity falls, period rises — all three together,
   because all three come from the same equations.
5. Change the inclination. The orbital plane tilts.
6. Walk through battery, solar, temperature, vibration. Note `SUNLIT` / `ECLIPSE` and that
   the battery trend reverses at the terminator, because of the geometry.
7. If the backend is running, point at `FSW LINK · LOCAL`: these numbers are coming from a C
   program over UDP.
8. **Attitude disturbance.** The pointing error jumps, the state goes `DISTURBANCE` →
   `ADCS_ACTIVE`, the reaction wheel is revealed, the error decays back to zero.
9. **Simulate anomaly.** The temperature climbs, crosses 58 °C, the fault is raised, the
   frame goes red, `SAFE MODE` appears — and the bus load drops from 5.4 W to 1.9 W. That
   number is the proof it is real.
10. Watch it recover on its own, or press **Reset**. Return to the wide Earth view.

Keyboard shortcuts for presenting: `R` reset view, `I` ICARUS, `S` ISS, `D` disturbance,
`A` anomaly, `X` reset. Everything is repeatable without restarting.

---

## What this is not

Being precise about this is part of the engineering.

- **ICARUS is not a real spacecraft** and is not in orbit. It is a controlled educational
  simulation.
- **This is not flight software.** No RTOS, no scheduler, no watchdog, no redundancy, no
  memory protection, no CCSDS packetisation, and the fault detection is two thresholds.
- **The ADCS is not flight-ready.** It is a bounded PD feedback demonstration with no
  sensors, no estimator, no momentum management and no disturbance torques. Its gains are
  chosen so the response is *watchable*, not so it is optimal.
- **The thermal model is not high fidelity.** It is a single first-order lumped mass. A fault
  is modelled as a bounded shift in the bus equilibrium temperature, in kelvin — deliberately
  **not** as a heat flux in watts, because no plausible fault power warms a 1 kg bus 40 K in
  a minute, and quoting a made-up wattage would look more rigorous while being less true.
- **The mission clock runs at ×60.** A 500 km orbit takes 94 minutes; the exhibit runs the
  orbit, the Sun geometry, the energy budget and the bus temperature on a sped-up clock so a
  full sunlit/eclipse cycle fits in a minute. The ADCS loop and the vibration channel run in
  **real** time, because a controller settling in a quarter of a second is unwatchable. Every
  *reported* quantity is the true physical value, and the status strip states the rate.
- **Spacecraft are not drawn to scale.** A 1U CubeSat at true scale would be about
  10⁻⁷ scene units. Positions are exact; marker and model sizes are exaggerated.
- **Fallback orbital elements are a snapshot**, never described as live.
- **Open MCT's history here is a per-session in-memory buffer**, not a database.

**What would change for a flight-qualified implementation?** Real sensors with noise and
bias; an attitude estimator (EKF or QUEST); actuator models with momentum build-up and
magnetorquer desaturation; disturbance torques (gravity gradient, aerodynamic, solar
radiation pressure, residual dipole); a multi-node thermal model with radiative view factors;
proper stability margins; and an FDIR design with fault isolation and autonomy levels rather
than two thresholds.

---

## Licences and credits

This project is MIT licensed. Third-party material, all bundled rather than fetched at
presentation time:

| Asset | Source | Licence |
|---|---|---|
| Coastline geometry | Natural Earth 110m land, via world-atlas | Public domain (data), ISC (package) |
| IBM Plex Mono | @fontsource | SIL Open Font License 1.1 |
| Archivo | @fontsource | SIL Open Font License 1.1 |
| Orbital elements | [CelesTrak](https://celestrak.org/) GP/OMM | Public US Space Force element sets |
| three.js, satellite.js, Motion, Open MCT | npm | MIT / Apache-2.0 (Open MCT) |

Full notices in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

CelesTrak is a free public service. This client uses group queries and a three-hour cache
rather than one request per object — please keep it that way if you add spacecraft.

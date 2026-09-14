# ICARUS - CubeSat Digital Twin

ICARUS is an educational CubeSat simulation for an Engineers' Day exhibition. It has a
browser-based digital twin, a separate C flight-software simulator, and a Python bridge
for running the two as a local telemetry pipeline.

ICARUS is simulated software. It is not a spacecraft, flight-qualified flight software,
or a source of live spacecraft telemetry.

Repository: <https://github.com/legoambarish/icarus-cubesat-simulation-engineering-day>

## What runs

The browser application starts without a backend:

- It renders the Earth, Sun, atmosphere, stars, orbital tracks, and selectable satellites.
- It propagates public orbital elements from CelesTrak when available.
- It uses `public/fallback/orbital-data.json` when the public data request is unavailable.
- It starts with `Browser-FSW`, the TypeScript simulator in `src/fsw/browserFsw.ts`.
- It can switch to `Local-FSW` when it receives validated telemetry from the local bridge.

The optional local engineering pipeline is:

```text
C OBC simulator --UDP 5005--> Python bridge --WebSocket 8082--> browser
       ^                         |
       +------UDP 5006-----------+
```

The bridge validates telemetry before forwarding it and only forwards whitelisted,
range-checked commands to the C simulator. The browser does not display a local command
effect until the C simulator's telemetry reports the resulting state.

Open MCT is an optional local engineering view. It reads the same WebSocket stream as the
browser and is not included in the GitHub Pages build.

## Requirements

For the browser application:

- Node.js 22 LTS or newer supported by the installed Vite version
- npm
- A current browser with WebGL 2 support

For the local pipeline:

- Python 3.11 or newer
- Python package `websockets>=13`
- A C99 compiler and build tool: `make`, MinGW/MSYS2, or Visual Studio's `cl.exe`

The C simulator is optional. The browser simulator provides the complete public demo.

## Quick start: browser mode
To run the frontend UI on your local system(No Backend):

1\. Clone this repository.

2\. From the repository root:

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173/`.

The browser mode does not require Python, a C compiler, Open MCT, or a running bridge.

3\. Open the localhost URL on browser.

## Production build

Build and preview the application at the root path:

```bash
npm run build
npm run preview
```

GitHub Pages serves this repository as a project site, so test the repository sub-path
before pushing. On PowerShell:

```powershell
$env:BASE_PATH = "/icarus-cubesat-simulation-engineering-day/"
npm run build
node scripts/serve-pages.mjs
```

On Linux, macOS, or a POSIX shell:

```bash
BASE_PATH=/icarus-cubesat-simulation-engineering-day/ npm run build
node scripts/serve-pages.mjs
```

Open:

```text
http://127.0.0.1:4173/icarus-cubesat-simulation-engineering-day/
```

The Pages-style server intentionally returns 404 outside the configured sub-path. This
catches asset URLs that work at `/` but fail on GitHub Pages.

## Local engineering pipeline

Use three terminals. Run these commands from the repository root unless noted otherwise.

### 1. Build and run the C OBC simulator

Linux or macOS:

```bash
make -C fsw
./fsw/icarus --quiet
```

Windows with MSYS2/MinGW:

```bash
make -C fsw
./fsw/icarus.exe --quiet
```

Windows with Visual Studio:

```powershell
Set-Location fsw
& .\build-msvc.bat
& .\icarus.exe --quiet
```

The default ports are UDP `5005` for telemetry and UDP `5006` for commands. The simulator
uses a mission clock for orbit, eclipse, power, and thermal behaviour; the attitude and
vibration channels remain observable at real-time speed.

Useful C simulator targets:

```bash
make -C fsw              # build
make -C fsw selftest     # start, step, serialise for three seconds
make -C fsw clean        # remove C build output
```

### 2. Start the Python bridge

Create a virtual environment if one is not already available:

```bash
python -m venv .venv
```

Activate it on PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

Activate it on Linux/macOS:

```bash
source .venv/bin/activate
```

Install the bridge dependency and start it:

```bash
python -m pip install -r bridge/requirements.txt
python bridge/bridge.py
```

The bridge binds to loopback by default. Use `python bridge/bridge.py --help` to see the
available host, port, status interval, and verbose logging options.

### 3. Start the browser

```bash
npm run dev
```

The top-left link indicator should change from `FSW LINK · SIMULATED` to
`FSW LINK · LOCAL` after a valid packet arrives. Stop the C simulator and the browser
falls back to the browser simulator after the stale-telemetry grace period.

## Open MCT view

Open MCT is separate from the root npm project. In a fourth terminal:

```bash
Set-Location openmct       # PowerShell; use cd openmct elsewhere
npm ci
npm start
```

Open <http://127.0.0.1:8080/>. Expand `ICARUS-1U` and select a measurement to view it.
Open MCT connects to `ws://127.0.0.1:8082` by default. To use another bridge endpoint,
open the page with a `bridge` query parameter, for example:

```text
http://127.0.0.1:8080/?bridge=ws://127.0.0.1:8082
```

## Telemetry and command contract

The contract is defined in [`src/state/types.ts`](src/state/types.ts), validated in
[`bridge/bridge.py`](bridge/bridge.py), and serialised by
[`fsw/src/telemetry.c`](fsw/src/telemetry.c). The browser simulator emits the same shape.

Each telemetry packet contains:

- `telemetry_schema_version`
- UTC UNIX `timestamp`
- source and satellite identifiers
- orbit, attitude, power, thermal, vibration, environment, fault, and state objects

Units are encoded in field names such as `_km`, `_km_s`, `_deg`, `_pct`, `_w`, `_c`, and
`_min`. Missing values are represented as `null`; fields are not silently omitted. The
current packet schema is version `2`; it adds the continuous `environment.illumination_pct`
field used by the ground display and Open MCT.

### How the live readouts are coupled

The telemetry plate is fed from one simulator state. The main values in the display are
not independent counters:

| Readout | Model relationship |
| --- | --- |
| `SOLAR` | `9.4 W peak × illumination fraction × cos(pointing error)`; clipped at zero when the array is edge-on or back-facing |
| `LOAD` | `5.4 W nominal + reaction-wheel draw while ADCS is active + injected parasitic fault load`; safe mode sheds to `1.9 W` |
| `VIBRATION` | Low-pass filtered baseline/noise plus reaction-wheel activity and anomaly excitation |
| `ILLUM` | Eclipse geometry, reported as `0–100 %`; a short terminator ramp avoids a discontinuous power jump |
| `ROLL`, `PITCH`, `YAW` | Current quaternion converted to ZYX Euler angles; commands and disturbances are flown through the controller |
| `POINT ERR` | Angular distance between current and commanded attitude; it drives the solar projection term and ADCS state |

Nominal attitude is intentionally observable rather than mathematically frozen.
The simulator applies a small, bounded aggregate of environmental torques whose
orbital component follows true anomaly and whose smaller real-time component
represents unresolved disturbance sources. The reaction-wheel controller
corrects that motion continuously, so the displayed angles move around the
commanded attitude while remaining bounded. These torque amplitudes are scaled
for the educational display and are not flight values for a specific CubeSat.

The result is a useful engineering demonstrator rather than flight-qualified flight
software. The solar projection follows the cosine dependence described in NASA's small
spacecraft power reference, while the attitude side uses a deliberately readable
reaction-wheel control model. See the source comments in `src/fsw/browserFsw.ts` and
`fsw/src/power.c` before changing constants.

The supported commands are:

```json
{"type":"command","command":"inject_anomaly","kind":"thermal"}
{"type":"command","command":"inject_anomaly","kind":"battery"}
{"type":"command","command":"inject_attitude_disturbance"}
{"type":"command","command":"reset"}
{"type":"command","command":"set_altitude","value":700}
{"type":"command","command":"set_inclination","value":72}
{"type":"command","command":"set_attitude","roll_deg":20,"pitch_deg":0,"yaw_deg":0}
```

The allowed ranges and command names must stay aligned across the TypeScript types, the
bridge validator, and `fsw/src/commands.c`.

## Tests

Run the TypeScript checks and unit tests from the repository root:

```bash
npm run typecheck
npm test
```

Build the C simulator and run its behavioural test:

```bash
make -C fsw
python tests/integration/obc_smoke.py ./fsw/icarus
```

On Windows, use `./fsw/icarus.exe` instead. The full pipeline test starts an isolated
bridge and checks telemetry, malformed-packet rejection, command validation, command
delivery, safe-mode behaviour, multiple clients, and shutdown handling:

```bash
python -m pip install -r bridge/requirements.txt
python tests/integration/pipeline_test.py ./fsw/icarus
```

The GitHub Actions workflow runs the TypeScript checks, unit tests, C build, both
integration tests, the Pages-path build check, and the Pages deployment.

## Deployment

Push `main` to deploy:

```bash
git push origin main
```

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) derives the
Pages base path from the repository name. Enable GitHub Pages in the repository settings
with **Settings → Pages → Source → GitHub Actions**.

The expected project-site path is:

<https://legoambarish.github.io/icarus-cubesat-simulation-engineering-day/>

Only the browser application is deployed. The C simulator, Python bridge, and Open MCT
remain local tools.

## Ports and environment variables

| Port | Transport | Use |
|---:|---|---|
| 5005 | UDP | C OBC telemetry to bridge |
| 5006 | UDP | Bridge commands to C OBC |
| 8082 | WebSocket | Bridge clients: browser and Open MCT |
| 8080 | HTTP | Open MCT server |
| 5173 | HTTP | Vite development server |
| 4173 | HTTP | Pages-style local server |

All services bind to `127.0.0.1` by default.

| Variable | Component | Default |
|---|---|---|
| `ICARUS_TELEMETRY_HOST` / `ICARUS_TELEMETRY_PORT` | C OBC | `127.0.0.1` / `5005` |
| `ICARUS_COMMAND_HOST` / `ICARUS_COMMAND_PORT` | C OBC and bridge | `127.0.0.1` / `5006` |
| `ICARUS_BIND_HOST` | Bridge telemetry UDP bind | `127.0.0.1` |
| `ICARUS_WS_HOST` / `ICARUS_WS_PORT` | Bridge WebSocket server | `127.0.0.1` / `8082` |
| `ICARUS_SEED` | C OBC deterministic seed | `30023429` |
| `VITE_BRIDGE_URL` | Browser build | `ws://127.0.0.1:8082` |
| `BASE_PATH` | Vite build and Pages-style server | `/` for Vite |
| `PORT` | Pages-style server | `4173` |

If a port is changed, update every process that uses that side of the connection. For a
non-loopback exhibition setup, explicitly set the bind and connection hosts and account
for the local firewall.

## Repository layout

```text
src/                    Browser application and Browser-FSW simulator
fsw/                    C OBC simulator and platform socket layer
bridge/                 UDP/WebSocket bridge and packet validator
openmct/                Optional local Open MCT engineering view
design/                 Design-canvas source and published design artifact
tests/                  Unit tests and end-to-end integration tests
scripts/                Fallback-data and Pages-path tooling
public/fallback/        Bundled orbital snapshot used when CelesTrak is unavailable
.github/workflows/      GitHub Pages build, test, and deployment workflow
```

When changing physical units or coordinate conventions, start with
[`src/state/types.ts`](src/state/types.ts) and [`src/orbit/frames.ts`](src/orbit/frames.ts).
The C simulator constants are mirrored in `src/fsw/browserFsw.ts`; update both simulators
when changing model behaviour.

## Troubleshooting

### The page works locally but assets fail on Pages

Build with the repository base path and use `node scripts/serve-pages.mjs`. Do not test
only with `npm run preview`, because it serves `/` and can hide a missing project prefix.

### The link remains `SIMULATED`

Check that the bridge is running, the C simulator is sending to UDP `5005`, and the browser
is connecting to WebSocket `8082`. The bridge prints health counters; run it with
`--verbose` to log rejected packets.

### `websockets` cannot be imported

Activate the intended Python environment and run:

```bash
python -m pip install -r bridge/requirements.txt
```

### No C compiler is available

Run the browser-only quick start. For a local OBC, use MSYS2/MinGW on Windows, a normal
`make` toolchain on Linux/macOS, Visual Studio's Developer Command Prompt, or the Docker
command documented in [`fsw/README.md`](fsw/README.md).

### Orbital data is labelled `FALLBACK`

The app is using the bundled snapshot because the public request failed, was rate-limited,
or returned data that did not pass validation. This is expected behaviour and is labelled
in the interface. Refresh the snapshot with:

```bash
node scripts/refresh-fallback.mjs
```

### WebGL is unavailable

Use a current browser with hardware acceleration enabled. The application reports the
diagnostic rather than silently rendering an empty scene.

## License and notices

The project is MIT licensed. Third-party notices are in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Orbital elements are requested from
CelesTrak and a bundled snapshot is included for offline or rate-limited operation.

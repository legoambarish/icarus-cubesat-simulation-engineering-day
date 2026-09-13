# Icarus OBC simulator

A small, deterministic C program that models a 1U CubeSat and emits normalised JSON
telemetry over UDP. It is the "onboard computer" half of the digital twin.

**You do not need this to run the exhibition.** The browser carries an equivalent
simulator (`src/fsw/browserFsw.ts`) implementing the same telemetry contract, which is
what the public GitHub Pages build uses. This program exists so the local demonstration
has a real, separate flight-software process behind it.

## Build

```
make            # -> ./icarus  (or icarus.exe on Windows)
make run        # build and run with the default ports
make selftest   # build and run a 3-second self-check
make clean
```

Plain C99 and the C standard library. The only platform dependency is the socket API,
which is isolated in `src/platform.h`.

| Platform | How |
|---|---|
| Linux / macOS | `make` |
| Windows + MSYS2/MinGW | `pacman -S mingw-w64-ucrt-x86_64-gcc make`, then `make` from the UCRT64 shell |
| Windows + Visual Studio | `build-msvc.bat` from a Developer Command Prompt |
| Anywhere with Docker | `docker run --rm -v "$PWD:/w" -w /w gcc:13 make` |

The Makefile tracks header dependencies (`-MMD -MP`). Without that, editing a struct in
`icarus.h` leaves stale object files linked against the old layout and the telemetry comes
out with every field shifted by one — which is exactly as much fun to debug as it sounds.

## Run

```
./icarus
./icarus --telemetry-port 5005 --command-port 5006 --seed 42 --quiet
./icarus --help
```

It prints a status line every five seconds: flight state, battery, solar, load,
temperature, vibration, illumination, pointing error, packets sent, commands accepted and
rejected. That line is the first thing to look at when something is wrong.

## Modules

| File | Responsibility |
|---|---|
| `main.c` | the simulation clock, the orbit, the Sun and eclipse geometry, the loop |
| `icarus.h` / `icarus.c` | the shared state struct, every constant, the seeded PRNG |
| `power.c` | solar generation, bus load, battery integration |
| `thermal.c` | first-order bus temperature |
| `vibration.c` | bounded deterministic vibration |
| `adcs.c` | quaternion attitude and the PD reaction-wheel controller |
| `anomaly.c` | fault thresholds, safe-mode entry, recovery |
| `telemetry.c` | JSON serialisation and the UDP downlink |
| `commands.c` | the whitelisted UDP uplink |
| `platform.h` | the only place this program knows what OS it is on |

Every constant in `icarus.h` is **mirrored in `src/fsw/browserFsw.ts`**. If you change a
number in one, change it in the other, or the two simulators stop agreeing.

## Two clocks

The orbit, the Sun geometry, the energy budget and the bus temperature run on a **mission
clock** at 60x real time, so a 94-minute orbit and a 20-minute thermal time constant both
fit in an exhibition. The ADCS loop and the vibration channel run in **real** seconds,
because a controller that settles in 15 mission-seconds settles in a quarter of a real
second and there is nothing to watch. See the note at the top of `icarus.h`.

## Testing

```
python ../tests/integration/obc_smoke.py ./icarus       # behaviour, end to end
python ../tests/integration/pipeline_test.py            # with the bridge and a WS client
```

## What it is not

Not flight software. No RTOS, no scheduler, no watchdog, no redundancy, no memory
protection, no CCSDS packetisation, no error detection and correction, and the FDIR is two
thresholds. Those omissions are deliberate: a new OBC team member should be able to read
`main.c` end to end in one sitting.

# Third-party notices

Everything listed here is **bundled into the build** rather than fetched from a third-party
host at run time. That is deliberate: an exhibition cannot depend on venue Wi-Fi, and a
remote font or texture URL is the most common way a demo degrades in public.

The one exception is CelesTrak, which is fetched at startup *by design* — that is what makes
the orbital layer current — and which always falls back to a bundled snapshot.

---

## Runtime dependencies

### three.js
3D rendering. MIT License. Copyright © 2010-2026 three.js authors.
<https://github.com/mrdoob/three.js>

### satellite.js
SGP4/SDP4 orbital propagation and coordinate transforms. MIT License.
<https://github.com/shashwatak/satellite-js>

### Motion
DOM animation for the interface transitions. MIT License.
<https://motion.dev/>

Motion's experimental Three.js integration is deliberately **not** used: the 3D scene is
driven by the ordinary Three.js render loop, so nothing in the core visualisation depends on
alpha functionality.

---

## Fonts

Both faces are self-hosted through [@fontsource](https://fontsource.org/), which vendors the
woff2 files into `dist/assets/`. Only the four weights the interface actually uses are
imported.

### IBM Plex Mono
SIL Open Font License, Version 1.1. Copyright © 2017 IBM Corp.
<https://github.com/IBM/plex>

Used for every number, code, timestamp and identifier — it has real tabular figures, which
is what stops telemetry readouts from jittering as digits change.

### Archivo
SIL Open Font License, Version 1.1. Copyright © Omnibus-Type.
<https://github.com/Omnibus-Type/Archivo>

Used for every label, heading and button.

The SIL OFL permits bundling, redistribution and use in this project. The full licence text
ships inside each `@fontsource` package under `node_modules/@fontsource/<name>/LICENSE`.

---

## Geographic data

### Natural Earth — 110m land polygons
**Public domain.** Natural Earth data is free for any use, commercial or non-commercial,
with no permission needed.
<https://www.naturalearthdata.com/about/terms-of-use/>

Obtained through **world-atlas** (ISC License, © Mike Bostock), which packages Natural Earth
as TopoJSON.
<https://github.com/topojson/world-atlas>

Baked into `src/twin/landData.ts` by `scripts/build-land-data.mjs` as ~5,100 coastline
vertices, and rasterised in the browser at boot into the Earth's day map, night-lights map
and ocean mask.

Shipping vector coastlines rather than a satellite bitmap keeps the repository small, keeps
the licensing unambiguous, and means the presentation never depends on a remote texture.

---

## Orbital data

### CelesTrak — GP / OMM element sets
General Perturbations orbital element sets, redistributed by CelesTrak from public
US Space Force data.
<https://celestrak.org/>

Used two ways:

1. **Live**, fetched at startup with `FORMAT=JSON` (OMM). The client uses **group queries**
   and a **three-hour `localStorage` cache** rather than one request per object, in line with
   CelesTrak's guidance on not hammering the service.
2. **Bundled**, as a snapshot in `public/fallback/orbital-data.json`, so the exhibition still
   shows real orbits with no network. The interface labels this `ORBIT DATA · FALLBACK` and
   never describes it as live.

Refresh the snapshot before an exhibition with `node scripts/refresh-fallback.mjs`.

---

## Local engineering tools (not deployed)

### Open MCT
NASA's mission-control framework, used for the optional engineering view in `openmct/`.
Apache License 2.0. Copyright © 2014-2026 United States Government as represented by the
Administrator of the National Aeronautics and Space Administration.
<https://github.com/nasa/openmct>

Installed separately via `openmct/package.json` and deliberately excluded from the public
build.

### websockets (Python)
BSD 3-Clause License. Copyright © Aymeric Augustin and contributors.
<https://github.com/python-websockets/websockets>

---

## Algorithms

**SGP4** is implemented by satellite.js, following the reference implementation in
Vallado et al., *Revisiting Spacetrack Report #3* (AIAA 2006-6753).

The **low-precision Sun position** used for the terminator and the eclipse geometry follows
Vallado, *Fundamentals of Astrodynamics and Applications*, Algorithm 29. It is implemented
twice — `src/orbit/eclipse.ts` and `fsw/src/main.c` — so the browser and the C OBC compute
the same illumination for the same instant.

The **cylindrical Earth-shadow** test and the closed-form eclipse-fraction formula are the
standard first-order treatments found in any astrodynamics text; the penumbra is ignored
because in LEO it lasts a few seconds.

---

## This project

MIT License.

ICARUS is an educational simulation. It is not a real spacecraft, it is not in orbit, and
none of the software here is flight qualified. See the "What this is not" section of the
README.

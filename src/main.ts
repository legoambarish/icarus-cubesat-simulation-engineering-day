/**
 * ICARUS DIGITAL TWIN - application entry point
 * =============================================================================
 * Boot order, and why it is this order:
 *
 *   1. Build the 3D scene and start the render loop IMMEDIATELY. Nothing waits
 *      on the network or on a backend process; a visitor sees Earth in under a
 *      second on a cold load.
 *   2. Start BROWSER-FSW. It is authoritative until proven otherwise.
 *   3. In the background: fetch current orbital elements (CelesTrak, falling
 *      back to the bundled snapshot) and dial the local bridge. Either can
 *      fail; neither can stop the render loop.
 *   4. If the bridge delivers a valid packet, switch the HUD to LOCAL-FSW. If
 *      it stops, switch back after a short grace period.
 *
 * ONE CLOCK: browserFsw.missionDate() is the simulated instant used for the Sun
 * direction, the Earth's rotation (GMST) and the SGP4 propagation of every real
 * object. It runs ORBIT_TIME_SCALE times faster than the wall clock so a
 * 94-minute orbit is watchable, and the status strip says so out loud.
 *
 * Physics is advanced in fixed steps inside BrowserFsw, so the frame rate
 * cannot change the simulation result.
 */

import { Euler, Quaternion, Vector3 } from 'three';
import { gstime } from 'satellite.js';
import './styles/app.css';

import {
  ICARUS_ID,
  getState,
  pushAlert,
  setAudioEnabled,
  setClock,
  setControls,
  setFswMode,
  setLinkStatus,
  setOrbitData,
  setRenderStats,
  setSelected,
  setTelemetry,
} from './state/store.ts';
import {
  icarusProfile,
  objectRows,
  realObjectProfile,
  type HudViewModel,
} from './state/selectors.ts';
import type { CommandMessage, FlightState, ObjectKind, TelemetryPacket } from './state/types.ts';

import { createSceneContext, degradePixelRatio, WebGL2UnavailableError } from './twin/scene.ts';
import { createEarth } from './twin/earth.ts';
import { createSun } from './twin/sun.ts';
import { createStars } from './twin/stars.ts';
import { createCubeSat } from './twin/cubesat.ts';
import { createSatelliteMarkers } from './twin/satellites.ts';
import { createIcarusOrbitLine, OrbitLineSet, ICARUS_SEGMENTS } from './twin/orbitLines.ts';
import { createCameraController } from './twin/camera.ts';
import { pick, projectToScreen, type Pickable } from './twin/selection.ts';

import { sceneFromEci, earthSpinFromGmst, DEG } from './orbit/frames.ts';
import { EARTH_RADIUS_UNITS } from './twin/earth.ts';
import { loadCatalog } from './orbit/celestrak.ts';
import { buildTrackedObjects, updateTracked, PROPAGATE_HZ, type TrackedObject } from './orbit/propagate.ts';
import { sampleOrbitEci, orbitFromAltitude } from './orbit/simulatedOrbit.ts';
import { eclipseFraction } from './orbit/eclipse.ts';

import { BrowserFsw } from './fsw/browserFsw.ts';
import { LocalFswLink, defaultBridgeUrl } from './fsw/websocket.ts';
import { CommandRouter, cmd } from './fsw/commands.ts';

import { createHud } from './ui/hud.ts';
import { createAlertSystem } from './ui/alerts.ts';
import { synth } from './audio/synth.ts';
import { EULER_ORDER } from './adcs/attitude.ts';

/* ==========================================================================
 * Tunables
 * ========================================================================== */

/**
 * A 500 km orbit takes 94 minutes; nobody watches an exhibit for 94 minutes.
 * The MISSION CLOCK therefore runs at this multiple of real time. Every
 * displayed orbital quantity (period, velocity, altitude) is still the true
 * physical value - only the rate at which we watch is scaled.
 */
const ORBIT_TIME_SCALE = 60;

/** Camera stand-off when focusing, in scene units (1 unit = 1000 km). */
const FOCUS_RADIUS_ICARUS = 1.35;
const FOCUS_RADIUS_SATELLITE = 1.9;

/* ==========================================================================
 * Fatal-error path
 * ========================================================================== */

/**
 * Fraction of the Sun visible from the camera, 0..1.
 *
 * Ray/sphere intersection between the camera and the Sun against the Earth.
 * Returns 1 when the line of sight is clear, 0 when the Earth is squarely in
 * the way, and a smooth ramp across the limb so the glare fades instead of
 * snapping off as the Sun passes behind the planet.
 */
function sunVisibility(cameraPos: Vector3, sunPos: Vector3): number {
  const dir = _tmpA.copy(sunPos).sub(cameraPos);
  const distance = dir.length();
  if (distance < 1e-6) return 1;
  dir.divideScalar(distance);

  // Closest approach of the ray to the Earth's centre (the origin).
  const along = -cameraPos.dot(dir);
  if (along <= 0 || along >= distance) return 1; // Earth is behind us, or past the Sun

  const perpendicular = _tmpB.copy(cameraPos).addScaledVector(dir, along).length();

  // Soft edge one tenth of an Earth radius wide.
  const feather = EARTH_RADIUS_UNITS * 0.1;
  if (perpendicular >= EARTH_RADIUS_UNITS + feather) return 1;
  if (perpendicular <= EARTH_RADIUS_UNITS - feather) return 0;
  return (perpendicular - (EARTH_RADIUS_UNITS - feather)) / (2 * feather);
}

const _tmpA = new Vector3();
const _tmpB = new Vector3();

function showFatal(headline: string, detail: string): void {
  document.getElementById('boot')?.classList.add('gone');
  const fatal = document.getElementById('fatal');
  if (!fatal) return;
  const h = fatal.querySelector('h1');
  const p = document.getElementById('fatal-detail');
  if (h) h.textContent = headline;
  if (p) p.textContent = detail;
  fatal.classList.add('on');
}

/* ==========================================================================
 * Boot
 * ========================================================================== */

function boot(): void {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud');
  const bannerEl = document.getElementById('alert-banner');
  const safeFrameEl = document.getElementById('safe-mode-frame');
  const hoverLabel = document.getElementById('hover-label');
  const bootEl = document.getElementById('boot');

  if (!canvas || !hudRoot || !bannerEl || !safeFrameEl || !hoverLabel) {
    showFatal('Page failed to initialise', 'Expected DOM nodes are missing from index.html.');
    return;
  }
  // Re-bind after the guard so the narrowing survives into the render loop.
  const hover: HTMLElement = hoverLabel;

  /* ---------------------------------------------------------- 1. renderer */
  let ctx;
  try {
    ctx = createSceneContext(canvas);
  } catch (err) {
    if (err instanceof WebGL2UnavailableError) {
      showFatal(
        'WebGL 2 unavailable',
        'This digital twin renders with the Three.js WebGLRenderer, which requires WebGL 2. '
          + 'Your browser or graphics driver did not provide a WebGL 2 context. '
          + `Reported: ${err.message}`,
      );
    } else {
      showFatal('Renderer failed to start', String(err));
    }
    return;
  }
  const { renderer, scene, camera } = ctx;

  /* ------------------------------------------------------------ 2. scene */
  const stars = createStars(4200, renderer.getPixelRatio());
  scene.add(stars.points);

  const earth = createEarth();
  scene.add(earth.mesh);

  const sun = createSun(renderer.getPixelRatio());
  scene.add(sun.group, sun.light, sun.light.target);

  const cubesat = createCubeSat();
  scene.add(cubesat.root);

  const orbitLines = new OrbitLineSet();
  scene.add(orbitLines.group);

  const icarusOrbit = createIcarusOrbitLine();
  scene.add(icarusOrbit.line);

  const markers = createSatelliteMarkers(64, renderer.getPixelRatio());
  scene.add(markers.points);

  const cameraCtl = createCameraController(camera, canvas);

  /* ------------------------------------------------------- 3. simulators */
  const browserFsw = new BrowserFsw({ timeScale: ORBIT_TIME_SCALE });

  let localLink: LocalFswLink | null = null;
  let localAuthoritative = false;

  const router = new CommandRouter({
    browserFsw,
    getLink: () => localLink,
    isLocalAuthoritative: () => localAuthoritative,
  });

  /* --------------------------------------------------------------- 4. UI */
  const alerts = createAlertSystem(bannerEl, safeFrameEl);

  /** Send a command and report truthfully where it went. */
  function send(message: CommandMessage, label: string): void {
    const outcome = router.dispatch(message);
    synth.play('click');
    if (!outcome.ok) {
      alerts.show('warn', 'COMMAND NOT SENT', outcome.reason, 4200);
      pushAlert('warn', 'UPLINK', `${label}: ${outcome.reason}`);
      return;
    }
    if (outcome.route === 'LOCAL-FSW') {
      // Deliberately no local state change: the OBC's telemetry is the ack.
      pushAlert('info', 'UPLINK', `${label} sent to the Icarus OBC`);
    }
  }

  const hud = createHud(hudRoot, {
    onAltitude: (km) => {
      setControls({ altitudeKm: km });
      router.dispatch(cmd.setAltitude(km));
    },
    onInclination: (deg) => {
      setControls({ inclinationDeg: deg });
      router.dispatch(cmd.setInclination(deg));
    },
    onRoll: (deg) => {
      const c = getState().controls;
      setControls({ rollDeg: deg });
      router.dispatch(cmd.setAttitude(deg, c.pitchDeg, c.yawDeg));
    },
    onDisturbance: () => send(cmd.injectDisturbance(), 'Attitude disturbance'),
    onAnomaly: () => send(cmd.injectAnomaly('thermal'), 'Thermal anomaly'),
    onBatteryAnomaly: () => send(cmd.injectAnomaly('battery'), 'Battery fault'),
    onReset: () => send(cmd.reset(), 'Reset'),

    onResetView: () => {
      cameraCtl.reset();
      synth.play('click');
    },
    onFocusIcarus: () => selectObject(ICARUS_ID),
    onToggleAudio: () => {
      void synth.setEnabled(!synth.isEnabled()).then((on) => {
        setAudioEnabled(on);
        if (on) synth.play('select');
      });
    },
    onSelect: (id) => selectObject(id),
  });

  /* --------------------------------------------------- 5. orbital objects */
  let tracked: TrackedObject[] = [];
  const markerPositions: Vector3[] = [];
  const markerKinds: ObjectKind[] = [];
  const pickables: Pickable[] = [];

  void loadCatalog(import.meta.env.BASE_URL)
    .then((result) => {
      tracked = buildTrackedObjects(result.objects, browserFsw.missionDate());
      for (const obj of tracked) orbitLines.add(obj.record.id, obj.record.kind, obj.pathEciKm);
      setOrbitData(
        tracked.map((t) => t.record),
        tracked.length === 0 ? 'FALLBACK' : result.source,
        tracked.length === 0 ? 'No usable element sets - ICARUS simulation only' : result.detail,
      );
      if (result.source === 'FALLBACK') {
        pushAlert('warn', 'ORBIT DATA', 'CelesTrak unreachable - using bundled element sets');
      }
      orbitLines.setSelected(getState().selectedId);
    })
    .catch((err: unknown) => {
      // loadCatalog handles its own failures, but a rejected promise must never
      // be allowed to take out the render loop.
      console.error('[orbit] catalogue load failed', err);
      setOrbitData([], 'FALLBACK', 'Element sets unavailable - ICARUS simulation only');
    });

  /* ------------------------------------------------------- 6. local link */
  localLink = new LocalFswLink({
    url: defaultBridgeUrl(),
    onPacket: (packet) => {
      if (!localAuthoritative) {
        localAuthoritative = true;
        setFswMode('LOCAL-FSW');
        pushAlert('info', 'FSW LINK', 'Icarus C OBC telemetry accepted - LOCAL-FSW active');
        alerts.show('info', 'FSW LINK - LOCAL', 'Telemetry is now coming from the Icarus C OBC', 3600);
        synth.play('state');
      }
      applyPacket(packet, true);
    },
    onStatus: (ev) => {
      switch (ev.kind) {
        case 'connecting':
          setLinkStatus('CONNECTING');
          break;
        case 'connected':
          setLinkStatus('CONNECTED');
          break;
        case 'live':
          setLinkStatus('CONNECTED', 0);
          break;
        case 'stale':
        case 'disconnected':
          if (localAuthoritative) {
            localAuthoritative = false;
            setFswMode('BROWSER-FSW');
            pushAlert('warn', 'FSW LINK', 'Local telemetry stopped - reverting to Browser FSW');
            alerts.show('warn', 'FSW LINK LOST', 'Reverted to the in-browser simulator', 4000);
            synth.play('state');
          }
          setLinkStatus('DISCONNECTED');
          break;
        case 'rejected':
          console.warn('[link] packet rejected:', ev.reason);
          break;
      }
    },
  });
  localLink.start();

  /* ------------------------------------------------- 7. selection + hover */
  let hoveredId: string | null = null;

  function positionOf(id: string): Vector3 | null {
    if (id === ICARUS_ID) return cubesat.root.position;
    const idx = tracked.findIndex((t) => t.record.id === id);
    return idx >= 0 ? markerPositions[idx] ?? null : null;
  }

  function selectObject(id: string): void {
    setSelected(id);
    orbitLines.setSelected(id === ICARUS_ID ? null : id);
    icarusOrbit.setActive(id === ICARUS_ID);
    const pos = positionOf(id);
    if (pos) cameraCtl.focus(pos, id === ICARUS_ID ? FOCUS_RADIUS_ICARUS : FOCUS_RADIUS_SATELLITE);
    synth.play('select');
  }

  function nameOf(id: string): string {
    if (id === ICARUS_ID) return 'ICARUS-1U (simulated)';
    return tracked.find((t) => t.record.id === id)?.record.name ?? id;
  }

  canvas.addEventListener('pointermove', (ev) => {
    const hit = pick(pickables, camera, ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
    const id = hit?.id ?? null;
    if (id !== hoveredId) {
      hoveredId = id;
      canvas.classList.toggle('hovering', id !== null);
      if (id) hover.textContent = nameOf(id);
    }
    if (hit) {
      hover.style.left = `${hit.screenX}px`;
      hover.style.top = `${hit.screenY}px`;
      hover.classList.add('on');
    } else {
      hover.classList.remove('on');
    }
  });

  // A click only selects when it was a click, not the end of a camera drag.
  let downX = 0;
  let downY = 0;
  canvas.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX;
    downY = ev.clientY;
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
    const hit = pick(pickables, camera, ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
    if (hit) selectObject(hit.id);
  });

  // Presenter shortcuts - the demo can be driven from the keyboard.
  window.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    switch (ev.key.toLowerCase()) {
      case 'r':
        cameraCtl.reset();
        break;
      case 'i':
        selectObject(ICARUS_ID);
        break;
      case 's':
        if (tracked.some((t) => t.record.id === 'iss')) selectObject('iss');
        break;
      case 'a':
        send(cmd.injectAnomaly('thermal'), 'Thermal anomaly');
        break;
      case 'd':
        send(cmd.injectDisturbance(), 'Attitude disturbance');
        break;
      case 'x':
        send(cmd.reset(), 'Reset');
        break;
    }
  });

  /* -------------------------------------------------- 8. telemetry intake */
  const attitudeQ = new Quaternion();
  const attitudeE = new Euler();
  let lastPacket: TelemetryPacket | null = null;
  let lastSampleMs = 0;

  /**
   * The single funnel for telemetry, whichever simulator produced it.
   * `fromLocal` only decides whether the sliders are mirrored back from the
   * packet - in LOCAL-FSW the OBC owns those values, not the browser.
   */
  function applyPacket(packet: TelemetryPacket, fromLocal: boolean): void {
    setTelemetry(packet);
    lastPacket = packet;

    // Attitude drives the model and nothing else - it never touches the orbit.
    attitudeE.set(
      packet.attitude.roll_deg * DEG,
      packet.attitude.pitch_deg * DEG,
      packet.attitude.yaw_deg * DEG,
      EULER_ORDER,
    );
    attitudeQ.setFromEuler(attitudeE);
    cubesat.attitudeRoot.quaternion.copy(attitudeQ);

    if (fromLocal) {
      setControls({
        altitudeKm: packet.orbit.altitude_km,
        inclinationDeg: packet.orbit.inclination_deg,
        rollDeg: packet.attitude.roll_deg,
      });
      hud.syncControls(
        packet.orbit.altitude_km,
        packet.orbit.inclination_deg,
        packet.attitude.roll_deg,
      );
    }

    const nowMs = performance.now();
    if (nowMs - lastSampleMs > 90) {
      lastSampleMs = nowMs;
      hud.sample(packet.thermal.temperature_c, packet.vibration.g);
    }

    alerts.sync(packet, onFlightStateEnter);
    applyVisualState(packet);
  }

  function onFlightStateEnter(state: FlightState): void {
    switch (state) {
      case 'SAFE_MODE':
      case 'ANOMALY':
        synth.play('anomaly');
        break;
      case 'ADCS_ACTIVE':
        // The one internal view worth showing: the reaction wheel doing work.
        cubesat.revealInternals(6.5);
        synth.play('state');
        break;
      case 'RECOVERY':
        synth.play('recovery');
        break;
      default:
        break;
    }
  }

  function applyVisualState(packet: TelemetryPacket): void {
    if (packet.state === 'SAFE_MODE' || packet.state === 'ANOMALY') {
      cubesat.setVisualState('safe');
    } else if (
      packet.state === 'ADCS_ACTIVE'
      || packet.state === 'DISTURBANCE'
      || packet.state === 'ERROR_DECREASING'
    ) {
      cubesat.setVisualState('adcs');
    } else {
      cubesat.setVisualState('nominal');
    }
  }

  /* ------------------------------------------------------ 9. render loop */
  let lastFrameMs = performance.now();
  let icarusOrbitSignature = '';
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fpsTimer = 0;
  let degradeStage = 0;
  const startMs = Date.now();

  const scenePos = new Vector3();
  let phaseStartMs = Date.now();
  let phaseWasEclipse = false;
  let framedSunOnce = false;

  function frame(nowMs: number): void {
    requestAnimationFrame(frame);

    const dt = Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;

    /* --- simulation -----------------------------------------------------
     * BROWSER-FSW keeps running even while LOCAL-FSW is authoritative, so the
     * handover back to it is instant and never shows a frozen spacecraft.  */
    browserFsw.advance(dt);
    const snap = browserFsw.snapshot();
    if (!localAuthoritative) applyPacket(snap.packet, false);

    /* --- the one mission clock ------------------------------------------ */
    const missionDate = browserFsw.missionDate();
    setClock(missionDate.getTime(), (Date.now() - startMs) / 1000);

    /* --- Sun + Earth ----------------------------------------------------- */
    sun.setDirectionEci(browserFsw.sunDirectionNow());
    earth.setSunDirection(sun.direction);
    sun.setGlareVisibility(sunVisibility(camera.position, sun.group.position));
    if (!framedSunOnce) {
      // One-shot: open on the sunlit face so the exhibit looks right with no
      // interaction at all.
      framedSunOnce = true;
      cameraCtl.frameSunlitSide(sun.direction);
    }
    earth.setSpin(earthSpinFromGmst(gstime(missionDate)));
    stars.update((Date.now() - startMs) / 1000);

    /* --- ICARUS position + orbit ring ------------------------------------ */
    sceneFromEci(snap.positionEciKm, scenePos);
    cubesat.root.position.copy(scenePos);
    cubesat.update(dt, snap.wheelActivity);
    cubesat.setCameraDistance(
      camera.position.distanceTo(cubesat.root.position),
      getState().selectedId === ICARUS_ID,
    );

    // Rebuild the ring only when the orbit actually changed.
    const sig = `${snap.radiusKm.toFixed(1)}|${snap.inclinationDeg.toFixed(2)}|${snap.raanDeg.toFixed(1)}`;
    if (sig !== icarusOrbitSignature) {
      icarusOrbitSignature = sig;
      icarusOrbit.rebuild(
        sampleOrbitEci(snap.radiusKm, snap.inclinationDeg, snap.raanDeg, ICARUS_SEGMENTS),
      );
    }

    /* --- real objects ----------------------------------------------------
     * SGP4 runs at PROPAGATE_HZ into a pair of keyframes; every frame in
     * between is a cubic Hermite interpolation along the orbit (see
     * orbit/propagate.ts). That is what keeps the catalogue moving smoothly
     * while the mission clock is running at 60x.                           */
    const keyframeStepMs = (1000 / PROPAGATE_HZ) * ORBIT_TIME_SCALE;
    for (const obj of tracked) updateTracked(obj, missionDate, keyframeStepMs);

    markerPositions.length = 0;
    markerKinds.length = 0;
    pickables.length = 0;
    for (const obj of tracked) {
      if (obj.failed) continue;
      const p = sceneFromEci(obj.renderPositionKm);
      markerPositions.push(p);
      markerKinds.push(obj.record.kind);
      pickables.push({ id: obj.record.id, position: p });
    }
    pickables.push({ id: ICARUS_ID, position: cubesat.root.position });

    const state = getState();
    const selectedIdx = tracked.findIndex((t) => t.record.id === state.selectedId && !t.failed);
    const hoveredIdx = tracked.findIndex((t) => t.record.id === hoveredId);
    markers.update(markerPositions, markerKinds, selectedIdx, hoveredIdx);

    /* --- camera ---------------------------------------------------------- */
    const followPos =
      state.selectedId === ICARUS_ID
        ? cubesat.root.position
        : selectedIdx >= 0
          ? markerPositions[selectedIdx] ?? null
          : null;
    cameraCtl.update(dt, followPos);

    /* --- hover label follows its object ---------------------------------- */
    if (hoveredId) {
      const hp = positionOf(hoveredId);
      if (hp) {
        const s = projectToScreen(hp, camera, window.innerWidth, window.innerHeight);
        hover.style.left = `${s.x}px`;
        hover.style.top = `${s.y}px`;
        hover.classList.toggle('on', s.visible);
      }
    }

    /* --- HUD -------------------------------------------------------------- */
    hud.render(buildViewModel());

    /* --- draw ------------------------------------------------------------- */
    renderer.render(scene, camera);

    /* --- performance governor --------------------------------------------
     * Order of sacrifice: resolution, then orbit-line density. Telemetry
     * legibility is never touched.                                        */
    fpsAccum += 1 / Math.max(dt, 1e-4);
    fpsFrames++;
    fpsTimer += dt;
    if (fpsTimer >= 1) {
      const fps = fpsAccum / fpsFrames;
      setRenderStats(fps, renderer.info.render.calls);
      fpsAccum = 0;
      fpsFrames = 0;
      fpsTimer = 0;
      if (fps < 45) {
        if (degradeStage === 0 && degradePixelRatio(renderer)) {
          console.warn(`[perf] ${fps.toFixed(0)} fps - reduced pixel ratio`);
        } else if (degradeStage < 2) {
          degradeStage = 2;
          orbitLines.setDensity('reduced');
          console.warn(`[perf] ${fps.toFixed(0)} fps - reduced orbit-line density`);
        }
      }
    }
  }

  function buildViewModel(): HudViewModel {
    const state = getState();
    const packet = lastPacket ?? state.telemetry;

    const selected = tracked.find((t) => t.record.id === state.selectedId);
    const profile = selected ? realObjectProfile(selected) : icarusProfile(packet);

    const orbit = orbitFromAltitude(packet.orbit.altitude_km);
    const betaDeg = browserFsw.betaAngleDeg();
    const frac = eclipseFraction(orbit.radiusKm, betaDeg);

    return {
      profile,
      rows: objectRows(state, tracked),
      betaDeg,
      nextTerminatorS: nextTerminator(packet, orbit.periodMin * 60, frac),
      eclipseFraction: frac,
      timeScale: ORBIT_TIME_SCALE,
    };
  }

  /**
   * Time to the next sunlit/eclipse transition.
   *
   * The eclipse fraction gives the length of the shadow arc; we time the
   * current phase from the moment the geometric eclipse flag last flipped.
   * The authoritative eclipse state is always that flag in the telemetry
   * packet - this is only the countdown next to it.
   */
  function nextTerminator(
    packet: TelemetryPacket,
    periodS: number,
    frac: number,
  ): number | null {
    if (frac <= 0) return null;
    if (packet.environment.eclipse !== phaseWasEclipse) {
      phaseWasEclipse = packet.environment.eclipse;
      phaseStartMs = Date.now();
    }
    const phaseLengthS = (packet.environment.eclipse ? frac : 1 - frac) * periodS;
    const elapsedS = ((Date.now() - phaseStartMs) / 1000) * ORBIT_TIME_SCALE;
    return Math.max(0, phaseLengthS - elapsedS);
  }

  /* ---------------------------------------------------------- 10. launch */

  /*
   * Dismiss the boot screen on the FIRST DRAWN FRAME, or after a short
   * timeout, whichever comes first.
   *
   * The timeout is not belt-and-braces, it is load-bearing: browsers pause
   * requestAnimationFrame entirely while a tab is in the background, so a page
   * opened in a background tab - which is exactly what happens when a
   * presenter opens the exhibit and then switches away to something else -
   * would otherwise sit on "initialising" for ever and still be sitting there
   * when they came back.
   */
  let bootDismissed = false;
  const dismissBoot = () => {
    if (bootDismissed) return;
    bootDismissed = true;
    bootEl?.classList.add('gone');
  };
  const bootTimeout = setTimeout(dismissBoot, 2500);

  requestAnimationFrame((t) => {
    lastFrameMs = t;
    frame(t);
    setTimeout(() => {
      clearTimeout(bootTimeout);
      dismissBoot();
    }, 220);
  });

  // Handle for automated tests and exhibition debugging. Scene objects are
  // included so a renderer problem can be poked at from the console on the
  // presentation laptop without a rebuild.
  (window as unknown as { __icarus: unknown }).__icarus = {
    browserFsw,
    router,
    selectObject,
    getState,
    renderer,
    scene,
    camera,
    cameraCtl,
    earth,
    sun,
    cubesat,
    markers,
    orbitTimeScale: ORBIT_TIME_SCALE,
    tracked: () => tracked,
    send: (message: CommandMessage) => router.dispatch(message),
  };
}

/* ==========================================================================
 * Go
 * ========================================================================== */

try {
  boot();
} catch (err) {
  console.error('[icarus] fatal', err);
  showFatal('Application failed to start', String(err));
}

/**
 * ICARUS TELEMETRY PLATE + COMMAND DECK
 * =============================================================================
 * Every value here comes straight out of the current TelemetryPacket. Nothing
 * on this panel animates independently of the telemetry: if the battery tape
 * moves, the battery percentage in the packet moved.
 *
 * Layout, top to bottom:
 *   head            flight state, colour-coded, plus the telemetry source
 *   tapes           battery and bus temperature, each on a scale tape
 *   bus row         SOLAR / LOAD / VIBRATION / ILLUM
 *   attitude bank   ROLL / PITCH / YAW / POINT ERR
 *   traces          temperature and vibration on a graticule
 *   alert line      the active fault, or an explicit "no active alert"
 *   command deck    altitude, inclination, roll, and the four actions
 */

import type { AppState } from '../state/store.ts';
import {
  attitudeErrorSeverity,
  batterySeverity,
  flightStateLabel,
  flightStateSeverity,
  temperatureSeverity,
  vibrationSeverity,
} from '../state/selectors.ts';
import { THERMAL_LIMIT_C } from '../fsw/browserFsw.ts';
import { corners, el, fmt, fmtSigned, ICONS, icon, readout, setStateClass, setText, tape } from './dom.ts';
import { createSparkline } from './sparkline.ts';

export interface TelemetryHandlers {
  onAltitude: (km: number) => void;
  onInclination: (deg: number) => void;
  onRoll: (deg: number) => void;
  onDisturbance: () => void;
  onAnomaly: () => void;
  onBatteryAnomaly: () => void;
  onReset: () => void;
}

export interface TelemetryPanel {
  root: HTMLElement;
  update: (state: AppState) => void;
  /** Push a sample into the traces - called at telemetry rate, not FPS. */
  sample: (temperatureC: number, vibrationG: number) => void;
  /** Reflect externally changed control values (e.g. a LOCAL-FSW packet). */
  syncControls: (altitudeKm: number, inclinationDeg: number, rollDeg: number) => void;
}

/** Temperature range the bus tape spans, in celsius. */
const TEMP_TAPE_MIN = -30;
const TEMP_TAPE_MAX = 80;
const tempPct = (c: number) => ((c - TEMP_TAPE_MIN) / (TEMP_TAPE_MAX - TEMP_TAPE_MIN)) * 100;

/**
 * A graduated slider. The graduations are painted on the wrapper, so the input
 * itself only has to draw a 2px track and a rectangular index bug; a bipolar
 * control gets a taller centre tick so its sign reads without a label.
 */
function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  initial: number,
  unit: string,
  onInput: (v: number) => void,
  bipolar = false,
): { root: HTMLElement; setValue: (v: number) => void } {
  const readoutEl = el('div', { class: 'sv' }, [`${initial}${unit}`]);
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(initial),
    'aria-label': label,
  }) as HTMLInputElement;

  const grads: Node[] = [];
  for (const pct of [0, 25, 50, 75, 100]) {
    const g = el('i', { class: bipolar && pct === 50 ? 'grad zero' : 'grad' });
    g.style.left = `${pct}%`;
    grads.push(g);
  }

  // Show as many decimals as the step can actually resolve, so a 51.6 deg
  // inclination does not display as "52 deg" next to a profile panel that
  // correctly says 51.60.
  const decimals = step < 1 ? 1 : 0;
  const paint = (v: number) => {
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${pct.toFixed(1)}%`);
    setText(readoutEl, `${v.toFixed(decimals)}${unit}`);
  };
  paint(initial);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    onInput(v);
  });

  return {
    root: el('div', { class: 'slider-row' }, [
      el('div', { class: 'label' }, [label]),
      el('div', { class: 'slider-wrap' }, [...grads, input]),
      readoutEl,
    ]),
    setValue: (v) => {
      if (document.activeElement === input) return; // never fight the user
      input.value = String(v);
      paint(v);
    },
  };
}

export function createTelemetryPanel(handlers: TelemetryHandlers): TelemetryPanel {
  /* ---- head ------------------------------------------------------------ */
  const flightState = el('div', { class: 'flight-state nominal' }, ['BOOT']);
  const sourceLabel = el('div', { class: 'status-detail', style: 'padding-left:0' }, ['SRC - BROWSER FSW']);
  const key = el('span', { class: 'key' });

  /* ---- tapes ----------------------------------------------------------- */
  const batteryTape = tape({ graduations: [25, 50, 75] });
  const battery = readout('Battery', { size: 'big', cellClass: 'readout' });
  const batteryNet = el('div', { class: 'status-detail', style: 'padding-left:0' }, ['--']);
  battery.root.append(batteryNet);

  const tempTape = tape({ graduations: [30, 60], limitPct: tempPct(THERMAL_LIMIT_C) });
  const temperature = readout('Bus temp', { size: 'big', cellClass: 'readout' });
  const tempLimit = el('div', { class: 'status-detail', style: 'padding-left:0' }, [
    `LIM ${THERMAL_LIMIT_C} C`,
  ]);
  temperature.root.append(tempLimit);

  /* ---- bus row --------------------------------------------------------- */
  const solar = readout('Solar', { size: 'sm' });
  const load = readout('Load', { size: 'sm' });
  const vibration = readout('Vibration', { size: 'sm' });
  const illumination = readout('Illum', { size: 'sm' });

  /* ---- attitude bank --------------------------------------------------- */
  const roll = readout('Roll', { size: 'sm' });
  const pitch = readout('Pitch', { size: 'sm' });
  const yaw = readout('Yaw', { size: 'sm' });
  const attError = readout('Point Err', { size: 'sm' });

  /* ---- traces ---------------------------------------------------------- */
  const tempSpark = createSparkline({
    min: TEMP_TAPE_MIN,
    max: TEMP_TAPE_MAX,
    color: 'var(--c-accent)',
    limit: THERMAL_LIMIT_C,
  });
  const vibSpark = createSparkline({ min: 0, max: 0.16, color: 'var(--c-warn)' });
  const tempSparkVal = el('div', { class: 'spark-val' }, ['--']);
  const vibSparkVal = el('div', { class: 'spark-val' }, ['--']);

  /* ---- alert line ------------------------------------------------------ */
  const alertLamp = el('span', { class: 'lamp' });
  const alertCode = el('span', { class: 'code' }, ['NO ACTIVE ALERT']);
  const alertMsg = el('span', { class: 'msg' }, ['ALL SUBSYSTEMS IN LIMITS']);
  const alertTs = el('span', { class: 'ts' }, ['']);
  const alertLine = el('div', { class: 'alert-line' }, [alertLamp, alertCode, alertMsg, alertTs]);

  /* ---- command deck ---------------------------------------------------- */
  const altSlider = slider('Altitude', 300, 1200, 10, 500, ' km', handlers.onAltitude);
  const incSlider = slider('Inclin', 0, 120, 0.5, 51.6, ' deg', handlers.onInclination);
  const rollSlider = slider('Roll cmd', -90, 90, 1, 0, ' deg', handlers.onRoll, true);

  const btnDisturb = el('button', { class: 'btn', type: 'button' }, [icon(ICONS.wave), 'Disturbance']);
  const btnAnomaly = el('button', { class: 'btn danger', type: 'button' }, [icon(ICONS.warn), 'Inject anomaly']);
  const btnBattery = el('button', { class: 'btn', type: 'button' }, [icon(ICONS.power), 'Battery fault']);
  const btnReset = el('button', { class: 'btn', type: 'button' }, [icon(ICONS.reset), 'Reset']);

  btnDisturb.addEventListener('click', handlers.onDisturbance);
  btnAnomaly.addEventListener('click', handlers.onAnomaly);
  btnBattery.addEventListener('click', handlers.onBatteryAnomaly);
  btnReset.addEventListener('click', handlers.onReset);

  /* ---- assembly -------------------------------------------------------- */
  const root = el('section', { class: 'plate', id: 'telemetry' }, [
    corners(),
    el('header', { class: 'plate-head' }, [
      key,
      el('div', { class: 'profile-title' }, [
        el('div', { class: 'head-title' }, ['Icarus telemetry']),
        sourceLabel,
      ]),
      el('div', { class: 'spacer' }),
      flightState,
    ]),
    el('div', { class: 'plate-body' }, [
      el('div', { class: 'tape-row' }, [
        el('div', { class: 'tape-cell grow' }, [batteryTape.root, battery.root]),
        el('div', { class: 'tape-cell' }, [tempTape.root, temperature.root]),
      ]),

      el('div', { class: 'tm-section tm-power' }, [
        el('div', { class: 'tm-grid-4' }, [solar.root, load.root, vibration.root, illumination.root]),
      ]),

      el('div', { class: 'tm-section tm-attitude' }, [
        el('div', { class: 'spark-row', style: 'margin-bottom:11px' }, [
          el('div', { class: 'label' }, ['Attitude']),
          el('div', { class: 'rule' }),
          el('div', { class: 'spark-val', style: 'width:auto' }, ['ZYX DEG']),
        ]),
        el('div', { class: 'tm-grid-4' }, [roll.root, pitch.root, yaw.root, attError.root]),
      ]),

      el('div', { class: 'tm-section tm-traces' }, [
        el('div', { class: 'spark-row' }, [
          el('div', { class: 'label' }, ['Temp C']),
          tempSpark.svg,
          tempSparkVal,
        ]),
        el('div', { class: 'spark-row' }, [
          el('div', { class: 'label' }, ['Vib g']),
          vibSpark.svg,
          vibSparkVal,
        ]),
      ]),

      alertLine,

      el('div', { class: 'deck' }, [
        el('div', { class: 'spark-row', style: 'margin-bottom:13px' }, [
          el('div', { class: 'label' }, ['Command']),
          el('div', { class: 'rule' }),
        ]),
        el('div', { class: 'deck-rows' }, [altSlider.root, incSlider.root, rollSlider.root]),
        el('div', { class: 'deck-actions' }, [btnDisturb, btnAnomaly, btnBattery, btnReset]),
      ]),
    ]),
  ]);

  return {
    root,

    update: (state) => {
      const t = state.telemetry;
      const sev = flightStateSeverity(t.state);

      setStateClass(flightState, 'flight-state', sev);
      setText(flightState, flightStateLabel(t.state));
      setStateClass(key, 'key', sev === 'busy' ? '' : sev);
      setStateClass(root, 'plate', sev === 'crit' ? 'crit' : '');

      setText(
        sourceLabel,
        state.fswMode === 'LOCAL-FSW' ? 'SRC - ICARUS C OBC' : 'SRC - BROWSER FSW',
      );

      /* ---- battery ---- */
      const batSev = batterySeverity(t.power.battery_pct);
      setStateClass(battery.value, 'value big', batSev);
      battery.setValue(fmt(t.power.battery_pct, 1), '%');
      batteryTape.set(t.power.battery_pct, batSev === 'busy' ? 'nominal' : batSev);

      // Charging vs discharging is the story of the eclipse - make it explicit.
      const net = t.power.solar_w - t.power.load_w;
      setText(
        batteryNet,
        `${fmtSigned(net, 1)} W NET - ${net >= 0 ? 'CHARGING' : 'DISCHARGING'}`,
      );

      /* ---- temperature ---- */
      const tempSev = temperatureSeverity(t.thermal.temperature_c);
      setStateClass(temperature.value, 'value big', tempSev);
      temperature.setValue(fmt(t.thermal.temperature_c, 1), 'C');
      tempTape.set(
        tempPct(t.thermal.temperature_c),
        tempSev === 'busy' ? 'accent' : tempSev === 'nominal' ? 'accent' : tempSev,
      );
      setText(
        tempLimit,
        t.thermal.temperature_c > THERMAL_LIMIT_C
          ? `LIM ${THERMAL_LIMIT_C} C - BREACHED`
          : `LIM ${THERMAL_LIMIT_C} C`,
      );

      /* ---- bus row ---- */
      setStateClass(solar.value, 'value sm', net >= 0 ? 'nominal' : 'dim');
      solar.setValue(fmt(t.power.solar_w, 2), 'W');
      setStateClass(load.value, 'value sm', t.state === 'SAFE_MODE' ? 'warn' : '');
      load.setValue(fmt(t.power.load_w, 2), 'W');
      setStateClass(vibration.value, 'value sm', vibrationSeverity(t.vibration.g));
      vibration.setValue(fmt(t.vibration.g, 3), 'g');
      setStateClass(
        illumination.value,
        'value sm',
        t.environment.illumination_pct <= 0 ? 'dim' : 'nominal',
      );
      illumination.setValue(fmt(t.environment.illumination_pct, 0), '%');

      /* ---- attitude ---- */
      roll.setValue(fmtSigned(t.attitude.roll_deg, 1), '°');
      pitch.setValue(fmtSigned(t.attitude.pitch_deg, 1), '°');
      yaw.setValue(fmtSigned(t.attitude.yaw_deg, 1), '°');
      setStateClass(attError.value, 'value sm', attitudeErrorSeverity(t.attitude.target_error_deg));
      attError.setValue(fmt(t.attitude.target_error_deg, 1), '°');

      setText(tempSparkVal, fmt(t.thermal.temperature_c, 1));
      setText(vibSparkVal, fmt(t.vibration.g, 3));

      /* ---- alert line mirrors the fault block exactly ---- */
      if (t.fault.active && t.fault.code) {
        setStateClass(alertLine, 'alert-line', 'crit');
        setText(alertCode, t.fault.code.replace(/_/g, ' '));
        setText(alertMsg, (t.fault.message ?? '').toUpperCase());
        setText(alertTs, new Date(t.timestamp * 1000).toISOString().slice(11, 19));
      } else if (t.fault.code) {
        setStateClass(alertLine, 'alert-line', 'warn');
        setText(alertCode, t.fault.code.replace(/_/g, ' '));
        setText(alertMsg, (t.fault.message ?? '').toUpperCase());
        setText(alertTs, '');
      } else {
        setStateClass(alertLine, 'alert-line', '');
        setText(alertCode, 'NO ACTIVE ALERT');
        setText(alertMsg, 'ALL SUBSYSTEMS IN LIMITS');
        setText(alertTs, '');
      }

      btnAnomaly.classList.toggle('armed', t.state === 'SAFE_MODE' || t.state === 'ANOMALY');
      const idle = t.state === 'NOMINAL' && !t.fault.active && t.attitude.target_error_deg < 1;
      btnReset.disabled = idle;
      btnReset.classList.toggle('go', !idle);
    },

    sample: (temperatureC, vibrationG) => {
      tempSpark.push(temperatureC);
      vibSpark.push(vibrationG);
    },

    syncControls: (altitudeKm, inclinationDeg, rollDeg) => {
      altSlider.setValue(altitudeKm);
      incSlider.setValue(inclinationDeg);
      rollSlider.setValue(rollDeg);
    },
  };
}

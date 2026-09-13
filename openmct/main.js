/**
 * ICARUS engineering view - Open MCT bootstrap.
 *
 * Kept as an external module rather than an inline <script> so that a syntax or
 * runtime error shows up as a normal script error in the console instead of a
 * silently blank page.
 *
 * `openmct` is a global, installed by dist/openmct.js which index.html loads as
 * a classic script before this module runs.
 */

import DictionaryPlugin from './dictionary-plugin.js';
import RealtimeTelemetryPlugin from './realtime-telemetry-plugin.js';

/* eslint-disable no-undef */

// Overridable for an exhibition laptop running the bridge elsewhere:
//   http://127.0.0.1:8080/?bridge=ws://10.0.0.5:8082
const wsUrl = new URLSearchParams(location.search).get('bridge') || 'ws://127.0.0.1:8082';

const REALTIME_OFFSETS = { start: -3 * 60 * 1000, end: 10 * 1000 };

openmct.setAssetPath('node_modules/openmct/dist');

openmct.install(openmct.plugins.LocalStorage());
openmct.install(openmct.plugins.MyItems());
openmct.install(openmct.plugins.Espresso());
openmct.install(openmct.plugins.UTCTimeSystem());

// The telemetry stream is live, so the view follows the clock.
openmct.install(
  openmct.plugins.Conductor({
    menuOptions: [
      {
        name: 'Realtime',
        timeSystem: 'utc',
        clock: 'local',
        clockOffsets: REALTIME_OFFSETS,
      },
      {
        name: 'Last 15 minutes',
        timeSystem: 'utc',
        clock: 'local',
        clockOffsets: { start: -15 * 60 * 1000, end: 10 * 1000 },
      },
    ],
  }),
);

openmct.install(DictionaryPlugin({ wsUrl }));
openmct.install(RealtimeTelemetryPlugin({ wsUrl }));

openmct.start();

// setClock has to come AFTER start(): before it, the conductor has no clock
// registered to switch to and the call is a no-op, leaving the plots frozen at
// a fixed time range with no incoming data drawn.
openmct.time.setClock('local');
openmct.time.setClockOffsets(REALTIME_OFFSETS);

console.info('[icarus] engineering view ready - telemetry from', wsUrl);

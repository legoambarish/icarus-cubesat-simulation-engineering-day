/**
 * ICARUS REALTIME TELEMETRY PROVIDER
 * ============================================================================
 * Subscribes Open MCT to the same WebSocket bridge the digital twin uses, so
 * both surfaces are looking at one stream from one source. There is no second
 * telemetry path and no separate simulator behind this view.
 *
 * The Open MCT contract for live data is a provider with:
 *
 *     supportsSubscribe(domainObject)  -> can I stream this object?
 *     subscribe(domainObject, callback) -> start; return an unsubscribe function
 *
 * A datum handed to `callback` must carry every key the object's `values`
 * declare - here `value` and `timestamp` - or the plot silently draws nothing.
 *
 * A HISTORICAL provider is included as well, backed by a small in-memory ring
 * buffer. Without one, opening a plot shows an empty chart until the next
 * sample arrives; with it, the last few minutes are already there. It is not a
 * database, and it says so: the buffer is per-session and is lost on reload.
 */

const BUFFER_SAMPLES = 1800; // 3 minutes at 10 Hz

/** Read a dotted path out of a telemetry packet: "power.battery_pct". */
function readPath(packet, path) {
  let value = packet;
  for (const part of path.split('.')) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Coerce a telemetry value into something Open MCT can plot or display.
 * Booleans become 0/1 so `environment.eclipse` can be drawn as a step trace;
 * null (an inactive fault code) becomes a readable string rather than a hole.
 */
function coerce(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return 'NONE';
  return value;
}

/**
 * @param {object} options
 * @param {string} options.wsUrl
 */
export default function RealtimeTelemetryPlugin(options = {}) {
  const wsUrl = options.wsUrl || 'ws://127.0.0.1:8082';

  /** key -> Set<callback> */
  const listeners = new Map();
  /** key -> datum[] */
  const history = new Map();
  /** Every key seen in the dictionary, so history is kept for all of them. */
  let trackedKeys = [];

  let socket = null;
  let reconnectDelay = 1000;
  let closedByUs = false;

  function record(key, datum) {
    let buffer = history.get(key);
    if (!buffer) {
      buffer = [];
      history.set(key, buffer);
    }
    buffer.push(datum);
    if (buffer.length > BUFFER_SAMPLES) buffer.shift();
  }

  function onPacket(packet) {
    // The bridge also emits {type:"status"} frames; they are not telemetry.
    if (!packet || packet.type === 'status') return;

    const timestamp = Math.round((packet.timestamp ?? Date.now() / 1000) * 1000);

    for (const key of trackedKeys) {
      const raw = readPath(packet, key);
      if (raw === undefined) continue;
      const datum = { timestamp, value: coerce(raw), id: key };
      record(key, datum);
      const subscribers = listeners.get(key);
      if (subscribers) {
        for (const callback of subscribers) {
          try {
            callback(datum);
          } catch (err) {
            console.error('[icarus] telemetry listener threw', err);
          }
        }
      }
    }
  }

  function connect() {
    if (closedByUs) return;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      console.warn('[icarus] could not open', wsUrl, err);
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      reconnectDelay = 1000;
      console.info('[icarus] telemetry link open:', wsUrl);
    };

    socket.onmessage = (event) => {
      let packet;
      try {
        packet = JSON.parse(event.data);
      } catch {
        return; // the bridge already validates; a bad frame is simply ignored
      }
      onPacket(packet);
    };

    socket.onclose = () => {
      socket = null;
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows - avoid logging the same failure twice.
    };
  }

  function scheduleReconnect() {
    if (closedByUs) return;
    console.info(`[icarus] telemetry link down, retrying in ${reconnectDelay} ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }

  return function install(openmct) {
    // Learn every key up front so history accumulates from the moment the page
    // loads, not from the moment a plot is opened.
    fetch('dictionary.json')
      .then((res) => res.json())
      .then((dictionary) => {
        trackedKeys = dictionary.measurements.map((m) => m.key);
      })
      .catch((err) => console.error('[icarus] dictionary unavailable', err));

    connect();

    /* ---- realtime ----------------------------------------------------- */
    openmct.telemetry.addProvider({
      supportsSubscribe(domainObject) {
        return domainObject.type === 'icarus.telemetry';
      },
      subscribe(domainObject, callback) {
        const key = domainObject.identifier.key;
        let subscribers = listeners.get(key);
        if (!subscribers) {
          subscribers = new Set();
          listeners.set(key, subscribers);
        }
        subscribers.add(callback);

        // The unsubscribe function Open MCT calls when the view goes away.
        return () => {
          subscribers.delete(callback);
          if (subscribers.size === 0) listeners.delete(key);
        };
      },
    });

    /* ---- historical (session buffer only) ------------------------------ */
    openmct.telemetry.addProvider({
      supportsRequest(domainObject) {
        return domainObject.type === 'icarus.telemetry';
      },
      request(domainObject, requestOptions) {
        const buffer = history.get(domainObject.identifier.key) || [];
        const start = requestOptions?.start ?? -Infinity;
        const end = requestOptions?.end ?? Infinity;
        return Promise.resolve(buffer.filter((d) => d.timestamp >= start && d.timestamp <= end));
      },
    });

    /* ---- limits: red and yellow bands on plots, alarms on tables ------- */
    openmct.telemetry.addProvider({
      supportsLimits(domainObject) {
        return domainObject.type === 'icarus.telemetry' && Boolean(domainObject.limits);
      },
      getLimits(domainObject) {
        return Promise.resolve({ limits: () => domainObject.limits });
      },
      getLimitEvaluator(domainObject) {
        const limits = domainObject.limits?.rl;
        return {
          evaluate(datum) {
            if (!limits || typeof datum.value !== 'number') return undefined;
            if (datum.value > limits.high || datum.value < limits.low) {
              return { cssClass: 'is-limit--upr is-limit--red', name: 'Out of limits' };
            }
            return undefined;
          },
        };
      },
    });

    return () => {
      closedByUs = true;
      if (socket) socket.close();
    };
  };
}

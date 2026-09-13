/**
 * ICARUS TELEMETRY DICTIONARY PLUGIN
 * ============================================================================
 * Teaches Open MCT what the spacecraft measures.
 *
 * Three pieces, which is the standard shape of an Open MCT telemetry adapter:
 *
 *   1. an OBJECT PROVIDER   - turns an identifier into a domain object
 *   2. a COMPOSITION PROVIDER - says which objects live inside the spacecraft
 *   3. a TYPE               - gives the measurements an icon and a name
 *
 * The dictionary itself is dictionary.json, whose measurement keys are paths
 * into the telemetry contract (src/state/types.ts), so the realtime provider
 * can read a value straight out of a packet with no mapping table.
 *
 * This is an ENGINEERING view. It is deliberately not the exhibition screen:
 * the cinematic twin tells the story, and this is where you go when you want
 * to see the numbers plotted and check the story is true.
 */

const NAMESPACE = 'icarus.taxonomy';
const ROOT_KEY = 'spacecraft';

/** Fetch and memoise the dictionary. */
let dictionaryPromise = null;
function getDictionary() {
  if (!dictionaryPromise) {
    dictionaryPromise = fetch('dictionary.json').then((res) => {
      if (!res.ok) throw new Error(`dictionary.json: HTTP ${res.status}`);
      return res.json();
    });
  }
  return dictionaryPromise;
}

/**
 * @param {object} options
 * @param {string} options.wsUrl  bridge WebSocket, shown on the root object
 */
export default function DictionaryPlugin(options = {}) {
  const wsUrl = options.wsUrl || 'ws://127.0.0.1:8082';

  return function install(openmct) {
    /* ---- the root of the tree ---------------------------------------- */
    openmct.objects.addRoot({ namespace: NAMESPACE, key: ROOT_KEY }, openmct.priority.HIGH);

    /* ---- objects ------------------------------------------------------ */
    openmct.objects.addProvider(NAMESPACE, {
      get(identifier) {
        return getDictionary().then((dictionary) => {
          if (identifier.key === ROOT_KEY) {
            return {
              identifier,
              name: dictionary.name,
              type: 'folder',
              location: 'ROOT',
            };
          }

          const measurement = dictionary.measurements.find((m) => m.key === identifier.key);
          if (!measurement) return undefined;

          return {
            identifier,
            name: measurement.name,
            type: 'icarus.telemetry',
            telemetry: {
              values: measurement.values,
            },
            // Limits drive the red/yellow bands on a plot and the alarm state
            // on a table row - this is how OpenMCT shows a threshold breach.
            ...(measurement.limits ? { limits: measurement.limits } : {}),
            location: `${NAMESPACE}:${ROOT_KEY}`,
            units: measurement.units,
          };
        });
      },
    });

    /* ---- composition: what is inside the spacecraft folder ------------ */
    openmct.composition.addProvider({
      appliesTo(domainObject) {
        return (
          domainObject.identifier.namespace === NAMESPACE
          && domainObject.identifier.key === ROOT_KEY
        );
      },
      load() {
        return getDictionary().then((dictionary) =>
          dictionary.measurements.map((m) => ({ namespace: NAMESPACE, key: m.key })),
        );
      },
    });

    /* ---- the type ----------------------------------------------------- */
    openmct.types.addType('icarus.telemetry', {
      name: 'Icarus telemetry point',
      description:
        'A measurement produced by the Icarus 1U CubeSat simulator and delivered '
        + `live over ${wsUrl}. ICARUS is a simulation, not a spacecraft in orbit.`,
      cssClass: 'icon-telemetry',
    });
  };
}

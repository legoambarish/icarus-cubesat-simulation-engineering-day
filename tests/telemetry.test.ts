/**
 * TELEMETRY VALIDATION AND COMMAND ROUTING
 *
 * The validator is the gate between an external process and the application's
 * state, so these tests are adversarial on purpose: NaN, Infinity, wrong types,
 * numeric strings, missing blocks, out-of-range values and unknown enums all
 * have to be refused, and a valid packet has to survive intact.
 */

import { describe, expect, it, vi } from 'vitest';

import { bootPacket, validateTelemetryPacket } from '../src/fsw/telemetry.ts';
import { TELEMETRY_SCHEMA_VERSION, COMMAND_WHITELIST } from '../src/state/types.ts';
import type { TelemetryPacket } from '../src/state/types.ts';
import { CommandRouter, cmd, isAllowedCommand, validateCommand } from '../src/fsw/commands.ts';
import { BrowserFsw, SIM_STEP_S } from '../src/fsw/browserFsw.ts';
import {
  validateOmm,
  CURATED_OBJECTS,
  catalogEntry,
  type CatalogEntry,
} from '../src/orbit/celestrak.ts';

/** A known-good packet, deep-cloned so a test cannot contaminate the next. */
function goodPacket(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(bootPacket(1_757_940_000))) as Record<string, unknown>;
}

describe('telemetry validation - the happy path', () => {
  it('accepts a well-formed packet and preserves every value', () => {
    const raw = goodPacket();
    const result = validateTelemetryPacket(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.packet;
    expect(p.telemetry_schema_version).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(p.source).toBe('BROWSER-FSW');
    expect(p.orbit.altitude_km).toBe(500);
    expect(p.state).toBe('BOOT');
  });

  it('accepts a packet from the C OBC', () => {
    const raw = { ...goodPacket(), source: 'ICARUS-OBC', state: 'NOMINAL' };
    expect(validateTelemetryPacket(raw).ok).toBe(true);
  });

  it('accepts every known flight state', () => {
    for (const state of [
      'BOOT', 'NOMINAL', 'DISTURBANCE', 'ADCS_ACTIVE',
      'ERROR_DECREASING', 'ANOMALY', 'SAFE_MODE', 'RECOVERY',
    ]) {
      expect(validateTelemetryPacket({ ...goodPacket(), state }).ok, state).toBe(true);
    }
  });

  it('accepts eclipse as 0/1 as well as a boolean', () => {
    for (const value of [true, false, 0, 1]) {
      const raw = goodPacket();
      (raw.environment as Record<string, unknown>).eclipse = value;
      const r = validateTelemetryPacket(raw);
      expect(r.ok, String(value)).toBe(true);
      if (r.ok) expect(typeof r.packet.environment.eclipse).toBe('boolean');
    }
  });
});

describe('telemetry validation - shape is constant', () => {
  it('back-fills period_min rather than dropping the field', () => {
    const raw = goodPacket();
    delete (raw.orbit as Record<string, unknown>).period_min;
    const r = validateTelemetryPacket(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // T = 2*pi*sqrt(r^3/mu) at 500 km.
    expect(r.packet.orbit.period_min).toBeCloseTo(94.469, 2);
  });

  it('back-fills optional attitude and power fields', () => {
    const raw = goodPacket();
    delete (raw.attitude as Record<string, unknown>).angular_velocity_deg_s;
    delete (raw.attitude as Record<string, unknown>).target_error_deg;
    delete (raw.power as Record<string, unknown>).load_w;
    const r = validateTelemetryPacket(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.packet.attitude.angular_velocity_deg_s).toEqual([0, 0, 0]);
    expect(r.packet.attitude.target_error_deg).toBe(0);
    expect(r.packet.power.load_w).toBe(0);
  });

  it('always produces a complete fault block, even with none sent', () => {
    const raw = goodPacket();
    delete raw.fault;
    const r = validateTelemetryPacket(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.packet.fault).sort()).toEqual(['active', 'code', 'message']);
    expect(r.packet.fault.code).toBeNull();
    expect(r.packet.fault.message).toBeNull();
  });

  it('nulls an unknown fault code rather than passing it through', () => {
    const raw = goodPacket();
    raw.fault = { active: true, code: 'ALIEN_ATTACK', message: 'x' };
    const r = validateTelemetryPacket(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.packet.fault.code).toBeNull();
  });

  it('truncates an over-long fault message', () => {
    const raw = goodPacket();
    raw.fault = { active: true, code: 'THERMAL_LIMIT', message: 'x'.repeat(500) };
    const r = validateTelemetryPacket(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.packet.fault.message!.length).toBe(160);
  });
});

describe('telemetry validation - rejections', () => {
  const reject = (mutate: (raw: Record<string, unknown>) => void, label: string) => {
    it(`rejects ${label}`, () => {
      const raw = goodPacket();
      mutate(raw);
      const r = validateTelemetryPacket(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    });
  };

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 42, 'hello', [], true]) {
      expect(validateTelemetryPacket(value).ok, String(value)).toBe(false);
    }
  });

  reject((r) => { r.telemetry_schema_version = 2; }, 'an unsupported schema version');
  reject((r) => { delete r.timestamp; }, 'a missing timestamp');
  reject((r) => { r.timestamp = NaN; }, 'a NaN timestamp');
  reject((r) => { r.timestamp = Infinity; }, 'an infinite timestamp');
  reject((r) => { r.timestamp = '1757940000'; }, 'a timestamp sent as a string');
  reject((r) => { r.source = 'SOMETHING-ELSE'; }, 'an unknown source');
  reject((r) => { delete r.satellite; }, 'a missing satellite id');
  reject((r) => { r.satellite = 'x'.repeat(200); }, 'an over-long satellite id');
  reject((r) => { r.state = 'PARTY_MODE'; }, 'an unknown flight state');
  reject((r) => { delete r.orbit; }, 'a missing orbit block');
  reject((r) => { delete r.attitude; }, 'a missing attitude block');
  reject((r) => { delete r.power; }, 'a missing power block');
  reject((r) => { delete r.thermal; }, 'a missing thermal block');
  reject((r) => { delete r.vibration; }, 'a missing vibration block');
  reject((r) => { delete r.environment; }, 'a missing environment block');
  reject((r) => { (r.orbit as Record<string, unknown>).altitude_km = NaN; }, 'a NaN altitude');
  reject((r) => { (r.orbit as Record<string, unknown>).altitude_km = -50; }, 'a sub-surface altitude');
  reject((r) => { (r.orbit as Record<string, unknown>).altitude_km = 1e9; }, 'an absurd altitude');
  reject((r) => { (r.orbit as Record<string, unknown>).velocity_km_s = 3e5; }, 'a relativistic velocity');
  reject((r) => { (r.orbit as Record<string, unknown>).inclination_deg = 400; }, 'an impossible inclination');
  reject((r) => { (r.power as Record<string, unknown>).battery_pct = 150; }, 'a battery above 100 %');
  reject((r) => { (r.power as Record<string, unknown>).battery_pct = -1; }, 'a negative battery');
  reject((r) => { (r.thermal as Record<string, unknown>).temperature_c = 5000; }, 'an absurd temperature');
  reject((r) => { (r.vibration as Record<string, unknown>).g = -1; }, 'negative vibration');
  reject((r) => { (r.environment as Record<string, unknown>).eclipse = 'yes'; }, 'a string eclipse flag');
  reject(
    (r) => { (r.attitude as Record<string, unknown>).angular_velocity_deg_s = [0, NaN, 0]; },
    'a NaN body rate',
  );
  reject(
    (r) => { (r.attitude as Record<string, unknown>).angular_velocity_deg_s = [0, 9999, 0]; },
    'an out-of-range body rate',
  );
  reject((r) => { (r.attitude as Record<string, unknown>).roll_deg = 'zero'; }, 'a non-numeric roll');

  it('tolerates a two-element rate array by falling back to zeros', () => {
    // Not fatal: the field is optional, so a wrong-length array is ignored.
    const raw = goodPacket();
    (raw.attitude as Record<string, unknown>).angular_velocity_deg_s = [1, 2];
    const r = validateTelemetryPacket(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.packet.attitude.angular_velocity_deg_s).toEqual([0, 0, 0]);
  });
});

describe('boot packet', () => {
  it('is itself valid, so the UI is never blank or broken at startup', () => {
    const r = validateTelemetryPacket(JSON.parse(JSON.stringify(bootPacket())));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.packet.state).toBe('BOOT');
  });
});

/* ========================================================================== */

describe('command validation', () => {
  it('accepts every command on the whitelist', () => {
    const all = [
      cmd.injectAnomaly('thermal'),
      cmd.injectAnomaly('battery'),
      cmd.injectDisturbance(),
      cmd.reset(),
      cmd.setAltitude(700),
      cmd.setInclination(72),
      cmd.setAttitude(10, -5, 30),
    ];
    for (const c of all) expect(validateCommand(c), c.command).toBeNull();
    // Every whitelisted name is exercised above.
    expect(new Set(all.map((c) => c.command)).size).toBe(COMMAND_WHITELIST.length);
  });

  it('refuses anything not on the whitelist', () => {
    for (const name of ['self_destruct', 'deorbit', '', 'SET_ALTITUDE', '__proto__']) {
      expect(isAllowedCommand(name), name).toBe(false);
    }
    const bad = { type: 'command', command: 'self_destruct' } as never;
    expect(validateCommand(bad)).toContain('not whitelisted');
  });

  it('refuses a message that is not a command', () => {
    expect(validateCommand({ type: 'telemetry', command: 'reset' } as never)).toContain('type');
  });

  it('range-checks numeric arguments', () => {
    expect(validateCommand(cmd.setAltitude(150))).toContain('range');
    expect(validateCommand(cmd.setAltitude(5000))).toContain('range');
    expect(validateCommand(cmd.setInclination(-1))).toContain('range');
    expect(validateCommand(cmd.setInclination(200))).toContain('range');
    expect(validateCommand(cmd.setAttitude(400, 0, 0))).toContain('range');
    expect(validateCommand(cmd.setAltitude(NaN))).toContain('numeric');
  });

  it('refuses an unknown anomaly kind', () => {
    const bad = { type: 'command', command: 'inject_anomaly', kind: 'gravity' } as never;
    expect(validateCommand(bad)).toContain('thermal');
  });
});

describe('command routing', () => {
  const makeRouter = (isLocal: boolean, link: { send: ReturnType<typeof vi.fn> } | null) => {
    const browserFsw = new BrowserFsw({ seed: 1, timeScale: 60 });
    const router = new CommandRouter({
      browserFsw,
      getLink: () => link as never,
      isLocalAuthoritative: () => isLocal,
    });
    return { router, browserFsw };
  };

  it('applies commands to the browser simulator in BROWSER-FSW', () => {
    const { router, browserFsw } = makeRouter(false, null);
    const outcome = router.dispatch(cmd.setAltitude(750));
    expect(outcome).toEqual({ ok: true, route: 'BROWSER-FSW' });
    browserFsw.advance(SIM_STEP_S);
    expect(browserFsw.snapshot().packet.orbit.altitude_km).toBeCloseTo(750, 6);
  });

  it('does NOT touch the browser simulator in LOCAL-FSW', () => {
    // This is the honesty requirement: with the C OBC authoritative, the
    // browser must not fake the effect of a command locally.
    const link = { send: vi.fn(() => true) };
    const { router, browserFsw } = makeRouter(true, link);
    const before = browserFsw.snapshot().packet.orbit.altitude_km;

    const outcome = router.dispatch(cmd.setAltitude(750));
    expect(outcome).toEqual({ ok: true, route: 'LOCAL-FSW' });
    expect(link.send).toHaveBeenCalledWith(cmd.setAltitude(750));

    browserFsw.advance(SIM_STEP_S);
    expect(browserFsw.snapshot().packet.orbit.altitude_km).toBeCloseTo(before, 6);
  });

  it('does not fake an anomaly locally while LOCAL-FSW is authoritative', () => {
    const link = { send: vi.fn(() => true) };
    const { router, browserFsw } = makeRouter(true, link);
    router.dispatch(cmd.injectAnomaly('thermal'));
    for (let i = 0; i < 600; i++) browserFsw.advance(SIM_STEP_S);
    // The browser simulator stays nominal: only the OBC can raise this fault.
    expect(browserFsw.snapshot().packet.fault.active).toBe(false);
  });

  it('reports an undelivered command rather than pretending it worked', () => {
    const link = { send: vi.fn(() => false) };
    const { router } = makeRouter(true, link);
    const outcome = router.dispatch(cmd.reset());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('not delivered');
  });

  it('reports a missing link', () => {
    const { router } = makeRouter(true, null);
    const outcome = router.dispatch(cmd.reset());
    expect(outcome.ok).toBe(false);
  });

  it('refuses an invalid command before it can leave the tab', () => {
    const link = { send: vi.fn(() => true) };
    const { router } = makeRouter(true, link);
    const outcome = router.dispatch(cmd.setAltitude(99999));
    expect(outcome.ok).toBe(false);
    expect(link.send).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */

describe('orbital element validation', () => {
  const iss = catalogEntry('iss') as CatalogEntry;

  const validOmm = () => ({
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    EPOCH: '2026-09-13T04:12:47.894976',
    MEAN_MOTION: 15.49096932,
    ECCENTRICITY: 0.00049173,
    INCLINATION: 51.6307,
    RA_OF_ASC_NODE: 224.6171,
    ARG_OF_PERICENTER: 134.673,
    MEAN_ANOMALY: 225.4659,
    NORAD_CAT_ID: 25544,
    BSTAR: 9.6694874e-5,
    MEAN_MOTION_DOT: 4.898e-5,
    MEAN_MOTION_DDOT: 0,
  });

  it('accepts a real CelesTrak OMM record', () => {
    const v = validateOmm(validOmm(), iss, 'LIVE');
    expect(v).not.toBeNull();
    expect(v!.record.noradId).toBe(25544);
    expect(v!.record.origin).toBe('LIVE');
    expect(v!.record.inclinationDeg).toBeCloseTo(51.6307, 4);
  });

  it('accepts numeric fields sent as strings, as SpaceTrack does', () => {
    const raw = { ...validOmm(), MEAN_MOTION: '15.49096932', INCLINATION: '51.6307' };
    expect(validateOmm(raw, iss, 'LIVE')).not.toBeNull();
  });

  it('rejects a record for the wrong object', () => {
    expect(validateOmm({ ...validOmm(), NORAD_CAT_ID: 12345 }, iss, 'LIVE')).toBeNull();
  });

  it('rejects malformed records one by one', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing epoch', { EPOCH: undefined }],
      ['unparseable epoch', { EPOCH: 'not-a-date' }],
      ['zero mean motion', { MEAN_MOTION: 0 }],
      ['absurd mean motion', { MEAN_MOTION: 999 }],
      ['eccentricity >= 1', { ECCENTRICITY: 1.5 }],
      ['negative eccentricity', { ECCENTRICITY: -0.1 }],
      ['impossible inclination', { INCLINATION: 361 }],
      ['missing bstar', { BSTAR: undefined }],
      ['missing raan', { RA_OF_ASC_NODE: undefined }],
      ['non-numeric mean anomaly', { MEAN_ANOMALY: 'soon' }],
    ];
    for (const [label, patch] of cases) {
      expect(validateOmm({ ...validOmm(), ...patch }, iss, 'LIVE'), label).toBeNull();
    }
  });

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 42, []]) {
      expect(validateOmm(v, iss, 'LIVE')).toBeNull();
    }
  });

  it('marks bundled records as FALLBACK, never as LIVE', () => {
    const v = validateOmm(validOmm(), iss, 'FALLBACK');
    expect(v!.record.origin).toBe('FALLBACK');
  });
});

describe('curated catalogue', () => {
  it('has unique ids and catalogue numbers', () => {
    expect(new Set(CURATED_OBJECTS.map((o) => o.id)).size).toBe(CURATED_OBJECTS.length);
    expect(new Set(CURATED_OBJECTS.map((o) => o.catnr)).size).toBe(CURATED_OBJECTS.length);
  });

  it('includes the ISS at its real catalogue number', () => {
    expect(catalogEntry('iss')?.catnr).toBe(25544);
  });

  it('gives every object a kind and an explanatory blurb', () => {
    for (const o of CURATED_OBJECTS) {
      expect(o.blurb.length, o.id).toBeGreaterThan(20);
      expect(['station', 'cubesat', 'science', 'weather', 'imaging'], o.id).toContain(o.kind);
    }
  });

  it('includes real student CubeSats, not invented ones', () => {
    const cubesats = CURATED_OBJECTS.filter((o) => o.kind === 'cubesat');
    expect(cubesats.length).toBeGreaterThanOrEqual(4);
    expect(cubesats.map((o) => o.catnr)).toContain(35932); // SwissCube
  });
});

describe('the fallback snapshot that ships with the site', () => {
  it('covers every curated object and parses as valid OMM', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile('public/fallback/orbital-data.json', 'utf8');
    const parsed = JSON.parse(raw) as { objects: unknown[]; generated_utc: string };

    expect(Array.isArray(parsed.objects)).toBe(true);
    expect(Date.parse(parsed.generated_utc)).not.toBeNaN();

    const byCatnr = new Map(
      parsed.objects.map((o) => [(o as { NORAD_CAT_ID: number }).NORAD_CAT_ID, o]),
    );
    for (const entry of CURATED_OBJECTS) {
      const record = byCatnr.get(entry.catnr);
      expect(record, `${entry.name} missing from the bundled snapshot`).toBeDefined();
      expect(validateOmm(record, entry, 'FALLBACK'), entry.name).not.toBeNull();
    }
  });
});

/* ========================================================================== */

describe('the two simulators agree', () => {
  it('shares one packet shape between BROWSER-FSW and the C OBC contract', () => {
    // A packet the C OBC would emit, built by hand from its serialiser format.
    const fromC: TelemetryPacket = {
      telemetry_schema_version: 1,
      timestamp: 1_757_940_000.25,
      source: 'ICARUS-OBC',
      satellite: 'ICARUS-1U',
      orbit: { altitude_km: 500, velocity_km_s: 7.6166, inclination_deg: 51.6, period_min: 94.469 },
      attitude: {
        roll_deg: 0.2,
        pitch_deg: -0.4,
        yaw_deg: 3.1,
        angular_velocity_deg_s: [0.01, -0.02, 0.0],
        target_error_deg: 3.13,
      },
      power: { battery_pct: 82.4, solar_w: 8.18, load_w: 5.4 },
      thermal: { temperature_c: 28.4 },
      vibration: { g: 0.012 },
      environment: { eclipse: false },
      fault: { active: false, code: null, message: null },
      state: 'NOMINAL',
    };

    const fromBrowser = new BrowserFsw({ seed: 1, timeScale: 60 }).snapshot().packet;

    expect(Object.keys(fromC).sort()).toEqual(Object.keys(fromBrowser).sort());
    expect(Object.keys(fromC.orbit).sort()).toEqual(Object.keys(fromBrowser.orbit).sort());
    expect(Object.keys(fromC.attitude).sort()).toEqual(Object.keys(fromBrowser.attitude).sort());
    expect(Object.keys(fromC.power).sort()).toEqual(Object.keys(fromBrowser.power).sort());
    expect(Object.keys(fromC.fault).sort()).toEqual(Object.keys(fromBrowser.fault).sort());

    // And the C-shaped packet passes the same validator the WebSocket uses.
    expect(validateTelemetryPacket(JSON.parse(JSON.stringify(fromC))).ok).toBe(true);
  });
});

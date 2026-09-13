/**
 * LOCAL-FSW LINK - WebSocket client for the Python bridge
 * =============================================================================
 * The front-end NEVER waits for this. The scene renders immediately in
 * BROWSER-FSW, this client dials the bridge in the background, and the
 * application switches to LOCAL-FSW only after a *valid* telemetry packet has
 * been received and validated.
 *
 * If local telemetry stops (process killed, cable pulled, packet storm) the
 * client waits STALE_GRACE_MS and then hands authority back to BROWSER-FSW.
 * The telemetry UI is never blanked - the worst case is that it keeps showing
 * the browser simulator with the indicator reading SIMULATED.
 *
 * Reconnection uses capped exponential backoff so a demo laptop with no bridge
 * running does not hammer localhost for an hour.
 */

import { validateTelemetryPacket } from './telemetry.ts';
import type { CommandMessage, TelemetryPacket } from '../state/types.ts';

export interface LocalLinkOptions {
  url: string;
  /** How long without a packet before LOCAL-FSW is considered dead. */
  staleGraceMs?: number;
  onPacket: (packet: TelemetryPacket) => void;
  onStatus: (status: LinkEvent) => void;
}

export type LinkEvent =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'connected' }
  | { kind: 'live' } // first valid packet accepted
  | { kind: 'stale'; sinceMs: number }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'rejected'; reason: string };

const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 15_000;
const DEFAULT_STALE_GRACE_MS = 2500;

export class LocalFswLink {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private lastPacketMs = 0;
  private live = false;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly staleGraceMs: number;

  /** Counters shown in the engineering readout. */
  accepted = 0;
  rejected = 0;

  private readonly opts: LocalLinkOptions;

  constructor(opts: LocalLinkOptions) {
    this.opts = opts;
    this.staleGraceMs = opts.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
  }

  start(): void {
    this.closed = false;
    this.connect();
    this.staleTimer ??= setInterval(() => this.checkStale(), 500);
  }

  stop(): void {
    this.closed = true;
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.live = false;
  }

  /** True while LOCAL-FSW is delivering fresh, valid telemetry. */
  isLive(): boolean {
    return this.live;
  }

  /** Milliseconds since the last accepted packet, or null if there never was one. */
  packetAgeMs(): number | null {
    return this.lastPacketMs === 0 ? null : Date.now() - this.lastPacketMs;
  }

  /**
   * Send a command to the C OBC through the bridge.
   * Returns false when the link is not open - the caller then knows the OBC
   * did NOT receive it and must not pretend otherwise.
   */
  send(cmd: CommandMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(cmd));
      return true;
    } catch (err) {
      console.warn('[link] command send failed', err);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */

  private connect(): void {
    if (this.closed) return;
    this.attempt++;
    this.opts.onStatus({ kind: 'connecting', attempt: this.attempt });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.scheduleRetry(`constructor threw: ${String(err)}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus({ kind: 'connected' });
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(ev.data);
      } catch {
        this.rejected++;
        this.opts.onStatus({ kind: 'rejected', reason: 'not JSON' });
        return;
      }
      // The bridge also sends {type:"status"} frames; only telemetry counts.
      if (typeof decoded === 'object' && decoded !== null && (decoded as { type?: string }).type === 'status') {
        return;
      }
      const result = validateTelemetryPacket(decoded);
      if (!result.ok) {
        this.rejected++;
        this.opts.onStatus({ kind: 'rejected', reason: result.reason });
        return;
      }
      this.accepted++;
      this.lastPacketMs = Date.now();
      if (!this.live) {
        this.live = true;
        this.opts.onStatus({ kind: 'live' });
      }
      this.opts.onPacket(result.packet);
    };

    ws.onerror = () => {
      // onclose always follows; avoid double-reporting.
    };

    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      this.live = false;
      this.scheduleRetry(ev.reason || `socket closed (code ${ev.code})`);
    };
  }

  private scheduleRetry(reason: string): void {
    if (this.closed) return;
    this.opts.onStatus({ kind: 'disconnected', reason });
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.attempt, 4));
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private checkStale(): void {
    if (!this.live) return;
    const age = Date.now() - this.lastPacketMs;
    if (age > this.staleGraceMs) {
      this.live = false;
      this.opts.onStatus({ kind: 'stale', sinceMs: age });
    }
  }
}

/**
 * Default bridge address.
 *
 * Overridable at build time with VITE_BRIDGE_URL, or at run time with
 * ?bridge=ws://host:port for exhibition laptops where the bridge is on
 * another machine. The public GitHub Pages build simply fails to connect,
 * which is the expected and handled case.
 */
export function defaultBridgeUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('bridge');
  if (fromQuery) return fromQuery;
  const fromEnv = import.meta.env.VITE_BRIDGE_URL as string | undefined;
  if (fromEnv) return fromEnv;
  return 'ws://127.0.0.1:8082';
}

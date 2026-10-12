// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fake-websocket.ts — a WebSocket stand-in that replays REAL browser event
 * sequences (plan-541 Phase 0; pattern from `rv-twincat-hmi-interface.test.ts`).
 *
 * What a browser actually shows a page matters more than any server state:
 * - an accepted-then-closed handshake (CONNECT's pairing answers) is
 *   `open` → `close(44xx, reason)` — the page DOES see `open`;
 * - a refused handshake (401/403/404, CONNECT down, LNA denied) is
 *   `error` → `close(1006)` — never `open`, never an HTTP status;
 * - a mixed-content / SecurityError block throws from the CONSTRUCTOR and
 *   fires no event at all.
 *
 * Usage: `const ws = installFakeWebSocket();` in a test (or `beforeEach`), drive
 * `ws.last` with `open()` / `message()` / `serverClose()` / `refuse()`, and
 * `ws.restore()` afterwards. `ws.throwOnConstruct = new DOMException(...)`
 * makes the next constructions throw.
 */

import { vi } from 'vitest';

export interface FakeCloseEvent { code: number; reason: string; wasClean: boolean }

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  /** Every frame the page sent, decoded where it was JSON. */
  readonly sent: unknown[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: FakeCloseEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  readonly send = vi.fn((data: string) => {
    try { this.sent.push(JSON.parse(data)); } catch { this.sent.push(data); }
  });

  /** Page-initiated close: like a browser, no `onclose` reaches a page that nulled it. */
  readonly close = vi.fn(() => { this.readyState = FakeWebSocket.CLOSED; });

  constructor(url: string) {
    this.url = url;
  }

  /** The server accepted the handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  /** A frame from the server (objects are JSON-encoded). */
  message(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  /** The server closed an OPEN socket with this code (e.g. 4401 after accept). */
  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: code !== 1006 });
  }

  /** The handshake failed: what any refusal looks like in a browser. */
  refuse(): void {
    this.onerror?.({});
    this.serverClose(1006);
  }

  /** Types of the frames sent so far (`discover`, `control`, …). */
  sentTypes(): string[] {
    return this.sent.map((f) => (f as { type?: string })?.type ?? '?');
  }
}

export interface FakeWebSocketInstall {
  /** Every socket constructed since install, oldest first. */
  readonly instances: FakeWebSocket[];
  /** The most recently constructed socket (throws if none). */
  readonly last: FakeWebSocket;
  /** When set, constructing a socket throws this instead (counted in `throws`). */
  throwOnConstruct: unknown;
  /** How many constructions threw. */
  readonly throws: number;
  restore(): void;
}

/** Replace `globalThis.WebSocket` with {@link FakeWebSocket} until `restore()`. */
export function installFakeWebSocket(): FakeWebSocketInstall {
  const instances: FakeWebSocket[] = [];
  let throws = 0;
  const state: FakeWebSocketInstall = {
    instances,
    get last(): FakeWebSocket {
      const ws = instances[instances.length - 1];
      if (!ws) throw new Error('no FakeWebSocket constructed yet');
      return ws;
    },
    throwOnConstruct: undefined,
    get throws(): number { return throws; },
    restore: () => { vi.unstubAllGlobals(); },
  };
  class Tracked extends FakeWebSocket {
    constructor(url: string) {
      if (state.throwOnConstruct !== undefined) {
        throws++;
        throw state.throwOnConstruct;
      }
      super(url);
      instances.push(this);
    }
  }
  vi.stubGlobal('WebSocket', Tracked);
  return state;
}

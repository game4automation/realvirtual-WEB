// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-transport.worker — Web Worker entry point for the WebSocket Realtime
 * v2 transport (Plan 235, Phase B4 / F8 / F10).
 *
 * The worker owns the WebSocket connection: handshake, reconnect, heartbeat and
 * incoming coalescing all happen off the render thread. It receives control
 * messages from the main thread (`connect` / `disconnect` / `discover` /
 * `outgoing` / `visible`) and posts back `open` / `closed` / `error` / `delta` /
 * `import_answer` / `import_error` / `model_changed`.
 *
 * The heavy lifting lives in signal-transport-core.ts (SignalTransport), which
 * is environment-free and unit-tested directly. This shell is just the wiring
 * to `self.onmessage` / `self.postMessage`.
 */

import {
  SignalTransport,
  REAL_TIMERS,
  type TransportInboundMessage,
  type TransportOutboundMessage,
  type WebSocketLike,
} from './signal-transport-core';

// Worker global scope.
const ctx = self as unknown as {
  onmessage: ((ev: { data: TransportInboundMessage }) => void) | null;
  postMessage: (msg: TransportOutboundMessage) => void;
};

const transport = new SignalTransport({
  createSocket: (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
  post: (msg) => ctx.postMessage(msg),
  timers: REAL_TIMERS,
});

ctx.onmessage = (ev) => {
  transport.handleInbound(ev.data);
};

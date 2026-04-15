// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebSocketRealtimeInterface — WebSocket Realtime v2 protocol implementation.
 *
 * Connects to the realvirtual WebSocket Realtime server (Unity-side) using
 * the v2 flat-JSON protocol:
 *   1. init    → identify client
 *   2. import_request / import_answer → signal discovery
 *   3. subscribe → request signal updates
 *   4. snapshot  → initial values after subscribe
 *   5. data     → bidirectional delta updates
 *
 * Also used as base class for ctrlX (same protocol, different auth/URL).
 */

import {
  BaseIndustrialInterface,
  parseSignalType,
  defaultValueForType,
  type SignalDescriptor,
} from './base-industrial-interface';
import type { InterfaceSettings } from './interface-settings-store';

// ── Wire protocol types (matching SignalTransportData.cs WsMessage) ──

interface WsMessage {
  type: string;
  version?: number;
  name?: string;
  signals?: Record<string, unknown>;
  signalTypes?: Record<string, string>;
  subscribe?: string[];
  config?: Record<string, unknown>;
  success?: boolean;
  message?: string;
}

export class WebSocketRealtimeInterface extends BaseIndustrialInterface {
  readonly id: string = 'websocket-realtime';
  readonly protocolName: string = 'WebSocket Realtime';

  protected ws: WebSocket | null = null;
  private _importResolve: ((signals: SignalDescriptor[]) => void) | null = null;
  private _importReject: ((err: Error) => void) | null = null;
  private _importTimeout: ReturnType<typeof setTimeout> | null = null;
  private _connectTimeout: ReturnType<typeof setTimeout> | null = null; // Fix 3: track connect timeout

  // ── Protocol Implementation ──

  protected async doConnect(settings: InterfaceSettings): Promise<void> {
    const scheme = settings.wsUseSSL ? 'wss' : 'ws';
    const path = settings.wsPath.startsWith('/') ? settings.wsPath : '/' + settings.wsPath;
    const url = this.buildUrl(scheme, settings.wsAddress, settings.wsPort, path, settings);

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(new Error(`Failed to create WebSocket: ${err}`));
        return;
      }

      // Fix 3: Store timeout handle as instance field for cleanup in doDisconnect
      this._connectTimeout = setTimeout(() => {
        this._connectTimeout = null;
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          reject(new Error(`Connection to ${url} timed out (5s)`));
        }
      }, 5000);

      this.ws.onopen = () => {
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        // Send init message
        this.wsSend({ type: 'init', version: 2, name: 'WebViewer' });
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = (event) => {
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        if (this.isConnected) {
          this.onConnectionLost(event.reason || `WebSocket closed (code ${event.code})`);
        }
      };

      this.ws.onerror = () => {
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        // onclose will also fire — error handling happens there
      };
    });
  }

  protected doDisconnect(): void {
    // Fix 3: Clear connect timeout if still pending
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
    }
    this.clearImportPromise();
    if (this.ws) {
      // Prevent onclose from triggering reconnect
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }
  }

  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    return new Promise<SignalDescriptor[]>((resolve, reject) => {
      this._importResolve = resolve;
      this._importReject = reject;

      // Timeout for discovery — null out _importReject first so clearImportPromise
      // doesn't reject with 'Discovery cancelled' before our explicit timeout error
      this._importTimeout = setTimeout(() => {
        this._importReject = null;
        this.clearImportPromise();
        reject(new Error('Signal discovery timed out (10s)'));
      }, 10_000);

      // Send import request
      this.wsSend({ type: 'import_request', version: 2 });
    });
  }

  protected sendSignals(signals: Record<string, boolean | number>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.wsSend({ type: 'data', version: 2, signals: signals as Record<string, unknown> });
  }

  // ── Message Handling ──

  private handleMessage(raw: string): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      this.onProtocolError(`Invalid JSON: ${raw.substring(0, 100)}`);
      return;
    }

    switch (msg.type) {
      case 'import_answer':
        this.handleImportAnswer(msg);
        break;

      case 'snapshot':
      case 'data':
        this.handleData(msg);
        break;

      case 'config_answer':
      case 'config_result':
        // Config messages — not used in WebViewer currently
        break;

      default:
        // Unknown message type — ignore silently
        break;
    }
  }

  private handleImportAnswer(msg: WsMessage): void {
    if (!this._importResolve) return;

    const signals: SignalDescriptor[] = [];
    const values = msg.signals ?? {};
    const types = msg.signalTypes ?? {};

    for (const name in values) {
      const plcType = types[name] ?? 'PLCInputFloat';
      const { type, direction } = parseSignalType(plcType);
      const rawValue = values[name];

      let initialValue: boolean | number;
      if (typeof rawValue === 'boolean') {
        initialValue = rawValue;
      } else if (typeof rawValue === 'number') {
        initialValue = rawValue;
      } else {
        initialValue = defaultValueForType(type);
      }

      signals.push({ name, type, direction, initialValue });
    }

    // Resolve the discovery promise — null out reject first to prevent
    // clearImportPromise from rejecting a successfully resolved discovery
    const resolve = this._importResolve;
    this._importReject = null;
    this.clearImportPromise();
    resolve(signals);

    // Subscribe to all signals
    const allNames = signals.map(s => s.name);
    this.wsSend({ type: 'subscribe', version: 2, subscribe: allNames });
  }

  private handleData(msg: WsMessage): void {
    if (!msg.signals) return;

    const incoming: Record<string, boolean | number> = {};
    for (const name in msg.signals) {
      const value = msg.signals[name];
      if (typeof value === 'boolean' || typeof value === 'number') {
        incoming[name] = value;
      } else if (typeof value === 'string') {
        // Parse string values from some protocols
        if (value === 'true' || value === 'True') incoming[name] = true;
        else if (value === 'false' || value === 'False') incoming[name] = false;
        else {
          const num = Number(value);
          if (!isNaN(num)) incoming[name] = num;
        }
      }
    }

    if (Object.keys(incoming).length > 0) {
      this.bufferIncoming(incoming);
    }
  }

  // ── Helpers ──

  /**
   * Build the WebSocket URL. Override in subclasses for custom URL schemes.
   */
  protected buildUrl(
    scheme: string,
    address: string,
    port: number,
    path: string,
    _settings: InterfaceSettings,
  ): string {
    return `${scheme}://${address}:${port}${path}`;
  }

  /** Send a JSON message over the WebSocket. */
  protected wsSend(msg: WsMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private clearImportPromise(): void {
    if (this._importTimeout) {
      clearTimeout(this._importTimeout);
      this._importTimeout = null;
    }
    // Fix 5: Reject any pending discovery promise before clearing
    if (this._importReject) {
      this._importReject(new Error('Discovery cancelled'));
    }
    this._importResolve = null;
    this._importReject = null;
  }
}

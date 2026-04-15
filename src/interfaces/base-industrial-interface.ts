// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BaseIndustrialInterface — Abstract base class for all industrial protocol plugins.
 *
 * Provides the common buffer-flush pattern for bidirectional signal exchange:
 *   - Incoming signals (PLC → Viewer) are buffered in `pendingIncoming` and
 *     flushed to `SignalStore.setMany()` in `onFixedUpdatePre` (synchronous
 *     with drive physics, max 60Hz).
 *   - Outgoing signals (Viewer → PLC) are collected from `dirtyOutgoing` and
 *     sent via the protocol-specific `sendSignals()` in `onFixedUpdatePost`.
 *
 * Subclasses implement the actual protocol (WebSocket Realtime, MQTT, KEBA, etc.)
 * by overriding the abstract methods.
 *
 * Usage:
 *   class MyInterface extends BaseIndustrialInterface {
 *     readonly id = 'my-interface';
 *     readonly protocolName = 'My Protocol';
 *     async doConnect(settings) { ... }
 *     doDisconnect() { ... }
 *     sendSignals(signals) { ... }
 *   }
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { SignalStore } from '../core/engine/rv-signal-store';
import type { InterfaceSettings } from './interface-settings-store';
import { debug } from '../core/engine/rv-debug';

// ── Public Types ─────────────────────────────────────────────────────────

/** Signal direction from the PLC's perspective. */
export type SignalDirection = 'input' | 'output';

/** Signal type matching Unity PLC signal types. */
export type SignalType = 'bool' | 'int' | 'float';

/** Describes a single discovered signal. */
export interface SignalDescriptor {
  /** Signal name (key in SignalStore). */
  name: string;
  /** Data type. */
  type: SignalType;
  /** Direction: 'input' = PLC writes (Viewer reads), 'output' = Viewer writes (PLC reads). */
  direction: SignalDirection;
  /** Initial value at discovery time. */
  initialValue: boolean | number;
}

/** Connection state of an interface. */
export type InterfaceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Event payload emitted on state changes. */
export interface InterfaceStateChange {
  interfaceId: string;
  state: InterfaceConnectionState;
  error?: string;
}

// ── Reconnect Constants ──────────────────────────────────────────────────

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 2.0;

// ── Abstract Base Class ──────────────────────────────────────────────────

export abstract class BaseIndustrialInterface implements RVViewerPlugin {
  /** Unique plugin ID (e.g. 'websocket-realtime', 'mqtt'). */
  abstract readonly id: string;

  /** Human-readable protocol name for UI display. */
  abstract readonly protocolName: string;

  /** Sort order — interface plugins run early to provide signal values before drive physics. */
  readonly order = 10;

  // ── State ──

  protected viewer: RVViewer | null = null;
  protected signalStore: SignalStore | null = null;
  private _connectionState: InterfaceConnectionState = 'disconnected';
  private _discoveredSignals: SignalDescriptor[] = [];
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempt = 0;
  private _settings: InterfaceSettings | null = null;
  private _outgoingSubscriptions: (() => void)[] = [];

  // ── Incoming buffer (WS callback → Map → flush in onFixedUpdatePre) ──

  /**
   * Buffer for incoming signal updates received from the protocol callback.
   * Written asynchronously from WebSocket/MQTT onMessage handlers.
   * Flushed synchronously in onFixedUpdatePre.
   * Map ensures automatic dedup — last value wins if multiple updates
   * arrive between two ticks.
   */
  protected readonly pendingIncoming = new Map<string, boolean | number>();

  /**
   * Buffer for outgoing signal values that have changed in the Viewer.
   * Populated by SignalStore subscriptions on output signals.
   * Drained and sent via sendSignals() in onFixedUpdatePost.
   */
  protected readonly dirtyOutgoing = new Map<string, boolean | number>();

  // ── Public Getters ──

  get connectionState(): InterfaceConnectionState { return this._connectionState; }
  get discoveredSignals(): ReadonlyArray<SignalDescriptor> { return this._discoveredSignals; }
  get isConnected(): boolean { return this._connectionState === 'connected'; }

  // ── Abstract Methods (protocol-specific) ──

  /**
   * Establish the protocol connection.
   * Called by `connect()` after state transitions.
   * Must resolve when the connection is established (or reject on failure).
   */
  protected abstract doConnect(settings: InterfaceSettings): Promise<void>;

  /**
   * Tear down the protocol connection.
   * Called by `disconnect()`. Must be synchronous and idempotent.
   */
  protected abstract doDisconnect(): void;

  /**
   * Send outgoing signal values to the PLC/controller.
   * Called from `onFixedUpdatePost` with all signals that changed since last tick.
   * @param signals Map of signal name → new value
   */
  protected abstract sendSignals(signals: Record<string, boolean | number>): void;

  /**
   * Request signal discovery from the remote endpoint.
   * Called after successful connection. Must resolve with the list of available signals.
   * For WebSocket Realtime this sends `import_request` and waits for `import_answer`.
   * For MQTT this subscribes to wildcard and waits for retained messages.
   */
  protected abstract doDiscoverSignals(): Promise<SignalDescriptor[]>;

  // ── RVViewerPlugin Lifecycle ──

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.signalStore = viewer.signalStore ?? null;

    // Auto-connect if settings say so and we're not already connected
    if (this._settings?.autoConnect && this._connectionState === 'disconnected') {
      this.connect(this._settings).catch(() => {});
    }
  }

  onModelCleared(): void {
    // Don't disconnect on model clear — interface connection is independent
  }

  /**
   * Flush incoming buffer → SignalStore (synchronous with drive physics).
   * Called at 60Hz BEFORE drive physics computation.
   */
  onFixedUpdatePre(_dt: number): void {
    if (this.pendingIncoming.size === 0 || !this.signalStore) return;

    const batch: Record<string, boolean | number> = {};
    for (const [name, value] of this.pendingIncoming) {
      batch[name] = value;
    }
    this.pendingIncoming.clear();
    this.signalStore.setMany(batch);
  }

  /**
   * Collect dirty outgoing signals and send them.
   * Called at 60Hz AFTER drive physics + transport.
   */
  onFixedUpdatePost(_dt: number): void {
    if (this.dirtyOutgoing.size === 0 || !this.isConnected) return;

    const outgoing: Record<string, boolean | number> = {};
    for (const [name, value] of this.dirtyOutgoing) {
      outgoing[name] = value;
    }
    this.dirtyOutgoing.clear();

    try {
      this.sendSignals(outgoing);
    } catch (err) {
      console.warn(`[${this.id}] sendSignals error:`, err);
    }
  }

  dispose(): void {
    this.disconnect();
    this.viewer = null;
    this.signalStore = null;
  }

  // ── Public API ──

  /**
   * Connect to the remote endpoint with the given settings.
   * Handles state transitions, discovery, and reconnect setup.
   */
  async connect(settings: InterfaceSettings): Promise<void> {
    this._settings = settings;
    this._reconnectAttempt = 0;
    this.cancelReconnect();

    this.setConnectionState('connecting');

    try {
      await this.doConnect(settings);
      this.setConnectionState('connected');

      // Run signal discovery
      try {
        const signals = await this.doDiscoverSignals();
        this._discoveredSignals = signals;
        this.registerDiscoveredSignals(signals);
        this.subscribeToOutputSignals(signals);
      } catch (discErr) {
        console.warn(`[${this.id}] Signal discovery failed:`, discErr);
        // Connection succeeded even if discovery failed — user can retry
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.setConnectionState('error', errorMsg);
      this.scheduleReconnect();
      throw err;
    }
  }

  /** Disconnect and stop reconnect attempts. */
  disconnect(): void {
    // Fix 4: Set state first — prevents onConnectionLost from triggering reconnect
    this._connectionState = 'disconnected'; // direct assignment, skip event for now

    this.unsubscribeFromOutputSignals();
    this.pendingIncoming.clear();
    this.dirtyOutgoing.clear();
    this._discoveredSignals = [];

    try {
      this.doDisconnect();
    } catch (err) {
      console.warn(`[${this.id}] doDisconnect error:`, err);
    }

    this.cancelReconnect(); // AFTER doDisconnect — catches any timer set during close
    this.setConnectionState('disconnected'); // emit events now (no-op if already disconnected)
  }

  /**
   * Re-run signal discovery without reconnecting.
   * Useful when the PLC program has changed.
   */
  async rediscover(): Promise<SignalDescriptor[]> {
    if (!this.isConnected) {
      throw new Error(`Cannot discover signals: ${this.id} is not connected`);
    }

    this.unsubscribeFromOutputSignals();
    const signals = await this.doDiscoverSignals();
    this._discoveredSignals = signals;
    this.registerDiscoveredSignals(signals);
    this.subscribeToOutputSignals(signals);
    return signals;
  }

  // ── Helpers for Subclasses ──

  /**
   * Called by subclass protocol handlers when incoming data arrives.
   * Writes to the pendingIncoming buffer — NOT directly to SignalStore.
   * Safe to call from async callbacks (WebSocket.onmessage, MQTT.on('message')).
   */
  protected bufferIncoming(signals: Record<string, boolean | number>): void {
    for (const name in signals) {
      this.pendingIncoming.set(name, signals[name]);
    }
    // Also emit interface-data event for plugins that want raw data
    this.viewer?.emit('interface-data', {
      interfaceId: this.id,
      signals,
    });
  }

  /**
   * Called by subclass when the protocol connection is lost unexpectedly.
   * Triggers state change and schedules reconnect.
   */
  protected onConnectionLost(reason?: string): void {
    if (this._connectionState === 'disconnected') return; // Already handled
    this.setConnectionState('disconnected');
    this.viewer?.emit('interface-disconnected', {
      interfaceId: this.id,
      reason: reason ?? 'Connection lost',
    });
    this.scheduleReconnect();
  }

  /**
   * Called by subclass when a protocol-level error occurs.
   */
  protected onProtocolError(error: string): void {
    console.error(`[${this.id}] Protocol error: ${error}`);
    this.viewer?.emit('interface-error', {
      interfaceId: this.id,
      error,
    });
  }

  /**
   * Calculate reconnect delay with exponential backoff.
   * @param attempt Zero-based attempt number
   * @returns Delay in milliseconds (capped at RECONNECT_MAX_MS)
   */
  getReconnectDelay(attempt: number): number {
    const delay = RECONNECT_INITIAL_MS * Math.pow(RECONNECT_FACTOR, attempt);
    return Math.min(delay, RECONNECT_MAX_MS);
  }

  // ── Internal Helpers ──

  private setConnectionState(state: InterfaceConnectionState, error?: string): void {
    const previous = this._connectionState;
    if (previous === state) return;

    this._connectionState = state;

    // Update viewer's global connection state
    if (state === 'connected') {
      this.viewer?.setConnectionState?.('Connected');
      this.viewer?.emit('interface-connected', {
        interfaceId: this.id,
        type: this.protocolName,
      });
    } else if (state === 'disconnected' && previous === 'connected') {
      this.viewer?.setConnectionState?.('Disconnected');
    }

    if (state === 'error' && error) {
      this.viewer?.emit('interface-error', {
        interfaceId: this.id,
        error,
      });
    }
  }

  /** Register discovered signals in the SignalStore. */
  private registerDiscoveredSignals(signals: SignalDescriptor[]): void {
    if (!this.signalStore) return;

    for (const sig of signals) {
      // Fix 6: Use prefixed path to avoid collision with GLB model paths
      this.signalStore.register(sig.name, `__iface__/${sig.name}`, sig.initialValue);
    }
    debug('interface', `[${this.id}] Registered ${signals.length} signals in SignalStore`);
  }

  /**
   * Subscribe to output signals (Viewer → PLC) in the SignalStore.
   * When a UI element or logic changes an output signal, it gets queued
   * in dirtyOutgoing for the next onFixedUpdatePost cycle.
   */
  private subscribeToOutputSignals(signals: SignalDescriptor[]): void {
    this.unsubscribeFromOutputSignals();
    if (!this.signalStore) return; // Fix 1: null guard

    for (const sig of signals) {
      if (sig.direction !== 'output') continue;

      const unsub = this.signalStore.subscribe(sig.name, (value) => {
        // Fix 7: Don't echo back values we just received from the remote
        if (this.pendingIncoming.has(sig.name)) return;
        this.dirtyOutgoing.set(sig.name, value);
      });
      this._outgoingSubscriptions.push(unsub);
    }
  }

  private unsubscribeFromOutputSignals(): void {
    for (const unsub of this._outgoingSubscriptions) unsub();
    this._outgoingSubscriptions = [];
  }

  private scheduleReconnect(): void {
    if (!this._settings?.autoConnect) return;
    this.cancelReconnect();

    const delay = this.getReconnectDelay(this._reconnectAttempt);
    this._reconnectAttempt++;

    debug('interface', `[${this.id}] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);

    this._reconnectTimer = setTimeout(async () => {
      if (this._connectionState !== 'disconnected' && this._connectionState !== 'error') return;
      try {
        await this.connect(this._settings!);
      } catch {
        // connect() already calls scheduleReconnect on failure
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

// ── Utility: Parse signal type string from C# ───────────────────────────

/**
 * Converts a C# PLC signal type string to SignalDescriptor fields.
 * @param plcType e.g. "PLCInputBool", "PLCOutputFloat", "PLCInputInt"
 */
export function parseSignalType(plcType: string): { type: SignalType; direction: SignalDirection } {
  const lower = plcType.toLowerCase();

  const direction: SignalDirection = lower.includes('output') ? 'output' : 'input';

  let type: SignalType = 'float';
  if (lower.includes('bool')) type = 'bool';
  else if (lower.includes('int')) type = 'int';

  return { type, direction };
}

/**
 * Returns the appropriate default value for a signal type.
 */
export function defaultValueForType(type: SignalType): boolean | number {
  return type === 'bool' ? false : 0;
}

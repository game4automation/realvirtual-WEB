// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DebugEndpointPlugin — Bidirectional debug bridge between browser and Claude Code.
 *
 * READ (browser → Vite → Claude Code):
 *   - State snapshots every ~1s (drives, signals, sensors, logic, transport)
 *   - Browser console errors/warnings
 *   - Signal change log with timestamps
 *   - Connection state transition history
 *
 * WRITE (Claude Code → Vite → browser):
 *   - setSignal / setSignals — write PLC signal values
 *   - jogDrive / stopDrive / moveDrive — control drives
 *   - setRenderBackend — switch Three/Omniverse for integration diagnostics
 *
 * Endpoints:
 *   GET  /__api/debug              Full snapshot
 *   GET  /__api/debug/signals      All signals (or ?names=A,B for filter)
 *   GET  /__api/debug/drives       Drive states
 *   GET  /__api/debug/errors       Browser console errors/warnings
 *   GET  /__api/debug/changelog    Recent signal changes
 *   GET  /__api/debug/stateHistory Connection state transitions
 *   GET  /__api/debug/logs         Structured log buffer (filterable: ?level=warn&category=signal&limit=20)
 *   POST /__api/debug/cmd          Push command (setSignal, jogDrive, etc.)
 *
 * Dev-mode only — not included in production builds.
 */

import { RVBehavior } from '../core/rv-behavior';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVLogicStep } from '../core/engine/rv-logic-step';
import { getLastLogs } from '../core/engine/rv-debug';

/** Serialize any object's own enumerable properties (primitives + shallow objects). */
function serializeProps(obj: unknown, maxDepth = 2): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue; // skip private-by-convention
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined || val === null) { result[key] = val; continue; }
    if (typeof val === 'function') continue;
    if (typeof val === 'number') { result[key] = +val.toFixed(4); continue; }
    if (typeof val === 'boolean' || typeof val === 'string') { result[key] = val; continue; }
    if (Array.isArray(val)) continue; // skip arrays (children, etc.) to avoid bloat
    if (typeof val === 'object') {
      if (maxDepth > 0) result[key] = serializeProps(val, maxDepth - 1);
      continue;
    }
  }
  return result;
}

// ── Console-argument serialization (crash-safe) ──

/** Max characters kept per serialized console argument. */
const MAX_ARG_LEN = 2000;
/** Max characters kept for one buffered console message (all args joined). */
const MAX_MESSAGE_LEN = 8000;

/**
 * Serialize ONE console.error/warn argument for the error buffer. MUST NEVER
 * THROW — this runs inside the console monkey-patch, and an exception here
 * would swallow the ORIGINAL error and replace it with a serialization error
 * (seen live: `JSON.stringify` on a Three.js BufferGeometry walked
 * `BufferAttribute.toJSON` → `Array.from` over a typed array whose
 * ArrayBuffer was detached (worker transfer / disposed WASM heap) → TypeError
 * "Cannot perform %TypedArray%.prototype.values on a detached ArrayBuffer").
 *
 * Three.js objects (BufferGeometry / BufferAttribute / Object3D / Material)
 * are therefore NEVER JSON-serialized — they render as a short tag like
 * `[BufferGeometry name=Belt uuid=…]`. Anything else falls back through
 * try/catch chains: JSON.stringify → String(arg) → '[unserializable]'.
 *
 * Exported for tests.
 */
export function serializeConsoleArg(arg: unknown): string {
  try {
    if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
    if (arg === null || typeof arg !== 'object') return String(arg).slice(0, MAX_ARG_LEN);

    // Three.js objects: identify via their `is*` marker flags (stable public
    // API). Their toJSON walks geometry buffers — potentially megabytes, and
    // it THROWS on detached ArrayBuffers. Short tag instead.
    const o = arg as {
      isBufferGeometry?: boolean; isBufferAttribute?: boolean;
      isInterleavedBufferAttribute?: boolean; isObject3D?: boolean;
      isMaterial?: boolean; isTexture?: boolean;
      type?: unknown; name?: unknown; uuid?: unknown;
    };
    if (
      o.isBufferGeometry || o.isBufferAttribute || o.isInterleavedBufferAttribute ||
      o.isObject3D || o.isMaterial || o.isTexture
    ) {
      const kind =
        o.isBufferGeometry ? 'BufferGeometry' :
        (o.isBufferAttribute || o.isInterleavedBufferAttribute) ? 'BufferAttribute' :
        o.isObject3D ? 'Object3D' :
        o.isMaterial ? 'Material' : 'Texture';
      const type = typeof o.type === 'string' && o.type !== kind ? ` type=${o.type}` : '';
      const name = typeof o.name === 'string' && o.name ? ` name=${o.name}` : '';
      const uuid = typeof o.uuid === 'string' ? ` uuid=${o.uuid}` : '';
      return `[${kind}${type}${name}${uuid}]`;
    }

    // Plain data: JSON — throws on cycles, BigInt, throwing toJSON/getters.
    const json = JSON.stringify(arg);
    return (json ?? String(arg)).slice(0, MAX_ARG_LEN);
  } catch {
    try {
      return String(arg).slice(0, MAX_ARG_LEN);
    } catch {
      return '[unserializable]';
    }
  }
}

// ── Types ──

interface DebugCommand {
  id: number;
  cmd: string;
  [k: string]: unknown;
}

interface ErrorEntry {
  level: 'error' | 'warning';
  message: string;
  timestamp: number;
  stack?: string;
}

interface ChangelogEntry {
  name: string;
  from: boolean | number | undefined;
  to: boolean | number;
  time: number;
}

interface StateHistoryEntry {
  state: string;
  timestamp: number;
  elapsed: number;
}

// ── Plugin ──

export class DebugEndpointPlugin extends RVBehavior {
  readonly id = 'debug-endpoint';
  readonly order = 999;
  private readonly _debugSessionId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  private _lastPush = 0;
  private _lastPoll = 0;
  private _pushInterval = 1000;  // ms between snapshot pushes
  private _pollInterval = 500;   // ms between command polls

  // Error capture
  private _errors: ErrorEntry[] = [];
  private _origError: typeof console.error | null = null;
  private _origWarn: typeof console.warn | null = null;
  private static readonly MAX_ERRORS = 50;

  // Signal changelog
  private _changelog: ChangelogEntry[] = [];
  private static readonly MAX_CHANGELOG = 200;

  // Connection state history
  private _stateHistory: StateHistoryEntry[] = [];
  private static readonly MAX_STATE_HISTORY = 100;
  private _stateTrackingOff?: () => void;
  private _pushInFlight = false;
  private _tickTimer: ReturnType<typeof setInterval> | null = null;

  // Console monkey-patch guard — prevents double-patching on model reload
  private _intercepted = false;

  // ── Lifecycle ──

  protected onStart(_result: LoadResult): void {
    this._lastPush = 0;
    this._lastPoll = 0;
    this._errors = [];
    this._changelog = [];
    this._stateHistory = [{ state: 'started', timestamp: Date.now(), elapsed: 0 }];

    this._setupErrorCapture();
    this._setupSignalChangelog();
    this._setupStateTracking();
    // Non-Three backends deliberately pause plugin onRender callbacks. Keep
    // diagnostics and command polling alive so Omniverse can still be observed
    // and switched back through the debug endpoint.
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._tick(), 250);
  }

  protected onDestroy(): void {
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = null;
    this._restoreConsole();
    this._stateTrackingOff?.();
    this._stateTrackingOff = undefined;
  }

  onRender(_frameDt: number): void {
    this._tick();
  }

  private _tick(): void {
    const now = performance.now();

    // Push snapshot at 1Hz (skip if previous push still in-flight)
    if (now - this._lastPush >= this._pushInterval && !this._pushInFlight) {
      this._lastPush = now;
      const snapshot = this._collectState();
      this._pushInFlight = true;
      fetch('/__api/debug/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      }).catch(() => {}).finally(() => { this._pushInFlight = false; });
    }

    // Poll commands at 2Hz
    if (now - this._lastPoll >= this._pollInterval) {
      this._lastPoll = now;
      this._pollCommands();
    }
  }

  // ── Error Capture ──

  private _setupErrorCapture(): void {
    if (this._intercepted) return;
    this._origError = console.error;
    this._origWarn = console.warn;

    // Buffering must NEVER prevent the original console call — a throwing
    // _bufferError would swallow the actual error (belt and braces on top of
    // the per-argument try/catch in serializeConsoleArg).
    console.error = (...args: unknown[]) => {
      try { this._bufferError('error', args); } catch { /* never block the original */ }
      this._origError!.apply(console, args);
    };

    console.warn = (...args: unknown[]) => {
      try { this._bufferError('warning', args); } catch { /* never block the original */ }
      this._origWarn!.apply(console, args);
    };

    this._intercepted = true;
    this.addCleanup(() => this._restoreConsole());
  }

  private _bufferError(level: 'error' | 'warning', args: unknown[]): void {
    // Per-argument crash-safe serialization (see serializeConsoleArg) + a
    // total length cap so one geometry dump can't bloat every 1 Hz snapshot.
    const message = args.map(serializeConsoleArg).join(' ').slice(0, MAX_MESSAGE_LEN);

    this._errors.push({
      level,
      message,
      timestamp: Date.now(),
      stack: new Error().stack?.split('\n').slice(3, 6).join('\n'),
    });
    if (this._errors.length > DebugEndpointPlugin.MAX_ERRORS) this._errors.shift();
  }

  private _restoreConsole(): void {
    if (this._origError) { console.error = this._origError; this._origError = null; }
    if (this._origWarn) { console.warn = this._origWarn; this._origWarn = null; }
    this._intercepted = false;
  }

  // ── Signal Changelog ──

  private _setupSignalChangelog(): void {
    const store = this.signals;
    if (!store) return;

    for (const [name, value] of store.getAll()) {
      let prev: boolean | number | undefined = value;
      this.onSignalChanged(name, (newValue) => {
        this._changelog.push({
          name,
          from: prev,
          to: newValue,
          time: +this.elapsed.toFixed(3),
        });
        if (this._changelog.length > DebugEndpointPlugin.MAX_CHANGELOG) this._changelog.shift();
        prev = newValue;
      });
    }
  }

  // ── Connection State Tracking ──

  private _setupStateTracking(): void {
    if (!this.viewer) return;

    this._stateTrackingOff = this.viewer.on('connection-state-changed', ({ state }) => {
      this._stateHistory.push({
        state,
        timestamp: Date.now(),
        elapsed: +this.elapsed.toFixed(2),
      });
      if (this._stateHistory.length > DebugEndpointPlugin.MAX_STATE_HISTORY) {
        this._stateHistory.shift();
      }
    });
  }

  // ── Command Polling ──

  private _pollCommands(): void {
    fetch('/__api/debug/cmd/poll')
      .then(r => r.json())
      .then((data: { commands: DebugCommand[] }) => {
        for (const cmd of data.commands) {
          void this._executeCommand(cmd);
        }
      })
      .catch(() => {});
  }

  private async _executeCommand(cmd: DebugCommand): Promise<void> {
    let success = true;
    let error: string | undefined;

    try {
      switch (cmd.cmd) {
        case 'setSignal': {
          const name = cmd.name as string;
          const value = cmd.value as boolean | number;
          this.signalWriter?.set(name, value);
          break;
        }
        case 'setSignals': {
          const signals = cmd.signals as Record<string, boolean | number>;
          this.signalWriter?.setMany(signals);
          break;
        }
        case 'jogDrive': {
          const drive = this.drives.find(d => d.name === cmd.name);
          if (!drive) { success = false; error = `Drive "${cmd.name}" not found`; break; }
          const forward = cmd.forward !== false;
          drive.jogForward = forward;
          drive.jogBackward = !forward;
          break;
        }
        case 'stopDrive': {
          const drive = this.drives.find(d => d.name === cmd.name);
          if (!drive) { success = false; error = `Drive "${cmd.name}" not found`; break; }
          drive.jogForward = false;
          drive.jogBackward = false;
          drive.stop();
          break;
        }
        case 'moveDrive': {
          const drive = this.drives.find(d => d.name === cmd.name);
          if (!drive) { success = false; error = `Drive "${cmd.name}" not found`; break; }
          drive.startMove(cmd.position as number);
          break;
        }
        case 'setRenderBackend': {
          const backend = cmd.backend;
          if (backend !== 'three' && backend !== 'omniverse') {
            success = false;
            error = `Invalid render backend: ${String(backend)}`;
            break;
          }
          if (!this.viewer) {
            success = false;
            error = 'Viewer not available';
            break;
          }
          await this.viewer.setRenderBackend(backend);
          break;
        }
        default:
          success = false;
          error = `Unknown command: ${cmd.cmd}`;
      }
    } catch (e) {
      success = false;
      error = String(e);
    }

    // Report result back
    fetch('/__api/debug/cmd/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cmd.id, success, error }),
    }).catch(() => {});
  }

  // ── State Collection ──

  private _collectState() {
    return {
      debugSessionId: this._debugSessionId,
      timestamp: Date.now(),
      fps: this.viewer?.currentFps ?? 0,
      elapsed: +this.elapsed.toFixed(2),
      connectionState: this.viewer?.connectionState ?? 'unknown',
      renderBackend: {
        id: this.viewer?.renderBackend ?? 'three',
        status: this.viewer?.renderBackendStatus ?? 'idle',
        detail: this.viewer?.renderBackendStatusDetail ?? '',
      },
      selection: {
        primaryPath: this.viewer?.selectionManager.primaryPath ?? null,
        selectedPaths: [...(this.viewer?.selectionManager.selectedPaths ?? [])],
      },
      scene: {
        model: this.viewer?.currentModelUrl ?? null,
        driveCount: this.drives.length,
        sensorCount: this.sensors.length,
        signalCount: this.signals?.size ?? 0,
      },
      drives: this.drives.map(d => ({
        name: d.name,
        ...serializeProps(d),
        direction: d.Direction,
      })),
      sensors: this.sensors.map(s => ({
        name: s.node.name,
        ...serializeProps(s),
      })),
      signals: Object.fromEntries(this.signals?.getAll() ?? []),
      logic: this._collectLogic(),
      transport: {
        spawned: this.transportManager?.totalSpawned ?? 0,
        consumed: this.transportManager?.totalConsumed ?? 0,
        activeMUs: this.transportManager?.mus.length ?? 0,
        mus: this.transportManager?.mus.map(mu => ({
          name: mu.getName(),
          ...serializeProps(mu),
        })) ?? [],
      },
      playback: this._collectPlayback(),
      logs: getLastLogs(100),
      errors: this._errors,
      changelog: this._changelog,
      stateHistory: this._stateHistory,
    };
  }

  private _collectPlayback() {
    const pb = this.playback;
    if (!pb) return null;
    return {
      isPlaying: pb.isPlaying,
      frame: pb.frame,
      totalFrames: pb.totalFrames,
      progress: +(pb.progress * 100).toFixed(1),
      loop: pb.loop,
      sequences: pb.sequences,
    };
  }

  private _collectLogic() {
    const engine = this.viewer?.logicEngine;
    if (!engine) return null;

    const mapStep = (step: RVLogicStep): object => {
      const props = serializeProps(step, 1);
      const base: Record<string, unknown> = {
        name: step.name,
        type: step.constructor.name,
        state: step.state,
        ...props,
      };
      if ('children' in step) {
        base.children = (step as { children: RVLogicStep[] }).children.map(mapStep);
      }
      return base;
    };

    return {
      stats: engine.stats,
      roots: engine.roots.map(mapStep),
    };
  }
}

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
import { getDiagnosticsEntries } from '../core/diagnostics/rv-diagnostics-collector';
export { serializeConsoleArg } from '../core/diagnostics/rv-diagnostics-collector';

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

/** Max characters kept for one buffered console message (all args joined). */

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

  // ── Lifecycle ──

  protected onStart(_result: LoadResult): void {
    this._lastPush = 0;
    this._lastPoll = 0;
    this._changelog = [];
    this._stateHistory = [{ state: 'started', timestamp: Date.now(), elapsed: 0 }];

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
        case 'emitEvent': {
          if (!this.viewer) { success = false; error = 'Viewer not available'; break; }
          const eventName = cmd.event as string;
          if (!eventName) { success = false; error = 'emitEvent needs "event"'; break; }
          this.viewer.emit(eventName as never, cmd.payload as never);
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
      errors: getDiagnosticsEntries().filter(e => e.cat === 'console').slice(-50).map((e): ErrorEntry => ({
        level: e.lvl === 'warn' ? 'warning' : 'error',
        message: e.msg,
        timestamp: Date.parse(e.t),
        stack: e.stack,
      })),
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

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-runtime-tools — MCP tools for the RUNNING model: drives, signals,
 * sensors, material flow, LogicStep sequences and the simulation clock.
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * rv-mcp-tools.ts). Split out of the plugin by plan-713 Phase 1, which was a
 * pure code move: every announced name, description, schema, `readOnly`
 * classification and timeout is unchanged, and `rv-mcp-delegate-split.test.ts`
 * proves it against the baseline frozen before the move.
 *
 * The dividing line against the other delegates: this file answers "what is the
 * machine DOING right now" — live values that change on their own. Structure
 * (`web_node_*`, `web_component_*`) and the planner live in
 * `rv-mcp-scene-tools.ts`; the discrete-event and virtual-PLC subsystems in
 * `rv-mcp-desplc-tools.ts`.
 *
 * The convenience getters below reproduce `RVBehavior`'s — the tools used to be
 * methods ON the plugin and read `this.drives` / `this.signals` and friends. The
 * signal writer in particular keeps the plugin's identity (`'mcp-bridge'`, which
 * `pluginSignalWriterKind` maps to the `'mcp'` write origin), so a signal
 * written by a tool is still attributed to the bridge in the signal UI.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { RVSensor } from '../../core/engine/rv-sensor';
import type { RVTransportManager } from '../../core/engine/rv-transport-manager';
import type { RVLogicStep } from '../../core/engine/rv-logic-step';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from '../../core/engine/rv-signal-store';
import { pluginSignalWriterKind } from '../../core/rv-plugin-context';
import { getDriveSpeedOverride, setDriveSpeedOverride } from '../../core/engine/rv-speed-override';
import { getViewerMode } from '../../core/hmi/connect-store';
import { physicsDiagnostics } from '../../core/engine/rv-physics-registry';
import { serializeProps } from './rv-mcp-serialize';

/** Plugin id the written signals are attributed to — unchanged from the plugin. */
const WRITER_ID = 'mcp-bridge';

export class McpRuntimeTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private _writerStore: SignalStore | null = null;
  private _writer: SignalWriter | null = null;

  private get viewer(): RVViewer | undefined { return this.getViewer(); }
  private get drives(): RVDrive[] { return this.viewer?.drives ?? []; }
  private get sensors(): RVSensor[] { return this.viewer?.transportManager?.sensors ?? []; }
  private get signals(): SignalStore | null { return this.viewer?.signalStore ?? null; }
  private get transportManager(): RVTransportManager | null {
    return this.viewer?.transportManager ?? null;
  }

  /** Cached writer, rebuilt whenever the underlying store is swapped (model reload). */
  private get signalWriter(): SignalWriter | null {
    const store = this.viewer?.signalStore ?? null;
    if (!store) {
      this._writerStore = null;
      this._writer = null;
      return null;
    }
    if (this._writerStore !== store) {
      this._writerStore = store;
      this._writer = createSignalWriter(store, WRITER_ID, pluginSignalWriterKind(WRITER_ID));
    }
    return this._writer;
  }

  @McpTool('List all drives: current/target position, speed, running/jog flags, direction, limits. First stop when diagnosing why something does not move.', { readOnly: true })
  async webDriveList(): Promise<string> {
    return JSON.stringify(this.drives.map(d => ({
      name: d.name,
      currentPosition: +d.currentPosition.toFixed(3),
      targetPosition: +d.targetPosition.toFixed(3),
      targetSpeed: +d.targetSpeed.toFixed(3),
      isRunning: d.isRunning,
      jogForward: d.jogForward,
      jogBackward: d.jogBackward,
      direction: d.Direction,
      upperLimit: d.UpperLimit,
      lowerLimit: d.LowerLimit,
      acceleration: d.Acceleration,
    })));
  }

  @McpTool('List all PLC signals with current values. For direction/forced/live-vs-stale diagnosis use web_signal_status instead.', { readOnly: true })
  async webSignalList(): Promise<string> {
    const all = this.signals?.getAll();
    if (!all) return JSON.stringify([]);
    const result: Array<{ name: string; value: boolean | number; type: string }> = [];
    for (const [name, value] of all) {
      result.push({
        name,
        value,
        type: typeof value,
      });
    }
    return JSON.stringify(result);
  }

  @McpTool('List PLC signals with full status: value, type, direction, forced state, live/stale activity, address/comment metadata. Use to diagnose whether signals actually update (live) vs stale/no-source. Filters: name substring, activeOnly, limit.', { readOnly: true })
  async webSignalStatus(
    @McpParam('filter', 'Only signals whose name contains this substring (case-insensitive). Empty = all.', 'string', false) filter?: string,
    @McpParam('activeOnly', 'Only signals currently live or supplied (drop stale / no-source).', 'boolean', false) activeOnly?: boolean,
    @McpParam('limit', 'Maximum number of signals returned (default 200).', 'number', false) limit?: number,
  ): Promise<string> {
    const store = this.signals;
    if (!store) return JSON.stringify({ error: 'No signal store available' });
    const all = store.getAll();
    const now = Date.now();
    const mode = getViewerMode();
    const q = (filter ?? '').toLowerCase();
    const max = limit && limit > 0 ? limit : 200;

    const activityCounts: Record<string, number> = {};
    const signals: Array<Record<string, unknown>> = [];
    let matched = 0;

    for (const [name, value] of all) {
      if (q && !name.toLowerCase().includes(q)) continue;
      const activity = store.getActivity(name, now, mode);
      activityCounts[activity] = (activityCounts[activity] ?? 0) + 1;
      if (activeOnly && (activity === 'stale' || activity === 'no-source')) continue;
      matched++;
      if (signals.length >= max) continue;
      const plcType = store.getType(name) ?? '';
      const forced = store.isForced(name);
      const meta = store.getSignalMeta(name);
      const ts = store.getLastUpdateTs(name);
      signals.push({
        name,
        value,
        plcType,
        direction: plcType.startsWith('PLCOutput') ? 'output'
          : plcType.startsWith('PLCInput') ? 'input' : 'unknown',
        activity,
        ageMs: ts !== undefined ? now - ts : null,
        forced,
        forcedValue: forced ? store.getForcedValue(name) : undefined,
        address: meta?.address,
        comment: meta?.comment,
        source: meta?.source,
      });
    }

    return JSON.stringify({
      mode,
      total: all.size,
      matched,
      returned: signals.length,
      truncated: matched > signals.length,
      activityCounts,
      signals,
    });
  }

  @McpTool('Write a boolean PLC signal in the browser SignalStore. Fails when the signal does not exist — find names with web_signal_list.', { readOnly: false })
  async webSignalSetBool(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Boolean value to set', 'boolean') value: boolean,
  ): Promise<string> {
    if (!this.signals) return JSON.stringify({ error: 'No signal store available' });
    const current = this.signals.get(name);
    if (current === undefined) return JSON.stringify({ error: `Signal "${name}" not found` });
    this.signalWriter?.set(name, value);
    return JSON.stringify({ name, value, previous: current });
  }

  @McpTool('Write a float PLC signal in the browser SignalStore. Fails when the signal does not exist — find names with web_signal_list.', { readOnly: false })
  async webSignalSetFloat(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Float value to set', 'number') value: number,
  ): Promise<string> {
    if (!this.signals) return JSON.stringify({ error: 'No signal store available' });
    const current = this.signals.get(name);
    if (current === undefined) return JSON.stringify({ error: `Signal "${name}" not found` });
    this.signalWriter?.set(name, value);
    return JSON.stringify({ name, value, previous: current });
  }

  @McpTool('Jog a runtime drive forward or backward (sets jog flags; drive names from web_drive_list). Stop with web_drive_stop. For authored drives in the asset editor use web_editor_verify_drive instead.', { readOnly: false })
  async webDriveJog(
    @McpParam('name', 'Drive name') name: string,
    @McpParam('forward', 'true for forward, false for backward', 'boolean', false) forward: boolean,
  ): Promise<string> {
    const drive = this.drives.find(d => d.name === name);
    if (!drive) return JSON.stringify({ error: `Drive "${name}" not found` });
    const dir = forward !== false;  // default to true if not specified
    drive.jogForward = dir;
    drive.jogBackward = !dir;
    return JSON.stringify({ name, jogForward: dir, jogBackward: !dir });
  }

  @McpTool('Play or pause the simulation. Pass paused=true/false, or omit to toggle. Returns all active pause reasons.', { readOnly: false })
  async webSimPlayPause(
    @McpParam('paused', 'true to pause, false to play; omit to toggle', 'boolean', false) paused: boolean,
  ): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    const userPaused = this.viewer.simulationPauseReasons.includes('user');
    const next = paused === undefined || paused === null ? !userPaused : paused;
    this.viewer.setSimulationPaused('user', next);
    return JSON.stringify({
      paused: this.viewer.isSimulationPaused,
      userPaused: next,
      reasons: [...this.viewer.simulationPauseReasons],
    });
  }

  @McpTool('Show or hide the floor markers (ring + label) under every Source. Persists in localStorage. Useful to locate spawn points in screenshots.', { readOnly: false })
  async webViewSourceMarkers(
    @McpParam('visible', 'true to show, false to hide', 'boolean', true) visible: boolean,
  ): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    this.viewer.setSourceMarkersVisible(visible);
    const sources = this.transportManager?.sources ?? [];
    return JSON.stringify({
      ok: true,
      visible,
      affectedSources: sources.length,
    });
  }

  @McpTool('Reset the simulation: clears MUs, resets LogicStep states and snaps every drive back to its authored StartPosition. Signals are untouched.', { readOnly: false })
  async webSimReset(): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    const before = {
      mus: this.transportManager?.mus.length ?? 0,
      totalSpawned: this.transportManager?.totalSpawned ?? 0,
    };
    this.viewer.resetSimulation();
    return JSON.stringify({
      ok: true,
      before,
      after: {
        mus: this.transportManager?.mus.length ?? 0,
        totalSpawned: this.transportManager?.totalSpawned ?? 0,
      },
    });
  }

  @McpTool('Stop a drive: clears jog flags and halts motion. Drive names from web_drive_list.', { readOnly: false })
  async webDriveStop(
    @McpParam('name', 'Drive name') name: string,
  ): Promise<string> {
    const drive = this.drives.find(d => d.name === name);
    if (!drive) return JSON.stringify({ error: `Drive "${name}" not found` });
    drive.jogForward = false;
    drive.jogBackward = false;
    drive.stop();
    return JSON.stringify({ name, stopped: true });
  }

  @McpTool('Master speed factor scaling ALL drives (1 = normal, 0.5 = half, 2 = double, 0 = stopped; relative speeds preserved). Omit factor to read the current value.', { readOnly: false })
  async webDriveSpeedOverride(
    @McpParam('factor', 'Master speed factor (1 = normal). Omit to read the current value.', 'number', false) factor: number,
  ): Promise<string> {
    if (factor === undefined || factor === null) {
      return JSON.stringify({ factor: getDriveSpeedOverride() });
    }
    return JSON.stringify({ factor: setDriveSpeedOverride(factor) });
  }

  @McpTool('List all sensors with occupancy state, mode and their occupied/not-occupied signal names.', { readOnly: true })
  async webSensorList(): Promise<string> {
    return JSON.stringify(this.sensors.map(s => ({
      name: s.node.name,
      occupied: s.occupied,
      mode: s.mode,
      signalOccupied: s.SensorOccupied,
      signalNotOccupied: s.SensorNotOccupied,
    })));
  }

  @McpTool('Get material-flow status: spawned/consumed/active MU counts, blocked and physics-owned MUs, per-source and per-sink stats. Use when parts are missing, jammed or not spawning.', { readOnly: true })
  async webTransportStatus(): Promise<string> {
    const tm = this.transportManager;
    if (!tm) return JSON.stringify({ error: 'No transport manager' });
    let physicsOwnedCount = 0;
    for (const mu of tm.mus) if (mu.physicsOwned) physicsOwnedCount++;
    return JSON.stringify({
      totalSpawned: tm.totalSpawned,
      totalConsumed: tm.totalConsumed,
      activeMUs: tm.mus.length,
      // MUs currently jam-blocked by the accumulation gap clamp (plan-255).
      blockedMuCount: tm.blockedMuCount,
      // MUs currently simulated as free rigid bodies (plan-276 physics zones).
      physicsOwnedCount,
      // Dynamic bodies in the physics provider world (0 when physics is off).
      physicsBodies: physicsDiagnostics.bodies,
      mus: tm.mus.map(mu => ({
        name: mu.getName(),
        ...serializeProps(mu, 1),
      })),
      sources: tm.sources.map(src => ({
        name: src.node.name,
        ...serializeProps(src, 1),
      })),
      sinks: tm.sinks.map(sink => ({
        name: sink.node.name,
        ...serializeProps(sink, 1),
      })),
    });
  }

  @McpTool('Get the LogicStep sequence hierarchy with per-step state and progress. Use to see where an automation sequence is stuck.', { readOnly: true })
  async webLogicFlow(): Promise<string> {
    const engine = this.viewer?.logicEngine;
    if (!engine) return JSON.stringify({ error: 'No logic engine' });

    const mapStep = (step: RVLogicStep): object => {
      const props = serializeProps(step, 1);
      const base: Record<string, unknown> = {
        name: step.name,
        type: step.constructor.name,
        state: step.state,
        progress: step.progress,
        ...props,
      };
      if ('children' in step) {
        base.children = (step as { children: RVLogicStep[] }).children.map(mapStep);
      }
      return base;
    };

    return JSON.stringify({
      stats: engine.stats,
      roots: engine.roots.map(mapStep),
    });
  }
}

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
 * methods ON the plugin and read `this.drives` / `this.signals` and friends.
 *
 * plan-499: the WRITE tools here (sim play/pause/reset, speed override, drive
 * jog/stop, signal set) are views of the runtime commands in
 * `plugins/sim-controller/sim-commands.ts` — one `dispatchBoundCommand` each.
 * The signal writer moved with them and keeps the bridge's identity for an MCP
 * dispatch (`'mcp-bridge'` / `'mcp'`), so a signal written by a tool is still
 * attributed to the bridge in the signal UI.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { RVSensor } from '../../core/engine/rv-sensor';
import type { RVTransportManager } from '../../core/engine/rv-transport-manager';
import type { RVLogicStep } from '../../core/engine/rv-logic-step';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { getDriveSpeedOverride } from '../../core/engine/rv-speed-override';
import {
  bindStandalone,
  commandErrorJson,
  dispatchBoundCommand,
  type McpCallContext,
} from '../../core/hmi/rv-command-context';
import { ensureSimCommandsRegistered } from '../sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../../core/hmi/view-commands';
import { ensureMuCommandsRegistered } from '../mu-interaction-plugin';
import { getViewerMode } from '../../core/hmi/connect-store';
import { physicsDiagnostics } from '../../core/engine/rv-physics-registry';
import { serializeProps } from './rv-mcp-serialize';

export class McpRuntimeTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined { return this.getViewer(); }
  private get drives(): RVDrive[] { return this.viewer?.drives ?? []; }
  private get sensors(): RVSensor[] { return this.viewer?.transportManager?.sensors ?? []; }
  private get signals(): SignalStore | null { return this.viewer?.signalStore ?? null; }
  private get transportManager(): RVTransportManager | null {
    return this.viewer?.transportManager ?? null;
  }

  /**
   * plan-499: THE one dispatch of a bound body — the command the call context
   * resolved (bridge), or the decorator's binding for a direct call.
   */
  private _dispatch<R = Record<string, unknown>>(
    ctx: McpCallContext | undefined, methodKey: string, wire: Record<string, unknown>,
  ): ReturnType<typeof dispatchBoundCommand<R>> {
    // Direct callers (tests, internal) may come before the plugin registered them.
    ensureSimCommandsRegistered();
    ensureViewCommandsRegistered();
    ensureMuCommandsRegistered();
    return dispatchBoundCommand<R>(ctx ?? bindStandalone(this, methodKey, wire, this.viewer), this.viewer);
  }

  /** Serialise a dispatch: `{error, ...details}` on refusal, else the shaped value. */
  private _json<R>(
    r: Awaited<ReturnType<typeof dispatchBoundCommand<R>>>,
    shape: (v: R) => Record<string, unknown> = (v) => v as unknown as Record<string, unknown>,
  ): string {
    return JSON.stringify(r.ok ? shape(r.value) : commandErrorJson(r));
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

  @McpTool('Write a boolean PLC signal in the browser SignalStore. Fails when the signal does not exist — find names with web_signal_list. With `asset`, fan out: write the signal of that name inside EVERY placed instance of the asset, nested instances included (a reference inside a placed asset is an instance of the inner asset — address it by the inner asset; path is the address, plan-757 F12).', { readOnly: false, command: 'signal.setBool' })
  async webSignalSetBool(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Boolean value to set', 'boolean') value: boolean,
    @McpParam('asset', 'Fan-out: asset id, catalog id, file name or root name of a PLACED asset — the signal named `name` is written in every placed instance of it', 'string', false) asset?: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: a view of `signal.setBool` (fan-out included) — the inspector Toggle is the other.
    return this._json(await this._dispatch(ctx, 'webSignalSetBool', { name, value, asset }));
  }

  @McpTool('Write a float PLC signal in the browser SignalStore. Fails when the signal does not exist — find names with web_signal_list. With `asset`, fan out: write the signal of that name inside EVERY placed instance of the asset, nested instances included (a reference inside a placed asset is an instance of the inner asset — address it by the inner asset; path is the address, plan-757 F12).', { readOnly: false, command: 'signal.setFloat' })
  async webSignalSetFloat(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Float value to set', 'number') value: number,
    @McpParam('asset', 'Fan-out: asset id, catalog id, file name or root name of a PLACED asset — the signal named `name` is written in every placed instance of it', 'string', false) asset?: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webSignalSetFloat', { name, value, asset }));
  }

  @McpTool('Jog a runtime drive forward or backward (sets jog flags; drive names from web_drive_list). Stop with web_drive_stop. For authored drives in the asset editor use web_editor_verify_drive instead.', { readOnly: false, command: 'drive.jog' })
  async webDriveJog(
    @McpParam('name', 'Drive name') name: string,
    @McpParam('forward', 'true for forward, false for backward', 'boolean', false) forward: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: a view of `drive.jog` — the inspector Jog +/− buttons are the others.
    return this._json(await this._dispatch(ctx, 'webDriveJog', { name, forward }));
  }

  @McpTool('Play or pause the simulation. ALWAYS pass paused=true (pause) or paused=false (play) — omitting it TOGGLES, and the simulation is usually already running, so a bare call pauses it. Returns the state before (wasPaused), after, and all active pause reasons.', { readOnly: false, command: 'sim.playPause' })
  async webSimPlayPause(
    @McpParam('paused', 'true to pause, false to play; omit to toggle', 'boolean', false) paused: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: a view of `sim.playPause` — the toolbar segment and Space are the others.
    return this._json(await this._dispatch(ctx, 'webSimPlayPause', { paused }), (v) => ({
      wasPaused: v['wasPaused'],
      ...(v['toggled'] ? { toggled: true, hint: 'No paused argument — the state was TOGGLED. Pass paused=true/false to be explicit.' } : {}),
      paused: v['paused'],
      userPaused: v['userPaused'],
      reasons: v['reasons'],
    }));
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

  @McpTool('Switch the viewport render mode: simple (unlit, fastest — use for captures of heavy scenes), default (shaded) or toon (cel-shaded). Persists like the Visual tab; refused when the deployment locks the Visual settings. Current value: web_status.renderMode.', { readOnly: false, command: 'view.renderMode' })
  async webViewRenderMode(
    @McpParam('mode', 'simple | default | toon', 'string', true) mode: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-761: a view of `view.renderMode` — the toolbar pill and the Visual tab dropdown are the others.
    return this._json(await this._dispatch(ctx, 'webViewRenderMode', { mode }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Apply a named visual preset — the quality axis (resolution, antialias, shadow map, AO, reflection): "Default" is the full look, "Fast" the low-end one. Refused on an unknown name or a locked Visual tab; current values are web_status.visualPreset and web_status.antialiasActive (antialias only takes effect after a page reload).', { readOnly: false, command: 'view.visualPreset' })
  async webViewVisualPreset(
    @McpParam('name', 'Preset name, e.g. Default | Fast', 'string', true) name: string,
    @McpParam('source', 'shipped = public/presets only; any (default) = also browser-local', 'string', false) source: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-591: a view of `view.visualPreset` — the render-mode menu's two
    // quality rows and the Visual tab's preset dropdown are the others.
    return this._json(
      await this._dispatch(ctx, 'webViewVisualPreset', { name, source }),
      (v) => ({ ok: true, ...v }),
    );
  }

  @McpTool('Reset the simulation: clears MUs, resets LogicStep states and snaps every drive back to its authored StartPosition. Signals are untouched.', { readOnly: false, command: 'sim.reset' })
  async webSimReset(ctx?: McpCallContext): Promise<string> {
    // plan-499: a view of `sim.reset` — the toolbar Reset segment and Shift+R are the others.
    return this._json(await this._dispatch(ctx, 'webSimReset', {}), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Stop a drive: clears jog flags and halts motion. Drive names from web_drive_list.', { readOnly: false, command: 'drive.stop' })
  async webDriveStop(
    @McpParam('name', 'Drive name') name: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: a view of `drive.stop` — the inspector Stop button is the other.
    return this._json(await this._dispatch(ctx, 'webDriveStop', { name }));
  }

  @McpTool('Master speed factor scaling ALL drives (1 = normal, 0.5 = half, 2 = double, 0 = stopped; relative speeds preserved). Omit factor to read the current value.', { readOnly: false, command: 'sim.speedOverride' })
  async webDriveSpeedOverride(
    @McpParam('factor', 'Master speed factor (1 = normal). Omit to read the current value.', 'number', false) factor: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    // Without a factor the tool is a READ and dispatches nothing (like
    // web_editor_materialize without assignments); the bridge preflight refuses
    // the command for it, so no button is pressed either.
    if (factor === undefined || factor === null) {
      return JSON.stringify({ factor: getDriveSpeedOverride() });
    }
    // plan-499: a view of `sim.speedOverride` — the toolbar speed menu is the other.
    return this._json(await this._dispatch(ctx, 'webDriveSpeedOverride', { factor }));
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
      // Moving machine parts registered as kinematic bodies (plan-467 F13) —
      // counted IN ADDITION to physicsBodies. Zero here while parts visibly
      // pass through MUs is the answer, not a missing number.
      physicsKinematicBodies: physicsDiagnostics.kinematicBodies,
      stoppers: [...tm.stoppers].map(stopper => ({
        name: stopper.node.name,
        enabled: stopper.Enabled,
        bounds: { min: stopper.bounds.min.toArray(), max: stopper.bounds.max.toArray() },
      })),
      // plan-521 Zones: activation, Detect result, held MUs and the world box.
      zones: [...tm.zones].map(zone => ({
        name: zone.node.name,
        effects: { detect: zone.Detect, block: zone.Block, hold: zone.Hold },
        activation: zone.Activation,
        active: zone.active,
        occupied: zone.occupied,
        held: zone.held.map(mu => mu.getName()),
        bounds: { min: zone.bounds.min.toArray(), max: zone.bounds.max.toArray() },
      })),
      mus: tm.mus.map(mu => ({
        // plan-567: the engine id web_mu_delete / web_mu_move address.
        id: mu.id,
        name: mu.getName(),
        ...serializeProps(mu, 1),
        bounds: { min: mu.aabb.min.toArray(), max: mu.aabb.max.toArray() },
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

  @McpTool('Remove a workpiece carrier (MU) with the parts on it, also while paused (sensors update at once). id = web_transport_status mus[].id. Commissioning only; an authored carrier returns on reset.', { readOnly: false, command: 'mu.delete' })
  async webMuDelete(
    @McpParam('id', 'MU id (web_transport_status mus[].id)', 'number') id: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-567: a view of `mu.delete` — the Delete key and the context menu are the others.
    return this._json(await this._dispatch(ctx, 'webMuDelete', { id }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Set a workpiece carrier (MU) onto a transport surface at (x, z): bottom on the surface top, rotation kept; refused when occupied or off every surface. Commissioning only.', { readOnly: false, command: 'mu.move' })
  async webMuMove(
    @McpParam('id', 'MU id (web_transport_status mus[].id)', 'number') id: number,
    @McpParam('x', 'World X (m)', 'number') x: number,
    @McpParam('y', 'World Y (m), picks the level of stacked surfaces', 'number') y: number,
    @McpParam('z', 'World Z (m)', 'number') z: number,
    @McpParam('surface', 'Surface node name or path (default: the one under the point)', 'string', false) surface?: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-567: a view of `mu.move` — dragging a carrier in Commissioning is the other.
    return this._json(await this._dispatch(ctx, 'webMuMove', { id, x, y, z, surface }), (v) => ({ ok: true, ...v }));
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

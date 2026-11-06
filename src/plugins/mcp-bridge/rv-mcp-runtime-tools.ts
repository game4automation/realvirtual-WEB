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
 * Runtime writes use registry commands through web_execute (plan-2007).
 * The former tool names were removed in 6.7.1; use web_execute / web_query.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { RVSensor } from '../../core/engine/rv-sensor';
import type { RVTransportManager } from '../../core/engine/rv-transport-manager';
import type { RVLogicStep } from '../../core/engine/rv-logic-step';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { isDynamicAxis } from '../../core/engine/rv-axis-contract';
import { ensureMuCommandsRegistered } from '../mu-interaction-plugin';

import { getViewerMode } from '../../core/hmi/connect-store';
import { physicsDiagnostics } from '../../core/engine/rv-physics-registry';
import { serializeProps } from './rv-mcp-serialize';

export class McpRuntimeTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {
    // The removed alias wrappers registered these before dispatch; command doors need them eagerly.
    ensureMuCommandsRegistered();
  }

  private get viewer(): RVViewer | undefined { return this.getViewer(); }
  private get drives(): RVDrive[] { return this.viewer?.drives ?? []; }
  private get sensors(): RVSensor[] { return this.viewer?.transportManager?.sensors ?? []; }
  private get signals(): SignalStore | null { return this.viewer?.signalStore ?? null; }
  private get transportManager(): RVTransportManager | null {
    return this.viewer?.transportManager ?? null;
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryDriveList(): Promise<string> {
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
      // plan-673 Phase 4 — only for a DYNAMIC axis, and that is the point: on a
      // kinematic drive the position IS the setpoint, the following error is
      // structurally zero and three constant fields per drive would be noise in
      // the answer every diagnosis starts with. Where they appear, they are the
      // reason the axis is not where it was told to be. The error is the RAW
      // one; `DynamicAxis.BaseFollowingError` is the declared share to subtract.
      ...(isDynamicAxis(d) ? {
        commandedPosition: Number.isFinite(d.commandedPosition) ? +d.commandedPosition.toFixed(3) : null,
        followingError: +d.followingError.toFixed(4),
        actualTorque: +d.actualTorque.toFixed(3),
        saturated: d.saturated,
      } : {}),
    })));
  }

  @McpTool('List PLC signals with values as {signals:[{name,value,type}], total, truncated}. For direction/forced/live-vs-stale diagnosis use web_signal_status instead.', { readOnly: true })
  async webSignalList(
    @McpParam('filter', 'Name substring, case-insensitive.', 'string', false) filter?: string,
    @McpParam('limit', 'Max signals (default 500).', 'number', false) limit?: number,
  ): Promise<string> {
    // plan-2005 F8: the filter is honoured (it used to be dropped silently) and
    // the answer says how many matched, so a cut list never reads as complete.
    const needle = (filter ?? '').toString().trim().toLowerCase();
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 500;
    const signals: Array<{ name: string; value: boolean | number; type: string }> = [];
    let total = 0;
    for (const [name, value] of this.signals?.getAll() ?? []) {
      if (needle && !name.toLowerCase().includes(needle)) continue;
      total++;
      if (signals.length < max) signals.push({ name, value, type: typeof value });
    }
    return JSON.stringify({ signals, total, truncated: total > signals.length });
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

  /** Read-only command body; preserves the original JSON value contract. */
  async querySensorList(): Promise<string> {
    return JSON.stringify(this.sensors.map(s => ({
      name: s.node.name,
      occupied: s.occupied,
      mode: s.mode,
      signalOccupied: s.SensorOccupied,
      signalNotOccupied: s.SensorNotOccupied,
    })));
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryTransportStatus(): Promise<string> {
    const tm = this.transportManager;
    if (!tm) return JSON.stringify({ error: 'No transport manager' });
    let physicsOwnedCount = 0;
    for (const mu of tm.mus) if (mu.owner !== 'transport') physicsOwnedCount++;
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

  /** Read-only command body; preserves the original JSON value contract. */
  async queryLogicFlow(): Promise<string> {
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

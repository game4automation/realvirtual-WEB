// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.8 — the PARITY GATE, part b (execution). Chromium: the tool
 * classes import viewer modules.
 *
 * For EVERY bound write tool, table-driven, with a hand-kept expectation
 * `EXPECTED_DISPATCH[tool] = {wire, id, args}` that is independent of the
 * production resolver:
 *  - one call → exactly ONE `commandRegistry.execute`, with that id and args;
 *  - a `value` fixture → the serialised result carries the fields the tool
 *    answered before the migration (`path`, `deleted`, `kinematicPath`, …);
 *  - a refusal → `{error: reason}` (plus `details`), and with a real registry
 *    and a stubbed implementation `run` is never called;
 *  - multiplexer branches (pivot) each dispatch once; an unknown branch none.
 * The table must cover exactly the tools that carry a binding.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { listToolEntries } from '../src/core/engine/rv-mcp-tools';
import { createMcpDelegates } from '../src/plugins/mcp-bridge/rv-mcp-instances';
import { commandRegistry, type CommandDescriptor } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { CIRCLE_INVALID, OWN_MESH_PIVOT } from '../src/core/hmi/editor-command-descriptors';
import {
  NEEDS_ANCHOR_SOURCE,
  NEEDS_AXIS_SOURCE,
} from '../src/core/hmi/mechanism-command-descriptors';
import {
  setMechanismUiBridge,
  type MechanismUiBridge,
  type MechanismView,
} from '../src/core/engine/rv-kinematic-registry';

type Wire = Record<string, unknown>;
interface Expectation {
  readonly wire: Wire;
  readonly id: string;
  readonly args: unknown;
  /** Fixture the stubbed execute returns as `value`. */
  readonly value: Record<string, unknown>;
  /** Fields the serialised result must carry (the pre-migration answer shape). */
  readonly result: Record<string, unknown>;
}

const EXPECTED_DISPATCH: Readonly<Record<string, Expectation>> = {
  web_editor_zero_position: {
    wire: { paths: 'A,B' }, id: 'editor.zeroPosition', args: { paths: 'A,B' },
    value: { count: 2 }, result: { ok: true, count: 2 },
  },
  web_editor_rotate90: {
    wire: { path: 'A', axis: 'y', sign: -1 }, id: 'editor.rotate90', args: { path: 'A', axis: 'y', sign: -1 },
    value: { path: 'A', axis: 'y', sign: -1 }, result: { ok: true, path: 'A', axis: 'y', sign: -1 },
  },
  web_editor_to_ground: {
    wire: { path: 'A' }, id: 'editor.toGround', args: { path: 'A' },
    value: { path: 'A' }, result: { ok: true, path: 'A' },
  },
  web_editor_pivot: {
    wire: { path: 'A', mode: 'align_y_up', targetPath: undefined }, id: 'editor.alignYUp', args: { path: 'A' },
    value: { path: 'A', pivotWorld: [0, 1, 0] }, result: { ok: true, path: 'A', mode: 'align_y_up', pivotWorld: [0, 1, 0] },
  },
  web_editor_rename: {
    wire: { path: 'R/A', name: 'B' }, id: 'editor.rename', args: { path: 'R/A', name: 'B' },
    value: { path: 'R/B' }, result: { ok: true, path: 'R/B' },
  },
  web_editor_delete: {
    wire: { paths: 'A' }, id: 'editor.delete', args: { paths: 'A' },
    value: { deleted: 1 }, result: { ok: true, deleted: 1 },
  },
  web_editor_set_visible: {
    wire: { paths: 'A', visible: false }, id: 'editor.setVisible', args: { paths: 'A', visible: false },
    value: { changed: 1, visible: false }, result: { ok: true, changed: 1, visible: false },
  },
  web_editor_create_empty: {
    wire: { parentPath: 'R', name: 'E' }, id: 'editor.createEmpty', args: { parentPath: 'R', name: 'E' },
    value: { path: 'R/E' }, result: { ok: true, path: 'R/E' },
  },
  web_editor_reparent: {
    wire: { paths: 'A', newParentPath: 'R' }, id: 'editor.reparent', args: { paths: 'A', newParentPath: 'R' },
    value: { moved: 1 }, result: { ok: true, moved: 1 },
  },
  web_editor_add_component: {
    wire: { path: 'A', type: 'Drive', propsJson: undefined }, id: 'editor.addComponent',
    args: { path: 'A', type: 'Drive', propsJson: undefined },
    value: { path: 'A', component: 'Drive', fields: { Direction: 'LinearX' } },
    result: { ok: true, path: 'A', component: 'Drive', fields: { Direction: 'LinearX' } },
  },
  web_editor_remove_component: {
    wire: { path: 'A', componentType: 'Drive' }, id: 'editor.removeComponent', args: { path: 'A', componentType: 'Drive' },
    value: { path: 'A', removed: 'Drive' }, result: { ok: true, path: 'A', removed: 'Drive' },
  },
  web_editor_set_field: {
    wire: { path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '5' },
    id: 'editor.setField', args: { path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '5' },
    value: { path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', value: 5, prev: 1 },
    result: { ok: true, path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', value: 5, prev: 1 },
  },
  web_editor_create_kinematic: {
    wire: { name: 'Axis' }, id: 'editor.createKinematic', args: { name: 'Axis' },
    value: { kinematicPath: 'Axis', groupName: 'Axis' }, result: { ok: true, kinematicPath: 'Axis', groupName: 'Axis' },
  },
  web_editor_assign_to_kinematic: {
    wire: { paths: 'A,B', groupName: 'Axis' }, id: 'editor.assignToKinematic',
    args: { name: 'Axis', paths: ['A', 'B'], requireExisting: true },
    value: { kinematicPath: 'Axis', groupName: 'Axis', members: 2, added: 0, skipped: 0, createdKinematicPath: '' },
    result: { ok: true, kinematicPath: 'Axis', groupName: 'Axis', members: 2 },
  },
  // ── plan-760 F13: Quick Edit Groups (wire == args, 1:1; result = {ok: true, ...value}) ──
  web_editor_group_assign: {
    wire: { name: 'Hood', paths: 'A,B' }, id: 'editor.groupAssign', args: { name: 'Hood', paths: 'A,B' },
    value: { group: 'Hood', added: 2, skipped: 0, kinematicsUpdated: 0 },
    result: { ok: true, group: 'Hood', added: 2, skipped: 0, kinematicsUpdated: 0 },
  },
  web_editor_group_remove: {
    wire: { name: 'Cover', paths: 'A,B' }, id: 'editor.groupRemove', args: { name: 'Cover', paths: 'A,B' },
    value: { group: 'Cover', removed: 1, skipped: 1 }, result: { ok: true, group: 'Cover', removed: 1, skipped: 1 },
  },
  web_editor_group_rename: {
    wire: { name: 'Axis1', newName: 'Axis1_Rot' }, id: 'editor.groupRename', args: { name: 'Axis1', newName: 'Axis1_Rot' },
    value: { group: 'Axis1_Rot', previous: 'Axis1', renamed: 2, kinematicsUpdated: 1 },
    result: { ok: true, group: 'Axis1_Rot', previous: 'Axis1', renamed: 2, kinematicsUpdated: 1 },
  },
  web_editor_group_dissolve: {
    wire: { name: 'Axis1' }, id: 'editor.groupDissolve', args: { name: 'Axis1' },
    value: { group: 'Axis1', dissolved: 2, kinematicsUpdated: 1 },
    result: { ok: true, group: 'Axis1', dissolved: 2, kinematicsUpdated: 1 },
  },
  web_editor_assign_material: {
    wire: { paths: 'A', presetId: 'steel', color: undefined, metalness: undefined, roughness: undefined, opacity: undefined },
    id: 'editor.assignMaterial',
    args: { paths: 'A', presetId: 'steel', color: undefined, metalness: undefined, roughness: undefined, opacity: undefined },
    value: { applied: 'Steel', paths: 1 }, result: { ok: true, applied: 'Steel', paths: 1 },
  },
  web_editor_materialize: {
    wire: { assignmentsJson: '[{"key":"k","presetId":"steel"}]' }, id: 'editor.materialize',
    args: { assignmentsJson: '[{"key":"k","presetId":"steel"}]' },
    value: { applied: [{ key: 'k' }], skipped: [] }, result: { ok: true, applied: [{ key: 'k' }], skipped: [] },
  },
  web_editor_undo: {
    wire: { count: 2 }, id: 'editor.undo', args: { count: 2 },
    value: { undone: 2, canUndo: false, canRedo: true }, result: { undone: 2, canUndo: false, canRedo: true },
  },
  web_editor_redo: {
    wire: { count: 1 }, id: 'editor.redo', args: { count: 1 },
    value: { redone: 1, canUndo: true, canRedo: false }, result: { redone: 1, canUndo: true, canRedo: false },
  },
  web_editor_shortcut: {
    wire: { keys: 's > i', arg: undefined }, id: 'select.identical', args: { seeds: null },
    value: { selected: 3 }, result: { shortcut: 'S>I', selected: 3 },
  },
  // ── plan-499 Phase 4: Quick Edit signals / logic steps ──
  web_editor_add_signal: {
    wire: { parentPath: 'R', sigType: 'PLCOutputBool', name: 'Start' }, id: 'editor.addSignal',
    args: { parentPath: 'R', sigType: 'PLCOutputBool', name: 'Start' },
    value: { path: 'R/Start' }, result: { ok: true, path: 'R/Start' },
  },
  web_editor_convert_signal: {
    wire: { path: 'R/S', target: 'Int' }, id: 'editor.convertSignal', args: { path: 'R/S', target: 'Int' },
    value: { path: 'R/S' }, result: { ok: true, path: 'R/S' },
  },
  web_editor_toggle_signal_direction: {
    wire: { path: 'R/S' }, id: 'editor.toggleSignalDirection', args: { path: 'R/S' },
    value: { path: 'R/S' }, result: { ok: true, path: 'R/S' },
  },
  web_editor_add_logic_step: {
    wire: { path: 'R', stepType: 'LogicStep_Delay' }, id: 'editor.addLogicStep', args: { path: 'R', stepType: 'LogicStep_Delay' },
    value: { path: 'R/Delay' }, result: { ok: true, path: 'R/Delay' },
  },
  // ── plan-589 Phase 2: the signal editor's two verbs ──
  web_editor_signal_set_field: {
    wire: { path: 'R/S', field: 'Comment', value: 'Belt start' }, id: 'editor.signalSetField',
    args: { path: 'R/S', field: 'Comment', value: 'Belt start' },
    value: { path: 'R/S', field: 'Comment' }, result: { ok: true, path: 'R/S', field: 'Comment' },
  },
  web_editor_signal_set_binding: {
    wire: {
      name: 'Cell.Start', interfaceId: 's7-1', topic: undefined,
      protocolAddress: 'DB10.DBX4.1', dataType: 'Bool', remove: undefined,
    },
    id: 'editor.signalSetBinding',
    args: {
      name: 'Cell.Start', interfaceId: 's7-1', topic: undefined,
      protocolAddress: 'DB10.DBX4.1', dataType: 'Bool', remove: undefined,
    },
    value: { name: 'Cell.Start', interfaceId: 's7-1', outcome: 'updated' },
    result: { ok: true, name: 'Cell.Start', interfaceId: 's7-1', outcome: 'updated' },
  },
  // ── plan-589 Phase 3: the report's one repair ──
  web_editor_signals_create_from_interface: {
    wire: { interfaceId: 's7-1', parentPath: 'R', names: 'Cell.Start' },
    id: 'editor.signalsCreateFromInterface',
    args: { interfaceId: 's7-1', parentPath: 'R', names: 'Cell.Start' },
    value: { interfaceId: 's7-1', parentPath: 'R', created: ['R/PLCOutputBool'], unsupported: [] },
    result: {
      ok: true, interfaceId: 's7-1', parentPath: 'R',
      created: ['R/PLCOutputBool'], unsupported: [],
    },
  },
  // ── plan-590: signal rename + its two Problems actions ──
  web_editor_signal_rename: {
    wire: { path: 'R/S', newName: 'DB_FG01.Start', dryRun: undefined, confirmWireChange: true },
    id: 'editor.signalRename',
    args: { path: 'R/S', newName: 'DB_FG01.Start', dryRun: undefined, confirmWireChange: true },
    value: { dryRun: false, status: 'committed', journalId: 'sr_1', path: 'R/S', oldName: 'S', newName: 'DB_FG01.Start' },
    result: { ok: true, status: 'committed', journalId: 'sr_1', oldName: 'S', newName: 'DB_FG01.Start' },
  },
  web_editor_signal_rename_repair: {
    wire: { journalId: 'sr_1' }, id: 'editor.signalRenameRepair', args: { journalId: 'sr_1' },
    value: { journalId: 'sr_1', state: 'aborted' }, result: { ok: true, journalId: 'sr_1', state: 'aborted' },
  },
  web_editor_signal_rename_recheck: {
    wire: { journalId: 'sr_1' }, id: 'editor.signalRenameRecheck', args: { journalId: 'sr_1' },
    value: { journalId: 'sr_1', state: 'committed' }, result: { ok: true, journalId: 'sr_1', state: 'committed' },
  },
  // ── plan-499 Phase 3: planner ──
  web_layout_place: {
    wire: { catalogId: 'c', x: 1, y: 0, z: 2, onto: undefined }, id: 'layout.place',
    args: { catalogId: 'c', x: 1, y: 0, z: 2, onto: undefined },
    value: { id: 'p1', catalogId: 'c', position: [1, 0, 2], placeMs: 3 },
    result: { id: 'p1', catalogId: 'c', position: [1, 0, 2], placeMs: 3, next: expect.stringContaining('web_layout_snap_attach') },
  },
  web_layout_move: {
    wire: { id: 'p1', x: 1, y: 0, z: 0, rx: undefined, ry: 90, rz: undefined }, id: 'layout.move',
    args: { id: 'p1', x: 1, y: 0, z: 0, rx: undefined, ry: 90, rz: undefined },
    value: { id: 'p1', position: [1, 0, 0], rotation: [0, 90, 0], persisted: true },
    result: { id: 'p1', position: [1, 0, 0], rotation: [0, 90, 0], persisted: true },
  },
  web_layout_remove: {
    wire: { id: 'p1' }, id: 'layout.remove', args: { id: 'p1' },
    value: { removed: ['p1'], selection: false }, result: { id: 'p1', removed: true, persisted: true },
  },
  web_layout_snap_attach: {
    wire: { targetId: 'p1', catalogId: 'c', targetSnapName: undefined, flow: 'in' }, id: 'layout.snapAttach',
    args: { targetId: 'p1', catalogId: 'c', targetSnapName: undefined, flow: 'in' },
    value: { id: 'p2', catalogId: 'c', ownSnapName: 'Out', flow: 'in' },
    result: { id: 'p2', catalogId: 'c', ownSnapName: 'Out', flow: 'in' },
  },
  // ── plan-499 Phase 3: sim / runtime ──
  web_sim_play_pause: {
    wire: { paused: true }, id: 'sim.playPause', args: { paused: true },
    value: { wasPaused: false, toggled: false, paused: true, userPaused: true, reasons: ['user'] },
    result: { wasPaused: false, paused: true, userPaused: true, reasons: ['user'] },
  },
  web_sim_reset: {
    wire: {}, id: 'sim.reset', args: {},
    value: { before: { mus: 2, totalSpawned: 5 }, after: { mus: 0, totalSpawned: 5 } },
    result: { ok: true, before: { mus: 2, totalSpawned: 5 }, after: { mus: 0, totalSpawned: 5 } },
  },
  web_drive_speed_override: {
    wire: { factor: 2 }, id: 'sim.speedOverride', args: { factor: 2 },
    value: { factor: 2 }, result: { factor: 2 },
  },
  web_drive_jog: {
    wire: { name: 'D', forward: false }, id: 'drive.jog', args: { name: 'D', forward: false },
    value: { name: 'D', jogForward: false, jogBackward: true }, result: { name: 'D', jogForward: false, jogBackward: true },
  },
  web_drive_stop: {
    wire: { name: 'D' }, id: 'drive.stop', args: { name: 'D' },
    value: { name: 'D', stopped: true }, result: { name: 'D', stopped: true },
  },
  web_signal_set_bool: {
    wire: { name: 'S', value: true, asset: undefined }, id: 'signal.setBool', args: { name: 'S', value: true, asset: undefined },
    value: { name: 'S', value: true, previous: false }, result: { name: 'S', value: true, previous: false },
  },
  web_signal_set_float: {
    wire: { name: 'F', value: 1.5, asset: 'Arburg' }, id: 'signal.setFloat', args: { name: 'F', value: 1.5, asset: 'Arburg' },
    value: { name: 'F', value: 1.5, previous: 0, asset: 'Arburg', instances: 2 },
    result: { name: 'F', value: 1.5, previous: 0, asset: 'Arburg', instances: 2 },
  },
  // ── plan-761: the render-mode pill's shading switch ──
  web_view_render_mode: {
    wire: { mode: 'toon' }, id: 'view.renderMode', args: { mode: 'toon' },
    value: { renderMode: 'toon', wireframe: false }, result: { ok: true, renderMode: 'toon', wireframe: false },
  },
  // ── plan-591: the quality axis of the same menu ──
  // `source` travels on the wire AND into the args — that is the F12 contract:
  // a view that resolved the shipped preset must not apply a local one.
  web_view_visual_preset: {
    wire: { name: 'Default', source: 'shipped' }, id: 'view.visualPreset',
    args: { name: 'Default', source: 'shipped' },
    value: { name: 'Default', source: 'shipped', antialiasNeedsReload: true },
    result: { ok: true, name: 'Default', source: 'shipped', antialiasNeedsReload: true },
  },
  // ── plan-567: remove / move a workpiece carrier (Commissioning) ──
  web_mu_delete: {
    wire: { id: 7 }, id: 'mu.delete', args: { id: 7 },
    value: { id: 7, name: 'WT', removed: [7] }, result: { ok: true, id: 7, name: 'WT', removed: [7] },
  },
  web_mu_move: {
    wire: { id: 7, x: 1, y: 0, z: 2, surface: undefined }, id: 'mu.move', args: { id: 7, x: 1, y: 0, z: 2, surface: undefined },
    value: { id: 7, name: 'WT', surface: 'Belt' }, result: { ok: true, id: 7, name: 'WT', surface: 'Belt' },
  },
  // ── plan-504: the Mechanism section (wire == args, 1:1) ──
  web_editor_mechanism_create: {
    wire: { path: 'M' }, id: 'mechanism.create', args: { path: 'M' },
    value: { path: 'M', component: 'KinematicMechanism' }, result: { ok: true, path: 'M', component: 'KinematicMechanism' },
  },
  web_editor_mechanism_add_joint: {
    wire: { path: 'M/J', jointType: 'Revolute', bodyBPath: 'M/B', bodyAPath: undefined, anchorAJson: undefined, anchorBJson: '{"x":1}', axisAJson: undefined },
    id: 'mechanism.addJoint',
    args: { path: 'M/J', jointType: 'Revolute', bodyBPath: 'M/B', bodyAPath: undefined, anchorAJson: undefined, anchorBJson: '{"x":1}', axisAJson: undefined },
    value: { path: 'M/J', jointType: 'Revolute', bodyA: 'world', bodyB: 'M/B' },
    result: { ok: true, path: 'M/J', jointType: 'Revolute', bodyA: 'world', bodyB: 'M/B' },
  },
  web_editor_mechanism_assign_drive: {
    wire: { path: 'M/J', componentType: 'KinematicJoint', drivePath: 'M/D' }, id: 'mechanism.assignDrive',
    args: { path: 'M/J', componentType: 'KinematicJoint', drivePath: 'M/D' },
    value: { path: 'M/J', componentType: 'KinematicJoint', drive: 'M/D' },
    result: { ok: true, path: 'M/J', componentType: 'KinematicJoint', drive: 'M/D' },
  },
  web_editor_mechanism_jog: {
    wire: { path: 'M/J', value: 30, componentType: undefined }, id: 'mechanism.jog',
    args: { path: 'M/J', value: 30, componentType: undefined },
    value: { path: 'M/J', value: 30, converged: true, residualError: 0.001 },
    result: { ok: true, path: 'M/J', value: 30, converged: true, residualError: 0.001 },
  },
  web_editor_mechanism_set_anchor_snap: {
    wire: { path: 'M/J', componentType: 'KinematicJoint', side: 'B', candidateId: 'snap2-0', assignBody: undefined, pickJson: undefined },
    id: 'mechanism.setAnchorSnap',
    args: { path: 'M/J', componentType: 'KinematicJoint', side: 'B', candidateId: 'snap2-0', assignBody: undefined, pickJson: undefined },
    value: { path: 'M/J', componentType: 'KinematicJoint', side: 'B', candidate: { id: 'snap2-0', kind: 'circle-center', label: 'c' }, anchor: { x: 1, y: 2, z: 3 }, body: 'M/B' },
    result: { ok: true, path: 'M/J', side: 'B', candidate: { id: 'snap2-0' }, anchor: { x: 1, y: 2, z: 3 }, body: 'M/B' },
  },
  web_editor_mechanism_set_axis: {
    wire: { path: 'M/J', componentType: 'KinematicJoint', candidateId: undefined, axisWorldJson: '{"x":0,"y":1,"z":0}', secondaryAxisWorldJson: undefined, snapToPrincipal: true },
    id: 'mechanism.setAxis',
    args: { path: 'M/J', componentType: 'KinematicJoint', candidateId: undefined, axisWorldJson: '{"x":0,"y":1,"z":0}', secondaryAxisWorldJson: undefined, snapToPrincipal: true },
    value: { path: 'M/J', componentType: 'KinematicJoint', from: 'vector', axis: { x: 0, y: 1, z: 0 }, secondaryAxis: null },
    result: { ok: true, path: 'M/J', from: 'vector', axis: { x: 0, y: 1, z: 0 }, secondaryAxis: null },
  },
  web_editor_mechanism_add_body: {
    wire: { path: 'M/L', densityPreset: 'aluminum' }, id: 'mechanism.addBody', args: { path: 'M/L', densityPreset: 'aluminum' },
    value: { path: 'M/L', densityPreset: 'aluminum', densityKgM3: 2700 },
    result: { ok: true, path: 'M/L', densityPreset: 'aluminum', densityKgM3: 2700 },
  },
  web_editor_mechanism_set_mass: {
    // TWO args in ONE call → ONE dispatch (one transaction), `applied` with both.
    wire: { path: 'M/L', densityPreset: undefined, densityKgM3: undefined, massKg: '2.5', comJson: '{"x":0,"y":10,"z":0}' },
    id: 'mechanism.setMass',
    args: { path: 'M/L', densityPreset: undefined, densityKgM3: undefined, massKg: '2.5', comJson: '{"x":0,"y":10,"z":0}' },
    value: { path: 'M/L', applied: ['massOverride', 'comOverride'] },
    result: { ok: true, path: 'M/L', applied: ['massOverride', 'comOverride'] },
  },
  web_editor_mechanism_set_limits: {
    wire: { path: 'M/J', componentType: 'KinematicJoint_1', useLimits: true, lower: -45, upper: 45 }, id: 'mechanism.setLimits',
    args: { path: 'M/J', componentType: 'KinematicJoint_1', useLimits: true, lower: -45, upper: 45 },
    value: { path: 'M/J', componentType: 'KinematicJoint_1', useLimits: true, lower: -45, upper: 45 },
    result: { ok: true, path: 'M/J', componentType: 'KinematicJoint_1', useLimits: true, lower: -45, upper: 45 },
  },
  web_editor_mechanism_statics: {
    wire: { mechanismPath: 'M' }, id: 'mechanism.statics', args: { mechanismPath: 'M' },
    value: { ok: true, mechanismPath: 'M', status: 0, dynamicsValid: true, channels: [{ id: 'c', holding: 9 }], joints: [] },
    result: { ok: true, mechanismPath: 'M', status: 0, dynamicsValid: true, channels: [{ id: 'c', holding: 9 }] },
  },
  web_editor_mechanism_fix: {
    wire: { path: 'M/J', code: 'AnchorsApart' }, id: 'mechanism.fix', args: { path: 'M/J', code: 'AnchorsApart' },
    value: { path: 'M/J', componentType: 'KinematicJoint', code: 'AnchorsApart', applied: { AnchorB: { x: 1, y: 0, z: 0 } } },
    result: { ok: true, path: 'M/J', code: 'AnchorsApart', applied: { AnchorB: { x: 1, y: 0, z: 0 } } },
  },
};

/** The pivot branches, each once (hand-kept, not from PIVOT_BRANCHES). */
const PIVOT_CASES: ReadonlyArray<{ wire: Wire; id: string; args: unknown; buttonKey: string | undefined }> = [
  { wire: { path: 'A', mode: 'bottom' }, id: 'editor.pivotToBottom', args: { path: 'A' }, buttonKey: 'qe.pivot-bottom' },
  { wire: { path: 'A', mode: 'object_center', targetPath: 'T' }, id: 'editor.pivotToObjectCenter', args: { path: 'A', targetPath: 'T' }, buttonKey: 'qe.pivot-to-object' },
  { wire: { path: 'A', mode: 'group_center' }, id: 'editor.centerKinematicToGroup', args: { path: 'A' }, buttonKey: undefined },
  { wire: { path: 'A', mode: 'align_y_up' }, id: 'editor.alignYUp', args: { path: 'A' }, buttonKey: 'qe.align-y-up' },
];

// ─── Fixtures ───────────────────────────────────────────────────────────

const viewer = {
  modes: { activeMode: 'editor' },
  selectionManager: { getSnapshot: () => ({ selectedPaths: ['S'] }), clear() {}, selectPaths() {} },
  registry: { getNode: () => null },
} as unknown as RVViewer;

interface Bound { name: string; instance: Record<string, (...a: unknown[]) => Promise<string>>; methodKey: string; params: string[] }
let bound: Bound[] = [];

beforeAll(() => {
  ensureEditorCommandsRegistered();
  ensurePlannerCommandsRegistered();
  ensureSimCommandsRegistered();
  ensureViewCommandsRegistered();
  const delegates = Object.values(createMcpDelegates(() => viewer));
  bound = delegates.flatMap((inst) => listToolEntries(inst)
    .filter((e) => e.command)
    .map((e) => ({
      name: e.name,
      instance: inst as Bound['instance'],
      methodKey: e.methodKey,
      params: e.params.map((p) => p.name),
    })));
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveAssetContext(null);
  setMechanismUiBridge(null);
});

async function callTool(b: Bound, wire: Wire): Promise<Record<string, unknown>> {
  const ordered = b.params.map((p) => wire[p]);
  return JSON.parse(await b.instance[b.methodKey](...ordered)) as Record<string, unknown>;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('parity gate (execution)', () => {
  it('the expectation table covers exactly the bound tools', () => {
    expect(bound.map((b) => b.name).sort()).toEqual(Object.keys(EXPECTED_DISPATCH).sort());
  });

  it('every bound tool: ONE execute with the expected id/args; the value serialises to the pre-migration shape', async () => {
    for (const b of bound) {
      const exp = EXPECTED_DISPATCH[b.name];
      const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: exp.value });
      const res = await callTool(b, exp.wire);
      expect(spy, b.name).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0], b.name).toBe(exp.id);
      expect(spy.mock.calls[0][1], b.name).toEqual(exp.args);
      expect(spy.mock.calls[0][2], b.name).toMatchObject({ origin: 'mcp' });
      expect(res, b.name).toMatchObject(exp.result);
      spy.mockRestore();
    }
  });

  it('every bound tool: a refusal comes back as {error: reason, ...details}', async () => {
    for (const b of bound) {
      const exp = EXPECTED_DISPATCH[b.name];
      const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({
        ok: false, kind: 'disabled', reason: 'X', details: { hint: 1 },
      });
      const res = await callTool(b, exp.wire);
      expect(res, b.name).toEqual({ error: 'X', hint: 1 });
      spy.mockRestore();
    }
  });

  it('with the real registry: a refusing enabled() never reaches run()', async () => {
    const original = commandRegistry.get('editor.toGround') as CommandDescriptor<unknown, unknown>;
    const run = vi.fn();
    commandRegistry.register({ ...original, available: true, impl: async () => ({ enabled: () => ({ reason: 'X' }), run }) });
    setActiveAssetContext({ viewer, doc: { id: 'd', whenIdle: async () => {} } as unknown as ActiveAssetContext['doc'] });
    try {
      const b = bound.find((x) => x.name === 'web_editor_to_ground')!;
      expect(await callTool(b, { path: 'A' })).toEqual({ error: 'X' });
      expect(run).not.toHaveBeenCalled();
    } finally {
      commandRegistry.register(original);
    }
  });

  it('plan-504: anchor / axis without exactly ONE source are refused by run() — enabled said yes, nothing is written', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: ERR_EDITOR_UNAVAILABLE before any rule
    const joint = new Object3D();
    joint.name = 'J';
    joint.userData['realvirtual'] = { KinematicJoint: { JointType: 'Revolute' } };
    const view = {
      nodePath: 'M', name: 'M', active: true, converged: true, residualError: 0, solveTimeMs: 0, disabledReason: '',
      jointCount: 1, linkCount: 0, loopCount: 0, dof: 1, links: [], findings: [], cog: null,
      joints: [{
        nodePath: 'M/J', componentType: 'KinematicJoint', name: 'J', jointType: 'Revolute',
        bodyAName: null, bodyBName: null, bodyAPath: null, bodyBPath: null, worldAnchored: true,
        driveName: null, currentValue: 0, joggable: false, lowerLimit: 0, upperLimit: 0, useLimits: false,
        originWorld: [0, 0, 0], axisWorld: [0, 0, 1],
      }],
    } as unknown as MechanismView;
    setMechanismUiBridge({ list: () => [view], rebuild: vi.fn() } as unknown as MechanismUiBridge);
    const holder = viewer as unknown as { registry: unknown };
    const originalRegistry = holder.registry;
    holder.registry = { getNode: (p: string) => (p === 'M/J' ? joint : null) };
    const withTransaction = vi.fn();
    setActiveAssetContext({
      viewer, doc: { id: 'd', withTransaction, whenIdle: async () => {} } as unknown as ActiveAssetContext['doc'],
    });
    try {
      await commandRegistry.preload(['mechanism.setAnchorSnap', 'mechanism.setAxis']);
      // Readiness: the Anchor / Axis buttons are clickable BEFORE the pick.
      expect(commandRegistry.enabled('mechanism.setAnchorSnap', { path: 'M/J', componentType: 'KinematicJoint', side: 'A' }, viewer)).toBe(true);
      expect(commandRegistry.enabled('mechanism.setAxis', { path: 'M/J', componentType: 'KinematicJoint' }, viewer)).toBe(true);
      const snap = bound.find((x) => x.name === 'web_editor_mechanism_set_anchor_snap')!;
      const axis = bound.find((x) => x.name === 'web_editor_mechanism_set_axis')!;
      // No source.
      expect(await callTool(snap, { path: 'M/J', componentType: 'KinematicJoint', side: 'A' })).toEqual({ error: NEEDS_ANCHOR_SOURCE });
      expect(await callTool(axis, { path: 'M/J', componentType: 'KinematicJoint' })).toEqual({ error: NEEDS_AXIS_SOURCE });
      // Both sources.
      expect(await callTool(snap, {
        path: 'M/J', componentType: 'KinematicJoint', side: 'A', candidateId: 'snap1-0',
        pickJson: '{"nodePath":"M/J","worldPosition":[0,0,0],"worldNormal":[0,0,1]}',
      })).toEqual({ error: NEEDS_ANCHOR_SOURCE });
      expect(await callTool(axis, {
        path: 'M/J', componentType: 'KinematicJoint', candidateId: 'snap1-0', axisWorldJson: '{"x":0,"y":1,"z":0}',
      })).toEqual({ error: NEEDS_AXIS_SOURCE });
      expect(withTransaction).not.toHaveBeenCalled();
    } finally {
      holder.registry = originalRegistry;
    }
  });

  it('pivot: every branch dispatches once with its own button; an unknown mode dispatches nothing', async () => {
    const b = bound.find((x) => x.name === 'web_editor_pivot')!;
    for (const c of PIVOT_CASES) {
      const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: { path: 'A', pivotWorld: null } });
      await callTool(b, c.wire);
      expect(spy, JSON.stringify(c.wire)).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(c.id);
      expect(spy.mock.calls[0][1]).toEqual(c.args);
      if (c.buttonKey) expect(spy.mock.calls[0][2]).toMatchObject({ buttonKey: c.buttonKey });
      spy.mockRestore();
    }
    const spy = vi.spyOn(commandRegistry, 'execute');
    const res = await callTool(b, { path: 'A', mode: 'sideways' });
    expect(spy).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'mode must be bottom | object_center | group_center | align_y_up' });
  });

  it('editor.pivotToCircle (UI-only): a degenerate circle or a meshed node is refused, nothing is written', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: ERR_EDITOR_UNAVAILABLE before any rule
    const axis = new Object3D();
    axis.name = 'Axis';
    const meshed = new Mesh(new BoxGeometry());
    meshed.name = 'Bore';
    const holder = viewer as unknown as { registry: unknown };
    const originalRegistry = holder.registry;
    holder.registry = { getNode: (p: string) => (p === 'M/Axis' ? axis : p === 'M/Bore' ? meshed : null) };
    const withTransaction = vi.fn();
    setActiveAssetContext({
      viewer, doc: { id: 'd', withTransaction, whenIdle: async () => {} } as unknown as ActiveAssetContext['doc'],
    });
    try {
      const run = (args: unknown) => commandRegistry.execute('editor.pivotToCircle', args, { origin: 'ui', viewer });
      // The Quick Edit button's placeholder circle: the node rules alone decide.
      await commandRegistry.preload(['editor.pivotToCircle']);
      expect(commandRegistry.enabled('editor.pivotToCircle', { path: 'M/Axis', worldCenter: [0, 0, 0], worldAxis: [0, 1, 0] }, viewer)).toBe(true);
      // Degenerate axis / malformed circle.
      for (const bad of [
        { path: 'M/Axis', worldCenter: [1, 2, 3], worldAxis: [0, 0, 0] },
        { path: 'M/Axis', worldCenter: [1, 2, 3], worldAxis: [0, Number.NaN, 1] },
        { path: 'M/Axis', worldCenter: [1, 2], worldAxis: [0, 1, 0] },
      ]) {
        expect(await run(bad), JSON.stringify(bad)).toMatchObject({ ok: false, kind: 'disabled', reason: CIRCLE_INVALID });
      }
      // A node with its own mesh: the button's old hasMesh rule, now the command's.
      expect(await run({ path: 'M/Bore', worldCenter: [1, 2, 3], worldAxis: [0, 0, 1] }))
        .toMatchObject({ ok: false, kind: 'disabled', reason: OWN_MESH_PIVOT });
      expect(withTransaction).not.toHaveBeenCalled();
      expect(axis.position.lengthSq()).toBe(0);
    } finally {
      holder.registry = originalRegistry;
    }
  });
});

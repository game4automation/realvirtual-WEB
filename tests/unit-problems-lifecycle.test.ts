// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 §9.5 — unit Problems are DERIVED from the current state, through
 * the binding manager's "binding set changed" notification: report on bind,
 * clear on unbind and bulk unbind, clear on a compatible re-bind, re-report
 * after a reload (applyMappings), follow undo/redo (incl. the unbindAll path),
 * re-evaluate after a repair, pick up a LATE FMU (mapping before meta) through
 * the plugin's FMU trigger, and vanish with the model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { unitRig, type UnitRig } from './helpers/unit-scale-rig';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { RVFmu } from '../src/core/engine/rv-fmu';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';
import type { RVViewer } from '../src/core/rv-viewer';

const FP = 'Drive_FollowPosition';
let rigs: UnitRig[] = [];
function fp(): UnitRig {
  const r = unitRig({ behaviors: { [FP]: {} } });
  rigs.push(r);
  return r;
}
const unitProblems = () => getProblems().filter((p) => p.id.startsWith('unit:'));

beforeEach(() => resetProblemsForTests());
afterEach(() => {
  for (const r of rigs) r.dispose();
  rigs = [];
});

describe('unit problems lifecycle (plan-512 F7)', () => {
  it('bind reports, unbind clears', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    expect(unitProblems().map((p) => p.code)).toEqual(['unit-mismatch']);
    // Unbind through the inspector path: applyMappings + persistence.
    const p = r.persistence();
    const next = p.read().filter((m) => m.slot !== 'Position');
    r.manager.applyMappings(r.nodePath, r.node, next);
    p.write(next);
    expect(unitProblems()).toEqual([]);
    // Unbind leaves the field alone — nothing was written here anyway.
    expect(r.extras(FP, 'Scale')).toBeUndefined();
  });

  it('bulk unbind (empty mapping list) clears; a compatible re-bind clears', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    r.manager.applyMappings(r.nodePath, r.node, []);
    r.persistence().write([]);
    expect(unitProblems()).toEqual([]);
    await r.bind('Position', r.signal('Arm.phi2', 'PLCOutputFloat', 'rad'));
    expect(unitProblems()).toHaveLength(1);
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    expect(unitProblems()).toEqual([]);
    expect(r.extras(FP, 'Scale')).toBe(1000);
  });

  it('a reload re-reports from the persisted mappings (the load pass writes no field)', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    const persisted = r.persistence().read();
    resetProblemsForTests();
    const opsBefore = r.doc.opCount;
    // What the plugin's restore traverse does on load.
    r.manager.applyMappings(r.nodePath, r.node, persisted.map((m) => ({ ...m })));
    expect(unitProblems().map((p) => p.code)).toEqual(['unit-mismatch']);
    expect(r.doc.opCount).toBe(opsBefore);
  });

  it('undo/redo through the scene executors follow the state', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    await r.doc.undo();
    expect(unitProblems()).toEqual([]);
    await r.doc.redo();
    expect(unitProblems()).toHaveLength(1);
  });

  it('a repair (componentPath fixed) re-evaluates the moved mapping', () => {
    const r = fp();
    r.signal('Arm.phi', 'PLCOutputFloat', 'rad');
    const broken: SignalMapping = {
      kind: 'direct-property', componentPath: 'Old/Axis', componentType: FP, slot: 'Position',
      signal: 'Arm.phi', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
    };
    r.manager.applyMappings(r.nodePath, r.node, [broken]);
    r.persistence().write([broken]);
    // Unresolved: no slot, no drive context → no unit statement.
    expect(unitProblems()).toEqual([]);
    const repaired = { ...broken, componentPath: '.' };
    r.persistence().write([repaired]);
    r.manager.applyMappings(r.nodePath, r.node, [repaired]);
    expect(unitProblems().map((p) => p.code)).toEqual(['unit-mismatch']);
  });

  it('a LATE FMU (mapping before meta) is picked up by the plugin; a model switch clears', async () => {
    const r = fp();
    const plugin = new SignalBindPlugin();
    const viewer = Object.assign(r.viewer as unknown as Record<string, unknown>, {
      contextMenu: { register: () => {}, unregister: () => {} },
    }) as unknown as RVViewer;
    plugin.init(viewer);
    plugin.onRender(); // attaches the reconcile to the current manager
    // Bind to a signal the FMU has not registered yet: no unit → no statement.
    await r.bind('Position', { name: 'Ball.phi', interfaceId: 'plc', direction: 'output', dataType: 'PLCOutputFloat', origin: 'connect' });
    expect(unitProblems()).toEqual([]);

    // The FMU attaches afterwards and registers `Ball.phi` [rad].
    const ball = new Object3D();
    ball.name = 'Ball';
    r.scene.add(ball);
    const extras = {
      FmuEmbed: { fileName: 'b.fmu', sha256: 'c'.repeat(64), guid: '{g}', modelName: 'B', fmiVersion: '2.0', byteLength: 1, bufferView: -1 },
      FmuVariables: [{ name: 'phi', valueReference: 1, causality: 'output', variability: 'continuous', type: 'Real', unit: 'rad' }],
    };
    ball.userData.realvirtual = { Fmu: extras };
    r.registry.registerNode(NodeRegistry.computeNodePath(ball), ball);
    const fmu = new RVFmu(ball);
    applySchema(fmu as unknown as Record<string, unknown>, RVFmu.schema, extras);
    fmu.init({ registry: r.registry, signalStore: r.store, scene: r.scene } as unknown as ComponentContext);
    expect(fmu.signalOf('phi')?.name).toBe('Ball.phi');
    expect(unitProblems().map((p) => p.code)).toEqual(['unit-mismatch']);

    plugin.onModelCleared();
    expect(unitProblems()).toEqual([]);
    fmu.dispose();
    plugin.dispose();
  });
});

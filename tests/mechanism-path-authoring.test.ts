// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-729 §9.4 — the MechanismPath / MechanismTarget plan builders.
 *
 * Pure functions returning the primitive intents, so they run against a
 * recording document double — no viewer, no GLB, no wasm (the plan-404 T9
 * pattern). The waypoint list is ONE field: every list edit must be a single
 * `setField` carrying the complete array, or an undo would restore half a list.
 */

import { describe, it, expect } from 'vitest';
import {
  MECHANISM_PATH_TYPE,
  MECHANISM_TARGET_TYPE,
  planAddWaypoint,
  planCreatePath,
  planCreateTarget,
  planRemoveWaypoint,
  planReorderWaypoints,
  readWaypointPaths,
  runMechanismPlan,
  type MechanismDocumentLike,
  type MechanismOpPlan,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';

/** Minimal document double: records primitives and transactions. */
class RecordingDoc implements MechanismDocumentLike {
  readonly ops: { kind: string; nodePath: string; type: string; field?: string; value?: unknown }[] = [];
  transactions = 0;
  async withTransaction(_label: string, fn: () => Promise<void>): Promise<void> {
    this.transactions++;
    await fn();
  }
  addComponent(nodePath: string, baseType: string, fields: Record<string, unknown>): string {
    this.ops.push({ kind: 'addComponent', nodePath, type: baseType, value: fields });
    return baseType;
  }
  setField(nodePath: string, componentType: string, fieldName: string, value: unknown): void {
    this.ops.push({ kind: 'setField', nodePath, type: componentType, field: fieldName, value });
  }
  unsetField(nodePath: string, componentType: string, fieldName: string): void {
    this.ops.push({ kind: 'unsetField', nodePath, type: componentType, field: fieldName });
  }
}

/** The `Path` array of a list plan, as plain node paths. */
function listOf(plan: MechanismOpPlan): string[] {
  expect(plan.intents).toHaveLength(1);
  const intent = plan.intents[0];
  expect(intent.op).toBe('setField');
  if (intent.op !== 'setField') return [];
  expect(intent.fieldName).toBe('Path');
  return readWaypointPaths({ Path: intent.value });
}

describe('plan-729 9.4 — MechanismTarget / MechanismPath plan builders', () => {
  it('planCreateTarget writes one addComponent; an absent speed stays ABSENT', () => {
    const plan = planCreateTarget('Delta/Paths/WP_Pick', { interpolation: 'PointToPoint', waitForSeconds: 0.2 });
    expect(plan.intents).toHaveLength(1);
    const intent = plan.intents[0];
    expect(intent.op).toBe('addComponent');
    if (intent.op !== 'addComponent') return;
    expect(intent.baseType).toBe(MECHANISM_TARGET_TYPE);
    expect(intent.fields).toEqual({ InterpolationToTarget: 'PointToPoint', WaitForSeconds: 0.2 });
    // "Inherit the path speed" is an absent key, never 0 or null.
    expect('SpeedToTarget' in intent.fields).toBe(false);

    const withSpeed = planCreateTarget('X', { speedToTarget: 250, mechanismPath: 'Delta' }).intents[0];
    if (withSpeed.op !== 'addComponent') throw new Error('expected addComponent');
    expect(withSpeed.fields.SpeedToTarget).toBe(250);
    expect(withSpeed.fields.Mechanism).toEqual({
      type: 'ComponentReference', path: 'Delta', componentType: 'realvirtual.KinematicMechanism',
    });
  });

  it('planCreatePath carries mechanism, target link and the seeded list in ONE addComponent', () => {
    const plan = planCreatePath('Delta/Paths/Cycle', 'Delta', 'Delta/Platform', {
      waypoints: ['Delta/Paths/A', 'Delta/Paths/B'], loopPath: true, linearSpeedToTarget: 800,
    });
    expect(plan.intents).toHaveLength(1);
    const intent = plan.intents[0];
    if (intent.op !== 'addComponent') throw new Error('expected addComponent');
    expect(intent.baseType).toBe(MECHANISM_PATH_TYPE);
    expect(intent.fields.Mechanism).toEqual({
      type: 'ComponentReference', path: 'Delta', componentType: 'realvirtual.KinematicMechanism',
    });
    // The TargetLink is a plain NODE reference (the link node, not a component).
    expect(intent.fields.TargetLink).toEqual({
      type: 'ComponentReference', path: 'Delta/Platform', componentType: 'UnityEngine.Transform',
    });
    expect(readWaypointPaths(intent.fields)).toEqual(['Delta/Paths/A', 'Delta/Paths/B']);
    expect((intent.fields.Path as { componentType: string }[])[0].componentType)
      .toBe('realvirtual.MechanismTarget');
    expect(intent.fields.LoopPath).toBe(true);
    expect(intent.fields.LinearSpeedToTarget).toBe(800);
    expect(intent.fields.LinearAcceleration).toBe(1000);
    expect(intent.fields.SpeedOverride).toBe(1);
  });

  it('planAddWaypoint appends, inserts at an index, and allows a repeated waypoint', () => {
    const cur = ['A', 'B'];
    expect(listOf(planAddWaypoint('P', cur, 'C'))).toEqual(['A', 'B', 'C']);
    expect(listOf(planAddWaypoint('P', cur, 'C', 0))).toEqual(['C', 'A', 'B']);
    expect(listOf(planAddWaypoint('P', cur, 'A', 99))).toEqual(['A', 'B', 'A']);
    // The input is never mutated — the caller's list is the prev value.
    expect(cur).toEqual(['A', 'B']);
    // A deduped component key is honoured.
    const intent = planAddWaypoint('P', cur, 'C', undefined, 'MechanismPath_1').intents[0];
    expect(intent.op === 'setField' && intent.componentType).toBe('MechanismPath_1');
  });

  it('planRemoveWaypoint / planReorderWaypoints edit the list; invalid indices make EMPTY plans', () => {
    const cur = ['A', 'B', 'C'];
    expect(listOf(planRemoveWaypoint('P', cur, 1))).toEqual(['A', 'C']);
    expect(planRemoveWaypoint('P', cur, 3).intents).toHaveLength(0);
    expect(planRemoveWaypoint('P', cur, -1).intents).toHaveLength(0);

    expect(listOf(planReorderWaypoints('P', cur, 0, 2))).toEqual(['B', 'C', 'A']);
    expect(listOf(planReorderWaypoints('P', cur, 2, 0))).toEqual(['C', 'A', 'B']);
    expect(planReorderWaypoints('P', cur, 1, 1).intents).toHaveLength(0);
    expect(planReorderWaypoints('P', cur, 0, 5).intents).toHaveLength(0);
  });

  it('readWaypointPaths drops non-references and tolerates a missing list', () => {
    expect(readWaypointPaths(undefined)).toEqual([]);
    expect(readWaypointPaths({ Path: 'nope' })).toEqual([]);
    expect(readWaypointPaths({
      Path: [{ type: 'ComponentReference', path: 'A' }, null, 7, { path: 'B' }],
    })).toEqual(['A']);
  });

  it('every list edit runs as ONE transaction with ONE primitive (one undo step)', async () => {
    const doc = new RecordingDoc();
    await runMechanismPlan(doc, planAddWaypoint('P', ['A'], 'B'));
    await runMechanismPlan(doc, planReorderWaypoints('P', ['A', 'B'], 0, 1));
    await runMechanismPlan(doc, planRemoveWaypoint('P', ['B', 'A'], 0));
    // An empty plan is not even a transaction.
    await runMechanismPlan(doc, planRemoveWaypoint('P', [], 0));
    expect(doc.transactions).toBe(3);
    expect(doc.ops.map((o) => `${o.kind}:${o.field}`)).toEqual([
      'setField:Path', 'setField:Path', 'setField:Path',
    ]);
    expect(readWaypointPaths({ Path: doc.ops[2].value })).toEqual(['A']);
  });
});

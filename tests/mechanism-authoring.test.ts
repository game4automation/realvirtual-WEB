// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-706 T4 / T5 — the two composites this plan adds must stay ATOMIC.
 *
 *  * **T4** — a snap commit writes the anchor AND the body reference as one
 *    unit, with the anchor expressed in that body's local frame. Split across
 *    two undo steps, an undo would leave an anchor stated in the frame of a body
 *    that is no longer assigned: a silently wrong joint rather than a visibly
 *    unfinished one.
 *  * **T5** — `web_editor_mechanism_set_mass` merges up to three builders into
 *    ONE plan. It is one decision ("how heavy is this part"), so it must be one
 *    transaction, and a throw anywhere inside it must leave NO field written.
 *
 * The builders are pure functions, so both run against a recording document
 * double — no viewer, no GLB, no wasm.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Vector3 } from 'three';
import {
  planPickAnchor, planSetComOverride, planSetDensity, planSetMassOverride,
  runMechanismPlan,
  type MechanismDocumentLike, type MechanismOpIntent, type MechanismOpPlan,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';
import { worldPointToAnchorField } from '@rv-private/plugins/asset-editor/mechanism/mechanism-frames';

// ─── Recording double ───────────────────────────────────────────────────────

interface RecordedOp {
  kind: 'addComponent' | 'setField' | 'unsetField';
  nodePath: string;
  componentType: string;
  fieldName?: string;
  value?: unknown;
}

/** Applies primitives to a live map and rolls back on a throw, like the real document. */
class RecordingDoc implements MechanismDocumentLike {
  transactions: { label: string; ops: RecordedOp[] }[] = [];
  state = new Map<string, Record<string, unknown>>();
  /** Set to a field name to make writing THAT field throw. */
  failOnField: string | null = null;

  private _txn: RecordedOp[] | null = null;

  async withTransaction(label: string, fn: () => Promise<void>): Promise<void> {
    const snapshot = new Map([...this.state].map(([k, v]) => [k, { ...v }]));
    this._txn = [];
    try {
      await fn();
      const ops = this._txn;
      this._txn = null;
      this.transactions.push({ label, ops });
    } catch (e) {
      this._txn = null;
      this.state = snapshot;
      throw e;
    }
  }

  addComponent(nodePath: string, baseType: string, fields: Record<string, unknown>): string {
    this._txn?.push({ kind: 'addComponent', nodePath, componentType: baseType });
    this.state.set(`${nodePath}|${baseType}`, { ...fields });
    return baseType;
  }

  setField(nodePath: string, componentType: string, fieldName: string, value: unknown): void {
    if (fieldName === this.failOnField) throw new Error(`boom on ${fieldName}`);
    this._txn?.push({ kind: 'setField', nodePath, componentType, fieldName, value });
    const key = `${nodePath}|${componentType}`;
    this.state.set(key, { ...(this.state.get(key) ?? {}), [fieldName]: value });
  }

  unsetField(nodePath: string, componentType: string, fieldName: string): void {
    if (fieldName === this.failOnField) throw new Error(`boom on ${fieldName}`);
    this._txn?.push({ kind: 'unsetField', nodePath, componentType, fieldName });
    const key = `${nodePath}|${componentType}`;
    const fields = { ...(this.state.get(key) ?? {}) };
    delete fields[fieldName];
    this.state.set(key, fields);
  }
}

// ─── T4 — the snap commit ───────────────────────────────────────────────────

describe('T4 — a snap anchor commit is ONE composite in body-local millimetres', () => {
  /** A body rotated 90° about Y and moved 100 mm along X — no accidental identity. */
  function rotatedBody(): Object3D {
    const parent = new Group();
    const body = new Object3D();
    body.position.set(100, 0, 0);
    body.rotation.set(0, Math.PI / 2, 0);
    parent.add(body);
    parent.updateMatrixWorld(true);
    return body;
  }

  it('writes AnchorB and BodyB, and nothing else', () => {
    const body = rotatedBody();
    const worldPoint = new Vector3(140, 25, -8);
    const plan = planPickAnchor({
      jointPath: 'Mech/Joint1',
      componentType: 'KinematicJoint',
      side: 'B',
      anchor: worldPointToAnchorField(worldPoint, body),
      bodyPath: 'Mech/Arm',
    });
    expect(plan.intents).toHaveLength(2);
    const fields = plan.intents.map((i: MechanismOpIntent) =>
      'fieldName' in i ? i.fieldName : null);
    expect(fields).toEqual(['AnchorB', 'BodyB']);
  });

  it('the anchor equals worldPointToAnchorField for that body, to 1e-6', () => {
    const body = rotatedBody();
    const worldPoint = new Vector3(140, 25, -8);
    const expected = worldPointToAnchorField(worldPoint, body);
    const plan = planPickAnchor({
      jointPath: 'Mech/Joint1', componentType: 'KinematicJoint', side: 'B',
      anchor: worldPointToAnchorField(worldPoint, body), bodyPath: 'Mech/Arm',
    });
    const written = (plan.intents[0] as { value: { x: number; y: number; z: number } }).value;
    expect(written.x).toBeCloseTo(expected.x, 6);
    expect(written.y).toBeCloseTo(expected.y, 6);
    expect(written.z).toBeCloseTo(expected.z, 6);
    // …and the frame really is body-local: the written magnitude is the
    // distance to the BODY origin, not to the world origin. Scene units are
    // metres and the field is millimetres, hence the ×1000.
    const localDistance = body.worldToLocal(worldPoint.clone()).length();
    expect(Math.hypot(written.x, written.y, written.z)).toBeCloseTo(localDistance * 1000, 6);
    expect(localDistance).toBeLessThan(worldPoint.length());
  });

  it('runs in exactly ONE transaction', async () => {
    const doc = new RecordingDoc();
    const body = rotatedBody();
    await runMechanismPlan(doc, planPickAnchor({
      jointPath: 'Mech/Joint1', componentType: 'KinematicJoint', side: 'B',
      anchor: worldPointToAnchorField(new Vector3(140, 25, -8), body),
      bodyPath: 'Mech/Arm',
    }));
    expect(doc.transactions).toHaveLength(1);
    expect(doc.transactions[0].ops).toHaveLength(2);
  });

  it('a world-anchored side is the world point itself — mirrored and scaled only', () => {
    // A null body is not a missing value to guard against: it is the AUTHORED
    // meaning of an absent BodyA, where body-local and world coincide.
    const worldPoint = new Vector3(140, 25, -8);
    const field = worldPointToAnchorField(worldPoint, null);
    expect(field.x).toBeCloseTo(-worldPoint.x * 1000, 6); // Unity mirrors X
    expect(field.y).toBeCloseTo(worldPoint.y * 1000, 6);
    expect(field.z).toBeCloseTo(worldPoint.z * 1000, 6);
  });
});

// ─── T5 — set_mass is one composite, not three ──────────────────────────────

/** What `web_editor_mechanism_set_mass` concatenates, in its own order. */
function massPlan(nodePath: string): MechanismOpPlan {
  return {
    label: 'Set body mass properties',
    intents: [
      ...planSetDensity(nodePath, 'aluminum').intents,
      ...planSetMassOverride(nodePath, null).intents,
      ...planSetComOverride(nodePath, { x: 1, y: 2, z: 3 }).intents,
    ],
  };
}

describe('T5 — set_mass merges three builders into one undo step', () => {
  it('one transaction, and the intents keep their order', async () => {
    const doc = new RecordingDoc();
    await runMechanismPlan(doc, massPlan('Mech/Arm'));
    expect(doc.transactions).toHaveLength(1);
    expect(doc.transactions[0].ops.map((o) => `${o.kind}:${o.fieldName}`)).toEqual([
      'setField:DensityPreset',
      'setField:DensityKgM3',
      'unsetField:MassOverrideKg',
      'setField:ComOverrideLocalMm',
    ]);
  });

  it('clearing an override is an unsetField, never a null write', async () => {
    const doc = new RecordingDoc();
    await runMechanismPlan(doc, massPlan('Mech/Arm'));
    const cleared = doc.transactions[0].ops.find((o) => o.fieldName === 'MassOverrideKg')!;
    expect(cleared.kind).toBe('unsetField');
    expect(doc.state.get('Mech/Arm|MechanismBody')).not.toHaveProperty('MassOverrideKg');
  });

  it('a throw part-way leaves NO field written at all', async () => {
    const doc = new RecordingDoc();
    doc.failOnField = 'ComOverrideLocalMm'; // the last intent
    await expect(runMechanismPlan(doc, massPlan('Mech/Arm'))).rejects.toThrow();
    // The density was applied before the throw and must be gone again — half a
    // mass decision is a body claiming "Aluminium" while weighing like steel.
    expect(doc.transactions).toHaveLength(0);
    expect(doc.state.get('Mech/Arm|MechanismBody')).toBeUndefined();
  });

  it('the density preset and its value always move together', async () => {
    const doc = new RecordingDoc();
    await runMechanismPlan(doc, massPlan('Mech/Arm'));
    const fields = doc.state.get('Mech/Arm|MechanismBody')!;
    expect(fields.DensityPreset).toBe('aluminum');
    expect(fields.DensityKgM3).toBe(2700);
  });
});

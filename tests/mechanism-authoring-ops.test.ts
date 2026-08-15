// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T9 — Mechanism authoring composites (plan-404 §2.6, §9).
 *
 * The load-bearing claim of the authoring design (SOL round-2 finding 1) is that
 * mechanism editing needs NO new op kinds: every action is a composite of the
 * existing generic `addComponent` / `setField` / `unsetField` primitives, run
 * inside `withTransaction`, which already provides one undo unit, atomic
 * rollback and persistence. This suite proves exactly that claim:
 *
 *  - each of the four persistent tools produces the expected generic sequence,
 *  - a world anchor is an ABSENT BodyA key, never an empty/dangling reference,
 *  - clearing a drive is an `unsetField`, not a null write,
 *  - a failing composite rolls back atomically and records NOTHING,
 *  - undo and redo both restore state,
 *  - validate/jog are transient — no plan builder exists for them at all, so
 *    they cannot produce an op even by mistake.
 *
 * Runs unconditionally: pure op plumbing, no wasm and no GLB.
 */

import { describe, it, expect } from 'vitest';
import * as authoring from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';
import {
  planAddJoint, planAssignDrive, planCreateMechanism, planSetAnchor, planSetAxis, planSetLimits,
  runMechanismPlan, JOINT_KINDS, nodeRef, driveRef,
  type MechanismDocumentLike, type MechanismOpIntent,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';

// ─── Recording document double ──────────────────────────────────────────────

interface RecordedOp {
  kind: 'addComponent' | 'setField' | 'unsetField';
  nodePath: string;
  componentType: string;
  fieldName?: string;
  value?: unknown;
  prev?: unknown;
}

/**
 * Mimics `AssetDocument`'s transaction contract: primitives are applied to a
 * live state map, and a body that throws rolls the state back and records
 * nothing — the two properties the real document guarantees and this suite
 * depends on. Also reproduces the `_N` dedup of component keys.
 */
class FakeDocument implements MechanismDocumentLike {
  /** nodePath → componentType → fields. The "live scene". */
  state = new Map<string, Map<string, Record<string, unknown>>>();
  /** Committed ops, newest last — the undo stack. */
  recorded: { label: string; ops: RecordedOp[] }[] = [];
  /** Popped by undo, for redo. */
  redoStack: { label: string; ops: RecordedOp[] }[] = [];

  private _txn: RecordedOp[] | null = null;
  /** Set to a field name to make writing THAT field throw (rollback test). */
  failOnField: string | null = null;

  private _node(path: string): Map<string, Record<string, unknown>> {
    let node = this.state.get(path);
    if (!node) { node = new Map(); this.state.set(path, node); }
    return node;
  }

  async withTransaction(label: string, fn: () => Promise<void>): Promise<void> {
    const snapshot = this._snapshot();
    this._txn = [];
    try {
      await fn();
      const ops = this._txn;
      this._txn = null;
      this.recorded.push({ label, ops });
      this.redoStack = [];
    } catch (e) {
      // All-or-nothing: restore the pre-transaction state, record nothing.
      this._txn = null;
      this._restore(snapshot);
      throw e;
    }
  }

  addComponent(nodePath: string, baseType: string, fields: Record<string, unknown>): string {
    const node = this._node(nodePath);
    let key = baseType;
    for (let n = 1; node.has(key); n++) key = `${baseType}_${n}`;
    node.set(key, { ...fields });
    this._txn?.push({ kind: 'addComponent', nodePath, componentType: key, value: { ...fields } });
    return key;
  }

  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): void {
    if (this.failOnField === fieldName) throw new Error(`injected failure on ${fieldName}`);
    const comp = this._node(nodePath).get(componentType);
    if (!comp) throw new Error(`no component ${componentType} on ${nodePath}`);
    comp[fieldName] = value;
    this._txn?.push({ kind: 'setField', nodePath, componentType, fieldName, value, prev });
  }

  unsetField(nodePath: string, componentType: string, fieldName: string, prev: unknown): void {
    const comp = this._node(nodePath).get(componentType);
    if (!comp) throw new Error(`no component ${componentType} on ${nodePath}`);
    delete comp[fieldName];
    this._txn?.push({ kind: 'unsetField', nodePath, componentType, fieldName, prev });
  }

  readField = (nodePath: string, componentType: string, fieldName: string): unknown =>
    this.state.get(nodePath)?.get(componentType)?.[fieldName];

  /** All primitives of the last committed composite. */
  get lastOps(): RecordedOp[] { return this.recorded[this.recorded.length - 1]?.ops ?? []; }

  fieldsOf(nodePath: string, componentType: string): Record<string, unknown> | undefined {
    return this.state.get(nodePath)?.get(componentType);
  }

  // ── Undo / redo over the committed composites ──
  undo(): void {
    const entry = this.recorded.pop();
    if (!entry) return;
    for (let i = entry.ops.length - 1; i >= 0; i--) this._invert(entry.ops[i]);
    this.redoStack.push(entry);
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    for (const op of entry.ops) this._reapply(op);
    this.recorded.push(entry);
  }

  private _invert(op: RecordedOp): void {
    const node = this._node(op.nodePath);
    if (op.kind === 'addComponent') { node.delete(op.componentType); return; }
    const comp = node.get(op.componentType);
    if (!comp) return;
    if (op.prev === undefined) delete comp[op.fieldName!];
    else comp[op.fieldName!] = op.prev;
  }

  private _reapply(op: RecordedOp): void {
    const node = this._node(op.nodePath);
    if (op.kind === 'addComponent') { node.set(op.componentType, { ...(op.value as object) }); return; }
    const comp = node.get(op.componentType);
    if (!comp) return;
    if (op.kind === 'unsetField') delete comp[op.fieldName!];
    else comp[op.fieldName!] = op.value;
  }

  private _snapshot(): [string, [string, Record<string, unknown>][]][] {
    return [...this.state].map(([path, comps]) =>
      [path, [...comps].map(([k, v]) => [k, { ...v }] as [string, Record<string, unknown>])]);
  }

  private _restore(snap: [string, [string, Record<string, unknown>][]][]): void {
    this.state = new Map(snap.map(([path, comps]) => [path, new Map(comps)]));
  }
}

const NODE = 'Asset/Arm';
const BODY_A = 'Asset/Base';
const BODY_B = 'Asset/Arm';
const DRIVE = 'Asset/Base/Motor';

/** Op kinds of a PLAN's intents (field: `op`). */
function kinds(intents: readonly MechanismOpIntent[]): string[] {
  return intents.map((i) => i.op);
}

/** Op kinds of RECORDED primitives on the document double (field: `kind`). */
function recordedKinds(ops: readonly RecordedOp[]): string[] {
  return ops.map((o) => o.kind);
}

// ─── Plan shape ─────────────────────────────────────────────────────────────

describe('T9 — authoring plans use ONLY generic primitives', () => {
  it('every intent of every plan is addComponent / setField / unsetField', () => {
    // The guard behind SOL round-2 finding 1: if anyone ever adds a bespoke
    // primitive here, this fails before the op union can be touched.
    const allowed = new Set(['addComponent', 'setField', 'unsetField']);
    const plans = [
      planCreateMechanism(NODE),
      planAddJoint({ nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B }),
      planSetAnchor(NODE, 'KinematicJoint', { anchorA: { x: 1, y: 2, z: 3 }, anchorB: { x: 1, y: 2, z: 3 } }),
      planAssignDrive(NODE, 'KinematicJoint', DRIVE),
      planAssignDrive(NODE, 'KinematicJoint', null),
      planSetAxis(NODE, 'KinematicJoint', { x: 0, y: 1, z: 0 }),
      planSetLimits(NODE, 'KinematicJoint', { useLimits: true, lower: -90, upper: 90 }),
    ];
    for (const plan of plans) {
      expect(plan.intents.length).toBeGreaterThan(0);
      for (const intent of plan.intents) expect(allowed.has(intent.op)).toBe(true);
    }
  });

  it('exposes NO plan builder for validate or jog — they are transient by construction', () => {
    // plan-404 §2.6: validate/jog must produce no persistent op and no undo
    // entry. The strongest form of that guarantee is that no builder exists.
    const exported = Object.keys(authoring).filter((k) => k.startsWith('plan'));
    expect(exported.some((k) => /validate/i.test(k))).toBe(false);
    expect(exported.some((k) => /jog/i.test(k))).toBe(false);
  });

  it('offers exactly the four Unity joint kinds', () => {
    expect([...JOINT_KINDS]).toEqual(['Revolute', 'Prismatic', 'Spherical', 'Universal']);
  });
});

describe('T9 — world-anchor semantics (plan-404 §2.4)', () => {
  it('a null Body A OMITS the key entirely — never an empty or dangling ref', () => {
    const plan = planAddJoint({ nodePath: NODE, jointType: 'Revolute', bodyAPath: null, bodyBPath: BODY_B });
    const add = plan.intents[0];
    expect(add.op).toBe('addComponent');
    const fields = (add as Extract<MechanismOpIntent, { op: 'addComponent' }>).fields;
    expect('BodyA' in fields).toBe(false);
    expect(fields.BodyB).toEqual(nodeRef(BODY_B));
  });

  it('a real Body A writes a Transform-typed reference', () => {
    const plan = planAddJoint({ nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B });
    const fields = (plan.intents[0] as Extract<MechanismOpIntent, { op: 'addComponent' }>).fields;
    // `UnityEngine.Transform` is the only componentType the shared resolver maps
    // to a plain scene node — using anything else silently breaks resolution.
    expect(fields.BodyA).toEqual({ type: 'ComponentReference', path: BODY_A, componentType: 'UnityEngine.Transform' });
  });

  it('only a Universal joint gets a SecondaryAxisB default', () => {
    const revolute = planAddJoint({ nodePath: NODE, jointType: 'Revolute', bodyAPath: null, bodyBPath: BODY_B });
    expect('SecondaryAxisB' in (revolute.intents[0] as never as { fields: object }).fields).toBe(false);

    const universal = planAddJoint({ nodePath: NODE, jointType: 'Universal', bodyAPath: null, bodyBPath: BODY_B });
    const fields = (universal.intents[0] as Extract<MechanismOpIntent, { op: 'addComponent' }>).fields;
    expect(fields.SecondaryAxisB).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe('T9 — composite execution', () => {
  it('mechanism_create adds exactly one component with the Unity defaults', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planCreateMechanism(NODE), doc.readField);
    expect(doc.recorded).toHaveLength(1);
    expect(doc.recorded[0].label).toBe('Create mechanism');
    expect(recordedKinds(doc.lastOps)).toEqual(['addComponent']);
    expect(doc.fieldsOf(NODE, 'KinematicMechanism')).toMatchObject({
      SolverIterations: 4, Damping: 0.01, Tolerance: 0.001,
    });
  });

  it('add_joint is ONE composite — no intermediate state without a Body B', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Prismatic', bodyAPath: BODY_A, bodyBPath: BODY_B,
      anchorA: { x: 10, y: 0, z: 0 },
    }), doc.readField);
    expect(doc.recorded).toHaveLength(1);
    expect(doc.lastOps).toHaveLength(1);
    const fields = doc.fieldsOf(NODE, 'KinematicJoint')!;
    expect(fields.JointType).toBe('Prismatic');
    expect(fields.AnchorA).toEqual({ x: 10, y: 0, z: 0 });
    expect(fields.BodyB).toBeDefined();
  });

  it('set_anchor writes both anchors inside ONE undo unit', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B,
    }), doc.readField);
    await runMechanismPlan(doc, planSetAnchor(NODE, 'KinematicJoint', {
      anchorA: { x: 1, y: 2, z: 3 }, anchorB: { x: 1, y: 2, z: 3 },
    }), doc.readField);

    expect(doc.recorded).toHaveLength(2);
    expect(recordedKinds(doc.lastOps)).toEqual(['setField', 'setField']);
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.AnchorB).toEqual({ x: 1, y: 2, z: 3 });
    // Both writes are one entry — a snap is a single undo step.
    doc.undo();
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.AnchorA).toEqual({ x: 0, y: 0, z: 0 });
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.AnchorB).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('assign_drive sets a Drive-typed reference, clearing it UNSETS the key', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B,
    }), doc.readField);

    await runMechanismPlan(doc, planAssignDrive(NODE, 'KinematicJoint', DRIVE), doc.readField);
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.DrivenBy).toEqual(driveRef(DRIVE));

    await runMechanismPlan(doc, planAssignDrive(NODE, 'KinematicJoint', null), doc.readField);
    // A passive joint has NO DrivenBy key — the same shape Unity writes for a
    // null Drive. A null VALUE would be a different, wrong thing.
    expect('DrivenBy' in doc.fieldsOf(NODE, 'KinematicJoint')!).toBe(false);
    expect(recordedKinds(doc.lastOps)).toEqual(['unsetField']);
  });

  it('a later intent inherits the deduped key of the addComponent before it', async () => {
    const doc = new FakeDocument();
    // Two joints on the same node → the second is KinematicJoint_1.
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B,
    }), doc.readField);
    await runMechanismPlan(doc, {
      label: 'Add + configure',
      intents: [
        { op: 'addComponent', nodePath: NODE, baseType: 'KinematicJoint', fields: { JointType: 'Prismatic' } },
        // Empty componentType = "the one just added" — this is what keeps
        // "add and immediately configure" a single composite.
        { op: 'setField', nodePath: NODE, componentType: '', fieldName: 'UseLimits', value: true },
      ],
    }, doc.readField);

    expect(doc.fieldsOf(NODE, 'KinematicJoint_1')).toMatchObject({ JointType: 'Prismatic', UseLimits: true });
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.UseLimits).toBe(false);
  });

  it('set_limits omits the bounds when limits are switched off', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B,
    }), doc.readField);
    await runMechanismPlan(doc, planSetLimits(NODE, 'KinematicJoint', { useLimits: false }), doc.readField);
    expect(recordedKinds(doc.lastOps)).toEqual(['setField']);
  });

  it('an empty plan runs no transaction at all', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, { label: 'noop', intents: [] }, doc.readField);
    expect(doc.recorded).toHaveLength(0);
  });
});

describe('T9 — atomic rollback', () => {
  it('a failing composite restores the previous state and records NOTHING', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B,
    }), doc.readField);
    const committed = doc.recorded.length;
    const before = JSON.stringify(doc.fieldsOf(NODE, 'KinematicJoint'));

    // Fail on the SECOND write of a two-write composite: the first has already
    // been applied when the failure hits, which is exactly the case that used
    // to leave a half-edited joint behind.
    doc.failOnField = 'AnchorB';
    await expect(runMechanismPlan(doc, planSetAnchor(NODE, 'KinematicJoint', {
      anchorA: { x: 9, y: 9, z: 9 }, anchorB: { x: 9, y: 9, z: 9 },
    }), doc.readField)).rejects.toThrow(/injected failure/);

    expect(doc.recorded).toHaveLength(committed);
    expect(JSON.stringify(doc.fieldsOf(NODE, 'KinematicJoint'))).toBe(before);
  });
});

describe('T9 — undo and redo', () => {
  it('undo removes the whole mechanism, redo restores it', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planCreateMechanism(NODE), doc.readField);
    expect(doc.fieldsOf(NODE, 'KinematicMechanism')).toBeDefined();

    doc.undo();
    expect(doc.fieldsOf(NODE, 'KinematicMechanism')).toBeUndefined();

    doc.redo();
    expect(doc.fieldsOf(NODE, 'KinematicMechanism')).toMatchObject({ SolverIterations: 4 });
  });

  it('undo of a drive assignment restores the previous (absent) reference', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: BODY_A, bodyBPath: BODY_B,
    }), doc.readField);
    await runMechanismPlan(doc, planAssignDrive(NODE, 'KinematicJoint', DRIVE), doc.readField);
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.DrivenBy).toBeDefined();

    doc.undo();
    // `prev` was undefined, so the inverse must DELETE the key, not write null.
    expect('DrivenBy' in doc.fieldsOf(NODE, 'KinematicJoint')!).toBe(false);

    doc.redo();
    expect(doc.fieldsOf(NODE, 'KinematicJoint')!.DrivenBy).toEqual(driveRef(DRIVE));
  });

  it('a full authoring session round-trips through undo and redo', async () => {
    const doc = new FakeDocument();
    await runMechanismPlan(doc, planCreateMechanism('Asset'), doc.readField);
    await runMechanismPlan(doc, planAddJoint({
      nodePath: NODE, jointType: 'Revolute', bodyAPath: null, bodyBPath: BODY_B,
    }), doc.readField);
    await runMechanismPlan(doc, planAssignDrive(NODE, 'KinematicJoint', DRIVE), doc.readField);
    const final = JSON.stringify([...doc.state].map(([p, c]) => [p, [...c]]));

    doc.undo(); doc.undo(); doc.undo();
    expect(doc.state.get('Asset')?.size ?? 0).toBe(0);

    doc.redo(); doc.redo(); doc.redo();
    expect(JSON.stringify([...doc.state].map(([p, c]) => [p, [...c]]))).toBe(final);
  });
});

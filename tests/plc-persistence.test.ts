// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-persistence.test.ts — plan-242 Phase 4 (scene persistence of PLC code).
 *
 * The PLC editor persists code through the EXISTING generic `setField` op —
 * no dedicated op kind (plan-242 §2.2). These tests pin that contract at the
 * pure op-log level (pattern: tests/rv-scene-edits.test.ts):
 *  - two rapid Code edits coalesce into ONE history entry (keystroke flood
 *    protection via the SceneStore's same-field window),
 *  - the op materialises into the overlay under PLCProgram.Code,
 *  - inverseOp restores the pre-edit source (undo),
 *  - the editor load path reads Code/Name from node userData (pure
 *    findPlcProgramNode / readPlcProgramData — first node wins, defaults ok).
 *
 * Plan-242 follow-up (node-creation fix): `ensurePlcProgramNode` is async,
 * VERIFIES the addNode against the registry (the executor swallows failures)
 * and reports a distinguishable outcome ('existing' | 'created' |
 * 'live-only'); `persistPlcCodeEnsured` retries the ensure when the target
 * node is missing so autosave ops never silently target a non-existent path.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  type AddNodeOp,
  type PrimitiveEditOp,
  type SetFieldOp,
  COALESCE_WINDOW_MS,
  freshOpId,
  materialise,
  canCoalesce,
  mergeOps,
  inverseOp,
} from '../src/core/hmi/scene/rv-scene-edits';
import {
  ensurePlcProgramNode,
  findPlcProgramNode,
  persistPlcCodeEnsured,
  readPlcProgramData,
  PLC_TEMPLATE_PROGRAM,
  type PlcSceneStoreLike,
  type PlcViewerLike,
} from '@rv-private/plugins/plc/plc-program-node';

const NODE = 'Cell/PLC';

function codeOp(value: string, prev: string | undefined, ts: number): SetFieldOp {
  return {
    id: freshOpId(), ts, schemaV: 1,
    kind: 'setField', nodePath: NODE, componentType: 'PLCProgram', fieldName: 'Code',
    value, prev,
  };
}

// ─── Coalescing (keystroke flood → one history entry) ───────────────────────

describe('PLC code persistence — setField coalescing', () => {
  it('two rapid Code ops coalesce into one entry keeping the original prev', () => {
    const a = codeOp('PROGRAM Main', '', 1000);
    const b = codeOp('PROGRAM Main\nEND_PROGRAM', 'PROGRAM Main', 1200);
    expect(canCoalesce(a, b)).toBe(true);

    const merged = mergeOps(a, b) as SetFieldOp;
    expect(merged.value).toBe('PROGRAM Main\nEND_PROGRAM');
    expect(merged.prev).toBe(''); // undo jumps back to the pre-burst source
    expect(merged.id).toBe(a.id); // ONE history entry
  });

  it('does NOT coalesce outside the window or across fields', () => {
    const a = codeOp('x', '', 1000);
    const late = codeOp('y', 'x', 1000 + COALESCE_WINDOW_MS + 1);
    expect(canCoalesce(a, late)).toBe(false);

    const otherField: SetFieldOp = { ...codeOp('y', 'x', 1100), fieldName: 'Name' };
    expect(canCoalesce(a, otherField)).toBe(false);
  });
});

// ─── Materialisation + undo ─────────────────────────────────────────────────

describe('PLC code persistence — materialise + inverse', () => {
  it('a Code setField op materialises into overlay.nodes[path].PLCProgram.Code', () => {
    const m = materialise([codeOp('PROGRAM P END_PROGRAM', '', 1000)]);
    expect(m.overlay.nodes[NODE].PLCProgram.Code).toBe('PROGRAM P END_PROGRAM');
  });

  it('inverseOp restores the previous source (undo)', () => {
    const op = codeOp('NEW', 'OLD', 1000);
    const inv = inverseOp(op) as SetFieldOp;
    expect(inv.kind).toBe('setField');
    expect(inv.value).toBe('OLD');
  });

  it('inverseOp of a first-ever edit (prev undefined) unsets the override', () => {
    const op = codeOp('NEW', undefined, 1000);
    const inv = inverseOp(op);
    expect(inv.kind).toBe('unsetField');
  });
});

// ─── Editor load path (pure userData read) ──────────────────────────────────

describe('PLC editor load path — code from node userData', () => {
  function plcNode(data: Record<string, unknown>): Object3D {
    const n = new Object3D();
    n.name = 'PLC';
    n.userData.realvirtual = { PLCProgram: data };
    return n;
  }

  it('reads Code + Name from userData.realvirtual.PLCProgram', () => {
    const root = new Object3D();
    root.add(plcNode({ Name: 'LineControl', Code: 'PROGRAM LineControl END_PROGRAM' }));

    const hit = findPlcProgramNode(root);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe('PLC');
    expect(hit!.name).toBe('LineControl');
    expect(hit!.code).toBe('PROGRAM LineControl END_PROGRAM');
  });

  it('first PLCProgram node wins (v1 singleton semantics)', () => {
    const root = new Object3D();
    const first = plcNode({ Name: 'First', Code: 'A' });
    const second = plcNode({ Name: 'Second', Code: 'B' });
    root.add(first);
    root.add(second);

    const hit = findPlcProgramNode(root);
    expect(hit!.name).toBe('First');
    expect(hit!.code).toBe('A');
  });

  it('missing / non-string fields fall back to defaults (pure readPlcProgramData)', () => {
    expect(readPlcProgramData(undefined)).toEqual({ name: 'Main', code: '' });
    expect(readPlcProgramData({ Code: 42 as unknown })).toEqual({ name: 'Main', code: '' });
  });

  it('scene without a PLCProgram yields null (template is used on ensure)', () => {
    expect(findPlcProgramNode(new Object3D())).toBeNull();
    expect(PLC_TEMPLATE_PROGRAM).toContain('PROGRAM Main');
    expect(PLC_TEMPLATE_PROGRAM).toContain('VAR_EXTERNAL');
  });
});

// ─── ensurePlcProgramNode — outcome variants (node-creation fix) ─────────────

/** Mock scene: registered top-level 'Cell' parent; addNode materialises 'Cell/PLC'
 *  only when the store actually ran (mirrors createRuntimeNode + registry). */
function makeEnsureFixture(opts: { materialise?: boolean } = {}) {
  const root = new Object3D();
  root.name = 'Scene';
  const cell = new Object3D();
  cell.name = 'Cell';
  root.add(cell);

  const created = new Object3D();
  created.name = 'PLC';

  const ops: PrimitiveEditOp[] = [];
  let applied = false;
  const store: PlcSceneStoreLike = {
    applyOp: (op) => {
      ops.push(op);
      applied = true;
      return Promise.resolve();
    },
  };

  let refreshed = 0;
  const viewer: PlcViewerLike = {
    scene: root,
    registry: {
      getPathForNode: (n) => (n === cell ? 'Cell' : null),
      getNode: (path) =>
        applied && (opts.materialise ?? true) && path === 'Cell/PLC' ? created : null,
    },
    getPlugin: (id) =>
      id === 'rv-extras-editor' ? { refreshEditableNodes: () => { refreshed++; } } : undefined,
  };

  return { viewer, store, ops, created, refreshCount: () => refreshed };
}

describe('ensurePlcProgramNode — outcome variants', () => {
  it("returns 'existing' when a PLCProgram node is already in the scene", async () => {
    const root = new Object3D();
    const node = new Object3D();
    node.name = 'PLC';
    node.userData.realvirtual = { PLCProgram: { Name: 'Main', Code: 'X' } };
    root.add(node);

    const viewer: PlcViewerLike = { scene: root, registry: null };
    const result = await ensurePlcProgramNode(viewer, null);
    expect(result.outcome).toBe('existing');
    expect(result.path).toBe('PLC');
    expect(result.code).toBe('X');
  });

  it("creates the node via a VERIFIED addNode op → 'created' (+ hierarchy refresh)", async () => {
    const f = makeEnsureFixture();
    const result = await ensurePlcProgramNode(f.viewer, f.store);

    expect(result.outcome).toBe('created');
    expect(result.path).toBe('Cell/PLC');
    expect(result.code).toBe(PLC_TEMPLATE_PROGRAM);

    const op = f.ops[0] as AddNodeOp;
    expect(op.kind).toBe('addNode');
    expect(op.nodePath).toBe('Cell/PLC');
    expect((op.spec.components as Record<string, Record<string, unknown>>).PLCProgram.Code)
      .toBe(PLC_TEMPLATE_PROGRAM);

    // The hierarchy browser only rebuilds from an explicit editable-nodes
    // rescan — a verified creation must trigger exactly one.
    expect(f.refreshCount()).toBe(1);
  });

  it("degrades to 'live-only' without a SceneStore (op never emitted)", async () => {
    const f = makeEnsureFixture();
    const result = await ensurePlcProgramNode(f.viewer, null);
    expect(result.outcome).toBe('live-only');
    expect(result.path).toBe('PLC');
    expect(result.code).toBe(PLC_TEMPLATE_PROGRAM);
    expect(f.ops).toHaveLength(0);
  });

  it("degrades to 'live-only' when no registered parent exists (editor before model load)", async () => {
    const viewer: PlcViewerLike = {
      scene: new Object3D(),
      registry: { getPathForNode: () => null, getNode: () => null },
    };
    const store: PlcSceneStoreLike = { applyOp: () => Promise.resolve() };
    const result = await ensurePlcProgramNode(viewer, store);
    expect(result.outcome).toBe('live-only');
  });

  it("degrades to 'live-only' when the addNode does not materialise (executor swallowed a failure)", async () => {
    const f = makeEnsureFixture({ materialise: false });
    const result = await ensurePlcProgramNode(f.viewer, f.store);
    expect(result.outcome).toBe('live-only');
    expect(f.ops).toHaveLength(1); // op was attempted…
    expect(f.refreshCount()).toBe(0); // …but no refresh without a verified node
  });

  it("degrades to 'live-only' when applyOp rejects", async () => {
    const f = makeEnsureFixture();
    const store: PlcSceneStoreLike = { applyOp: () => Promise.reject(new Error('boom')) };
    const result = await ensurePlcProgramNode(f.viewer, store);
    expect(result.outcome).toBe('live-only');
  });
});

// ─── persistPlcCodeEnsured — autosave guard (node-creation fix) ──────────────

describe('persistPlcCodeEnsured', () => {
  it('persists directly when the target node exists (prev from userData)', async () => {
    const f = makeEnsureFixture();
    f.created.userData.realvirtual = { PLCProgram: { Code: 'OLD' } };
    // Pre-materialise the node: the registry resolves 'Cell/PLC' immediately.
    await ensurePlcProgramNode(f.viewer, f.store);
    f.ops.length = 0;

    const result = await persistPlcCodeEnsured(f.viewer, 'Cell/PLC', 'NEW', f.store);
    expect(result).toEqual({ ok: true, nodePath: 'Cell/PLC' });

    expect(f.ops).toHaveLength(1);
    const op = f.ops[0] as SetFieldOp;
    expect(op.kind).toBe('setField');
    expect(op.nodePath).toBe('Cell/PLC');
    expect(op.fieldName).toBe('Code');
    expect(op.value).toBe('NEW');
    expect(op.prev).toBe('OLD');
  });

  it('re-ensures a missing node first and persists to the RETURNED path (stale live path healed)', async () => {
    const f = makeEnsureFixture();

    // Editor store still points at the live-only fallback path 'PLC'.
    const result = await persistPlcCodeEnsured(f.viewer, 'PLC', 'NEW CODE', f.store);
    expect(result).toEqual({ ok: true, nodePath: 'Cell/PLC' });

    expect(f.ops.map((o) => o.kind)).toEqual(['addNode', 'setField']);
    const setField = f.ops[1] as SetFieldOp;
    expect(setField.nodePath).toBe('Cell/PLC'); // NOT the stale 'PLC'
    expect(setField.value).toBe('NEW CODE');
  });

  it('reports ok=false when even the ensure-retry stays live-only (visible warning path)', async () => {
    const viewer: PlcViewerLike = {
      scene: new Object3D(),
      registry: { getPathForNode: () => null, getNode: () => null },
    };
    const result = await persistPlcCodeEnsured(viewer, null, 'CODE', null);
    expect(result).toEqual({ ok: false, nodePath: null });
  });

  it('skips the op when the code is unchanged (no-op persist)', async () => {
    const f = makeEnsureFixture();
    f.created.userData.realvirtual = { PLCProgram: { Code: 'SAME' } };
    await ensurePlcProgramNode(f.viewer, f.store);
    f.ops.length = 0;

    const result = await persistPlcCodeEnsured(f.viewer, 'Cell/PLC', 'SAME', f.store);
    expect(result.ok).toBe(true);
    expect(f.ops).toHaveLength(0);
  });
});

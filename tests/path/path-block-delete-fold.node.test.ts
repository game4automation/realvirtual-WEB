// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 8.9a — deleting a path block added in this session must not leave
 * its field overrides behind in the scene fold. Found in the browser walkthrough
 * (Lauf 3): after a block delete the autosave bake refused with
 * `NodeNotFoundError … /PathNetwork/PN_Block_2/PN_C1`, because the `successors`
 * write of the earlier link still sat in the overlay for a node that was gone.
 */

import { describe, expect, it } from 'vitest';
import { materialise, type NodeSpec } from '../../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';

let n = 0;
const hdr = () => ({ id: `op_t_${++n}`, ts: n, schemaV: 1 as const });
const spec = (parentPath: string, name: string, components: NodeSpec['components'] = {}): NodeSpec => ({
  parentPath, name, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components,
});
const add = (path: string, parent: string, name: string): RvOp => ({ ...hdr(), kind: 'addNode', nodePath: path, spec: spec(parent, name) }) as RvOp;
const remove = (path: string, parent: string, name: string): RvOp => ({ ...hdr(), kind: 'removeNode', nodePath: path, spec: spec(parent, name) }) as RvOp;
const setField = (path: string, value: unknown): RvOp => ({
  ...hdr(), kind: 'setField', nodePath: path, componentType: 'Path', fieldName: 'Successors', value, prev: null,
}) as RvOp;

const BLOCK = '/PathNetwork/PN_Block_2';
const PIECE = `${BLOCK}/PN_C1`;

describe('plan-628 8.9a removeNode of an added node drops its overrides', () => {
  it('a removed added node leaves no overlay entry (the bake would not find it)', () => {
    const m = materialise([
      add(BLOCK, '/PathNetwork', 'PN_Block_2'),
      add(PIECE, BLOCK, 'PN_C1'),
      // A later link writes the successor list of the (added) piece …
      setField(PIECE, ['PN_S2']),
      // … then the block is deleted (pieces first, then the block).
      remove(PIECE, BLOCK, 'PN_C1'),
      remove(BLOCK, '/PathNetwork', 'PN_Block_2'),
    ]);
    expect(m.addedNodes.map((a) => a.nodePath)).toEqual([]);
    expect(Object.keys(m.overlay.nodes)).toEqual([]);
  });

  it('a re-added node of the same name does not inherit the removed one\'s overrides', () => {
    const m = materialise([
      add(PIECE, '/PathNetwork', 'PN_C1'),
      setField(PIECE, ['PN_S2']),
      remove(PIECE, '/PathNetwork', 'PN_C1'),
      add(PIECE, '/PathNetwork', 'PN_C1'),
    ]);
    expect(m.addedNodes).toHaveLength(1);
    expect(m.addedNodes[0].spec.components.Path).toBeUndefined();
  });

  it('an override of an ORIGINAL node survives a (no-op) removeNode of it', () => {
    const m = materialise([
      setField('/Model/Conveyor', true),
      remove('/Model/Conveyor', '/Model', 'Conveyor'),
    ]);
    expect(m.overlay.nodes['/Model/Conveyor']?.Path?.Successors).toBe(true);
  });

  it('an added child that stays keeps its overrides when only the parent op runs', () => {
    const m = materialise([
      add(BLOCK, '/PathNetwork', 'PN_Block_2'),
      add(PIECE, BLOCK, 'PN_C1'),
      setField(PIECE, ['PN_S2']),
      remove(BLOCK, '/PathNetwork', 'PN_Block_2'),
    ]);
    // The child's own removeNode would drop it; without one it stays an added node with its fields folded in.
    expect(m.addedNodes.map((a) => a.nodePath)).toEqual([PIECE]);
    expect(m.addedNodes[0].spec.components.Path?.Successors).toEqual(['PN_S2']);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Signal collision problems follow the editor (Problems panel, "Signal X is
 * claimed by N components").
 *
 * The collision was only ever REPORTED — when a second owner arrived — so a
 * collision the user resolved by renaming or deleting one owner stayed in the
 * panel until the next model load. And the editor sync registers a moved node's
 * new path before releasing its old one, which briefly counted ONE node twice
 * and reported a collision for a perfectly unique signal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllProblems, getProblem, getProblems, instanceSignalCollisionProblemId, subscribeProblems,
} from '../src/core/hmi/problems-store';
import type { RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { fwd, head, inv, makeSyncFixture, node, plc } from './helpers/signal-sync-fixture';

const DUP = instanceSignalCollisionProblemId('DB.Dup');

const build = () => makeSyncFixture((root) => {
  const a = node('A', root);
  node('Sig', a, plc('PLCOutputBool', 'DB.Dup'));
  const b = node('B', root);
  node('Sig', b, plc('PLCOutputBool', 'DB.Dup'));
  const c = node('C', root);
  node('Unique', c, plc('PLCInputInt', 'DB.Unique'));
  // An unrelated genuine collision that must survive every edit below.
  node('Keep1', c, plc('PLCInputInt', 'DB.Keep'));
  node('Keep2', c, plc('PLCInputInt', 'DB.Keep'));
});

function collisionIds(): string[] {
  return getProblems().filter((p) => p.code === 'instance-signal-collision').map((p) => p.id).sort();
}

describe('instance-signal-collision follows rename / delete', () => {
  beforeEach(() => clearAllProblems());

  it('the load reports both genuine collisions', () => {
    build();
    expect(collisionIds()).toEqual([instanceSignalCollisionProblemId('DB.Dup'), instanceSignalCollisionProblemId('DB.Keep')]);
  });

  it('renaming one owner clears the problem; undo brings it back', async () => {
    const f = build();
    const op: RvAssetOp = { ...head(), kind: 'setField', nodePath: 'Asset/B/Sig', componentType: 'PLCOutputBool', fieldName: 'Name', value: 'DB.Other', prev: 'DB.Dup' };
    await fwd(f, op);
    expect(getProblem(DUP)).toBeUndefined();
    expect(getProblem(instanceSignalCollisionProblemId('DB.Keep'))).toBeDefined();
    await inv(f, op);
    expect(getProblem(DUP)?.title).toBe('Signal "DB.Dup" is claimed by 2 components');
  });

  it('deleting one owner clears the problem', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'deleteNode', nodePath: 'Asset/A' });
    expect(getProblem(DUP)).toBeUndefined();
    expect(getProblem(instanceSignalCollisionProblemId('DB.Keep'))).toBeDefined();
  });

  it('a remaining collision is refreshed with the current owner list', async () => {
    const f = makeSyncFixture((root) => {
      for (const n of ['A', 'B', 'C']) node('Sig', node(n, root), plc('PLCOutputBool', 'DB.Dup'));
    });
    expect(getProblem(DUP)?.title).toBe('Signal "DB.Dup" is claimed by 3 components');
    await fwd(f, { ...head(), kind: 'deleteNode', nodePath: 'Asset/C' });
    const entry = getProblem(DUP);
    expect(entry?.title).toBe('Signal "DB.Dup" is claimed by 2 components');
    expect(entry?.detail).toContain('Asset/A/Sig, Asset/B/Sig');
    expect(entry?.detail).not.toContain('Asset/C/Sig');
  });

  it('renaming the node path of a unique signal never reports a transient collision', async () => {
    const f = build();
    const seen = new Set<string>();
    const off = subscribeProblems(() => { for (const id of collisionIds()) seen.add(id); });
    try {
      await fwd(f, { ...head(), kind: 'renameNode', nodePath: 'Asset/C/Unique', name: 'Moved', prevName: 'Unique' });
      await fwd(f, { ...head(), kind: 'renameNode', nodePath: 'Asset/C', name: 'C2', prevName: 'C' });
    } finally {
      off();
    }
    expect(seen.has(instanceSignalCollisionProblemId('DB.Unique'))).toBe(false);
    expect(getProblem(instanceSignalCollisionProblemId('DB.Unique'))).toBeUndefined();
    // The path move of the colliding pair keeps its genuine collision, with the new paths.
    const keep = getProblem(instanceSignalCollisionProblemId('DB.Keep'));
    expect(keep?.title).toBe('Signal "DB.Keep" is claimed by 2 components');
    expect(keep?.detail).toContain('Asset/C2/Keep1, Asset/C2/Keep2');
  });

  it('a rename INTO an existing name still reports the new collision', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'setField', nodePath: 'Asset/C/Unique', componentType: 'PLCInputInt', fieldName: 'Name', value: 'DB.Keep', prev: 'DB.Unique' });
    expect(getProblem(instanceSignalCollisionProblemId('DB.Keep'))?.title).toBe('Signal "DB.Keep" is claimed by 3 components');
  });
});

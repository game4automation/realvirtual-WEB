// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 History-Interceptor + Replay-Vertrag (SOL R1 #1, R2 #3).
 *
 *  - Rename → normal op → 2× Undo → 2× Redo: the normal op moves on its own,
 *    the rename moves AS A WHOLE (model, overlay, CONNECT, planner, historian);
 *  - a refused undo leaves every stack as it was;
 *  - `meta.journalId` survives a nested transaction and the flattening of a
 *    child composite, at the TOP level of the entry;
 *  - two document stacks (asset + scene): an undo from either document moves
 *    both, exactly once;
 *  - the facades (`AssetDocument`, `SceneStore`) reach the interceptor through
 *    `RvDocument.undo/redo`.
 */

import { describe, expect, it } from 'vitest';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvExecutor } from '../src/core/ops/rv-unified-executors';
import { journalIdOf, type RvOp } from '../src/core/ops/rv-unified-ops';
import { SignalRenameCoordinator } from '../src/core/engine/rv-signal-rename-coordinator';
import { field, head, makeRenameFixture, node, plc, planIn, type RenameFixture } from './helpers/signal-rename-fixture';

function build(opts: { sharedDocument?: boolean } = {}): RenameFixture {
  const f = makeRenameFixture((root) => {
    node('Start', root, plc('PLCInputBool', 'DB.Start'));
    node('Sensor', root, { WebSensor: { SignalBool: 'DB.Start' } });
    node('Lamp', root, { SignalLinks: { Mappings: [{ sourceKind: 'internal', signal: 'DB.Start' }] } });
  }, { connectNames: ['DB.Start'], sharedDocument: opts.sharedDocument });
  f.placed.placements = [{ id: 'p1', signalMappings: [{ sourceKind: 'internal', signal: 'DB.Start' }] }];
  f.historian.selection = ['DB.Start'];
  f.store.set('DB.Start', true);
  return f;
}

const label = (f: RenameFixture) => field(f, 'Asset/Sensor', 'WebSensor', 'Label');

async function rename(f: RenameFixture): Promise<string> {
  const result = await f.coordinator.apply(await planIn(f, 'Asset/Start', 'DB.Go'));
  expect(result.status).toBe('committed');
  return result.journalId!;
}

function expectRenamed(f: RenameFixture, renamed: boolean): void {
  const [now, gone] = renamed ? ['DB.Go', 'DB.Start'] : ['DB.Start', 'DB.Go'];
  expect(f.store.get(now)).toBe(true);
  expect(f.store.get(gone)).toBeUndefined();
  expect(field(f, 'Asset/Start', 'PLCInputBool', 'Name')).toBe(now);
  expect(field(f, 'Asset/Sensor', 'WebSensor', 'SignalBool')).toBe(now);
  expect((field(f, 'Asset/Lamp', 'SignalLinks', 'Mappings') as Array<{ signal: string }>)[0].signal).toBe(now);
  expect(f.placed.placements[0].signalMappings![0].signal).toBe(now);
  expect(f.historian.selection).toEqual([now]);
  expect(f.connect.names.has(now)).toBe(true);
  expect(f.connect.names.has(gone)).toBe(false);
  expect(f.store.hasPendingRename).toBe(false);
}

describe('history interceptor — rename + normal op, 2× undo, 2× redo', () => {
  it('moves the normal op alone and the rename as a whole', async () => {
    const f = build();
    const id = await rename(f);
    await f.asset.applyOp({ ...head(), kind: 'setField', nodePath: 'Asset/Sensor', componentType: 'WebSensor', fieldName: 'Label', value: 'L1', prev: undefined } as RvOp);
    expect(f.asset.opCount).toBe(2);

    await f.asset.undo(); // the normal op — not intercepted
    expect(label(f)).toBeUndefined();
    expectRenamed(f, true);
    expect(f.asset.lastHistoryInterception).toBeNull();

    await f.asset.undo(); // the rename — every store
    expectRenamed(f, false);
    expect(f.asset.lastHistoryInterception).toEqual({ journalId: id, direction: 'undo', verdict: 'handled' });
    expect(f.asset.historyHead()).toMatchObject({ undoLen: 0, redoLen: 2 });
    expect(f.sceneDoc.historyHead()).toMatchObject({ undoLen: 0, redoLen: 1 }); // moved ONCE with the asset undo
    expect(f.connect.calls.filter((c) => !c.preview).map((c) => `${c.from}>${c.to}`)).toEqual(['DB.Start>DB.Go', 'DB.Go>DB.Start']);

    await f.asset.redo(); // the rename again
    expectRenamed(f, true);
    expect(f.sceneDoc.historyHead()).toMatchObject({ undoLen: 1, redoLen: 0 });
    await f.asset.redo(); // the normal op
    expect(label(f)).toBe('L1');
    expect(f.asset.historyHead()).toMatchObject({ undoLen: 2, redoLen: 0 });
    expect(f.coordinator.entry(id)!.applied).toBe(true);
  });

  it('an undo started from the OTHER document moves both stacks exactly once', async () => {
    const f = build();
    await rename(f);
    await f.sceneDoc.undo();
    expectRenamed(f, false);
    expect(f.asset.historyHead()).toMatchObject({ undoLen: 0, redoLen: 1 });
    expect(f.sceneDoc.historyHead()).toMatchObject({ undoLen: 0, redoLen: 1 });
    await f.sceneDoc.redo();
    expectRenamed(f, true);
    expect(f.asset.historyHead()).toMatchObject({ undoLen: 1, redoLen: 0 });
  });

  it('works with ONE document carrying model and overlay', async () => {
    const f = build({ sharedDocument: true });
    await rename(f);
    expect(f.asset.opCount).toBe(1);
    await f.asset.undo();
    expectRenamed(f, false);
    await f.asset.redo();
    expectRenamed(f, true);
  });
});

describe('history interceptor — refusals leave the stacks unchanged', () => {
  it('CONNECT configuration changed since the rename → refused', async () => {
    const f = build();
    const id = await rename(f);
    f.connect.revision++; // a concurrent CONNECT change
    const before = [f.asset.historyHead(), f.sceneDoc.historyHead()];
    await f.asset.undo();
    expect(f.asset.lastHistoryInterception).toEqual({ journalId: id, direction: 'undo', verdict: 'refused' });
    expect([f.asset.historyHead(), f.sceneDoc.historyHead()]).toEqual(before);
    expectRenamed(f, true);
    expect(f.coordinator.entry(id)!.state).toBe('committed');
  });

  it('a tagged entry without a journal (page reloaded) is never undone model-only', async () => {
    const f = build();
    await rename(f);
    const fresh = new SignalRenameCoordinator(f.viewer, () => f.env); // knows no journal
    fresh.attach(f.asset);
    await f.asset.undo();
    expect(f.asset.lastHistoryInterception?.verdict).toBe('refused');
    expectRenamed(f, true);
  });
});

describe('meta.journalId survives transactions', () => {
  const doc = () => {
    const applied: string[] = [];
    const executor: RvExecutor = {
      applyForward: async (op) => { applied.push(`+${op.id}`); },
      applyInverse: async (op) => { applied.push(`-${op.id}`); },
    };
    return new RvDocument({ id: 'd', name: 'D', mode: 'asset', executor });
  };
  const set = (v: string): RvOp => ({ ...head(), kind: 'setField', nodePath: 'A', componentType: 'C', fieldName: 'F', value: v, prev: null } as RvOp);

  it('a nested transaction carries the meta to the TOP level', async () => {
    const d = doc();
    await d.withTransaction('outer', async () => {
      await d.applyOp(set('1'));
      await d.withTransaction('inner', async () => { await d.applyOp(set('2')); }, { meta: { journalId: 'J1' } });
    });
    expect(d.opCount).toBe(1);
    expect(journalIdOf(d.ops[0])).toBe('J1');
    expect(d.ops[0].kind === 'composite' && d.ops[0].ops).toHaveLength(2);
  });

  it('a child composite with a journal id is flattened and its id lifted', async () => {
    const d = doc();
    const child: RvOp = { ...head(), kind: 'composite', label: 'c', ops: [set('a') as never], meta: { journalId: 'J2' } };
    await d.withTransaction('outer', async () => {
      await d.applyOp(child);
      await d.applyOp(set('b'));
    });
    const top = d.ops[0];
    expect(top.kind === 'composite' && top.ops.every((o) => o.kind === 'setField')).toBe(true);
    expect(journalIdOf(top)).toBe('J2');
  });

  it('an ordinary transaction stays untagged (no meta key at all)', async () => {
    const d = doc();
    await d.withTransaction('t', async () => { await d.applyOp(set('x')); });
    expect('meta' in d.ops[0]).toBe(false);
  });
});

describe('facades reach the interceptor', () => {
  it('AssetDocument / SceneStore expose setHistoryInterceptor and route through RvDocument.undo', async () => {
    const { AssetDocument } = await import('../src/core/editor/rv-asset-document');
    const { SceneStore } = await import('../src/core/hmi/scene/scene-store');
    expect(typeof AssetDocument.prototype.setHistoryInterceptor).toBe('function');
    expect(typeof SceneStore.prototype.setHistoryInterceptor).toBe('function');
    // The routing itself: an interceptor on the document answers for the facade's undo.
    const d = doc2();
    const seen: string[] = [];
    d.setHistoryInterceptor(async (entry, dir) => { seen.push(`${dir}:${journalIdOf(entry)}`); return 'refused'; });
    await d.withTransaction('t', async () => {
      await d.applyOp({ ...head(), kind: 'setField', nodePath: 'A', componentType: 'C', fieldName: 'F', value: 1, prev: 0 } as RvOp);
    }, { meta: { journalId: 'JX' } });
    await d.undo();
    expect(seen).toEqual(['undo:JX']);
    expect(d.opCount).toBe(1);
  });
});

function doc2(): RvDocument {
  return new RvDocument({
    id: 'd2', name: 'D2', mode: 'scene',
    executor: { applyForward: async () => {}, applyInverse: async () => {} },
  });
}

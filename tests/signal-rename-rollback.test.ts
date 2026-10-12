// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 reverse phase (SOL R2 #2, #3, #4):
 *
 *  - a failure after the persist (step 4) runs the reverse phase: value,
 *    force pin, listener, writer and the node snapshot are `old` again — the
 *    store MIGRATED back, it never released and re-registered;
 *  - an existing redo branch survives a rename with ST code that fails later;
 *  - the automatic rollback of a failed transaction runs under the reverse
 *    phase (`beforeRollback`), so it migrates too;
 *  - two documents with a diverging head → the undo is refused, nothing moves;
 *  - the interceptor cannot re-enter its own document's undo.
 */

import { describe, expect, it } from 'vitest';
import type { SignalCatalogChange } from '../src/core/engine/rv-signal-store';
import { trackedSignalOf } from '../src/core/engine/rv-signal-construction';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { field, head, makeRenameFixture, node, plc, planIn, type RenameFixture } from './helpers/signal-rename-fixture';

const ST = 'PROGRAM Main\nVAR_EXTERNAL\n  DB.Start : BOOL;\nEND_VAR\nEND_PROGRAM';

function build(): RenameFixture {
  const f = makeRenameFixture((root) => {
    node('Start', root, plc('PLCInputBool', 'DB.Start'));
    node('Sensor', root, { WebSensor: { SignalBool: 'DB.Start' } });
    node('Lamp', root, { SignalLinks: { Mappings: [{ sourceKind: 'internal', signal: 'DB.Start' }] } });
    node('PLC', root, { PLCProgram: { Name: 'Main', Code: ST } });
  }, { connectNames: ['DB.Start'], plc: true });
  f.placed.placements = [{ id: 'p1', signalMappings: [{ sourceKind: 'internal', signal: 'DB.Start' }] }];
  f.historian.selection = ['DB.Start'];
  return f;
}

function catalog(f: RenameFixture): SignalCatalogChange[] {
  const log: SignalCatalogChange[] = [];
  f.store.onCatalogChanged((c) => log.push(c));
  return log;
}

const setLabel = (value: string): RvOp => ({
  ...head(), kind: 'setField', nodePath: 'Asset/Sensor', componentType: 'WebSensor', fieldName: 'Label', value, prev: undefined,
} as RvOp);

describe('reverse phase after a failure at step 4', () => {
  it('value, force, listener, writer and snapshot are back under the old name — migrated, not re-registered', async () => {
    const f = build();
    const startNode = f.registry.getNode('Asset/Start')!;
    f.store.createWriter('hmi:panel', 'hmi').set('DB.Start', true);
    f.store.forceSignal('DB.Start', true);
    const seen: unknown[] = [];
    f.store.subscribe('DB.Start', (v) => seen.push(v));
    const log = catalog(f);
    const plan = await planIn(f, 'Asset/Start', 'DB.Go');
    f.placed.failUpdate = 1; // after CONNECT + both documents persisted

    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('aborted');
    expect(f.coordinator.entry(result.journalId!)!.done).toEqual(['connect', 'asset-doc', 'scene-doc', 'placed']);

    expect(f.store.get('DB.Start')).toBe(true);
    expect(f.store.get('DB.Go')).toBeUndefined();
    expect(f.store.isForced('DB.Start')).toBe(true);
    expect(f.store.getWriterInventory().map((r) => `${r.signal}|${r.writerId}`).sort())
      .toEqual(['DB.Start|hmi:force', 'DB.Start|hmi:panel']);
    expect(trackedSignalOf(f.store, startNode)?.name).toBe('DB.Start');
    expect(f.store.registeredPaths('DB.Start')).toEqual(['Asset/Start']);
    // Only the two moves — never a release / register of the name.
    expect(log.flatMap((c) => c.renamed ?? [])).toEqual([{ from: 'DB.Start', to: 'DB.Go' }, { from: 'DB.Go', to: 'DB.Start' }]);
    expect(log.flatMap((c) => c.released)).toEqual([]);
    expect(f.store.hasPendingRename).toBe(false);
    f.store.unforce('DB.Start');
    f.store.set('DB.Start', false);
    expect(seen).toEqual([false]);
  });
});

describe('redo branch + ST + later failure', () => {
  it('restores the redo branch the user had before the rename', async () => {
    const f = build();
    await f.asset.applyOp(setLabel('A'));
    await f.asset.applyOp(setLabel('B'));
    await f.asset.undo();
    const before = f.asset.historyHead();
    const redoBefore = f.asset.redoBranch().map((o) => o.id);
    expect(before.redoLen).toBe(1);

    const plan = await planIn(f, 'Asset/Start', 'DB.Go');
    expect(plan.steps.some((s) => s.kind === 'plc-program')).toBe(true);
    f.historian.failSet = 1; // the very last forward step fails

    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('aborted');
    expect(f.asset.historyHead()).toEqual(before);
    expect(f.asset.redoBranch().map((o) => o.id)).toEqual(redoBefore);
    expect(field(f, 'Asset/PLC', 'PLCProgram', 'Code')).toBe(ST);
    // The branch is still usable.
    await f.asset.redo();
    expect(field(f, 'Asset/Sensor', 'WebSensor', 'Label')).toBe('B');
  });
});

describe('automatic rollback of a failed transaction', () => {
  it('runs under the reverse phase (the store migrates back inside the rollback)', async () => {
    const f = build();
    f.store.set('DB.Start', true);
    const log = catalog(f);
    const plan = await planIn(f, 'Asset/Start', 'DB.Go');
    f.assetTarget.failField = 'SignalBool'; // the Name step applied, the next one fails → withTransaction rolls back
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('aborted');
    expect(f.asset.opCount).toBe(0);
    expect(f.store.get('DB.Start')).toBe(true);
    expect(log.flatMap((c) => c.renamed ?? [])).toEqual([{ from: 'DB.Start', to: 'DB.Go' }, { from: 'DB.Go', to: 'DB.Start' }]);
    // No release / removal OUTSIDE the two rename events (a rename lists `removed: [from]` by contract).
    expect(log.filter((c) => !c.renamed?.length).flatMap((c) => [...c.released, ...c.removed])).toEqual([]);
    expect(f.connect.names.has('DB.Start')).toBe(true);
  });
});

describe('undo refusals', () => {
  it('two documents with a diverging head → refused, nothing moves', async () => {
    const f = build();
    const result = await f.coordinator.apply(await planIn(f, 'Asset/Start', 'DB.Go'));
    expect(result.status).toBe('committed');
    await f.sceneDoc.applyOp(setLabel('later')); // the overlay moved on
    const heads = [f.asset.historyHead(), f.sceneDoc.historyHead()];
    await f.asset.undo();
    expect(f.asset.lastHistoryInterception?.verdict).toBe('refused');
    expect([f.asset.historyHead(), f.sceneDoc.historyHead()]).toEqual(heads);
    expect(f.store.get('DB.Go')).toBeDefined();
    expect(f.connect.names.has('DB.Go')).toBe(true);
    // CONNECT was never asked: the head check runs BEFORE it.
    expect(f.connect.calls.filter((c) => !c.preview)).toHaveLength(1);
  });

  it('the interceptor cannot re-enter the undo of its own document', async () => {
    const d = new RvDocument({ id: 'd', name: 'D', mode: 'asset', executor: { applyForward: async () => {}, applyInverse: async () => {} } });
    await d.withTransaction('t', async () => { await d.applyOp(setLabel('x')); }, { meta: { journalId: 'J' } });
    let caught: unknown = null;
    d.setHistoryInterceptor(async (_entry, _dir, doc) => {
      try { await doc.undo(); } catch (e) { caught = e; }
      await doc.replayHistory('J', 'undo'); // the sanctioned path: no queue, no interception
      return 'handled';
    });
    await d.undo();
    expect(String(caught)).toContain('re-entrant undo');
    expect(d.historyHead()).toMatchObject({ undoLen: 0, redoLen: 1 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 Phase 4 — the coordinator (plan §2.1, F7, §9 row
 * `signal-rename-coordinator`):
 *
 *  - the journal exists BEFORE the first side effect;
 *  - 409 from CONNECT → nothing changed anywhere;
 *  - a failure after EACH step (asset doc, scene doc, ST, placements,
 *    historian) → complete compensation incl. history and redo branches;
 *  - a lost gateway answer after a successful commit is resolved through the
 *    status endpoint; an outcome nobody can tell locks further renames;
 *  - a compensation that fails → Problems error with a repair action.
 *
 * Real SignalStore / NodeRegistry / AssetExecutorContext / RvDocument; CONNECT,
 * planner, historian and PLC are in-memory doubles (tests/helpers).
 */

import { describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  getSignalRenameCoordinator,
  SIGNAL_RENAME_INCONSISTENT_CODE, SIGNAL_RENAME_RECHECK_COMMAND, SIGNAL_RENAME_REPAIR_COMMAND, signalRenameProblemId,
} from '../src/core/engine/rv-signal-rename-coordinator';
import { trackedSignalOf } from '../src/core/engine/rv-signal-construction';
import { field, head, makeRenameFixture, node, plc, planIn, type RenameFixture } from './helpers/signal-rename-fixture';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

const ST = 'PROGRAM Main\nVAR_EXTERNAL\n  DB.Start : BOOL;\nEND_VAR\nEND_PROGRAM';
const PANEL = '{"buttons":[{"signal":"DB.Start"}]}';

function build(): RenameFixture {
  const f = makeRenameFixture((root) => {
    const cell = node('Cell', root);
    node('Start', cell, plc('PLCInputBool', 'DB.Start'));
    node('Sensor', cell, { WebSensor: { SignalBool: 'DB.Start' } });
    node('Panel', root, { WebOperatorPanel: { Config: PANEL } });
    node('Lamp', root, { SignalLinks: { Mappings: [{ sourceKind: 'internal', signal: 'DB.Start', direction: 'plcOutput', enabled: true }] } });
    node('PLC', root, { PLCProgram: { Name: 'Main', Code: ST } });
  }, { connectNames: ['DB.Start'], plc: true });
  f.placed.placements = [{ id: 'p1', label: 'Conveyor', signalMappings: [{ sourceKind: 'internal', signal: 'DB.Start' }] }];
  f.historian.selection = ['DB.Start'];
  f.store.set('DB.Start', true);
  return f;
}

/** A normal edit on a document (gives it history + a redo branch to protect). */
async function normalEdit(f: RenameFixture, doc: 'asset' | 'scene', value: string): Promise<void> {
  const d = doc === 'asset' ? f.asset : f.sceneDoc;
  await d.applyOp({ ...head(), kind: 'setField', nodePath: 'Asset/Cell/Sensor', componentType: 'WebSensor', fieldName: 'Label', value, prev: undefined } as RvOp);
}

/** Everything that must be exactly as before after a compensated rename. */
function expectUntouched(f: RenameFixture, heads: { asset: unknown; scene: unknown; assetRedo: unknown; sceneRedo: unknown }): void {
  expect(f.store.get('DB.Start')).toBe(true);
  expect(f.store.get('DB.Go')).toBeUndefined();
  expect(f.store.registeredPaths('DB.Start')).toEqual(['Asset/Cell/Start']);
  expect(trackedSignalOf(f.store, f.registry.getNode('Asset/Cell/Start')!)?.name).toBe('DB.Start');
  expect(f.store.hasPendingRename).toBe(false);
  expect(field(f, 'Asset/Cell/Start', 'PLCInputBool', 'Name')).toBe('DB.Start');
  expect(field(f, 'Asset/Cell/Sensor', 'WebSensor', 'SignalBool')).toBe('DB.Start');
  expect(field(f, 'Asset/Panel', 'WebOperatorPanel', 'Config')).toBe(PANEL);
  expect(field(f, 'Asset/PLC', 'PLCProgram', 'Code')).toBe(ST);
  expect((field(f, 'Asset/Lamp', 'SignalLinks', 'Mappings') as Array<{ signal: string }>)[0].signal).toBe('DB.Start');
  expect(f.placed.placements[0].signalMappings![0].signal).toBe('DB.Start');
  expect(f.historian.selection).toEqual(['DB.Start']);
  expect(f.connect.names.has('DB.Start')).toBe(true);
  expect(f.connect.names.has('DB.Go')).toBe(false);
  const ah = f.asset.historyHead();
  const sh = f.sceneDoc.historyHead();
  expect({ undoLen: ah.undoLen, topId: ah.topId }).toEqual(heads.asset);
  expect({ undoLen: sh.undoLen, topId: sh.topId }).toEqual(heads.scene);
  expect({ redoLen: ah.redoLen, redoTopId: ah.redoTopId }).toEqual(heads.assetRedo);
  expect({ redoLen: sh.redoLen, redoTopId: sh.redoTopId }).toEqual(heads.sceneRedo);
}

async function withRedoBranches(f: RenameFixture) {
  await normalEdit(f, 'asset', 'a1');
  await normalEdit(f, 'asset', 'a2');
  await f.asset.undo(); // asset: one undoable, one redoable
  await normalEdit(f, 'scene', 's1');
  await f.sceneDoc.undo(); // scene: one redoable
  const ah = f.asset.historyHead();
  const sh = f.sceneDoc.historyHead();
  return {
    asset: { undoLen: ah.undoLen, topId: ah.topId },
    scene: { undoLen: sh.undoLen, topId: sh.topId },
    assetRedo: { redoLen: ah.redoLen, redoTopId: ah.redoTopId },
    sceneRedo: { redoLen: sh.redoLen, redoTopId: sh.redoTopId },
  };
}

describe('signal rename coordinator — happy path', () => {
  it('commits every store in order and tags one history entry per document', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    expect(plan.ok).toBe(true);
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('committed');
    const entry = f.coordinator.entry(result.journalId!)!;
    expect(entry.state).toBe('committed');
    expect(entry.done).toEqual(['connect', 'asset-doc', 'scene-doc', 'placed', 'historian']);
    expect(entry.renameRevisionBefore).toBe('r1');
    expect(entry.renameRevisionAfter).toBe('r2');

    expect(f.store.get('DB.Go')).toBe(true);
    expect(f.store.get('DB.Start')).toBeUndefined();
    expect(field(f, 'Asset/Cell/Start', 'PLCInputBool', 'Name')).toBe('DB.Go');
    expect(field(f, 'Asset/Cell/Sensor', 'WebSensor', 'SignalBool')).toBe('DB.Go');
    expect(field(f, 'Asset/Panel', 'WebOperatorPanel', 'Config')).toBe('{"buttons":[{"signal":"DB.Go"}]}');
    expect(String(field(f, 'Asset/PLC', 'PLCProgram', 'Code'))).toContain('(* @signal: DB.Go *)');
    expect((field(f, 'Asset/Lamp', 'SignalLinks', 'Mappings') as Array<{ signal: string }>)[0].signal).toBe('DB.Go');
    expect(f.placed.placements[0].signalMappings![0].signal).toBe('DB.Go');
    expect(f.historian.selection).toEqual(['DB.Go']);
    expect(f.connect.names.has('DB.Go')).toBe(true);
    expect(f.plcAdapter!.buffers.get('Asset/PLC')).toContain('DB.Go');
    // ONE tagged entry per document, ST inside the asset entry.
    expect(f.asset.opCount).toBe(1);
    expect(f.sceneDoc.opCount).toBe(1);
    const top = f.asset.ops[0];
    expect(top.kind === 'composite' && top.meta?.journalId).toBe(result.journalId);
    expect(top.kind === 'composite' && top.ops.map((o) => (o as { fieldName?: string }).fieldName))
      .toEqual(['Name', 'SignalBool', 'Config', 'Code']);
    expect(f.store.hasPendingRename).toBe(false);
  });

  it('requires the wire confirmation when CONNECT reports wire effects', async () => {
    const f = build();
    f.connect.wire = [{ interfaceId: 'MQTT', kind: 'json-key', detail: 'key' }];
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    expect((await f.coordinator.apply(plan)).status).toBe('refused');
    expect(f.coordinator.journal()).toEqual([]);
    expect((await f.coordinator.apply(plan, { confirmWireChange: true })).status).toBe('committed');
  });
});

describe('signal rename coordinator — journal and CONNECT', () => {
  it('writes the journal BEFORE the first side effect', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    let seen: unknown = null;
    f.connect.onApply = () => {
      seen = f.coordinator.journal().map((e) => ({ state: e.state, done: [...e.done], heads: Object.keys(e.before.heads) }));
      // Nothing else has moved yet.
      expect(f.asset.opCount).toBe(0);
      expect(f.store.pendingRenameOf('DB.Start')).toBe('DB.Go');
    };
    await f.coordinator.apply(plan);
    expect(seen).toEqual([{ state: 'started', done: [], heads: ['asset-doc', 'scene-doc'] }]);
  });

  it('409 revision-mismatch → aborted, nothing changed', async () => {
    const f = build();
    const heads = await withRedoBranches(f);
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    f.connect.revision++; // someone else changed the CONNECT configuration
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('aborted');
    expect(result.reason).toContain('changed since the preview');
    expect(f.coordinator.entry(result.journalId!)!.state).toBe('aborted');
    expectUntouched(f, heads);
  });

  it('a lost answer after a successful commit is resolved through the status endpoint', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    f.connect.failNext = ['lost-committed'];
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('committed');
    const entry = f.coordinator.entry(result.journalId!)!;
    expect(entry.done[0]).toBe('connect');
    expect(entry.renameRevisionAfter).toBe('r2'); // taken from a dry run of the way back
    expect(f.store.get('DB.Go')).toBe(true);
  });

  it('an outcome nobody can tell → unknown, locked, Re-check resolves it', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    f.connect.failNext = ['lost-pending'];
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('unknown');
    const id = result.journalId!;
    expect(f.coordinator.lockedBy).toBe(id);
    expect(f.store.hasPendingRename).toBe(false);
    expect(f.asset.opCount).toBe(0);
    const problem = f.problems.entries.get(signalRenameProblemId(id))!;
    expect(problem.code).toBe(SIGNAL_RENAME_INCONSISTENT_CODE);
    expect(problem.action).toEqual({ label: 'Re-check', commandId: SIGNAL_RENAME_RECHECK_COMMAND, args: { journalId: id } });

    // Further renames are locked.
    const second = await f.coordinator.apply(await planIn(f, 'Asset/Cell/Start', 'DB.Go'));
    expect(second.status).toBe('refused');

    // The gateway finally reports: it DID commit → the coordinator puts it back.
    const opId = f.coordinator.entry(id)!.operationId;
    f.connect.names.delete('DB.Start'); f.connect.names.add('DB.Go'); f.connect.revision++;
    f.connect.statuses.set(opId, 'committed');
    expect(await f.coordinator.recheck(id)).toBe('aborted');
    expect(f.connect.names.has('DB.Start')).toBe(true);
    expect(f.coordinator.lockedBy).toBeNull();
    expect(f.problems.entries.size).toBe(0);
  });
});

describe('signal rename coordinator — failure after each step → full compensation', () => {
  const cases: Array<[string, (f: RenameFixture) => void]> = [
    ['asset-doc', (f) => { f.assetTarget.failField = 'Config'; }],
    ['st', (f) => { f.plcAdapter!.failWrite = 1; }],
    ['scene-doc', (f) => { f.sceneTarget.failField = 'Mappings'; }],
    ['placed', (f) => { f.placed.failUpdate = 1; }],
    ['historian', (f) => { f.historian.failSet = 1; }],
  ];
  for (const [step, inject] of cases) {
    it(`fails at ${step}`, async () => {
      const f = build();
      const heads = await withRedoBranches(f);
      const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
      const seen: unknown[] = [];
      f.store.subscribe('DB.Start', (v) => seen.push(v));
      f.store.forceSignal('DB.Start', true);
      inject(f);
      const result = await f.coordinator.apply(plan);
      expect(result.status).toBe('aborted');
      const entry = f.coordinator.entry(result.journalId!)!;
      expect(entry.state).toBe('aborted');
      expect(entry.applied).toBe(false);
      expect(entry.done).toContain('connect');
      expectUntouched(f, heads);
      expect(f.store.isForced('DB.Start')).toBe(true);
      f.store.unforce('DB.Start');
      f.store.set('DB.Start', false);
      expect(seen).toContain(false); // the listener survived the round trip
      expect(f.plcAdapter!.buffers.get('Asset/PLC') ?? ST).toBe(ST);
      expect(f.problems.entries.size).toBe(0);
    });
  }
});

describe('signal rename coordinator — failed compensation', () => {
  it('→ inconsistent, Problems error with Repair; Repair finishes the job', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Cell/Start', 'DB.Go');
    f.placed.failUpdate = 1;               // step 4 fails …
    f.connect.failNext = [undefined as never, 'error', 'error', 'error']; // … and the inverse CONNECT call has no answer
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('inconsistent');
    const id = result.journalId!;
    const entry = f.coordinator.entry(id)!;
    expect(entry.state).toBe('inconsistent');
    expect(entry.pendingRepair).toEqual(['connect']);
    const problem = f.problems.entries.get(signalRenameProblemId(id))!;
    expect(problem.code).toBe(SIGNAL_RENAME_INCONSISTENT_CODE);
    expect(problem.severity).toBe('error');
    expect(problem.action).toEqual({ label: 'Repair', commandId: SIGNAL_RENAME_REPAIR_COMMAND, args: { journalId: id } });
    // The local side is back; CONNECT still has the new name.
    expect(f.store.get('DB.Start')).toBe(true);
    expect(f.connect.names.has('DB.Go')).toBe(true);

    f.connect.failNext = [];
    expect(await f.coordinator.repair(id)).toBe('aborted');
    expect(f.connect.names.has('DB.Start')).toBe(true);
    expect(f.problems.entries.size).toBe(0);
  });
});

describe('default wiring', () => {
  it('accepts a real RVViewer (type check) and caches one coordinator per viewer', () => {
    const viewerType: Parameters<typeof getSignalRenameCoordinator>[0] = null as unknown as RVViewer;
    expect(viewerType).toBeNull();
    const f = build();
    const a = getSignalRenameCoordinator(f.viewer, () => f.env);
    expect(getSignalRenameCoordinator(f.viewer)).toBe(a);
  });
});

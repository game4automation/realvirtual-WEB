// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { createSelf } from '../../src/core/material-flow/material-flow-self';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { writeComponentField } from '../../src/core/params/rv-param-field';
import { getProblems, clearAllProblems } from '../../src/core/hmi/problems-store';
import { recordDocumentStream, clearModelContentLedger, whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';

const runners: DESRunner[] = [];
afterEach(() => {
  runners.splice(0).forEach(r => r.dispose());
  vi.unstubAllGlobals();
  clearAllProblems(); clearModelContentLedger();
});

function fixture(mainDocumentKey: string | null = null) {
  const node = new Object3D(), mover = new Object3D(), undeclared = new Object3D();
  node.add(mover, undeclared);
  const addresses = new Map([[node, '#root'], [mover, '#mover'], [undeclared, '#other']]);
  const registry = { getAddressForNode: (n: Object3D) => addresses.get(n) ?? null,
    forEachNode: (cb: (p: string, n: Object3D) => void) => addresses.forEach((p, n) => cb(p, n)) };
  const host = { registry, mainDocumentKey, drives: [], signalStore: new SignalStore(),
    contextMenu: new ContextMenuStore(), on: () => () => {}, getPlugin: () => undefined };
  const def: MaterialFlowDefinition = { type: 'SnapshotMover', kind: 'conveyor', schema: {},
    continuous: {}, des: { movedNodes: () => [mover] } };
  const runner = new DESRunner(); runners.push(runner);
  const { ctx } = createBindContext(node, host as unknown as BindContextHost, {});
  const self = createSelf(ctx, def, { mode: 'des' });
  runner.addInstance(def, self, node, undefined, { desId: '#root@SnapshotMover' });
  runner.start([def], { root: node, host: host as unknown as BindContextHost });
  return { runner, node, mover, undeclared };
}

it('rejects a parameter edit after start, even if the value is restored', () => {
  const { runner, node } = fixture();
  expect(runner.fingerprintAtBind()).toMatchObject({ ok: true });
  writeComponentField(node, 'Conveyor', 'Speed', 7);
  expect(runner.fingerprintNow()).toMatchObject({ ok: false,
    reasons: ['model changed since run start \u2014 restart the run'] });
});
it('run motion after bind keeps the fingerprint; an authored edit is refused (plan-2059 C5: scene rows fixed at bind)', () => {
  const { runner, node, mover, undeclared } = fixture();
  const bind = runner.fingerprintAtBind();
  mover.position.x = 42;
  expect(runner.fingerprintNow()).toEqual(bind);
  // HMI buttons, carriers and other run-time movers are not model: same hash.
  undeclared.position.x = 42;
  expect(runner.fingerprintNow()).toEqual(bind);
  writeComponentField(node, 'Conveyor', 'Speed', 7);
  expect(runner.fingerprintNow()).toMatchObject({ ok: false });
});
it('a model without a file host is legal', () => {
  const runner = new DESRunner(); runners.push(runner);
  runner.start([], { root: new Object3D() });
  expect(runner.fingerprintAtBind()).toMatchObject({ ok: true });
});
it('reports missing document hashes at start', () => {
  const { runner } = fixture('unrecorded-main');
  expect(runner.fingerprintAtBind()).toMatchObject({ ok: false });
  expect(getProblems()).toContainEqual(expect.objectContaining({ code: 'des-snapshot-fingerprint',
    title: 'Model changed',
    detail: expect.stringContaining('document was never recorded') }));
});

it('retains the start input while document hashes settle', async () => {
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  async function* chunks() { await gate; yield new Uint8Array(4); }
  recordDocumentStream('pending-main', chunks());
  const { runner, undeclared } = fixture('pending-main');
  expect(runner.fingerprintAtBind()).toEqual({ pending: true });
  undeclared.position.x = 10;
  complete();
  await whenDocumentHashesSettled();
  await Promise.resolve();
  expect(runner.fingerprintAtBind()).toMatchObject({ ok: true });
  // The rows of the bind are kept: the move during the pending digest does not enter.
  expect(runner.fingerprintNow()).toEqual(runner.fingerprintAtBind());
});
it('script identity diagnostics include missing ids and both duplicate holders', () => {
  const { runner } = fixture();
  const adapter = { captureScriptState: () => null, restoreScriptState: () => {} };
  runner.setScriptComponentSource(() => [
    { path: 'a', desId: '#script@WebComponent', source: '', adapter },
    { path: 'b', desId: '#script@WebComponent', source: '', adapter },
    { path: 'c', desId: null, source: '', adapter },
  ]);
  expect(runner.desIdentity().unaddressable.map(e => e.label).sort()).toEqual(['a', 'b', 'c']);
  expect(runner.fingerprintNow()).toMatchObject({ ok: false });
});

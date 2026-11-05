// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2233 (Codex R2): a UI unbind / bulk action that waits in the bind queue computes its
 * next mapping list INSIDE its queue job — from what is stored when it runs, not from the
 * snapshot of the click. Otherwise a waiting unbind overwrites a change made meanwhile, and two
 * waiting unbinds resurrect each other's removed binding.
 *
 * Inline slot rows (`ComponentSignalSlots`) and the bulk header actions (`component-bulk-actions`)
 * on the shared inline fixture; the queue is held with `runInBindQueue` exactly as a composite
 * edit (a wall template) holds it. The undo/redo case runs on a real `RvDocument` with the scene
 * executors (SignalLinks sync), so every queued write is one undo step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ComponentSignalSlots } from '../src/plugins/signal-bind/InlineSignalSlots';
import {
  registerSignalBulkActions,
  _resetBulkActionStateForTesting,
} from '../src/plugins/signal-bind/component-bulk-actions';
import { componentActionRegistry, type ComponentActionContext } from '../src/core/hmi/rv-component-action-registry';
import {
  createSignalBindingPersistence, syncNodeSignalBindingPersistence,
} from '../src/plugins/signal-bind/signal-binding-persistence';
import { runInBindQueue } from '../src/core/hmi/rv-bind-queue';
import { getActiveEditTarget, setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { getConnectSnapshot } from '../src/core/hmi/connect-store';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvSceneOp } from '../src/core/ops/rv-unified-ops';
import { freshOpId } from '../src/core/ops/rv-op-utils';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';
import { makeInlineSlotFixture } from './_inline-slot-fixture';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

vi.mock('../src/core/hmi/connect-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/connect-store')>();
  return { ...actual, getConnectSnapshot: vi.fn(() => actual.getConnectSnapshot()) };
});

const FORWARD: SignalMapping = {
  kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
  sourceKind: 'internal', signal: 'ModelSig', direction: 'plcOutput', enabled: true,
};
const BACKWARD: SignalMapping = {
  kind: 'direct-property', componentPath: '.', slot: 'Backward',
  sourceKind: 'internal', signal: 'ModelSig', direction: 'plcOutput', enabled: true,
};

type Fixture = ReturnType<typeof makeInlineSlotFixture>;

/** Bind `mappings` the way a loaded document holds them (runtime + persisted). */
function bound(f: Fixture, mappings: SignalMapping[]) {
  const applied = f.mgr.applyMappings(f.nodePath, f.node, mappings);
  f.node.userData.realvirtual.SignalLinks = { Mappings: applied };
  const target = { kind: 'node' as const, nodePath: f.nodePath, node: f.node, label: f.node.name };
  const persistence = createSignalBindingPersistence(f.viewer, target);
  // The loaded state, not an edit: no op, no undo step.
  syncNodeSignalBindingPersistence(f.node, applied);
  return { persistence, slots: () => persistence.read().map((m) => m.slot).sort() };
}

function renderSlots(f: Fixture) {
  return render(<ComponentSignalSlots
    viewer={f.viewer}
    signalStore={f.store}
    nodePath={f.nodePath}
    componentType="Drive_Simple"
    data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
  />);
}

const unbindButton = (container: HTMLElement, slot: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[aria-label="unbind ${slot}"]`)!;

/** A real document with the scene executors; its edit target lands every write as an op. */
function withDocument(f: Fixture): RvDocument {
  Object.assign(f.viewer as object, {
    // No `modes`: signal linking is offered (signal-link-gate), as in the inline fixture.
    markRenderDirty: () => {}, logicEngine: null, currentModelRoot: null,
    on: () => () => {},
  });
  const viewer = f.viewer;
  const doc = new RvDocument({
    id: `unbind-queue-${Math.random()}`, name: 'unbind-queue', mode: 'scene', canApply: () => true,
    executor: {
      applyForward: (op) => applyForward(op as RvSceneOp, { viewer }),
      applyInverse: (op) => applyInverse(op as RvSceneOp, { viewer }),
    },
  });
  const mkOp = (p: string, c: string, fl: string, v: unknown, prev: unknown) => ({
    id: freshOpId(), ts: Date.now(), schemaV: 1 as const, kind: 'setField' as const,
    nodePath: p, componentType: c, fieldName: fl, value: v, prev,
  });
  const et: EditTarget = {
    available: true, documentKey: doc,
    setField(p, c, fl, v, prev) { doc.applyOpDetached(mkOp(p, c, fl, v, prev)); },
    setFieldAsync(p, c, fl, v, prev) { return doc.applyOp(mkOp(p, c, fl, v, prev)); },
    unsetField() { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(et);
  return doc;
}

afterEach(() => { cleanup(); setActiveEditTarget(null); });

describe('UI unbinds compute their mapping inside the queue job (plan-2233)', () => {
  it('two inline unbinds waiting behind a held queue: both bindings end up removed (no resurrection)', async () => {
    const f = makeInlineSlotFixture();
    const b = bound(f, [FORWARD, BACKWARD]);
    expect(b.slots()).toEqual(['Backward', 'Forward']);
    const ui = renderSlots(f);
    await runInBindQueue(getActiveEditTarget(), async () => {
      fireEvent.click(unbindButton(ui.container, 'Forward'));
      fireEvent.click(unbindButton(ui.container, 'Backward'));
      // Still waiting: nothing written while the holder runs.
      expect(b.slots()).toEqual(['Backward', 'Forward']);
    });
    await vi.waitFor(() => expect(b.slots()).toEqual([]));
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Forward', '.')).toBeUndefined();
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Backward', '.')).toBeUndefined();
  });

  it('an inline unbind waiting behind a held queue keeps a binding made meanwhile', async () => {
    const f = makeInlineSlotFixture();
    const b = bound(f, [FORWARD]);
    const ui = renderSlots(f);
    await runInBindQueue(getActiveEditTarget(), async () => {
      fireEvent.click(unbindButton(ui.container, 'Forward'));
      // The holder (e.g. a template) binds another slot of the same target.
      b.persistence.write(f.mgr.applyMappings(f.nodePath, f.node, [FORWARD, BACKWARD]));
    });
    await vi.waitFor(() => expect(b.slots()).toEqual(['Backward']));
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Backward', '.')).toBeDefined();
  });

  it('undo / redo after queued inline unbinds: the document restores and re-removes both, in queue order', async () => {
    const f = makeInlineSlotFixture();
    const doc = withDocument(f);
    const b = bound(f, [FORWARD, BACKWARD]);
    await doc.whenIdle();
    const ui = renderSlots(f);
    const undo = doc.historyHead().undoLen;
    await runInBindQueue(getActiveEditTarget(), async () => {
      fireEvent.click(unbindButton(ui.container, 'Forward'));
      fireEvent.click(unbindButton(ui.container, 'Backward'));
    });
    await vi.waitFor(() => expect(b.slots()).toEqual([]));
    // Two consecutive writes of the same SignalLinks field: the document folds them into one
    // step (canCoalesceRvOps — its rule for repeated edits of one field, not the queue's).
    await vi.waitFor(() => expect(doc.historyHead().undoLen).toBe(undo + 1));
    await doc.undo();
    expect(b.slots()).toEqual(['Backward', 'Forward']);
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Forward', '.')).toBeDefined();
    await doc.redo();
    expect(b.slots()).toEqual([]);
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Backward', '.')).toBeUndefined();
  });
});

describe('bulk header actions compute their mapping inside the queue job (plan-2233)', () => {
  beforeEach(() => {
    _resetBulkActionStateForTesting();
    registerSignalBulkActions();
  });

  const ctxFor = (f: Fixture): ComponentActionContext => ({
    node: f.node, nodePath: f.nodePath, viewer: f.viewer, componentType: 'Drive_Simple',
    componentData: f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>,
  });
  const action = (id: string) => componentActionRegistry.get('Drive_Simple').find((a) => a.id === id)!;

  it('Auto-assign waiting behind a held queue keeps a binding made meanwhile', async () => {
    vi.mocked(getConnectSnapshot).mockReturnValue({
      interfaces: [{ id: 'plc', signals: [{ name: 'Forward', type: 'PLCOutputBool' }] }],
    } as unknown as ReturnType<typeof getConnectSnapshot>);
    const f = makeInlineSlotFixture();
    const b = bound(f, []);
    const ctx = ctxFor(f);
    const auto = action('signal-auto-assign');
    auto.onClick(ctx); // arm
    await runInBindQueue(getActiveEditTarget(), async () => {
      auto.onClick(ctx); // apply — queued
      b.persistence.write(f.mgr.applyMappings(f.nodePath, f.node, [BACKWARD]));
    });
    await vi.waitFor(() => expect(b.slots()).toEqual(['Backward', 'Forward']));
  });

  it('Unbind all waiting behind a held queue removes what is bound when it runs, also a binding made meanwhile', async () => {
    const f = makeInlineSlotFixture();
    const b = bound(f, [FORWARD]);
    const ctx = ctxFor(f);
    const unbind = action('signal-unbind-all');
    unbind.onClick(ctx); // arm
    await runInBindQueue(getActiveEditTarget(), async () => {
      unbind.onClick(ctx); // execute — queued
      b.persistence.write(f.mgr.applyMappings(f.nodePath, f.node, [FORWARD, BACKWARD]));
    });
    await vi.waitFor(() => expect(b.slots()).toEqual([]));
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Backward', '.')).toBeUndefined();
  });

  it('undo / redo after a queued Unbind all: one step', async () => {
    const f = makeInlineSlotFixture();
    const doc = withDocument(f);
    const b = bound(f, [FORWARD, BACKWARD]);
    await doc.whenIdle();
    const ctx = ctxFor(f);
    const unbind = action('signal-unbind-all');
    const undo = doc.historyHead().undoLen;
    unbind.onClick(ctx);
    unbind.onClick(ctx);
    await vi.waitFor(() => expect(b.slots()).toEqual([]));
    await vi.waitFor(() => expect(doc.historyHead().undoLen).toBe(undo + 1));
    await doc.undo();
    expect(b.slots()).toEqual(['Backward', 'Forward']);
    await doc.redo();
    expect(b.slots()).toEqual([]);
  });
});

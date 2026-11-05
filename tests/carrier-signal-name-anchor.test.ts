// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * carrier-signal-name-anchor — a moved carrier is NOT re-homed by its signal name
 * (plan-2234, contract-node-identity R4/R10; replaces plan-425 F2 "case A").
 *
 * The anchor (`carrierSignalName`) is still written and still legible from the op
 * side (that read stays tested below — plan-2236 builds its adopt offer on it).
 * What changed: loading no longer MOVES the carrier's ops to whichever node carries
 * that name today. Moving them was an automatic, persisted name fallback. The
 * carrier stays an orphan, its ops stay as they are, the `orphaned-bindings`
 * notice names it — also when a same-named signal hangs on another node.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import {
  findOrphanedBindingCarriers,
  findOrphanedBindingPaths,
} from '../src/plugins/signal-bind/orphaned-bindings';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerSignal, resetDuplicateSignalNames } from '../src/core/engine/rv-signal-construction';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { setSceneStore } from '../src/core/hmi/scene/scene-store-ref';
import { clearSceneSyncNotices, onSceneSyncNotice, type SceneSyncNotice } from '../src/core/hmi/scene/rv-scene-live-sync';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';

import { setActiveEditTarget } from '../src/core/hmi/rv-edit-target';

/** A recording edit target — any write the load would make lands here. */
const editTarget = {
  available: true,
  setField: vi.fn(),
  unsetField: vi.fn(),
  setFieldAsync: vi.fn(),
  withTransaction: vi.fn(async (_label: string, fn: () => Promise<void> | void) => { await fn(); }),
};

const OLD_PATH = 'Cell/OldGroup/Motor_Run';
const NEW_PATH = 'Cell/Machine/Signals/Motor_Run';
const SIGNAL = 'Motor.Run';

const MAPPING = {
  kind: 'mapped-signal' as const,
  slot: 'Value',
  signal: 'PLC.Start',
  direction: 'plcInput' as const,
  enabled: true,
  carrierSignalName: SIGNAL,
};

/** The op a user's earlier bind actually left in the log. */
function setFieldOp(nodePath: string, mappings: unknown): RvOp {
  return {
    id: `op-${nodePath}`, ts: 1, schemaV: 1,
    kind: 'setField', nodePath, componentType: 'SignalLinks', fieldName: 'Mappings',
    value: mappings, prev: undefined,
  } as RvOp;
}

function registryWith(paths: readonly string[]) {
  const set = new Set(paths);
  return { getNode: (path: string) => (set.has(path) ? {} : undefined) };
}

/** A store + registry where `SIGNAL` lives at `path` — the same-named signal elsewhere. */
function storeWith(paths: readonly string[]) {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  for (const path of paths) {
    const node = new Object3D();
    node.name = SIGNAL;
    registry.registerNode(path, node);
    registerSignal(node, 'PLCOutputBool', { Name: SIGNAL, Status: { Value: false } },
      path, store, registry);
  }
  return { store, registry };
}

afterEach(() => {
  resetDuplicateSignalNames(new SignalStore());
  setSceneStore(null as never);
  clearSceneSyncNotices();
  setActiveEditTarget(null);
  vi.clearAllMocks();
});

describe('reading the anchor out of the op payload', () => {
  it('finds the carrier AND keeps its mappings — the anchor is in the payload', () => {
    const overlay = materialise([setFieldOp(OLD_PATH, [MAPPING])]).overlay;
    const carriers = findOrphanedBindingCarriers(overlay, registryWith([NEW_PATH]));
    expect(carriers).toHaveLength(1);
    expect(carriers[0].nodePath).toBe(OLD_PATH);
    // This is the whole point: the old path-only scan threw this away.
    expect(carriers[0].mappings[0].carrierSignalName).toBe(SIGNAL);
  });

  it('agrees with the path-only scan about WHICH carriers are orphaned', () => {
    const overlay = materialise([
      setFieldOp(OLD_PATH, [MAPPING]),
      setFieldOp(NEW_PATH, [MAPPING]),
    ]).overlay;
    const registry = registryWith([NEW_PATH]);
    expect(findOrphanedBindingCarriers(overlay, registry).map((c) => c.nodePath))
      .toEqual(findOrphanedBindingPaths(overlay, registry));
  });
});

describe('loading never re-homes a carrier by its signal name (plan-2234)', () => {
  it('a missing carrier with a same-named signal elsewhere: no move, no write, the notice names it', async () => {
    const ops: RvOp[] = [setFieldOp(OLD_PATH, [MAPPING])];
    const before = JSON.stringify(ops);
    setSceneStore({ getSnapshot: () => ({ draft: { edits: { ops } } }) } as never);
    const { store, registry } = storeWith([NEW_PATH]);
    expect(store.getPath(SIGNAL)).toBe(NEW_PATH); // the name now answers on another node
    const viewer = {
      registry, signalStore: store, signalBindingManager: null,
      currentModelUrl: 'cell.glb', whenSceneReady: async () => {},
    };
    setActiveEditTarget(editTarget as never);
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    try {
      const plugin = new SignalBindPlugin();
      await (plugin as unknown as { _reportOrphanedBindings(v: unknown, r: unknown): Promise<void> })
        ._reportOrphanedBindings(viewer, { root: new Object3D() });
    } finally {
      off();
    }
    expect(editTarget.setField).not.toHaveBeenCalled();
    expect(editTarget.unsetField).not.toHaveBeenCalled();
    expect(editTarget.withTransaction).not.toHaveBeenCalled();
    expect(JSON.stringify(ops)).toBe(before);
    expect(seen).toHaveLength(1);
    const notice = seen[0];
    if (notice.kind !== 'orphaned-bindings') throw new Error(`wrong kind ${notice.kind}`);
    expect(notice.paths).toEqual([OLD_PATH]);
  });
});

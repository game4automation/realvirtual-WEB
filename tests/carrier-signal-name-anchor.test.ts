// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * carrier-signal-name-anchor — a node binding survives its carrier being moved
 * (plan-425 F2, test 9.2, "case A").
 *
 * The review's first blocker was about the LAYER this repair lives on, and the
 * fixtures here exist to keep it there. A `setField` op is addressed by path. If
 * the path is dead, the op is never materialised onto any node — so the restore
 * traverse, which walks the loaded model's nodes, cannot read the anchor stored
 * INSIDE that op. It only ever sees ops that already worked.
 *
 * Which is why the fixtures below are overlays and ops, not nodes: the anchor
 * has to be legible from the op side or it is not legible at all.
 *
 * The second-round finding was about the WRITE. Persisting the mappings at the
 * new path while leaving the old op in place makes the repair last exactly one
 * session — the next load rediscovers the same dead carrier and reports the same
 * orphan. So the migration is a PAIR, and the test checks for the absence of the
 * old path, not merely the presence of the new one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import {
  findOrphanedBindingCarriers,
  findOrphanedBindingPaths,
  planCarrierMigrations,
} from '../src/plugins/signal-bind/orphaned-bindings';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  registerSignal,
  isDuplicateSignalName,
  resetDuplicateSignalNames,
} from '../src/core/engine/rv-signal-construction';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

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

/** A store where `SIGNAL` lives at `path` (and optionally at a second one). */
function storeWith(paths: readonly string[]) {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  for (const path of paths) {
    const node = new Object3D();
    node.name = SIGNAL;
    registerSignal(node, 'PLCOutputBool', { Name: SIGNAL, Status: { Value: false } },
      path, store, registry);
  }
  return store;
}

function resolverFor(store: SignalStore) {
  return {
    getPath: (name: string) => store.getPath(name),
    isDuplicate: (name: string) => isDuplicateSignalName(store, name),
  };
}

afterEach(() => resetDuplicateSignalNames(new SignalStore()));

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

describe('planCarrierMigrations', () => {
  it('migrates a dead carrier onto the path the signal name now resolves to', () => {
    const overlay = materialise([setFieldOp(OLD_PATH, [MAPPING])]).overlay;
    const registry = registryWith([NEW_PATH]);
    const store = storeWith([NEW_PATH]);
    const { migrations, stillOrphaned } = planCarrierMigrations(
      findOrphanedBindingCarriers(overlay, registry), resolverFor(store), registry);

    expect(stillOrphaned).toEqual([]);
    expect(migrations).toHaveLength(1);
    expect(migrations[0].from).toBe(OLD_PATH);
    expect(migrations[0].to).toBe(NEW_PATH);
    expect(migrations[0].mappings[0].signal).toBe('PLC.Start');
  });

  it('refuses the anchor when the name became ambiguous in the new model', () => {
    // Two live nodes now answer to `Motor.Run`. Since plan-418 that is exactly
    // the condition under which a name identifies NOTHING — so the mapping goes
    // back to being an ordinary orphan rather than landing on a coin flip.
    const overlay = materialise([setFieldOp(OLD_PATH, [MAPPING])]).overlay;
    const registry = registryWith([NEW_PATH, 'Cell/Other/Motor_Run']);
    const store = storeWith([NEW_PATH, 'Cell/Other/Motor_Run']);
    const { migrations, stillOrphaned } = planCarrierMigrations(
      findOrphanedBindingCarriers(overlay, registry), resolverFor(store), registry);

    expect(migrations).toEqual([]);
    expect(stillOrphaned).toEqual([OLD_PATH]);
  });

  it('leaves a legacy mapping without an anchor exactly as it was', () => {
    const legacy = { ...MAPPING, carrierSignalName: undefined };
    delete (legacy as { carrierSignalName?: string }).carrierSignalName;
    const overlay = materialise([setFieldOp(OLD_PATH, [legacy])]).overlay;
    const registry = registryWith([NEW_PATH]);
    const { migrations, stillOrphaned } = planCarrierMigrations(
      findOrphanedBindingCarriers(overlay, registry), resolverFor(storeWith([NEW_PATH])), registry);

    expect(migrations).toEqual([]);
    expect(stillOrphaned).toEqual([OLD_PATH]);
  });

  it('refuses to migrate onto a path that already carries its own mappings', () => {
    // Overwriting there would turn a repair into data loss — the destination's
    // own links would be replaced by the dead carrier's.
    const overlay = materialise([
      setFieldOp(OLD_PATH, [MAPPING]),
      setFieldOp(NEW_PATH, [{ ...MAPPING, signal: 'PLC.Other' }]),
    ]).overlay;
    const registry = registryWith([NEW_PATH]);
    const { migrations, stillOrphaned } = planCarrierMigrations(
      findOrphanedBindingCarriers(overlay, registry),
      resolverFor(storeWith([NEW_PATH])),
      registry,
      new Set(Object.keys(overlay.nodes)),
    );

    expect(migrations).toEqual([]);
    expect(stillOrphaned).toEqual([OLD_PATH]);
  });

  it('never sends two dead carriers to the same destination', () => {
    const second = 'Cell/OlderGroup/Motor_Run';
    const overlay = materialise([
      setFieldOp(OLD_PATH, [MAPPING]),
      setFieldOp(second, [{ ...MAPPING, signal: 'PLC.Second' }]),
    ]).overlay;
    const registry = registryWith([NEW_PATH]);
    const { migrations, stillOrphaned } = planCarrierMigrations(
      findOrphanedBindingCarriers(overlay, registry), resolverFor(storeWith([NEW_PATH])), registry);

    expect(migrations).toHaveLength(1);
    expect(stillOrphaned).toHaveLength(1);
  });
});

describe('the migration op pair', () => {
  it('leaves NO trace of the old path in the materialised overlay', () => {
    // Round-2 finding: setField alone would leave the old op standing and the
    // orphan would return on the next load. The pair is what makes it stick.
    const ops: RvOp[] = [setFieldOp(OLD_PATH, [MAPPING])];
    expect(Object.keys(materialise(ops).overlay.nodes)).toContain(OLD_PATH);

    ops.push(setFieldOp(NEW_PATH, [MAPPING]));
    ops.push({
      id: 'unset', ts: 2, schemaV: 1,
      kind: 'unsetField', nodePath: OLD_PATH, componentType: 'SignalLinks',
      fieldName: 'Mappings', prev: [MAPPING],
    } as RvOp);

    const after = materialise(ops).overlay;
    expect(Object.keys(after.nodes)).not.toContain(OLD_PATH);
    expect(Object.keys(after.nodes)).toContain(NEW_PATH);
  });

  it('produces no second orphan report after the migration', () => {
    const ops: RvOp[] = [
      setFieldOp(NEW_PATH, [MAPPING]),
      {
        id: 'unset', ts: 2, schemaV: 1,
        kind: 'unsetField', nodePath: OLD_PATH, componentType: 'SignalLinks',
        fieldName: 'Mappings', prev: [MAPPING],
      } as RvOp,
    ];
    const registry = registryWith([NEW_PATH]);
    expect(findOrphanedBindingCarriers(materialise(ops).overlay, registry)).toEqual([]);
  });
});

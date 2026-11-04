// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.2 — migration on load, the core proof (Phase 1a).
 *
 * A Unity file arrives with path references and no NodeIds. At decode every node
 * gets its seeded id and every stored path is read through the file's AUTHORED
 * index (`rv-decode-identity.ts`, `rv-reference-migration.mjs`) — never through the
 * registry's guessing stages. `NodeRegistry.resolveRef` then lands each reference on
 * the authored node, by address (`via: 'migrated'`).
 *
 * Phase-1a scope: the readers that went through `resolveComponentRefs` (every
 * ComponentReference field of a schema component) use the address first; the other
 * stored-reference readers (CRI, PhysicsZone, WebVisibility, Source, Kinematic
 * prepare hook, bake survival) switched in Phase 1b (`readStoredRef` — the file's
 * verdict is final); the `[1b]` `it.fails` is a plain `it` now. The per-reader
 * matrix lives in `tests/stored-readers-769.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getProblems, resetProblemsForTests, UNRESOLVED_INSTRUCTION_TARGET_CODE } from '../src/core/hmi/problems-store';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import { CR, buildContentRootGlb, buildMauserCoreGlb, driveNodeBySpeed } from './helpers/migrate-769-fixtures';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function gearOf(registry: NodeRegistry, slave: Object3D): RVDriveGear | null {
  const drive = registry.componentOn<RVDrive>(slave, 'Drive');
  return (drive?.driveBehaviors.find((b) => b instanceof RVDriveGear) as RVDriveGear | undefined) ?? null;
}

/** Spy every guessing stage of the registry (suffix, sanitized, name-in-scope, typed by-path). */
function spyGuessStages(registry: NodeRegistry): { calls(): number; restore(): void } {
  const r = registry as unknown as Record<string, (...a: unknown[]) => unknown>;
  const names = ['_getNodeStaged', '_getByPathStaged', '_resolveSanitized', 'findComponentNodeInScope', 'findNodeInScope'];
  const spies = names.filter((n) => typeof r[n] === 'function').map((n) => vi.spyOn(r, n));
  return {
    calls: () => spies.reduce((s, sp) => s + sp.mock.calls.length, 0),
    restore: () => { for (const s of spies) s.mockRestore(); },
  };
}

describe('plan-769 9.2 — migrate on load', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });

  async function load(name: string, bytes: ArrayBuffer): Promise<TestViewerHandle> {
    resetProblemsForTests();
    h = await createTestViewer('webgl');
    await h.viewer.loadModel(name, { data: bytes });
    return h;
  }

  describe('Mauser core: renamed by the loader AND re-parented by the Kinematic hook', () => {
    it('every decoded node carries an identity; the file has no NodeId of its own', async () => {
      const { viewer } = await load('mauser-core.glb', await buildMauserCoreGlb());
      const reg = viewer.registry!;
      const sep = reg.getNode('Cell/Mount/Sep_1')!;
      expect(sep).not.toBeNull();
      expect(identityIdOf(sep)).toMatch(UUID);
      // The authored path of the moved, renamed node is still its file's.
      expect(reg.getAuthoredPath(sep)).toBe('CadB/Sep');
      // Registered under the main model's occurrence, BEFORE the init (F5).
      expect(reg.getAddressForNode(sep)).toBe(`#${identityIdOf(sep)}`);
    });

    it('a ComponentReference lands on the AUTHORED node by address (resolvedVia migrated), at init', async () => {
      const { viewer } = await load('mauser-core.glb', await buildMauserCoreGlb());
      const reg = viewer.registry!;
      const authoredSep = driveNodeBySpeed(viewer.currentModelRoot!, 222)!;
      const slave = reg.getNode('Cell/Slave')!;
      const r = reg.resolveRef(slave, CR('CadB/Sep'));
      expect(r.status).toBe('resolved');
      expect(r.status === 'resolved' && r.node).toBe(authoredSep);
      expect(r.status === 'resolved' && r.via).toBe('migrated');
      // The component the init built took the same node (resolveComponentRefs → address first).
      expect(gearOf(reg, slave)?.masterDrive?.node).toBe(authoredSep);
      expect(reg.resolve(CR('CadB/Sep') as never, viewer.currentModelRoot, slave).resolvedVia).toBe('migrated');
    });

    it('the migration path calls no guessing stage', async () => {
      const { viewer } = await load('mauser-core.glb', await buildMauserCoreGlb());
      const reg = viewer.registry!;
      const slave = reg.getNode('Cell/Slave')!;
      const panel = reg.getNode('Cell/Panel')!;
      const spy = spyGuessStages(reg);
      try {
        expect(reg.resolveRef(slave, CR('CadB/Sep')).status).toBe('resolved');
        // A path field and the trap path — answered (resolved / missing) without guessing.
        reg.resolveRef(panel, 'CadB/Sep/Pin');
        reg.resolveRef(panel, 'CadB/Sep');
        expect(spy.calls()).toBe(0);
      } finally {
        spy.restore();
      }
    });

    it('a second load of the same bytes yields the same ids', async () => {
      const bytes = await buildMauserCoreGlb();
      const first = await load('mauser-core.glb', bytes.slice(0));
      const ids1 = new Map<string, string>();
      first.viewer.registry!.forEachNode((p, n) => { const id = identityIdOf(n); if (id) ids1.set(p, id); });
      first.dispose(); h = null;
      const second = await load('mauser-core.glb', bytes.slice(0));
      const ids2 = new Map<string, string>();
      second.viewer.registry!.forEachNode((p, n) => { const id = identityIdOf(n); if (id) ids2.set(p, id); });
      expect(ids1.size).toBeGreaterThan(4);
      expect(ids2).toEqual(ids1);
    });

    it('the instruction target path migrates to the authored pin (address of the 0.2 box)', async () => {
      const { viewer } = await load('mauser-core.glb', await buildMauserCoreGlb());
      const reg = viewer.registry!;
      const identity = reg.identityOfOccurrence('')!;
      const migrated = identity.migratePath('CadB/Sep/Pin');
      expect(migrated.address).toMatch(/^#/);
      // Not the CadA pin: its authored path is a different seed.
      expect(identity.migratePath('CadA/Sep/Pin').address).not.toBe(migrated.address);
    });

    it('the instruction target path resolves by address to the authored pin (its node survives as a claimed target)', async () => {
      const { viewer } = await load('mauser-core.glb', await buildMauserCoreGlb());
      const reg = viewer.registry!;
      const r = reg.resolveRef(reg.getNode('Cell/Panel')!, 'CadB/Sep/Pin');
      expect(r.status).toBe('resolved');
      expect(r.status === 'resolved' && reg.getAuthoredPath(r.node)).toBe('CadB/Sep/Pin');
      expect(r.status === 'resolved' && r.node.parent && reg.getAuthoredPath(r.node.parent)).toBe('CadB/Sep');
    });

    // [1b] CRI reads its targets itself (not through resolveComponentRefs).
    it('no unresolved-instruction-target (CRI reads its targets by the file verdict)', async () => {
      await load('mauser-core.glb', await buildMauserCoreGlb());
      expect(getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE)).toEqual([]);
    });
  });

  describe('content root: references written relative to the Unity root under a wrapper scene', () => {
    it('the guessing stages see two candidates; the migration names the authored one', async () => {
      const { viewer } = await load('content-root.glb', await buildContentRootGlb());
      const reg = viewer.registry!;
      const root = viewer.currentModelRoot!;
      const right = driveNodeBySpeed(root, 111)!;
      const wrong = driveNodeBySpeed(root, 999)!;
      expect(right).not.toBe(wrong);
      const slave = reg.getNode(`${reg.getPathForNode(root)}/Machine/Slave`)!;
      expect(slave).not.toBeNull();
      // The old chain (registry-wide stages, no document to judge by): the suffix
      // stage refuses (two candidates), the name stage takes the node the LOADER
      // named "Axis" — the wrong one. That is the guess the migration removes.
      const old = reg.resolveWithStage({ path: 'Static/Axis' }, 'realvirtual.Drive', null);
      expect(old?.node).toBe(wrong);
      // Phase 1b: a reader that names the document (here only by its SCOPE) gets the
      // file's verdict — the stored reference never reaches that guess any more.
      expect(reg.resolve(CR('Static/Axis') as never, root).drive?.node).toBe(right);
      // The migration: content-root step, authored index.
      expect(reg.identityOfOccurrence('')!.migratePath('Static/Axis').via).toBe('authored-content-root');
      const r = reg.resolveRef(slave, CR('Static/Axis'));
      expect(r.status === 'resolved' && r.node).toBe(right);
      // And the init used it: the gear follows the AUTHORED master (registration before initSubtree).
      expect(gearOf(reg, slave)?.masterDrive?.node).toBe(right);
    });
  });

  describe('negative: a target only a guess reaches', () => {
    it('is unresolved for the migration (missing), never guessed', async () => {
      const { viewer } = await load('mauser-core.glb', await buildMauserCoreGlb());
      const reg = viewer.registry!;
      const slave = reg.getNode('Cell/Slave')!;
      // Leaf-only spelling: the registry's suffix / name stages would find "a" Pin.
      const r = reg.resolveRef(slave, CR('Pin', 'UnityEngine.Transform'));
      expect(r.status).toBe('unresolved');
      expect(r.status === 'unresolved' && r.reason).toBe('missing');
      // …while the registry-wide chain (no document: the bare plugin API) would still
      // bind SOME node — a path INPUT, until plan-770.
      expect(reg.resolve(CR('Pin', 'UnityEngine.Transform') as never, null).node ?? null).not.toBeNull();
      // Phase 1b: through the referrer it is a stored read — and 'Pin' is no reference
      // of the file, so it is a web-written path (legacy), not a final miss.
      expect(reg.readStoredRef(slave, 'Pin').status).toBe('legacy');
      const r2 = reg.resolveRef(slave, CR('Nowhere/Sep', 'UnityEngine.Transform'));
      expect(r2.status === 'unresolved' && r2.reason).toBe('missing');
    });
  });
});

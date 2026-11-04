// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.23 — `ensureNodeId` in the reference writer (F17, Phase 3a) and the
 * layout-save atomicity warning (F21, Phase 3b): a reference written into ANOTHER
 * document's node whose id exists only in this session warns before it is saved.
 *
 * A reference written to a node WITHOUT a persistent id mints one (UUIDv4, the node's
 * runtime identity), indexes it in the node's document — so the address written now
 * also resolves now — and the export then persists exactly that id.
 */
import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { ensureNodeId, storedFormFor } from '../src/core/engine/rv-reference-writer';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { CR, box, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { applyForward } from '../src/core/hmi/scene/rv-scene-executors';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { RvSceneOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function plant() {
  const scene = new Scene();
  scene.name = 'Plant';
  scene.add(box('Floor', 1), node('Holder', { RefHolder: {} }));
  return loadGLB('plant.glb', new Scene(), { data: await sceneToGlb(scene), preserveHierarchy: true, loadKinematicsSidecar: false });
}

describe('plan-769 9.23 — ensureNodeId (reference writer)', () => {
  it('a node without an id gets a UUIDv4, indexed in its document', async () => {
    const { root, registry } = await plant();
    const fresh = new Object3D();
    fresh.name = 'Fresh';
    root.add(fresh);
    registry.registerNode(`${registry.getPathForNode(root) ? `${registry.getPathForNode(root)}/` : ''}Fresh`, fresh);
    expect(identityIdOf(fresh)).toBeNull();
    const id = ensureNodeId(registry, fresh);
    expect(id).toMatch(UUID_V4);
    expect(identityIdOf(fresh)).toBe(id);
    expect(registry.getAddressForNode(fresh)).toBe(`#${id}`);
    expect(ensureNodeId(registry, fresh)).toBe(id); // idempotent
  });

  it('writing a reference to an id-less target mints its id; the export persists it', async () => {
    const { root, registry } = await plant();
    const fresh = new Object3D();
    fresh.name = 'Fresh';
    root.add(fresh);
    const freshPath = `${registry.getPathForNode(root) ? `${registry.getPathForNode(root)}/` : ''}Fresh`;
    registry.registerNode(freshPath, fresh);
    let holder: Object3D | null = null;
    root.traverse((n) => { if (n.name === 'Holder') holder = n; });
    const form = storedFormFor(registry, holder!, CR(freshPath, ''));
    const id = identityIdOf(fresh)!;
    expect(id).toMatch(UUID_V4);
    expect(form).toEqual({ address: `#${id}` });
    expect(registry.readStoredRef(holder!, form!).status).toBe('resolved');

    holder!.userData.realvirtual = { RefHolder: { To: CR(freshPath, '') } };
    const json = readGlbJson(await exportAssetGlb(root, 'Plant', undefined, undefined, { registry })) as {
      nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, unknown> } }>;
    };
    expect(json.nodes.find((n) => n.name === 'Fresh')!.extras!.realvirtual!.NodeId).toBe(id);
    expect((json.nodes.find((n) => n.name === 'Holder')!.extras!.realvirtual!.RefHolder as Record<string, unknown>).To)
      .toEqual({ type: 'ComponentReference', address: `#${id}`, componentType: '' });
  });

});

describe('plan-769 9.23 — F21: a reference to an id another document has not saved yet', () => {
  it('writing it warns "save document X first"; a target whose id came from a file does not', async () => {
    resetProblemsForTests();
    const { root, registry } = await plant();
    const machine = new Object3D();
    machine.name = 'Machine_1';
    machine.userData._layoutId = 'pl-1';
    machine.userData[RV_SEEDED_NODE_ID_KEY] = 'pl-1';
    const minted = new Object3D();
    minted.name = 'NewPart';
    minted.userData[RV_SEEDED_NODE_ID_KEY] = '7f0d1c7e-1b2a-4c3d-8e4f-123456789abc'; // UUIDv4 = minted in the web
    const fromFile = new Object3D();
    fromFile.name = 'Axis';
    fromFile.userData.realvirtual = { NodeId: '7f0d1c7e-1b2a-4c3d-8e4f-0000000000aa' };
    machine.add(minted, fromFile);
    root.add(machine);
    const rp = registry.getPathForNode(root);
    const at = (s: string) => (rp ? `${rp}/${s}` : s);
    registry.registerNode(at('Machine_1'), machine);
    registry.registerNode(at('Machine_1/NewPart'), minted);
    registry.registerNode(at('Machine_1/Axis'), fromFile);
    registry.registerNodeIdInParentDocument(machine);
    registry.registerOccurrence(machine, 'pl-1', { contentRootId: 'c-root' });
    let holder: Object3D | null = null;
    root.traverse((n) => { if (n.name === 'Holder') holder = n; });
    const viewer = { registry, currentModelRoot: root, markRenderDirty() {} } as unknown as RVViewer;
    const write = async (to: string) => applyForward({
      id: `op-${to}`, ts: 0, schemaV: 1, kind: 'setField', nodePath: registry.getPathForNode(holder!)!,
      componentType: 'RefHolder', fieldName: to, value: CR(at(`Machine_1/${to}`), ''), prev: undefined,
    } as unknown as RvSceneOp, { viewer });
    await write('NewPart');
    const rv = () => (holder!.userData.realvirtual as Record<string, Record<string, { address?: string }>>).RefHolder;
    expect(rv().NewPart.address).toBe('pl-1#7f0d1c7e-1b2a-4c3d-8e4f-123456789abc');
    const warnings = getProblems().filter((p) => p.code === 'reference-target-unsaved');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.title).toContain('Machine_1');
    await write('Axis');
    expect(rv().Axis.address).toBe('pl-1#7f0d1c7e-1b2a-4c3d-8e4f-0000000000aa');
    expect(getProblems().filter((p) => p.code === 'reference-target-unsaved')).toHaveLength(1);
  });
});

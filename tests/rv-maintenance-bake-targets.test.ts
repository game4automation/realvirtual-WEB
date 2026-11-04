// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-maintenance-bake-targets.test.ts — plan-522 §9.2 / F4: the reference
 * targets of the maintenance components survive the destructive bake through
 * the SCHEMA path (`bakeTarget` on the field descriptor, no
 * `REFERENCE_BAKE_TARGETS` row): `SetTransparency.Targets`,
 * `AnimateTransform.Targets` (here under the `_1` dedup key) and
 * `Effect.Anchors` become chunk boundaries holding only their own subtree;
 * `MaintenanceStep.HighlightTargets` keeps its target as a node whose
 * triangles stay addressable (what the highlight reads). Without the
 * components the same bare CAD parts are removed.
 *
 * Template: the spike test `tests/spike-522-transparency.test.ts` (commit
 * 89ddd663, `prepareAndBake` + `inlinePickPort` + `isChunkMesh` + `chunk.owner`).
 * References are written the way the editor writes them: object form,
 * asset-relative authored path, `componentType: ''` for a bare node.
 */

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
} from 'three';
import '../src/core/engine/rv-scene-loader';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { isChunkMesh } from '../src/core/engine/rv-node-classification';
import { REFERENCE_BAKE_TARGETS, referenceBakeTargetOf } from '../src/core/engine/rv-bake-survival';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { inlinePickPort } from './fixtures/bake-fixture';

const BOX_TRIS = 12;

function box(name: string, size: [number, number, number], pos: [number, number, number]): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color: 0x888888, roughness: 1, metalness: 0 }));
  m.name = name;
  m.position.set(...pos);
  return m;
}

const nodeRef = (path: string) => ({ type: 'ComponentReference', path, componentType: '' });

/**
 * Machine (asset root)
 *  ├─ Housing        bare CAD mesh + child HousingLid  ← SetTransparency.Targets (chunk)
 *  ├─ Inner          bare CAD mesh                     ← AnimateTransform_1.Targets (chunk)
 *  ├─ NozzleTip      bare CAD mesh                     ← Effect.Anchors / ReducedAnchors (chunk)
 *  ├─ Lamp           bare CAD mesh                     ← MaintenanceStep.HighlightTargets (merge)
 *  ├─ Other          bare CAD mesh, not referenced
 *  └─ Maintenance    LogicStep_MaintenanceProcedure
 *      └─ 04 Look inside   MaintenanceStep + SetTransparency + AnimateTransform_1 + Effect
 */
function buildMachine(withComponents: boolean): Group {
  const root = new Group();
  root.name = 'Machine';
  const housing = box('Housing', [2, 2, 0.2], [0, 0, 1]);
  housing.add(box('HousingLid', [2, 0.2, 0.6], [0, 1.1, -0.3]));
  root.add(housing);
  root.add(box('Inner', [1, 1, 0.5], [0, 0, -1]));
  root.add(box('NozzleTip', [0.1, 0.3, 0.1], [0.5, 0.5, 0]));
  root.add(box('Lamp', [0.2, 0.2, 0.2], [-1.5, 1.5, 0]));
  root.add(box('Other', [1, 1, 0.5], [2.5, 0, 0]));
  const proc = new Object3D();
  proc.name = 'Maintenance';
  const step = new Object3D();
  step.name = '04 Look inside';
  proc.add(step);
  root.add(proc);
  if (withComponents) {
    proc.userData.realvirtual = { LogicStep_MaintenanceProcedure: { ProcedureName: 'Clean' } };
    step.userData.realvirtual = {
      LogicStep_MaintenanceStep: { Title: 'Look inside', HighlightTargets: [nodeRef('Lamp')] },
      LogicStep_SetTransparency: { Targets: [nodeRef('Housing')], Opacity: 0.25 },
      LogicStep_AnimateTransform_1: { Targets: [nodeRef('Inner')], RotationAngle: 720 },
      LogicStep_Effect: { Type: 'CoolantSpray', Anchors: [nodeRef('NozzleTip')], ReducedAnchors: [nodeRef('NozzleTip')] },
    };
  }
  return root;
}

let bakeSeq = 0;
async function bakeMachine(withComponents: boolean): Promise<BakedAsset> {
  const baked = await prepareAndBake(buildMachine(withComponents), {
    assetId: `plan-522-bake-targets-${withComponents ? 'with' : 'without'}-${bakeSeq++}`,
    renamedNodes: new Map<Object3D, string>(),
    signatureState: 'none',
    uber: new RVUberMaterial(false),
    isWebGPU: false,
    pickPort: inlinePickPort(),
  });
  baked.template.updateMatrixWorld(true);
  return baked;
}

function findNode(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

function tris(g: BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

function chunkMeshesUnder(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  node.traverse((o) => { if (isChunkMesh(o)) out.push(o as Mesh); });
  return out;
}

function chunkOf(baked: BakedAsset, mesh: Mesh) {
  const c = baked.chunks.find((x) => x.templateMesh === mesh);
  if (!c) throw new Error('chunk mesh without BakedChunk');
  return c;
}

function isInside(node: Object3D, ancestor: Object3D): boolean {
  for (let p: Object3D | null = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** Triangles of `node`'s subtree as the node table addresses them (what highlight reads). */
function addressedTriangles(baked: BakedAsset, node: Object3D): number {
  const table = baked.nodeTable;
  const o = table.ordinalOf.get(node);
  if (o === undefined) return 0;
  let n = 0;
  for (let r = table.rowStart[o]; r < table.rowStart[o + 1]; r++) {
    const pick = table.chunks[table.rowChunk[r]].pick;
    for (let s = table.rowFirstSeg[r]; s <= table.rowLastSeg[r]; s++) n += pick.segIndexCount[s] / 3;
  }
  return n;
}

describe('plan-522 §9.2 — maintenance reference targets survive the bake (schema path)', () => {
  it('no REFERENCE_BAKE_TARGETS row: the schema descriptor decides, also for a `_1` key', () => {
    // Schema REFERENCES of logic steps are tagged by their descriptor, never by a table row. The one
    // LogicStep row is a raw PATH STRING the schema cannot tag (plan-769: LogicStep_Enable.Target).
    expect(REFERENCE_BAKE_TARGETS.filter((e) => e.component.startsWith('LogicStep_')).map((e) => `${e.component}.${e.field}:${e.kind}`))
      .toEqual(['LogicStep_Enable.Target:pathString']);
    expect(referenceBakeTargetOf('LogicStep_SetTransparency', 'Targets')).toBe('chunk');
    expect(referenceBakeTargetOf('LogicStep_AnimateTransform_1', 'Targets')).toBe('chunk');
    expect(referenceBakeTargetOf('LogicStep_Effect_2', 'ReducedAnchors')).toBe('chunk');
    expect(referenceBakeTargetOf('LogicStep_MaintenanceStep', 'HighlightTargets')).toBe('merge');
    // Unrelated fields / keys stay on the default.
    expect(referenceBakeTargetOf('LogicStep_DriveTo', 'drive')).toBe('merge');
    expect(referenceBakeTargetOf('LogicStep_Unlisted_1', 'Targets')).toBe('merge');
  });

  it('chunk targets are chunk owners holding triangles of their own subtree only', async () => {
    const baked = await bakeMachine(true);
    const expectations: Array<[string, number]> = [
      ['Housing', 2 * BOX_TRIS], // Housing + HousingLid
      ['Inner', BOX_TRIS],       // via LogicStep_AnimateTransform_1
      ['NozzleTip', BOX_TRIS],
    ];
    for (const [name, triangles] of expectations) {
      const target = findNode(baked.template, name);
      expect(target, `${name} survives`).not.toBeNull();
      const meshes = chunkMeshesUnder(target!).filter((m) => chunkOf(baked, m).owner === target);
      expect(meshes.length, `${name} owns a chunk`).toBeGreaterThan(0);
      let sum = 0;
      for (const m of meshes) {
        sum += tris(m.geometry);
        const pick = chunkOf(baked, m).pick;
        for (let s = 0; s < pick.segNode.length; s++) {
          const n = baked.nodeTable.nodes[pick.segNode[s]];
          expect(isInside(n, target!), `${name}: segment node ${n.name} inside the target subtree`).toBe(true);
        }
      }
      expect(sum, `${name}: only its own triangles`).toBe(triangles);
    }
    // The procedure and step nodes survive as component carriers.
    expect(findNode(baked.template, 'Maintenance')).not.toBeNull();
    expect(findNode(baked.template, '04 Look inside')).not.toBeNull();
    // The unreferenced bare part is gone as a node; its triangles live on.
    expect(findNode(baked.template, 'Other')).toBeNull();
    const total = baked.chunks.reduce((n, c) => n + c.triangles, 0);
    expect(total).toBe(6 * BOX_TRIS);
  });

  it('the highlight target survives as a node (merge, no boundary) and its triangles stay addressable', async () => {
    const baked = await bakeMachine(true);
    const lamp = findNode(baked.template, 'Lamp');
    expect(lamp).not.toBeNull();
    // merge: no chunk of its own …
    expect(baked.chunks.some((c) => c.owner === lamp)).toBe(false);
    // … but the node table addresses exactly its 12 triangles (highlightByPath source).
    expect(addressedTriangles(baked, lamp!)).toBe(BOX_TRIS);
  });

  it('plan-522 Phase 7: a node carrying only a LogicStep_MaintenanceTrigger survives the bake', async () => {
    const machine = buildMachine(true);
    const proc = findNode(machine, 'Maintenance')!;
    const trigger = new Object3D();
    trigger.name = 'Lift cycles';
    trigger.userData.realvirtual = { LogicStep_MaintenanceTrigger: { Kind: 'Interval', Interval: 8760 } };
    proc.add(trigger);
    const baked = await prepareAndBake(machine, {
      assetId: `plan-522-bake-trigger-${bakeSeq++}`,
      renamedNodes: new Map<Object3D, string>(),
      signatureState: 'none',
      uber: new RVUberMaterial(false),
      isWebGPU: false,
      pickPort: inlinePickPort(),
    });
    const kept = findNode(baked.template, 'Lift cycles');
    expect(kept).not.toBeNull();
    expect((kept!.userData.realvirtual as Record<string, unknown>)['LogicStep_MaintenanceTrigger']).toMatchObject({ Kind: 'Interval' });
    expect(kept!.parent?.name).toBe('Maintenance');
  });

  it('counter-check: without the components every one of these targets is removed', async () => {
    const baked = await bakeMachine(false);
    for (const name of ['Housing', 'HousingLid', 'Inner', 'NozzleTip', 'Lamp', 'Other']) {
      expect(findNode(baked.template, name), `${name} removed`).toBeNull();
    }
    expect(baked.chunks.reduce((n, c) => n + c.triangles, 0)).toBe(6 * BOX_TRIS);
  });
});

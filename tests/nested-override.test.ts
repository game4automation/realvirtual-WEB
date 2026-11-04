// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.9 — overrides and component references into NESTED placements (F13).
 *
 * Layout → Machine (placement) → Cell_1 (nested placement inside the Machine asset)
 * → Slide (Drive, NodeId `nid-slide`). The Machine reference node may override the
 * nested Slide as `nid-cell#nid-slide` (address relative to the Machine asset);
 * the Machine asset's own Cell_1 reference node may override it as `#nid-slide`.
 *
 *  - outer + inner on the same address → the OUTER wins (one precedence point,
 *    `applyOverrideLayers`), for placements as for composition;
 *  - ten instances keep their overrides apart (one occurrence each);
 *  - the nested placement materialises AFTER its parent: the override waits for its
 *    occurrence (pending queue, `occurrence-registered`), and so does a component
 *    reference into it — resolved late, `reapplyConfig()` runs;
 *  - order variation (gated vs ungated decode, document order, warm cache) and reload;
 *  - the orphan verdict falls by itself once nothing is pending (no MCP, no caller);
 *  - the queue is flushed with a reason on 404, cap and clearModel;
 *  - `#<rootId>` of the placed asset resolves to the placement root.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { setAssetOverrides } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { resolveComponentRefs } from '../src/core/engine/rv-component-registry';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import {
  CELL_REF_NODE_ID, INNER_URL, OUTER_URL, SLIDE_NODE_ID,
  bootNestedViewer, bootRealLoaderViewer, dataUrlOf, findByName, innerDataUrl, makeOuter, referenceNode,
  toArrayBuffer, type Booted,
} from './helpers/nested-placement-fixture';

const NESTED = `${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`;

let booted: Booted | null = null;
afterEach(() => { booted?.h.dispose(); booted = null; resetProblemsForTests(); });

/** The outer Machine asset as a data url; `innerOverride` = what its Cell_1 reference node overrides (inner layer). */
async function machineUrl(innerUrl: string, innerOverride?: number): Promise<string> {
  const machine = makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true, assetId: 'cat:cell' }]);
  if (innerOverride !== undefined) {
    const cell = findByName(machine, 'Cell_1')!;
    setAssetOverrides(cell, { byAddress: { [`#${SLIDE_NODE_ID}`]: { Drive: { TargetSpeed: innerOverride } } } });
  }
  return dataUrlOf(await objectToGlb(machine));
}

interface MachineSpec { id: string; overrides?: Record<string, Record<string, Record<string, unknown>>> }

/** A layout of Machine placements (ids = occurrence segments) plus a plain `Panel` node of the document. */
async function layoutBytes(url: string, machines: MachineSpec[]): Promise<ArrayBuffer> {
  const doc = new Group();
  doc.name = 'Layout';
  machines.forEach((m, i) => {
    const ref = referenceNode(`Machine_${i}`, m.id, url, true, [10 * i, 0, 0], 'cat:machine');
    if (m.overrides) setAssetOverrides(ref, { byAddress: m.overrides });
    doc.add(ref);
  });
  const panel = new Object3D();
  panel.name = 'Panel';
  setNodeId(panel, 'nid-panel');
  doc.add(panel);
  return objectToGlb(doc);
}

async function loadReal(bytes: ArrayBuffer | Uint8Array, opts?: { cap?: number }): Promise<Booted> {
  booted?.h.dispose();
  booted = await bootRealLoaderViewer();
  if (opts?.cap !== undefined) booted.h.viewer.placements.maxPlacementsPerLoad = opts.cap;
  await booted.h.viewer.loadModel('layout.glb', { data: toArrayBuffer(bytes).slice(0) });
  await booted.h.viewer.whenSceneReady();
  return booted;
}

function slideOf(machine: Object3D | null): Object3D | null {
  const cell = machine ? findByName(machine, 'Cell_1') : null;
  return cell ? findByName(cell, 'Slide') : null;
}
function speed(node: Object3D | null): unknown {
  return (node?.userData.realvirtual as { Drive?: { TargetSpeed?: unknown } } | undefined)?.Drive?.TargetSpeed;
}
const orphans = (): ReturnType<typeof getProblems> => getProblems().filter((p) => p.code === 'override-orphaned');

describe('9.9 precedence: outer wins over inner on the same address', () => {
  it('inner alone → 300; inner 300 + outer 500 → 500; no orphan', async () => {
    const url = await machineUrl(await innerDataUrl(), 300);
    let b = await loadReal(await layoutBytes(url, [{ id: 'plc-m0' }]));
    expect(speed(slideOf(findByName(b.h.viewer.currentModelRoot!, 'Machine_0')))).toBe(300);

    b = await loadReal(await layoutBytes(url, [{ id: 'plc-m0', overrides: { [NESTED]: { Drive: { TargetSpeed: 500 } } } }]));
    expect(speed(slideOf(findByName(b.h.viewer.currentModelRoot!, 'Machine_0')))).toBe(500);
    expect(orphans()).toEqual([]);
    expect(b.h.viewer.placements.routedOverrideCount).toBe(1);
  });
});

describe('9.9 ten instances keep their overrides apart', () => {
  it('only the overridden occurrence changes; every instance has its own nested occurrence', async () => {
    const url = await machineUrl(await innerDataUrl());
    const specs: MachineSpec[] = Array.from({ length: 10 }, (_, i) => ({
      id: `plc-m${i}`,
      ...(i === 3 ? { overrides: { [NESTED]: { Drive: { TargetSpeed: 333 } } } } : {}),
      ...(i === 7 ? { overrides: { [NESTED]: { Drive: { TargetSpeed: 777 } } } } : {}),
    }));
    const b = await loadReal(await layoutBytes(url, specs));
    const root = b.h.viewer.currentModelRoot!;
    const speeds = specs.map((_, i) => speed(slideOf(findByName(root, `Machine_${i}`))));
    expect(speeds).toEqual([200, 200, 200, 333, 200, 200, 200, 777, 200, 200]);
    const reg = b.h.viewer.registry!;
    for (let i = 0; i < 10; i++) {
      expect(reg.getNodeByAddress(SLIDE_NODE_ID, `plc-m${i}/${CELL_REF_NODE_ID}`)).toBe(slideOf(findByName(root, `Machine_${i}`)));
    }
    expect(orphans()).toEqual([]);
  });
});

describe('9.9 the nested placement materialises late: pending queue, occurrence-registered, reapplyConfig', () => {
  it('gated decode: the override waits for the nested occurrence; a component reference into it resolves late and reapplyConfig runs', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const h = booted.h;
    const doc = new Group();
    doc.name = 'Layout';
    const machine = referenceNode('Machine_0', 'plc-m0', OUTER_URL, true, [10, 0, 0]);
    setAssetOverrides(machine, { byAddress: { [NESTED]: { Drive: { TargetSpeed: 640 } } } });
    doc.add(machine);
    const panel = new Object3D();
    panel.name = 'Panel';
    setNodeId(panel, 'nid-panel');
    doc.add(panel);
    await h.viewer.loadModel('layout.glb', { data: await objectToGlb(doc) });
    // Let the outer Machine materialise; the inner Cell stays gated.
    for (let i = 0; i < 50 && !findByName(h.viewer.currentModelRoot!, 'Cell_1')?.children.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (h.viewer.placements.routedOverrideCount > 0) break;
    }
    expect(h.viewer.placements.routedOverrideCount, 'the outer override waits for its occurrence').toBe(1);
    expect(slideOf(findByName(h.viewer.currentModelRoot!, 'Machine_0'))).toBeNull();

    // A component of the document references the nested Slide's Drive by address.
    const panelNode = findByName(h.viewer.currentModelRoot!, 'Panel')!;
    let reapplied = 0;
    const component: Record<string, unknown> = {
      node: panelNode,
      Target: { type: 'ComponentReference', address: `plc-m0/${NESTED}`, componentType: 'Drive' },
      reapplyConfig() { reapplied++; },
    };
    resolveComponentRefs(component, h.viewer.registry!);
    expect(component.Target).toBeNull();
    expect(h.viewer.registry!.pendingRefCount()).toBe(1);

    booted.open();
    await h.viewer.whenSceneReady();
    const slide = slideOf(findByName(h.viewer.currentModelRoot!, 'Machine_0'))!;
    expect(speed(slide)).toBe(640);
    expect((component.Target as { node?: Object3D } | null)?.node).toBe(slide);
    expect(reapplied).toBe(1);
    expect(h.viewer.registry!.pendingRefCount()).toBe(0);
    expect(orphans()).toEqual([]);
  });

  it('order variation: reversed document order and a warm second load give the same result (the gated decode is the case above)', async () => {
    const url = await machineUrl(await innerDataUrl(), 300);
    const specs: MachineSpec[] = [
      { id: 'plc-a', overrides: { [NESTED]: { Drive: { TargetSpeed: 501 } } } },
      { id: 'plc-b' },
    ];
    const read = (b: Booted): unknown[] => ['Machine_0', 'Machine_1'].map((n) => speed(slideOf(findByName(b.h.viewer.currentModelRoot!, n))));
    let b = await loadReal(await layoutBytes(url, specs));
    expect(read(b)).toEqual([501, 300]);
    b = await loadReal(await layoutBytes(url, [...specs].reverse()));
    expect(read(b)).toEqual([300, 501]);
    // Same viewer, second load: the assets are warm, the nested bake is joined at once.
    await b.h.viewer.loadModel('layout-2.glb', { data: await layoutBytes(url, specs) });
    await b.h.viewer.whenSceneReady();
    expect(read(b)).toEqual([501, 300]);
    expect(orphans()).toEqual([]);
  });
});

describe('9.9 save and reload', () => {
  it('a component edit on the nested Slide is saved on the Machine as "nid-cell#nid-slide" and comes back after the reload', async () => {
    const url = await machineUrl(await innerDataUrl(), 300);
    const bytes = await layoutBytes(url, [{ id: 'plc-m0' }]);
    const b = await loadReal(bytes);
    const registry = b.h.viewer.registry!;
    const slidePath = registry.getPathForNode(slideOf(findByName(b.h.viewer.currentModelRoot!, 'Machine_0'))!)!;
    const op = {
      id: 'op-1', ts: Date.now(), schemaV: 1,
      kind: 'setField', nodePath: slidePath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 450, prev: 300,
    } as unknown as RvOp;
    const baked = await bakeIntoGlb(toArrayBuffer(bytes).slice(0), materialise([op]), makeRegistryBakeResolver(registry, []), {
      expectedNames: registry.getGltfNodeNames(),
    });
    const json = JSON.stringify((await import('../src/core/persistence/rv-glb-chunks')).parseGlbChunks(baked.glb).json);
    expect(json).toContain(`"${NESTED}"`);
    const again = await loadReal(baked.glb);
    expect(speed(slideOf(findByName(again.h.viewer.currentModelRoot!, 'Machine_0')))).toBe(450);
    expect(orphans()).toEqual([]);
  });
});

describe('9.9 orphan verdict and queue flush', () => {
  it('no target in the nested asset, or a segment that is no nested reference → orphaned once nothing is pending (no caller asks)', async () => {
    const url = await machineUrl(await innerDataUrl());
    const b = await loadReal(await layoutBytes(url, [{
      id: 'plc-m0',
      overrides: {
        [`${CELL_REF_NODE_ID}#nid-ghost`]: { Drive: { TargetSpeed: 1 } },
        [`nid-nothere#${SLIDE_NODE_ID}`]: { Drive: { TargetSpeed: 2 } },
      },
    }]));
    const found = orphans();
    expect(found.map((p) => p.id).sort()).toEqual([
      `override-orphaned:${b.h.viewer.registry!.getPathForNode(findByName(b.h.viewer.currentModelRoot!, 'Machine_0')!)}:address:${CELL_REF_NODE_ID}#nid-ghost`,
      `override-orphaned:${b.h.viewer.registry!.getPathForNode(findByName(b.h.viewer.currentModelRoot!, 'Machine_0')!)}:address:nid-nothere#${SLIDE_NODE_ID}`,
    ].sort());
    expect(found.find((p) => p.id.endsWith(`nid-nothere#${SLIDE_NODE_ID}`))!.detail).toContain('never appeared');
    expect(b.h.viewer.placements.routedOverrideCount).toBe(1); // the ghost waits on a LIVE occurrence; only the missing one was settled
    expect(speed(slideOf(findByName(b.h.viewer.currentModelRoot!, 'Machine_0')))).toBe(200);
  });

  it('404: the nested asset cannot be loaded → placement-missing', async () => {
    const url = await machineUrl('blob:rv-test/p769-does-not-exist.glb');
    await loadReal(await layoutBytes(url, [{ id: 'plc-m0', overrides: { [NESTED]: { Drive: { TargetSpeed: 5 } } } }]));
    const found = orphans();
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('could not be loaded');
    expect(booted!.h.viewer.placements.routedOverrideCount).toBe(0);
  });

  it('cap: the nested placement is cut by the per-load cap → placement-cap', async () => {
    const url = await machineUrl(await innerDataUrl());
    await loadReal(await layoutBytes(url, [{ id: 'plc-m0', overrides: { [NESTED]: { Drive: { TargetSpeed: 5 } } } }]), { cap: 1 });
    const found = orphans();
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('placement cap');
  });

  it('clearModel: the queue is emptied (unloaded) — nothing reported for a document that is gone', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const h = booted.h;
    const doc = new Group();
    doc.name = 'Layout';
    const machine = referenceNode('Machine_0', 'plc-m0', OUTER_URL, true, [10, 0, 0]);
    setAssetOverrides(machine, { byAddress: { [NESTED]: { Drive: { TargetSpeed: 640 } } } });
    doc.add(machine);
    await h.viewer.loadModel('layout.glb', { data: await objectToGlb(doc) });
    for (let i = 0; i < 50 && h.viewer.placements.routedOverrideCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.viewer.placements.routedOverrideCount).toBe(1);
    h.viewer.clearModel();
    expect(h.viewer.placements.routedOverrideCount).toBe(0);
    booted.open();
    await new Promise((r) => setTimeout(r, 50));
    expect(orphans()).toEqual([]);
  });
});

describe('9.9 "#<rootId>" of the placed asset', () => {
  it('resolves to the placement root (the template root is in the id map)', async () => {
    const url = await machineUrl(await innerDataUrl());
    const probe = await loadReal(await layoutBytes(url, [{ id: 'plc-m0' }]));
    const inst = probe.h.viewer.bakeRegistry.instanceOf(findByName(probe.h.viewer.currentModelRoot!, 'Machine_0')!)!;
    const rootId = identityIdOf(inst.baked.template)!;
    expect(rootId).toBeTruthy();
    const b = await loadReal(await layoutBytes(url, [{ id: 'plc-m0', overrides: { [`#${rootId}`]: { Note: { Text: 'on the root' } } } }]));
    const placed = findByName(b.h.viewer.currentModelRoot!, 'Machine_0')!;
    expect((placed.userData.realvirtual as { Note?: { Text?: string } }).Note?.Text).toBe('on the root');
    expect(orphans()).toEqual([]);
  });
});

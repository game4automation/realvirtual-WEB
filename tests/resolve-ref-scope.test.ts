// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.4 — `NodeRegistry.resolveRef`: the address table of §2.3, row by row,
 * through the PRODUCTION registry (the Phase-0 spike, wired):
 *
 *  1. target in the same document          `#id`      → `O_doc#id`
 *  2. target in placement P of the document `p#id`     → `O_doc/p#id`
 *  3. target in nested placement B in P     `p/b#id`   → `O_doc/p/b#id` (pending until B materialises)
 *  5. reference between placements, stored in the layout: `b#id` from the layout's occurrence
 *  frames (authoring compose) — with and without a sha256 (derived vs seeded ids)
 *
 * plus the instance variant (the same relative address in two placements of one
 * asset → each its own instance; `O_doc` from the referrer's own address), the
 * id-less referrer (nearest registered ancestor; a reference node as ancestor opens
 * its content), a reference node without an authored id (seeded, addressable), and
 * the pending queue: flushed on `layout-content-added`, the orphan verdict once no
 * placement is pending, dropped with a reason on `clearModel`. Row 4 (overrides) is
 * Phase 4. Main-model references resolving inside `initSubtree` (registration before
 * the init): `migrate-on-load.test.ts`, "content root".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { NodeRegistry, PendingDropReason } from '../src/core/engine/rv-node-registry';
import { getNodeId, setNodeId } from '../src/core/engine/rv-node-id';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, resetSidecarProbeCache } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import {
  CELL_REF_NODE_ID, INNER_URL, OUTER_URL, SLIDE_NODE_ID, bootNestedViewer, findByName, referenceNode, sleep, type Booted,
} from './helpers/nested-placement-fixture';

const P1 = 'nid-p1';
const P2 = 'nid-p2';
const PANEL = 'nid-panel';
const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function layoutBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  setNodeId(root, 'nid-layout');
  root.add(referenceNode('Machine_1', P1, OUTER_URL, true, [10, 0, 0]));
  root.add(referenceNode('Machine_2', P2, OUTER_URL, true, [20, 0, 0]));
  const panel = new Object3D();
  panel.name = 'Panel';
  setNodeId(panel, PANEL);
  root.add(panel);
  return objectToGlb(root);
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error('waitFor: timeout');
    await sleep(10);
  }
}

const addr = (address: string) => ({ address });

describe('plan-769 9.4 — resolveRef scope (address table §2.3)', () => {
  let booted: Booted | null = null;
  afterEach(() => { booted?.h.dispose(); booted = null; });

  async function bootLayout(): Promise<{ b: Booted; reg: NodeRegistry; root: Object3D; panel: Object3D }> {
    booted = await bootNestedViewer({ gate: INNER_URL });
    await booted.h.viewer.loadModel('layout.glb', { data: await layoutBytes() });
    const reg = booted.h.viewer.registry!;
    const root = booted.h.viewer.currentModelRoot!;
    return { b: booted, reg, root, panel: findByName(root, 'Panel')! };
  }

  it('rows 1–3 + instance variant: same document, placement, nested placement (pending → resolved on layout-content-added)', async () => {
    const { b, reg, root, panel } = await bootLayout();
    // Row 1, before any placement exists.
    const self = reg.resolveRef(panel, addr(`#${PANEL}`));
    expect(self.status === 'resolved' && self.node).toBe(panel);
    expect(self.status === 'resolved' && self.via).toBe('address');

    await waitFor(() => b.order.filter((o) => o === 'added:Machine_1' || o === 'added:Machine_2').length === 2);
    const m1 = findByName(root, 'Machine_1')!;
    const m2 = findByName(root, 'Machine_2')!;
    // Row 2: the nested REFERENCE node Cell_1 of Machine_1 (content of P1).
    const cell = reg.resolveRef(panel, addr(`${P1}#${CELL_REF_NODE_ID}`));
    expect(cell.status === 'resolved' && cell.node.parent).toBe(m1);
    expect(cell.status === 'resolved' && cell.address).toBe(`${P1}#${CELL_REF_NODE_ID}`);

    // Row 3: inside nested placement B of P — not materialised (gated) → pending, not missing.
    const got: Record<string, Object3D> = {};
    const dropped: PendingDropReason[] = [];
    const r1 = reg.whenResolved(panel, addr(`${P1}/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`), (n) => { got.s1 = n; }, (why) => dropped.push(why));
    const r2 = reg.whenResolved(panel, addr(`${P2}/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`), (n) => { got.s2 = n; }, (why) => dropped.push(why));
    expect(r1.status).toBe('pending');
    expect(r2.status).toBe('pending');
    expect(r1.status === 'pending' && r1.blocking).toBe(findByName(m1, 'Cell_1'));
    expect(reg.pendingRefCount()).toBe(2);
    // A chain that does not exist is missing, never pending.
    expect(reg.resolveRef(panel, addr(`nid-nowhere/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`)).status).toBe('unresolved');

    // The gate opens; the viewer's own `layout-content-added` hook flushes the queue.
    b.open();
    await b.h.viewer.whenSceneReady();
    expect(reg.pendingRefCount()).toBe(0);
    expect(dropped).toEqual([]);
    // Instance variant: the same relative address lands in its OWN instance.
    expect(got.s1).toBe(findByName(findByName(m1, 'Cell_1')!, 'Slide'));
    expect(got.s2).toBe(findByName(findByName(m2, 'Cell_1')!, 'Slide'));
    expect(got.s1).not.toBe(got.s2);

    // A referrer INSIDE a placement: `#id` relative to its own file (O_doc = its occurrence).
    const fromInside = reg.resolveRef(got.s1!, addr(`#${SLIDE_NODE_ID}`));
    expect(fromInside.status === 'resolved' && fromInside.node).toBe(got.s1);
    expect(reg.docOccurrenceOf(got.s1!)).toBe(`${P1}/${CELL_REF_NODE_ID}`);
    // An id-less referrer: nearest registered ancestor; a reference node as ancestor opens its content.
    const gizmo = new Object3D();
    findByName(m2, 'Cell_1')!.add(gizmo);
    expect(reg.resolveRef(gizmo, addr(`#${SLIDE_NODE_ID}`)).status === 'resolved').toBe(true);
    expect((reg.resolveRef(gizmo, addr(`#${SLIDE_NODE_ID}`)) as { node: Object3D }).node).toBe(got.s2);
    // A reference node as REFERRER belongs to its parent file (spike condition b).
    expect(reg.docOccurrenceOf(findByName(m1, 'Cell_1')!)).toBe(P1);

    // Row 5: a reference between placements, stored in the LAYOUT (O_doc = '').
    const between = reg.resolveRefInOccurrence('', addr(`${P2}#${CELL_REF_NODE_ID}`));
    expect(between.status === 'resolved' && between.node.parent).toBe(m2);
    // The id index equals the traversal after every placement settled (9.21).
    expect(reg.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });
  });

  it('orphan verdict: a target that never appears is dropped as missing once no placement is pending', async () => {
    const { b, reg, panel } = await bootLayout();
    const dropped: PendingDropReason[] = [];
    const resolved = vi.fn();
    await waitFor(() => b.order.includes('added:Machine_1'));
    const r = reg.whenResolved(panel, addr(`${P1}/${CELL_REF_NODE_ID}#nid-not-there`), resolved, (why) => dropped.push(why));
    expect(r.status).toBe('pending');
    b.open();
    await b.h.viewer.whenSceneReady();
    await waitFor(() => dropped.length > 0);
    expect(dropped).toEqual(['missing']);
    expect(resolved).not.toHaveBeenCalled();
    expect(reg.pendingRefCount()).toBe(0);
  });

  it('a model change drops what still waits with "unloaded"', async () => {
    const { b, reg, panel } = await bootLayout();
    await waitFor(() => b.order.includes('added:Machine_1'));
    const dropped: PendingDropReason[] = [];
    reg.whenResolved(panel, addr(`${P1}/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`), () => {}, (why) => dropped.push(why));
    b.h.viewer.clearModel();
    expect(dropped).toEqual(['unloaded']);
  });
});

// ─── Frames (authoring compose) ────────────────────────────────────────

const material = new MeshStandardMaterial({ color: 0x8899aa });
function meshNamed(name: string, size: number, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(size, size, size), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

describe('plan-769 9.4 — frames (composed references)', () => {
  let pressBytes: ArrayBuffer;
  let plantBytes: ArrayBuffer;

  async function build(): Promise<void> {
    resetSidecarProbeCache();
    const press = new Group();
    press.name = 'Press';
    press.add(meshNamed('Ram', 1, { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
    press.add(meshNamed('Housing', 1.5));
    pressBytes = await objectToGlb(press);
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(meshNamed('Floor', 2));
    const ref = new Object3D();
    ref.name = 'Press_0';
    setAssetReference(ref, { assetId: 'press' });
    plant.add(ref);
    plantBytes = await objectToGlb(plant);
  }

  async function loadPlant(sha256?: string) {
    const resolver: ReferenceResolver = async () => ({
      bytes: pressBytes, url: 'lib/press.glb', ...(sha256 ? { sha256 } : {}), signatureState: 'none', signaturePresent: false,
    });
    return loadGLB('plant.glb', new Scene(), {
      data: plantBytes.slice(0), referenceResolver: resolver, preserveHierarchy: true, loadKinematicsSidecar: false,
    });
  }

  it('a file WITHOUT sha256: seeded ids; frame content under its occurrence, the reference node in its own file', async () => {
    await build();
    const result = await loadPlant();
    const reg = result.registry;
    const frame = result.composition!.frames[0]!;
    const housing = findByName(result.root, 'Housing')!;
    const pressRef = findByName(result.root, 'Press_0')!;
    // The reference node had no authored id: seeded, and addressable in the PLANT file.
    expect(identityIdOf(pressRef)).toMatch(UUID5);
    expect(reg.getAddressForNode(pressRef)).toBe(`#${identityIdOf(pressRef)}`);
    // Its content (the grafted clone) lives in the frame's occurrence, under seeded ids.
    expect(identityIdOf(housing)).toMatch(UUID5);
    expect(reg.getAddressForNode(housing)).toBe(`${frame.occurrence}#${identityIdOf(housing)}`);
    expect(reg.docOccurrenceOf(housing)).toBe(frame.occurrence);
    // Row 1 inside the frame, and the plant reaching into it (row 2 shape).
    const r = reg.resolveRef(findByName(result.root, 'Ram')!, { address: `#${identityIdOf(housing)}` });
    expect(r.status === 'resolved' && r.node).toBe(housing);
    const fromPlant = reg.resolveRef(findByName(result.root, 'Floor')!, { address: `${frame.occurrence}#${identityIdOf(housing)}` });
    expect(fromPlant.status === 'resolved' && fromPlant.node).toBe(housing);
    // The press's own legacy paths migrate in ITS file (identity registered with the frame).
    expect(reg.identityOfOccurrence(frame.occurrence)?.migratePath('Housing').address).toBe(`#${identityIdOf(housing)}`);
    expect(reg.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });
  });

  it('a file WITH sha256: compose derives NO ids any more (plan-769 F12) — the decode seed is the identity, the record agrees', async () => {
    await build();
    const result = await loadPlant('sha-press');
    const reg = result.registry;
    const frame = result.composition!.frames[0]!;
    const housing = findByName(result.root, 'Housing')!;
    // A UUIDv5 seed of the authored path (rv-node-id-seed), not a 16-hex sha256 derivation.
    expect(identityIdOf(housing)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(getNodeId(housing), 'no derived NodeId is stamped').toBeNull();
    expect(reg.identityOfOccurrence(frame.occurrence)?.migratePath('Housing').address).toBe(`#${identityIdOf(housing)}`);
    const r = reg.resolveRef(findByName(result.root, 'Ram')!, 'Housing');
    expect(r.status === 'resolved' && r.node).toBe(housing);
  });
});

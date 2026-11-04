// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0 — ADDRESS SPIKE (go / no-go for Phase 1 and 4).
 *
 * The thinnest runnable version of the plan's §2.3 address table against the
 * REAL viewer and its placement pipeline (`bootNestedViewer`, fake loader):
 *
 *  1. main-model registration under occurrence `''` that STOPS at reference
 *     nodes (their content is its own occurrence);
 *  2. `resolveRef(referrer, ref)`: relative address → absolute
 *     (`O_doc` + relative) → `NodeRegistry.getNodeByAddress`, with `O_doc` read
 *     off the referrer's registered address (nearest registered ancestor; a
 *     reference node met as ANCESTOR opens its content occurrence);
 *  3. a pending queue for a target inside a nested placement that materialises
 *     LATE (the inner asset's decode is gated), flushed on
 *     `layout-content-added` — the event integration emits after it registered
 *     the instance's ids.
 *
 * Spike code lives in this file on purpose (spike rule): nothing here is wired
 * into production. Findings → plan-769 `## Spike-Ergebnis`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { childOccurrence, getNodeId, parseNodeAddress, setNodeId } from '../src/core/engine/rv-node-id';
import { getAssetReference, getDeferredPlacement } from '../src/core/engine/rv-asset-reference';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  CELL_REF_NODE_ID, INNER_URL, OUTER_URL, SLIDE_NODE_ID, bootNestedViewer, findByName, referenceNode, sleep, type Booted,
} from './helpers/nested-placement-fixture';

// ─── The spike ──────────────────────────────────────────────────────────

/** A non-embedded AssetReference node: its content is another file, another occurrence. */
function isReferenceNode(node: Object3D): boolean {
  const ref = getAssetReference(node);
  return !!ref && (ref as { embedded?: boolean }).embedded !== true;
}

type Resolution =
  | { kind: 'node'; node: Object3D; absolute: string }
  | { kind: 'pending'; occurrence: string; absolute: string }
  | { kind: 'missing'; absolute: string | null };

class AddressSpike {
  private readonly pending = new Map<string, Array<{ referrer: Object3D; ref: string; done(node: Object3D): void }>>();
  flushed = 0;

  constructor(private readonly registry: NodeRegistry) {}

  /**
   * Register every id of a document's OWN nodes under `occurrence`: the
   * reference nodes themselves belong to this file, their content does not.
   * (`registerNodeIdsForSubtree` would walk into already-materialised content
   * and claim it for `''`.)
   */
  registerDocument(root: Object3D, occurrence: string): number {
    let n = 0;
    const visit = (node: Object3D, isRoot: boolean): void => {
      if (this.registry.registerNodeId(node, occurrence)) n++;
      if (!isRoot && isReferenceNode(node)) return;
      for (const c of node.children) visit(c, false);
    };
    visit(root, true);
    return n;
  }

  /** The content occurrence below a reference node. */
  contentOccurrenceOf(refNode: Object3D): string | null {
    const mark = getDeferredPlacement(refNode);
    if (mark?.occurrence) return mark.occurrence;
    const id = getNodeId(refNode);
    const own = this.registry.getAddressForNode(refNode);
    if (!id || own === null) return null;
    const occ = parseNodeAddress(own).occurrence;
    // HEAD double-registers a placement root (see the FINDING below): when its
    // reverse address already IS its content occurrence, do not append again.
    if (occ === id || occ.endsWith(`/${id}`)) return occ;
    return childOccurrence(occ, id);
  }

  /** O_doc of a referrer: the occurrence of the file whose bytes hold it. */
  docOccurrenceOf(referrer: Object3D): string | null {
    for (let n: Object3D | null = referrer; n; n = n.parent) {
      if (n !== referrer && isReferenceNode(n)) return this.contentOccurrenceOf(n);
      const a = this.registry.getAddressForNode(n);
      if (a !== null) return parseNodeAddress(a).occurrence;
    }
    return null;
  }

  private join(docOcc: string, rel: string): string {
    if (!rel) return docOcc;
    return docOcc ? `${docOcc}/${rel}` : rel;
  }

  /** Is `occurrence` a placement that exists but has not registered its content yet? */
  private isPending(occurrence: string): boolean {
    const segs = occurrence ? occurrence.split('/') : [];
    let parent = '';
    for (let i = 0; i < segs.length; i++) {
      const refNode = this.registry.getNodeByAddress(segs[i]!, parent);
      if (!refNode || !isReferenceNode(refNode)) return false;
      const child = childOccurrence(parent, segs[i]!);
      const registered = this.registry.getRegisteredAddresses().some((a) => a.startsWith(`${child}#`));
      if (!registered) return true; // the reference node is there, its content is not (yet)
      parent = child;
    }
    return false;
  }

  resolveRef(referrer: Object3D, ref: string): Resolution {
    const docOcc = this.docOccurrenceOf(referrer);
    if (docOcc === null) return { kind: 'missing', absolute: null };
    const { occurrence: rel, nodeId } = parseNodeAddress(ref);
    const occ = this.join(docOcc, rel);
    const absolute = `${occ}#${nodeId}`;
    const node = this.registry.getNodeByAddress(nodeId, occ);
    if (node) return { kind: 'node', node, absolute };
    if (this.isPending(occ)) return { kind: 'pending', occurrence: occ, absolute };
    return { kind: 'missing', absolute };
  }

  /** Resolve now, or queue until the occurrence registers. */
  whenResolved(referrer: Object3D, ref: string, done: (node: Object3D) => void): Resolution {
    const r = this.resolveRef(referrer, ref);
    if (r.kind === 'node') done(r.node);
    else if (r.kind === 'pending') {
      const list = this.pending.get(r.occurrence) ?? [];
      list.push({ referrer, ref, done });
      this.pending.set(r.occurrence, list);
    }
    return r;
  }

  pendingCount(): number {
    let n = 0;
    for (const l of this.pending.values()) n += l.length;
    return n;
  }

  /** `occurrence-registered` stand-in: retry every queued ref whose occurrence is there now. */
  flush(): void {
    for (const [occ, list] of [...this.pending]) {
      const still: typeof list = [];
      for (const p of list) {
        const r = this.resolveRef(p.referrer, p.ref);
        if (r.kind === 'node') { this.flushed++; p.done(r.node); } else still.push(p);
      }
      if (still.length) this.pending.set(occ, still); else this.pending.delete(occ);
    }
  }
}

// ─── Fixture: a layout with a Panel that references into its placements ──

const P1 = 'nid-p1';
const P2 = 'nid-p2';
const PANEL = 'nid-panel';

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

describe('plan-769 Phase 0 — address spike', () => {
  let booted: Booted | null = null;
  afterEach(() => { booted?.h.dispose(); booted = null; });

  it('main model registration + relative→absolute resolveRef + pending queue for a late nested placement', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const { h, open, order } = booted;
    let spike: AddressSpike | null = null;
    h.viewer.on('layout-content-added', () => spike?.flush());

    await h.viewer.loadModel('layout.glb', { data: await layoutBytes() });
    // The registry is built per load — take it (and start the spike) afterwards.
    const registry = h.viewer.registry!;
    spike = new AddressSpike(registry);
    const root = h.viewer.currentModelRoot!;
    const panel = findByName(root, 'Panel')!;

    // F5 gap, measured at Phase 0: NOTHING of the main model was in the id index.
    // Phase 1a: loadGLB registers the main model (between bake and init).
    expect(registry.getAddressForNode(panel), 'main model registered by loadGLB (plan-769 1a)').toBe(`#${PANEL}`);
    // Spike step 1 (now idempotent): register the document's own nodes (stops at reference nodes).
    // 5 since Phase 1a: the model root (the glTF scene) carries its SEEDED id now, plus Layout, Machine_1, Machine_2, Panel.
    expect(spike!.registerDocument(root, '')).toBe(5);
    expect(registry.getAddressForNode(panel)).toBe(`#${PANEL}`);

    // The outer placements materialise (their decode is not gated); the inner Cell is gated.
    await waitFor(() => order.filter((o) => o === 'added:Machine_1' || o === 'added:Machine_2').length === 2);
    const m1 = findByName(root, 'Machine_1')!;
    const m2 = findByName(root, 'Machine_2')!;

    // Occurrence of a top-level placement's content = its reference NodeId.
    expect(spike.contentOccurrenceOf(m1)).toBe(P1);
    // Row 1 of §2.3: target in the same document.
    const self = spike.resolveRef(panel, `#${PANEL}`);
    expect(self.kind === 'node' && self.node).toBe(panel);
    // Row 2: target in placement P of this document — the nested REFERENCE node Cell_1 of Machine_1.
    const cellRef1 = spike.resolveRef(panel, `${P1}#${CELL_REF_NODE_ID}`);
    expect(cellRef1.kind).toBe('node');
    expect(cellRef1.kind === 'node' && cellRef1.node.parent).toBe(m1);

    // Row 3: target inside nested placement B in P — NOT materialised yet → pending, not missing.
    let slide1: Object3D | null = null;
    let slide2: Object3D | null = null;
    const r1 = spike.whenResolved(panel, `${P1}/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`, (n) => { slide1 = n; });
    const r2 = spike.whenResolved(panel, `${P2}/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`, (n) => { slide2 = n; });
    expect(r1.kind).toBe('pending');
    expect(r2.kind).toBe('pending');
    expect(r1.absolute).toBe(`${P1}/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`);
    // A target whose occurrence does not exist at all is missing, never pending.
    expect(spike.resolveRef(panel, `nid-nowhere/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`).kind).toBe('missing');
    expect(spike.pendingCount()).toBe(2);

    // The gate opens: the inner asset decodes, both nested instances register and announce themselves.
    open();
    await h.viewer.whenSceneReady();
    expect(spike.pendingCount()).toBe(0);
    expect(spike.flushed).toBe(2);
    const cell1 = findByName(m1, 'Cell_1')!;
    const cell2 = findByName(m2, 'Cell_1')!;
    // Instance variant: the same relative address lands in its OWN instance.
    expect(slide1).toBe(findByName(cell1, 'Slide'));
    expect(slide2).toBe(findByName(cell2, 'Slide'));
    expect(slide1).not.toBe(slide2);

    // Referrer INSIDE a placement (asset-relative ref, `#id` in the inner file):
    // O_doc comes from the referrer's own registered address.
    const slideIn1 = slide1 as unknown as Object3D;
    const fromInside = spike.resolveRef(slideIn1, `#${SLIDE_NODE_ID}`);
    expect(fromInside.kind === 'node' && fromInside.node).toBe(slideIn1);
    // Plain CAD geometry (`Body`) does not survive the destructive bake — the
    // id-less referrers that remain are runtime/synthetic nodes. Nearest
    // registered ancestor: a plain node keeps ITS occurrence…
    const gizmoOnSlide = new Object3D();
    slideIn1.add(gizmoOnSlide);
    expect(spike.docOccurrenceOf(gizmoOnSlide)).toBe(`${P1}/${CELL_REF_NODE_ID}`);
    // …a REFERENCE node met as ancestor opens its content occurrence.
    const gizmoOnCell = new Object3D();
    cell1.add(gizmoOnCell);
    expect(spike.docOccurrenceOf(gizmoOnCell)).toBe(`${P1}/${CELL_REF_NODE_ID}`);
    const viaGizmo = spike.resolveRef(gizmoOnCell, `#${SLIDE_NODE_ID}`);
    expect(viaGizmo.kind === 'node' && viaGizmo.node).toBe(slideIn1);

    // FINDING at Phase 0 (fixed in Phase 1a, spike condition b): a placement root was
    // registered TWICE — under its parent file's occurrence AND by the integration
    // under its own content occurrence (`nid-p1#nid-p1`, `nid-p1/nid-cell#nid-cell`),
    // and the reverse map kept the LAST, so the nested reference node Cell_1 read
    // O_doc `nid-p1/nid-cell`. Now: the root only under its parent occurrence, the
    // content without it.
    const addresses = registry.getRegisteredAddresses();
    expect(addresses).toContain(`#${P1}`);
    expect(addresses).not.toContain(`${P1}#${P1}`);
    expect(addresses).toContain(`${P1}#${CELL_REF_NODE_ID}`);
    expect(addresses).not.toContain(`${P1}/${CELL_REF_NODE_ID}#${CELL_REF_NODE_ID}`);
    expect(registry.getAddressForNode(cell1), 'a reference node keeps the address of its own file').toBe(`${P1}#${CELL_REF_NODE_ID}`);
    expect(spike.docOccurrenceOf(cell1), 'O_doc of a reference node as referrer = its parent file').toBe(P1);
    // The production twin of the spike agrees (plan-769 1a, NodeRegistry.docOccurrenceOf).
    expect(registry.docOccurrenceOf(cell1)).toBe(P1);
    expect(registry.docOccurrenceOf(gizmoOnCell)).toBe(`${P1}/${CELL_REF_NODE_ID}`);
  });
});

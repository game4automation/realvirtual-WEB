// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * descend-override-suppression.test.ts — plan-703 §9.16 (F5 + the half of F7
 * that §9.4 does not reach), plus the Descend/Back special cases of §2.7.3.
 *
 * Descending edits the CHILD FILE, so the overrides of the instance the user
 * came from must not be in force down there — and the user has to be told that
 * something is being withheld, which is the hint line §2.7.2 specifies. After
 * Back the overrides are in force again, because they belong to the parent and
 * the parent's bytes never changed.
 *
 * The suppression is a consequence of the architecture rather than a feature:
 * the child is opened from ITS OWN bytes, so the parent's patches are absent by
 * construction. That is worth pinning precisely because it is easy to break by
 * "helpfully" seeding the child document from the composed subtree.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  setAssetOverrides,
  setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { buildMissingReferencePlaceholder } from '../src/core/engine/rv-missing-reference-placeholder';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import {
  RvDocumentStack,
  countInstanceOverrides,
  describeSuppressedOverrides,
  type RvPendingOverrideSource,
} from '../src/core/ops/rv-document-stack';
import {
  RvDescendController,
  type RvRecomposeHost,
  type RvStackProblem,
} from '../src/core/ops/rv-document-recompose';
import { createStackTestViewer, TestStackDocument } from './helpers/stack-test-viewer';

const material = new MeshStandardMaterial({ color: 0x334455 });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** The child file, authored with TargetSpeed 250. */
function buildAssembly(): Group {
  const g = new Group();
  g.name = 'Assembly';
  g.add(meshNamed('Axis', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
  return g;
}

/** The parent, whose reference node overrides the child's drive to 42. */
function buildPlant(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  const reference = new Object3D();
  reference.name = 'Station';
  setNodeId(reference, 'ref-station');
  setAssetReference(reference, { assetId: 'assembly' });
  setAssetOverrides(reference, {
    byNodeId: {},
    byPath: { Axis: { Drive: { TargetSpeed: 42 } } },
  });
  plant.add(reference);
  return plant;
}

let assemblyBytes: ArrayBuffer;
let plantBytes: ArrayBuffer;

const resolver: ReferenceResolver = async () => ({
  bytes: assemblyBytes.slice(0),
  url: 'lib/assembly.glb',
  sha256: 'sha-assembly',
  signatureState: 'none',
  signaturePresent: false,
});

function loadFrom(bytes: ArrayBuffer, url: string, withReferences: boolean): Promise<LoadResult> {
  return loadGLB(url, new Scene(), {
    data: bytes.slice(0),
    preserveHierarchy: true,
    loadKinematicsSidecar: false,
    ...(withReferences ? { referenceResolver: resolver } : {}),
  });
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

function targetSpeedOf(node: Object3D): unknown {
  const rv = node.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return rv?.Drive?.TargetSpeed;
}

beforeEach(async () => {
  assemblyBytes = await objectToGlb(buildAssembly());
  plantBytes = await objectToGlb(buildPlant());
});

describe('Overrides der Instanz sind im Kind unterdrueckt (§9.16 / F5)', () => {
  it('im Elternteil greift der Override, im eigenstaendig geoeffneten Kind nicht', async () => {
    const parent = await loadFrom(plantBytes, 'plant.glb', true);
    expect(targetSpeedOf(findByName(parent.root, 'Axis')!)).toBe(42);

    // The descend opens the child from ITS OWN bytes — the parent's instance
    // patch has no way in, which is the suppression.
    const child = await loadFrom(assemblyBytes, 'lib/assembly.glb', false);
    expect(targetSpeedOf(findByName(child.root, 'Axis')!)).toBe(250);
  });

  it('nach dem Back greift der Override wieder', async () => {
    const before = await loadFrom(plantBytes, 'plant.glb', true);
    expect(targetSpeedOf(findByName(before.root, 'Axis')!)).toBe(42);

    // Back = full reload of the parent (§2.7.3). The overrides belong to the
    // parent and its bytes did not change, so they are back in force.
    const after = await loadFrom(plantBytes, 'plant.glb', true);
    expect(targetSpeedOf(findByName(after.root, 'Axis')!)).toBe(42);
  });
});

describe('Die Hinweiszeile nennt die Anzahl (§2.7.2)', () => {
  it('countInstanceOverrides zaehlt je (Knoten, Komponente)', async () => {
    const parent = await loadFrom(plantBytes, 'plant.glb', true);
    const reference = findByName(parent.root, 'Station')!;

    expect(countInstanceOverrides(reference)).toBe(1);
    expect(describeSuppressedOverrides(countInstanceOverrides(reference)))
      .toBe('1 Override dieser Instanz ist ausgeblendet');
  });

  it('ein Referenzknoten ohne Overrides erzeugt keine Zeile', () => {
    const bare = new Object3D();
    setAssetReference(bare, { assetId: 'assembly' });
    expect(countInstanceOverrides(bare)).toBe(0);
    expect(describeSuppressedOverrides(0)).toBeNull();
  });

  it('mehrere Komponenten auf mehreren Knoten summieren sich', () => {
    const node = new Object3D();
    setAssetOverrides(node, {
      byNodeId: { 'id-1': { Drive: { TargetSpeed: 1 }, Sensor: { Enabled: false } } },
      byPath: { Axis: { Drive: { TargetSpeed: 2 } } },
    });
    expect(countInstanceOverrides(node)).toBe(3);
    expect(describeSuppressedOverrides(3)).toBe('3 Overrides dieser Instanz sind ausgeblendet');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The Descend/Back special cases of §2.7.3, driven through the controller.
// ─────────────────────────────────────────────────────────────────────────

interface CtrlHarness {
  stack: RvDocumentStack;
  controller: RvDescendController;
  problems: RvStackProblem[];
  detached: number;
  childDoc: TestStackDocument;
}

function controllerHarness(opts?: {
  openChildFails?: boolean;
  pending?: RvPendingOverrideSource | null;
}): CtrlHarness {
  const viewer = createStackTestViewer();
  const stack = new RvDocumentStack({ viewer, projectId: 'proj' });
  const parentDoc = new TestStackDocument('doc-parent', 'Plant');
  const childDoc = new TestStackDocument('doc-child', 'Assembly');
  stack.pushRoot({ doc: parentDoc, assetId: 'plant', name: 'Plant' });

  const problems: RvStackProblem[] = [];
  const state = { detached: 0 };
  const host: RvRecomposeHost = {
    async openChild(request) {
      if (opts?.openChildFails) throw new Error('asset file not found');
      const root = new Object3D();
      root.name = 'Assembly';
      viewer.scene.add(root);
      return { doc: childDoc, name: `Assembly@${request.occurrence}`, isolatedRoots: [root] };
    },
    async reloadFrame(frame) { return { isolatedRoots: frame.isolatedRoots }; },
    pendingOverrides() { return opts?.pending ?? null; },
    detachRuntime() { state.detached++; },
    reportProblem(p) { problems.push(p); },
  };

  return {
    stack,
    controller: new RvDescendController(stack, host),
    problems,
    get detached() { return state.detached; },
    childDoc,
  };
}

/**
 * A reference node as composition leaves it: the child's subtree grafted
 * underneath. `grafted: false` produces the PLACEHOLDER case — a reference
 * composition could not resolve, which stands empty (§2.8).
 */
function referenceNode(opts?: {
  id?: string | null;
  embedded?: boolean;
  grafted?: boolean;
}): Object3D {
  const node = new Object3D();
  node.name = 'Station';
  if (opts?.id !== null) setNodeId(node, opts?.id ?? 'ref-station');
  setAssetReference(node, { assetId: 'assembly', ...(opts?.embedded ? { embedded: true } : {}) });
  if (opts?.grafted !== false) {
    const subtree = new Object3D();
    subtree.name = 'Assembly';
    node.add(subtree);
  }
  return node;
}

describe('Descend-Sonderfaelle (§2.7.3)', () => {
  it('Descend auf einem Platzhalter ist deaktiviert — es gibt keine Bytes', () => {
    const h = controllerHarness();
    // Composition resolved nothing, so the reference node stands empty (§2.8).
    const verdict = h.controller.canDescend(referenceNode({ grafted: false }));
    expect(verdict).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('…auch wenn Phase 8 ein Drahtgitter darunter gehaengt hat', () => {
    // The regression this exists for: since plan-703 Phase 8 an unresolved
    // reference is NOT empty any more — it carries a placeholder. An
    // emptiness-only test would wave exactly that case through, and the user
    // would descend into a document with no bytes behind it.
    const h = controllerHarness();
    const node = referenceNode({ grafted: false });
    node.add(buildMissingReferencePlaceholder({ label: 'Assembly.glb' }));
    expect(h.controller.canDescend(node)).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('Descend auf einer eingebetteten Referenz ist deaktiviert', () => {
    const h = controllerHarness();
    // A flat export already inlined the subtree — the reference is only a
    // provenance note, and there is no separate file behind it.
    expect(h.controller.canDescend(referenceNode({ embedded: true })))
      .toEqual({ ok: false, reason: 'embedded' });
  });

  it('Descend auf einem Nicht-Referenzknoten ist deaktiviert', () => {
    const h = controllerHarness();
    const plain = new Object3D();
    plain.name = 'Floor';
    expect(h.controller.canDescend(plain)).toEqual({ ok: false, reason: 'not-a-reference' });
  });

  it('ein Referenzknoten ohne NodeId kann nicht betreten werden', () => {
    const h = controllerHarness();
    expect(h.controller.canDescend(referenceNode({ id: null })))
      .toEqual({ ok: false, reason: 'no-node-id' });
  });

  it('Descend waehrend laufender Simulation detacht die Runtime', async () => {
    const h = controllerHarness();
    await h.controller.descend(referenceNode());
    expect(h.detached).toBe(1);
    expect(h.stack.depth).toBe(2);
  });

  it('das Kind traegt die Anzahl unterdrueckter Overrides in seinen Frame', async () => {
    const h = controllerHarness();
    const reference = referenceNode();
    setAssetOverrides(reference, {
      byNodeId: {},
      byPath: { Axis: { Drive: { TargetSpeed: 42 } }, Tool: { Sensor: { Enabled: true } } },
    });

    const frame = await h.controller.descend(reference);

    expect(frame.suppressedOverrides).toBe(2);
    expect(h.stack.suppressionNotice()).toBe('2 Overrides dieser Instanz sind ausgeblendet');
    // …and the notice is gone again once the frame is left.
    h.stack.pop();
    expect(h.stack.suppressionNotice()).toBeNull();
  });

  it('Kind extern geloescht: ein Problems-Eintrag, kein stiller Absturz', async () => {
    const h = controllerHarness({ openChildFails: true });

    await expect(h.controller.descend(referenceNode())).rejects.toThrow(/not found/);

    expect(h.problems).toHaveLength(1);
    expect(h.problems[0].kind).toBe('child-missing');
    expect(h.problems[0].assetId).toBe('assembly');
    // The stack did not half-push a frame.
    expect(h.stack.depth).toBe(1);
  });

  it('der Frame traegt die Occurrence, die der Host zu sehen bekam', async () => {
    const h = controllerHarness();
    const frame = await h.controller.descend(referenceNode({ id: 'ref-a' }));
    expect(frame.occurrence).toBe('ref-a');
    expect(frame.name).toBe('Assembly@ref-a');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Lauf 12: the hint counts the UNSAVED overrides too.
//
// Since cc088ec a field edit inside a referenced subtree has a place to land
// (`guardReferenceOp` admits it as `scope: 'override'`, and `exportAssetGlb`
// no longer melts the reference away), so the descend genuinely hides it — but
// it lives in the op log and the inspector's overlay until the document is
// saved, not yet in `AssetOverrides`. A hint that only reads persisted state
// would say "0" about an edit the user made a second ago.
// ─────────────────────────────────────────────────────────────────────────

/** A composed instance: the reference, the grafted child root, two parts. */
function instanceTree(): { reference: Object3D; axis: Object3D; tool: Object3D } {
  const reference = new Object3D();
  reference.name = 'Station';
  setNodeId(reference, 'ref-station');
  setAssetReference(reference, { assetId: 'assembly' });
  // Composition grafts the child ROOT under the reference; `byPath` keys are
  // relative to that root and do not include it (`rv-glb-compose.ts:640-648`).
  const childRoot = new Object3D();
  childRoot.name = 'Assembly';
  reference.add(childRoot);
  const axis = new Object3D();
  axis.name = 'Axis';
  setNodeId(axis, 'id-axis');
  childRoot.add(axis);
  const tool = new Object3D();
  tool.name = 'Tool';
  setNodeId(tool, 'id-tool');
  childRoot.add(tool);
  return { reference, axis, tool };
}

/** A live, MUTABLE stand-in for the inspector overlay plus its registry. */
function pendingHarness(): {
  source: RvPendingOverrideSource;
  nodes: Record<string, Record<string, Record<string, unknown>>>;
  type(nodePath: string, node: Object3D, componentType: string, field: string, value: unknown): void;
  revert(nodePath: string, componentType: string, field: string): void;
} {
  const nodes: Record<string, Record<string, Record<string, unknown>>> = {};
  const registry = new Map<string, Object3D>();
  return {
    nodes,
    source: { nodes, resolve: (p) => registry.get(p) ?? null },
    type(nodePath, node, componentType, field, value) {
      registry.set(nodePath, node);
      nodes[nodePath] ??= {};
      nodes[nodePath][componentType] ??= {};
      nodes[nodePath][componentType][field] = value;
    },
    revert(nodePath, componentType, field) {
      const comp = nodes[nodePath]?.[componentType];
      if (!comp) return;
      delete comp[field];
      if (Object.keys(comp).length === 0) delete nodes[nodePath][componentType];
      if (Object.keys(nodes[nodePath] ?? {}).length === 0) delete nodes[nodePath];
    },
  };
}

describe('Die Hinweiszeile zaehlt auch die ungespeicherten Overrides (§2.7.2, Lauf 12)', () => {
  it('ohne Pending-Quelle bleibt die Zahl exakt die persistierte', () => {
    const { reference } = instanceTree();
    setAssetOverrides(reference, { byNodeId: {}, byPath: { Axis: { Drive: { TargetSpeed: 42 } } } });
    expect(countInstanceOverrides(reference)).toBe(1);
    expect(countInstanceOverrides(reference, null)).toBe(1);
  });

  it('ein frisch getippter Wert erhoeht die Zahl sofort — und ein Revert senkt sie wieder', () => {
    const { reference, axis } = instanceTree();
    setAssetOverrides(reference, { byNodeId: {}, byPath: { Axis: { Drive: { TargetSpeed: 42 } } } });
    const pending = pendingHarness();

    expect(countInstanceOverrides(reference, pending.source)).toBe(1);

    // The user types into a component that is NOT yet overridden on this node.
    pending.type('Plant/Station/Assembly/Axis', axis, 'Sensor', 'Enabled', false);
    expect(countInstanceOverrides(reference, pending.source)).toBe(2);
    expect(describeSuppressedOverrides(countInstanceOverrides(reference, pending.source)))
      .toBe('2 Overrides dieser Instanz sind ausgeblendet');

    // …and takes it back.
    pending.revert('Plant/Station/Assembly/Axis', 'Sensor', 'Enabled');
    expect(countInstanceOverrides(reference, pending.source)).toBe(1);
    expect(describeSuppressedOverrides(countInstanceOverrides(reference, pending.source)))
      .toBe('1 Override dieser Instanz ist ausgeblendet');
  });

  it('ein zweiter Griff an ein bereits ueberschriebenes Feld zaehlt nicht doppelt', () => {
    const { reference, axis } = instanceTree();
    // Persisted by PATH — the addressing a file written before NodeIds uses.
    setAssetOverrides(reference, { byNodeId: {}, byPath: { Axis: { Drive: { TargetSpeed: 42 } } } });
    const pending = pendingHarness();
    pending.type('Plant/Station/Assembly/Axis', axis, 'Drive', 'TargetSpeed', 99);
    expect(countInstanceOverrides(reference, pending.source)).toBe(1);
  });

  it('…auch wenn der persistierte Eintrag ueber die NodeId adressiert ist', () => {
    const { reference, axis } = instanceTree();
    setAssetOverrides(reference, { byNodeId: { 'id-axis': { Drive: { TargetSpeed: 42 } } } });
    const pending = pendingHarness();
    pending.type('Plant/Station/Assembly/Axis', axis, 'Drive', 'TargetSpeed', 99);
    expect(countInstanceOverrides(reference, pending.source)).toBe(1);
    // A different component on the same node IS a second override.
    pending.type('Plant/Station/Assembly/Axis', axis, 'Sensor', 'Enabled', true);
    expect(countInstanceOverrides(reference, pending.source)).toBe(2);
  });

  it('mehrere Knoten der Instanz summieren sich, ein Knoten ausserhalb nicht', () => {
    const { reference, axis, tool } = instanceTree();
    const outside = new Object3D();
    outside.name = 'Floor';
    setNodeId(outside, 'id-floor');
    const pending = pendingHarness();
    pending.type('Plant/Station/Assembly/Axis', axis, 'Drive', 'TargetSpeed', 99);
    pending.type('Plant/Station/Assembly/Tool', tool, 'Sensor', 'Enabled', true);
    pending.type('Plant/Floor', outside, 'Drive', 'TargetSpeed', 7);
    // The descend replaces only the reference's subtree, so only what sits in
    // it is hidden. `Floor` stays on screen and must not be announced.
    expect(countInstanceOverrides(reference, pending.source)).toBe(2);
  });

  it('ein Overlay-Pfad, den die Registry nicht mehr aufloest, zaehlt nicht mit', () => {
    const { reference } = instanceTree();
    const pending = pendingHarness();
    // Typed, then the node was renamed away — resolve() returns null. Counting
    // it would announce a suppression the user cannot find.
    pending.nodes['Plant/Station/Assembly/Gone'] = { Drive: { TargetSpeed: 1 } };
    expect(countInstanceOverrides(reference, pending.source)).toBe(0);
  });

  it('der Descend traegt die erhoehte Zahl in den Frame und in die Hinweiszeile', async () => {
    const reference = referenceNode();
    setAssetOverrides(reference, { byNodeId: {}, byPath: { Axis: { Drive: { TargetSpeed: 42 } } } });
    // `referenceNode()` grafts a child root named 'Assembly'; hang a part in it
    // so an overlay path has something inside the reference to resolve to.
    const axis = new Object3D();
    axis.name = 'Axis';
    setNodeId(axis, 'id-axis');
    reference.children[0].add(axis);

    const pending = pendingHarness();
    pending.type('Plant/Station/Assembly/Axis', axis, 'Sensor', 'Enabled', false);

    const h = controllerHarness({ pending: pending.source });
    const frame = await h.controller.descend(reference);

    expect(frame.suppressedOverrides).toBe(2);
    expect(h.stack.suppressionNotice()).toBe('2 Overrides dieser Instanz sind ausgeblendet');
  });
});

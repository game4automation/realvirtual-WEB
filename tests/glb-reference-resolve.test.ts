// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-reference-resolve.test.ts — plan-397 Phase 3, plan §9.3.
 *
 * Composition as a pure tree operation: resolution, dedup, one clone per
 * occurrence, base-relative paths, cycles, depth, abort. The resolver is
 * injected, so nothing here touches the network or the library registry — the
 * production resolver's policy is a separate concern (§2.5) and would only make
 * these assertions depend on things they are not about.
 *
 * The three assertions that exist because a plan review found the bug:
 *  - F17: ten references to one asset must be ten distinct `Object3D`s. Three.js
 *    allows exactly one parent, so a shared subtree would silently un-parent
 *    nine of them.
 *  - F18: a relative path resolves against the file it is WRITTEN IN. Resolving
 *    against the root scene would break every library assembly the moment it is
 *    used from a different folder.
 *  - F19/R2: ten occurrences carry IDENTICAL NodeIds — they come from the same
 *    bytes. Only the occurrence chain tells them apart.
 */

import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  compose,
  resolveReferencePath,
  ReferenceCycleError,
  ReferenceDepthError,
  ComposeAbortedError,
  GlbTemplateCache,
  type ReferenceResolver,
  type ResolvedReference,
} from '../src/core/engine/rv-glb-compose';
import { setAssetReference, setAssetOverrides } from '../src/core/engine/rv-asset-reference';
import { getNodeId, fullNodeAddress } from '../src/core/engine/rv-node-id';

// ─── Fixtures ────────────────────────────────────────────────────────────

const material = new MeshStandardMaterial({ color: 0x8899aa });

/** A leaf assembly: one named mesh carrying a Drive. */
function buildPart(name: string, speed = 100): Group {
  const root = new Group();
  root.name = name;
  const motor = new Mesh(new BoxGeometry(1, 1, 1), material);
  motor.name = 'Motor';
  motor.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: speed } };
  root.add(motor);
  const frame = new Mesh(new BoxGeometry(2, 1, 1), material);
  frame.name = 'Frame';
  root.add(frame);
  return root;
}

/** A reference node: no content of its own, just the pointer. */
function referenceNode(name: string, ref: Parameters<typeof setAssetReference>[1]): Object3D {
  const node = new Object3D();
  node.name = name;
  setAssetReference(node, ref);
  return node;
}

/** A scene root holding `count` references to the same asset id. */
function plantWithReferences(count: number, assetId: string): Group {
  const plant = new Group();
  plant.name = 'Plant';
  for (let i = 0; i < count; i++) {
    const node = referenceNode(`Press_${i}`, { assetId });
    node.position.set(i * 5, 0, 0);
    plant.add(node);
  }
  return plant;
}

interface Fixture {
  bytes: ArrayBuffer;
  sha256: string;
  url: string;
}

/** Bytes for an asset, with a stand-in content hash — no crypto needed here. */
async function assetFixture(tree: Object3D, url: string, sha256: string): Promise<Fixture> {
  return { bytes: await objectToGlb(tree), sha256, url };
}

/** A resolver over a fixed table, counting every call. */
function tableResolver(table: Record<string, Fixture>, calls: string[] = []): ReferenceResolver {
  return async (ref, context): Promise<ResolvedReference | null> => {
    const key = ref.assetId || context.resolvedPath;
    calls.push(key);
    const hit = table[key];
    if (!hit) return null;
    return { bytes: hit.bytes, url: hit.url, sha256: hit.sha256, signatureState: 'none', signaturePresent: false };
  };
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

function driveSpeedAt(occurrenceRoot: Object3D): number | undefined {
  const motor = findByName(occurrenceRoot, 'Motor');
  const rv = motor?.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return rv?.Drive?.TargetSpeed as number | undefined;
}

// ─── Relative path resolution (F18) ──────────────────────────────────────

describe('resolveReferencePath (F18)', () => {
  it('resolves against the containing file, not against the scene root', () => {
    // anlage.glb → unterordner/baugruppe.glb → ./teil.glb  ⇒  unterordner/teil.glb
    expect(resolveReferencePath('unterordner/baugruppe.glb', './teil.glb')).toBe('unterordner/teil.glb');
  });

  it('keeps a relative base relative — no document origin is baked in', () => {
    expect(resolveReferencePath('a/b/c.glb', 'd.glb')).toBe('a/b/d.glb');
  });

  it('walks up with ..', () => {
    expect(resolveReferencePath('a/b/c.glb', '../d/e.glb')).toBe('a/d/e.glb');
  });

  it('resolves against an absolute base through the URL rules', () => {
    expect(resolveReferencePath('https://x.test/lib/asm.glb', './part.glb'))
      .toBe('https://x.test/lib/part.glb');
  });

  it('leaves an already-absolute path alone', () => {
    expect(resolveReferencePath('a/b.glb', 'https://y.test/p.glb')).toBe('https://y.test/p.glb');
  });

  it('does not throw under an opaque blob: base — the path passes through', () => {
    // A library provider hands out object URLs as the child frame's baseUrl.
    // `new URL('./teil.glb', 'blob:…')` throws TypeError; the resolver's
    // assetId step is the real lookup there, so the path is passed through.
    expect(resolveReferencePath('blob:http://localhost:5173/5c6c62af', './teil.glb'))
      .toBe('teil.glb');
    expect(resolveReferencePath('data:application/octet-stream;base64,AAAA', 'sub/x.glb'))
      .toBe('sub/x.glb');
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────

describe('Referenzauflösung', () => {
  it('löst eine zweistufige Kette Anlage → Baugruppe → Teil auf', async () => {
    const part = await assetFixture(buildPart('Gripper'), 'lib/part.glb', 'sha-part');

    const assemblyTree = new Group();
    assemblyTree.name = 'Press';
    assemblyTree.add(referenceNode('GripperRef', { assetId: 'part' }));
    const assembly = await assetFixture(assemblyTree, 'lib/assembly.glb', 'sha-asm');

    const plant = plantWithReferences(1, 'assembly');
    const calls: string[] = [];
    const result = await compose(plant, {
      baseUrl: 'plant.glb',
      resolve: tableResolver({ assembly, part }, calls),
    });

    expect(result.frames).toHaveLength(2);
    expect(result.missing).toHaveLength(0);
    expect(findByName(plant, 'Motor')).not.toBeNull();
    // Depth 2 exists and is nested inside depth 1.
    const inner = result.frames.find((f) => f.depth === 2)!;
    const outer = result.frames.find((f) => f.depth === 1)!;
    expect(inner.occurrence.startsWith(outer.occurrence)).toBe(true);
    result.dispose();
  });

  it('lädt eine zehnfach referenzierte Baugruppe nur einmal', async () => {
    const press = await assetFixture(buildPart('Press'), 'lib/press.glb', 'sha-press');
    const calls: string[] = [];
    const result = await compose(plantWithReferences(10, 'press'), {
      baseUrl: 'plant.glb',
      resolve: tableResolver({ press }, calls),
    });
    expect(result.frames).toHaveLength(10);
    expect(calls).toHaveLength(1);
    expect(result.loads).toBe(1);
    result.dispose();
  });

  it('erzeugt pro Vorkommen einen eigenen Object3D (F17)', async () => {
    const press = await assetFixture(buildPart('Press'), 'lib/press.glb', 'sha-press');
    const plant = plantWithReferences(10, 'press');
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ press }) });

    const roots = result.frames.map((f) => f.subtreeRoot);
    expect(new Set(roots.map((o) => o.uuid)).size).toBe(10);
    roots.forEach((o) => expect(o.parent).not.toBeNull());
    // And every occurrence really is in the tree, not just in the result.
    let motors = 0;
    plant.traverse((n) => { if (n.name === 'Motor') motors++; });
    expect(motors).toBe(10);
    result.dispose();
  });

  it('gibt allen zehn Vorkommen dieselben NodeIds — nur die Vorkommenskette trennt sie (R2)', async () => {
    const press = await assetFixture(buildPart('Press'), 'lib/press.glb', 'sha-press');
    const plant = plantWithReferences(10, 'press');
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ press }) });

    const motorIds = result.frames.map((f) => getNodeId(findByName(f.subtreeRoot, 'Motor')!));
    expect(motorIds.every((id) => id && id === motorIds[0])).toBe(true);
    // The occurrences, however, are all different — which is what makes the
    // composite address unique.
    expect(new Set(result.frames.map((f) => f.occurrence)).size).toBe(10);
    const addresses = result.frames.map((f) => fullNodeAddress(f.occurrence, motorIds[0]!));
    expect(new Set(addresses).size).toBe(10);
    result.dispose();
  });

  it('trifft bei zehn Vorkommen desselben Assets nur das bearbeitete Vorkommen (F19)', async () => {
    const press = await assetFixture(buildPart('Press', 100), 'lib/press.glb', 'sha-press');

    // Compose once to learn the asset's NodeIds, then write an override that
    // addresses the Motor of occurrence 2 ONLY — that override lives on the
    // reference node, which is what keeps it local.
    const probe = plantWithReferences(1, 'press');
    const probeResult = await compose(probe, { baseUrl: 'plant.glb', resolve: tableResolver({ press }) });
    const motorId = getNodeId(findByName(probeResult.frames[0].subtreeRoot, 'Motor')!)!;
    probeResult.dispose();

    const plant = plantWithReferences(10, 'press');
    setAssetOverrides(plant.children[2], { byNodeId: { [motorId]: { Drive: { TargetSpeed: 999 } } } });

    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ press }) });
    expect(result.orphanedOverrides).toHaveLength(0);

    for (let i = 0; i < 10; i++) {
      const frame = result.frames.find((f) => f.referenceNode === plant.children[i])!;
      expect(driveSpeedAt(frame.subtreeRoot)).toBe(i === 2 ? 999 : 100);
    }
    result.dispose();
  });

  it('adressiert verschachtelte Vorkommen über die volle Referenzkette', async () => {
    const gripper = await assetFixture(buildPart('Gripper'), 'lib/gripper.glb', 'sha-grip');
    const pressTree = new Group();
    pressTree.name = 'Press';
    pressTree.add(referenceNode('GripperRef', { assetId: 'gripper' }));
    const press = await assetFixture(pressTree, 'lib/press.glb', 'sha-press');

    // anlage → presse[0..1] → greifer → Motor : four motors, individually addressable.
    const result = await compose(plantWithReferences(2, 'press'), {
      baseUrl: 'plant.glb',
      resolve: tableResolver({ press, gripper }),
    });
    const deep = result.frames.filter((f) => f.depth === 2);
    expect(deep).toHaveLength(2);
    expect(new Set(deep.map((f) => f.occurrence)).size).toBe(2);
    // Each deep occurrence's chain has two segments — one per reference node.
    deep.forEach((f) => expect(f.occurrence.split('/')).toHaveLength(2));
    result.dispose();
  });

  it('löst einen relativen Pfad gegen die enthaltende Datei auf, nicht gegen die Wurzel (F18)', async () => {
    const part = await assetFixture(buildPart('Teil'), 'unterordner/teil.glb', 'sha-teil');
    const assemblyTree = new Group();
    assemblyTree.name = 'Baugruppe';
    assemblyTree.add(referenceNode('TeilRef', { assetId: '', path: './teil.glb' }));
    const assembly = await assetFixture(assemblyTree, 'unterordner/baugruppe.glb', 'sha-bg');

    const plant = new Group();
    plant.name = 'Anlage';
    plant.add(referenceNode('BaugruppeRef', { assetId: '', path: 'unterordner/baugruppe.glb' }));

    const seen: string[] = [];
    const result = await compose(plant, {
      baseUrl: 'anlage.glb',
      resolve: async (ref, context) => {
        seen.push(context.resolvedPath);
        const table: Record<string, Fixture> = {
          'unterordner/baugruppe.glb': assembly,
          'unterordner/teil.glb': part,
        };
        const hit = table[context.resolvedPath];
        return hit ? { bytes: hit.bytes, url: hit.url, sha256: hit.sha256 } : null;
      },
    });

    expect(seen).toEqual(['unterordner/baugruppe.glb', 'unterordner/teil.glb']);
    expect(result.missing).toHaveLength(0);
    result.dispose();
  });

  it('meldet einen Zyklus a → b → a als Fehler statt endlos zu laden', async () => {
    const aTree = new Group();
    aTree.name = 'A';
    aTree.add(referenceNode('ToB', { assetId: 'b' }));
    const bTree = new Group();
    bTree.name = 'B';
    bTree.add(referenceNode('ToA', { assetId: 'a' }));
    const a = await assetFixture(aTree, 'a.glb', 'sha-a');
    const b = await assetFixture(bTree, 'b.glb', 'sha-b');

    const plant = new Group();
    plant.name = 'Plant';
    plant.add(referenceNode('ARef', { assetId: 'a' }));

    await expect(compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ a, b }) }))
      .rejects.toThrow(/Referenzzyklus/);
  });

  it('erkennt auch die Selbstreferenz der Wurzeldatei als Zyklus', async () => {
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(referenceNode('Self', { assetId: 'plant' }));
    const self = await assetFixture(buildPart('X'), 'plant.glb', 'sha-plant');
    await expect(compose(plant, {
      baseUrl: 'plant.glb',
      assetId: 'plant',
      resolve: tableResolver({ plant: self }),
    })).rejects.toBeInstanceOf(ReferenceCycleError);
  });

  it('erlaubt dieselbe Baugruppe mehrfach im selben Baum (DAG, kein Zyklus)', async () => {
    // Two different assemblies that BOTH reference the same part — a diamond.
    const part = await assetFixture(buildPart('Part'), 'lib/part.glb', 'sha-part');
    const mk = (name: string): Group => {
      const t = new Group();
      t.name = name;
      t.add(referenceNode('PartRef', { assetId: 'part' }));
      return t;
    };
    const left = await assetFixture(mk('Left'), 'lib/left.glb', 'sha-left');
    const right = await assetFixture(mk('Right'), 'lib/right.glb', 'sha-right');

    const plant = new Group();
    plant.name = 'Plant';
    plant.add(referenceNode('L', { assetId: 'left' }));
    plant.add(referenceNode('R', { assetId: 'right' }));

    const result = await compose(plant, {
      baseUrl: 'plant.glb',
      resolve: tableResolver({ left, right, part }),
    });
    expect(result.frames).toHaveLength(4);
    expect(result.loads).toBe(3); // left, right, part — part exactly once
    result.dispose();
  });

  it('bricht bei Überschreiten des Tiefenlimits ab', async () => {
    // A file that references itself by PATH under a changing name would be a
    // cycle; instead chain three distinct ids and set the limit to two.
    const c = await assetFixture(buildPart('C'), 'c.glb', 'sha-c');
    const bTree = new Group(); bTree.name = 'B'; bTree.add(referenceNode('ToC', { assetId: 'c' }));
    const b = await assetFixture(bTree, 'b.glb', 'sha-b');
    const aTree = new Group(); aTree.name = 'A'; aTree.add(referenceNode('ToB', { assetId: 'b' }));
    const a = await assetFixture(aTree, 'a.glb', 'sha-a');

    const plant = new Group();
    plant.name = 'Plant';
    plant.add(referenceNode('ARef', { assetId: 'a' }));

    await expect(compose(plant, {
      baseUrl: 'plant.glb',
      maxDepth: 2,
      resolve: tableResolver({ a, b, c }),
    })).rejects.toBeInstanceOf(ReferenceDepthError);
  });

  // Was "lässt den Referenzknoten leer". Since plan-703 Phase 8 (§2.8, F16) the
  // node gets a wireframe placeholder instead — an unresolved reference is no
  // longer allowed to be invisible. The DETAILED behaviour of that placeholder
  // is `compose-missing-references.test.ts`; what is pinned here is that the
  // reference itself is still reported and that the placeholder is the only
  // thing under the node (no half-grafted content).
  it('setzt einen Platzhalter und meldet, wenn das Asset fehlt', async () => {
    const plant = plantWithReferences(1, 'nowhere');
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({}) });
    expect(result.frames).toHaveLength(0);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].assetId).toBe('nowhere');
    expect(plant.children[0].children).toHaveLength(1);
    expect(plant.children[0].children[0]).toBe(result.missing[0].placeholder);
    // …and the placeholder comes off again with everything else compose grafted.
    result.dispose();
    expect(plant.children[0].children).toHaveLength(0);
  });

  it('gibt bei Abbruch während der Composition alle Klone frei', async () => {
    const press = await assetFixture(buildPart('Press'), 'lib/press.glb', 'sha-press');
    const plant = plantWithReferences(3, 'press');
    let resolved = 0;
    await expect(compose(plant, {
      baseUrl: 'plant.glb',
      // Abort once the first occurrence has been grafted.
      shouldAbort: () => resolved >= 1,
      resolve: async (ref, ctx) => {
        resolved++;
        void ctx;
        return { bytes: press.bytes, url: press.url, sha256: press.sha256 };
      },
    })).rejects.toBeInstanceOf(ComposeAbortedError);
    // Nothing is left hanging in the tree.
    for (const child of plant.children) expect(child.children).toHaveLength(0);
  });

  it('markiert ein geändertes Asset als aktualisiert (F9)', async () => {
    const press = await assetFixture(buildPart('Press'), 'lib/press.glb', 'sha-new');
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(referenceNode('P', { assetId: 'press', sha256: 'sha-old' }));

    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ press }) });
    expect(result.updated).toHaveLength(1);
    expect(result.frames[0].updated).toBe(true);
    result.dispose();
  });

  it('meldet einen verwaisten Override statt ihn still zu verwerfen (F9)', async () => {
    const press = await assetFixture(buildPart('Press'), 'lib/press.glb', 'sha-press');
    const plant = plantWithReferences(1, 'press');
    setAssetOverrides(plant.children[0], { byNodeId: { deadbeefdeadbeef: { Drive: { TargetSpeed: 5 } } } });

    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ press }) });
    expect(result.orphanedOverrides).toHaveLength(1);
    expect(result.orphanedOverrides[0].key).toBe('deadbeefdeadbeef');
    expect(result.orphanedOverrides[0].assetId).toBe('press');
    result.dispose();
  });

  it('lässt die äußere Datei gewinnen (Stärkeordnung §2.4)', async () => {
    const part = await assetFixture(buildPart('Part', 100), 'lib/part.glb', 'sha-part');

    // Learn the part's ids, then have the INNER assembly override to 200 …
    const probeRoot = new Group();
    probeRoot.name = 'Probe';
    probeRoot.add(referenceNode('PartRef', { assetId: 'part' }));
    const probe = await compose(probeRoot, { baseUrl: 'p.glb', resolve: tableResolver({ part }) });
    const motorId = getNodeId(findByName(probe.frames[0].subtreeRoot, 'Motor')!)!;
    probe.dispose();

    const assemblyTree = new Group();
    assemblyTree.name = 'Assembly';
    // A mesh of its own, so `unwrapGltfRoot` keeps `Assembly` as the content
    // root instead of peeling down to the lone reference node — the override
    // paths below are written against that shape.
    const base = new Mesh(new BoxGeometry(3, 1, 3), material);
    base.name = 'Base';
    assemblyTree.add(base);
    const innerRef = referenceNode('PartRef', { assetId: 'part' });
    setAssetOverrides(innerRef, { byNodeId: { [motorId]: { Drive: { TargetSpeed: 200 } } } });
    assemblyTree.add(innerRef);
    const assembly = await assetFixture(assemblyTree, 'lib/assembly.glb', 'sha-asm');

    // … and the OUTER plant override the same field to 300 by PATH. The outer
    // one must win — that is the whole rule.
    const plant = new Group();
    plant.name = 'Plant';
    const outerRef = referenceNode('AsmRef', { assetId: 'assembly' });
    setAssetOverrides(outerRef, { byNodeId: {}, byPath: { 'PartRef/Part/Motor': { Drive: { TargetSpeed: 300 } } } });
    plant.add(outerRef);

    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: tableResolver({ assembly, part }) });
    expect(result.orphanedOverrides).toHaveLength(0);
    expect(driveSpeedAt(findByName(plant, 'Motor')!.parent!)).toBe(300);
    result.dispose();
  });
});

// ─── Cache contract ──────────────────────────────────────────────────────

describe('Template-Cache', () => {
  it('dedupliziert gleichzeitig gestartete Auflösungen desselben Assets', async () => {
    const cache = new GlbTemplateCache();
    let loads = 0;
    const load = async (): Promise<null> => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return null;
    };
    // `getOrLoad` must return the SAME in-flight promise for concurrent callers.
    await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(loads).toBe(1);
  });

  it('merkt sich einen Fehlschlag NICHT — ein fehlendes Asset darf die Sitzung nicht vergiften', async () => {
    const cache = new GlbTemplateCache();
    let loads = 0;
    const miss = async (): Promise<null> => { loads++; return null; };
    await cache.getOrLoad('k', miss);
    await cache.getOrLoad('k', miss);
    expect(loads).toBe(2);
    expect(cache.size).toBe(0);
  });
});

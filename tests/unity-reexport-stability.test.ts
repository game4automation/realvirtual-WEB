// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.6 — Unity re-exports and ids (D2/D3/D8). Unity knows no ids: every
 * re-export arrives without any and is seeded from its authored paths (UUIDv5 of the
 * escaped canonical path, `[k]` for same-name siblings). What that means for a node's
 * identity — and therefore for an address a web save wrote — is pinned here:
 *
 *  - unchanged re-export → the same ids;
 *  - a renamed node → a new id; an address to the old one is an orphan (visible);
 *  - a new same-name sibling BEFORE an existing one → `[k]` moves: the NEW node takes
 *    the old id (pinned — the canonical path is positional among twins);
 *  - swapped (differently named) siblings → ids follow the names;
 *  - another root name → every id changes (the root segment is part of the path), but
 *    a root-prefixed reference still migrates (root-stripped);
 *  - a Unity re-export over a web-saved GLB (D8, no guard) → nodes Unity knows get
 *    their seeds back, which ARE the ids the web save promoted; web-created nodes are gone.
 */
import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { CR, box, node, sceneToGlb } from './helpers/migrate-769-fixtures';

async function load(data: ArrayBuffer, url = 'unity.glb') {
  return loadGLB(url, new Scene(), { data: data.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
}

/** Authored path → identity of every node a load produced (the scene root = ''). */
async function idsOf(data: ArrayBuffer): Promise<Map<string, string>> {
  const loaded = await load(data);
  const m = new Map<string, string>();
  for (const [p, n] of pathsOf(loaded.root)) { const id = identityIdOf(n); if (id) m.set(p, id); }
  return m;
}

function pathsOf(root: Object3D): Map<string, Object3D> {
  const m = new Map<string, Object3D>();
  const visit = (n: Object3D, prefix: string): void => {
    for (const c of n.children) {
      const name = (c.userData._rvOrigName as string | undefined) ?? c.name;
      let p = prefix ? `${prefix}/${name}` : name;
      while (m.has(p)) p += '+'; // same-name siblings: positional marker for the test map only
      m.set(p, c);
      visit(c, p);
    }
  };
  m.set('', root);
  visit(root, '');
  return m;
}

async function unity(build: (scene: Scene) => void, name = 'Plant'): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = name;
  build(scene);
  return sceneToGlb(scene);
}

describe('plan-769 9.6 — Unity re-export stability', () => {
  it('an unchanged re-export yields the same ids', async () => {
    const make = () => unity((s) => s.add(box('Floor', 1), node('Axis', { Drive: { Direction: 'LinearX' } })));
    expect(await idsOf(await make())).toEqual(await idsOf(await make()));
  });

  it('a renamed node gets a new id; an address to the old one is an orphan', async () => {
    const before = await unity((s) => s.add(box('Floor', 1), node('Axis'), node('Holder')));
    const after = await unity((s) => s.add(box('Floor', 1), node('AxisX'), node('Holder')));
    const a = await idsOf(before);
    const b = await idsOf(after);
    expect(b.get('Floor')).toBe(a.get('Floor'));
    expect(b.get('AxisX')).not.toBe(a.get('Axis'));
    const loaded = await load(after);
    const holder = pathsOf(loaded.root).get('Holder')!;
    const r = loaded.registry.readStoredRef(holder, { address: `#${a.get('Axis')}` });
    expect(r.status).toBe('unresolved');
  });

  it('a new same-name sibling BEFORE an existing one: [k] moves — the new node takes the old id (pinned)', async () => {
    const before = await unity((s) => s.add(box('Pin', 0.1)));
    const after = await unity((s) => s.add(box('Pin', 0.3), box('Pin', 0.1)));
    const a = await idsOf(before);
    const b = await idsOf(after);
    // `Pin` (first) carries the old id, the original part is now `Pin[1]` with a new one.
    expect(b.get('Pin')).toBe(a.get('Pin'));
    expect(b.get('Pin+')).not.toBe(a.get('Pin'));
  });

  it('swapped siblings with distinct names: ids follow the names', async () => {
    const a = await idsOf(await unity((s) => s.add(box('A', 0.1), box('B', 0.2))));
    const b = await idsOf(await unity((s) => s.add(box('B', 0.2), box('A', 0.1))));
    expect(b.get('A')).toBe(a.get('A'));
    expect(b.get('B')).toBe(a.get('B'));
  });

  it('another root name: ids change with it, a root-prefixed reference still migrates (root-stripped)', async () => {
    const make = (root: string) => unity((s) => {
      const top = node(root);
      // Unity writes the reference with ITS root name — root-prefixed.
      top.add(node('Axis', { Drive: { Direction: 'LinearX' } }), node('Holder', { RefHolder: { To: CR(`${root}/Axis`) } }));
      s.add(top);
    }, 'Scene');
    const a = await idsOf(await make('Plant'));
    const b = await idsOf(await make('Plant2'));
    expect(b.get('Plant2/Axis')).not.toBe(a.get('Plant/Axis'));
    const loaded = await load(await make('Plant2'));
    const paths = pathsOf(loaded.root);
    const holder = paths.get('Plant2/Holder')!;
    const r = loaded.registry.readStoredRef(holder, 'Plant2/Axis');
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && r.node).toBe(paths.get('Plant2/Axis'));
  });

  it('D8 — a Unity re-export over a web-saved GLB: Unity nodes get the promoted ids back, web nodes are gone', async () => {
    const make = () => unity((s) => s.add(box('Floor', 1), node('Axis', { Drive: { Direction: 'LinearX' } })));
    const loaded = await load(await make());
    const web = new Object3D();
    web.name = 'WebAdded';
    loaded.root.add(web);
    const saved = await exportAssetGlb(loaded.root, 'Plant', undefined, undefined, { registry: loaded.registry });
    const webSaved = await idsOf(saved);
    expect(webSaved.has('WebAdded')).toBe(true);
    const reexport = await idsOf(await make());
    expect(reexport.get('Floor')).toBe(webSaved.get('Floor'));
    expect(reexport.get('Axis')).toBe(webSaved.get('Axis'));
    expect(reexport.get('')).toBe(webSaved.get(''));
    expect(reexport.has('WebAdded')).toBe(false);
  });
});

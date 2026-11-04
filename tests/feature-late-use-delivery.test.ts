// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 §9.6 — a feature activated DURING a model load (component trigger) registers
 * its plugin with `viewer.use()` while the load runs. That plugin must receive
 * `onModelLoaded` exactly once, with the result of the model being loaded — never a
 * retroactive call with the previous model. Regression net, no code change: `clearModel()`
 * drops the previous load result before every load.
 *
 * Sequence: model A (no lazy type) → model B (lazy type → feature activates mid-load) →
 * model A again (feature stays active, no error) → a plugin registered outside a load
 * still gets the retroactive call.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { getRegisteredFactories, registerComponent } from '../src/core/engine/rv-component-registry';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const TYPE = 'Plan652LateUseStation';

function plant(name: string, withType: boolean): Group {
  const root = new Group();
  root.name = name;
  const cell = new Group();
  cell.name = 'Cell';
  if (withType) cell.userData.realvirtual = { [TYPE]: { ProcessingTime: 2 } };
  const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  body.name = 'Body';
  cell.add(body);
  root.add(cell);
  return root;
}

let handle: TestViewerHandle;
let glbA: ArrayBuffer;
let glbB: ArrayBuffer;
const delivered: string[] = [];
/**
 * Which fixture a load result belongs to. Only B survives the bake by name (its Cell
 * carries a component; A has nothing that claims a node), so "not B" is A.
 */
const modelOf = (r: LoadResult): string => (r.root?.getObjectByName('ModelB') ? 'ModelB' : 'ModelA');

beforeAll(async () => {
  glbA = await objectToGlb(plant('ModelA', false));
  glbB = await objectToGlb(plant('ModelB', true));
  handle = await createTestViewer('webgl', { desRunner: false });
  const { viewer } = handle;
  const plugin: RVViewerPlugin = {
    id: 'plan652-late-plugin',
    onModelLoaded: (result: LoadResult) => { delivered.push(modelOf(result)); },
  } as RVViewerPlugin;
  viewer.features.define({
    id: 'plan652-late',
    label: 'Late fixture',
    origin: 'internal',
    activation: [`component:${TYPE}`],
    load: async () => ({
      activate: (v) => {
        if (!getRegisteredFactories().has(TYPE)) {
          registerComponent({ type: TYPE, schema: { ProcessingTime: { type: 'number', default: 1 } }, create: (node) => ({ node }) as never });
        }
        if (!v.getPlugin(plugin.id)) v.use(plugin, 'internal');
      },
    }),
  });
}, 60_000);

afterAll(() => handle?.dispose());

describe('late use() during a load (plan-652 §9.6)', () => {
  it('A → B: the feature activates mid-load and the plugin gets B exactly once', async () => {
    const { viewer } = handle;
    await viewer.loadModel('a.glb', { data: glbA.slice(0) });
    expect(viewer.features.isActive('plan652-late')).toBe(false);
    expect(delivered).toEqual([]);

    await viewer.loadModel('b.glb', { data: glbB.slice(0) });
    expect(viewer.features.isActive('plan652-late')).toBe(true);
    expect(delivered).toEqual(['ModelB']);
  }, 60_000);

  it('B → A: the feature stays active, the plugin gets A once more, no error', async () => {
    const { viewer } = handle;
    const errors = vi.spyOn(console, 'error');
    await viewer.loadModel('a.glb', { data: glbA.slice(0) });
    expect(viewer.features.isActive('plan652-late')).toBe(true);
    expect(delivered).toEqual(['ModelB', 'ModelA']);
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('[feature]'))).toEqual([]);
    errors.mockRestore();
  }, 60_000);

  it('use() outside a load still delivers retroactively', () => {
    const { viewer } = handle;
    const got: string[] = [];
    viewer.use({ id: 'plan652-outside', onModelLoaded: (r: LoadResult) => { got.push(modelOf(r)); } } as RVViewerPlugin);
    expect(got).toEqual(['ModelA']);
  });
});

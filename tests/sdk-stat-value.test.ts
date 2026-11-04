// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { WebComponentPlugin } from '../src/plugins/web-component-plugin';

const rowsCode = `function setup(self) {
  self.statValue('Parts', 3);
  self.statValue('Cycle', 12.4, 's', 'Cell A');
  self.statValue('Parts', 4);
  return {};
}`;
const oldCode = `function setup(self) {
  self.statState('Working'); self.statOutput();
  self.statCycleStart(); self.statCycleEnd();
  return {};
}`;
async function load(h: TestViewerHandle, plugin: WebComponentPlugin, codes: string[]): Promise<void> {
  const root = new Group(); root.name = 'ScriptsAsset';
  codes.forEach((code, i) => {
    const node = new Object3D(); node.name = `Script${i}`;
    node.userData.realvirtual = { WebComponent: {
      Active: true, ApiVersion: 1, Language: 'js', TypeId: 'StatsTest', Code: code,
    } };
    root.add(node);
  });
  await h.viewer.loadModel('script-stats.glb', { data: await objectToGlb(root) });
  await plugin.whenWired();
  expect(plugin.instances).toHaveLength(codes.length);
}

it('plugin rows update, retain owners, disappear on hot reload and model clear; old stats remain separate', async () => {
  const h = await createTestViewer('webgl', { desRunner: false });
  const plugin = new WebComponentPlugin({ allowScripts: true });
  h.viewer.use(plugin);
  try {
    await load(h, plugin, [rowsCode, rowsCode]);
    const paths = plugin.instances.map(instance => instance.nodePath);
    const section = h.viewer.stats.list().find(s => s.id === 'scripts')!;
    expect(section).toMatchObject({ title: 'Scripts', order: 90 });
    expect(section.rows!()).toHaveLength(4);
    for (const path of paths) {
      expect(section.rows!().filter(r => r.owner === path)).toEqual([
        expect.objectContaining({ label: 'Parts', value: 4, group: path }),
        expect.objectContaining({ label: 'Cycle', value: 12.4, unit: 's', group: 'Cell A' }),
      ]);
    }
    plugin.reload(paths[0], oldCode);
    expect(section.rows!()).toHaveLength(2);
    expect(section.rows!().every(r => r.owner === paths[1])).toBe(true);
    const stats = h.viewer.statisticsManager.get(paths[0])!.getSnapshot();
    expect(stats).toMatchObject({ currentState: 'Working', output: 1, cycleCount: 1 });
    plugin.reload(paths[1], oldCode);
    expect(h.viewer.stats.list()).toEqual([]);
    plugin.reload(paths[0], rowsCode);
    expect(h.viewer.stats.list()[0].rows!()).toHaveLength(2);
    h.viewer.clearModel();
    expect(h.viewer.stats.list()).toEqual([]);
  } finally { h.dispose(); }
}, 90_000);

it('two viewers with identical owner paths have isolated script rows', async () => {
  const a = await createTestViewer('webgl', { desRunner: false });
  let b: TestViewerHandle | undefined;
  try {
    b = await createTestViewer('webgl', { desRunner: false });
    const pa = new WebComponentPlugin({ allowScripts: true });
    const pb = new WebComponentPlugin({ allowScripts: true });
    a.viewer.use(pa); b.viewer.use(pb);
    await load(a, pa, [rowsCode]);
    await load(b, pb, [rowsCode.replace("'Parts', 4", "'Parts', 99")]);
    expect(pa.instances[0].nodePath).toBe(pb.instances[0].nodePath);
    expect(a.viewer.stats.list()[0].rows!().find(r => r.label === 'Parts')!.value).toBe(4);
    expect(b.viewer.stats.list()[0].rows!().find(r => r.label === 'Parts')!.value).toBe(99);
    a.viewer.clearModel();
    expect(a.viewer.stats.list()).toEqual([]);
    expect(b.viewer.stats.list()[0].rows!()).toHaveLength(2);
    b.viewer.clearModel();
    expect(b.viewer.stats.list()).toEqual([]);
  } finally { b?.dispose(); a.dispose(); }
}, 90_000);

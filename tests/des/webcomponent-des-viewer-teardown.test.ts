// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 review #2 — archive before script dispose on a REAL viewer.
 * `clearModel()` notifies the plugins (the web-component plugin disposes its
 * scripts and their `self.statValue` rows) before the kernel is disposed, and
 * `dispose()` disposes the plugins first of all. The open DES run is archived
 * before either: at `simulation-run-ending` the script's KPI row still holds
 * the last DES value.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { SimDesControl } from '../../src/core/material-flow/simulation-kernel';

const COUNTER = `
function setup(self) {
  const st = self.persist({ n: 0 });
  self.statValue('Beats', st.n);
  self.every(1, 'beat');
  return {
    des: { on(hook) { if (hook !== 'beat') return; st.n++; self.statValue('Beats', st.n); } },
  };
}`;

function node(name: string, x: number, extras: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(x, 0, 0);
  n.userData.realvirtual = extras;
  return n;
}

interface World { h: TestViewerHandle; v: RVViewer; plugin: WebComponentPlugin; seen: unknown[] }

async function load(): Promise<World> {
  const h = await createTestViewer('webgl');
  const v = h.viewer;
  v.loop.setPaused('plan-2212-teardown', true);
  registerAllBehaviors(v.behaviors);
  const plugin = new WebComponentPlugin({ allowScripts: true });
  v.use(plugin);
  const doc = new Group();
  doc.name = 'TeardownDoc';
  doc.add(
    node('Source', 0, { Source: { Interval: 10 } }),
    node('Station', 2, { Station: { ProcessingTime: 5 } }),
    node('Sink', 4, { Sink: {} }),
    node('Counter', 6, { WebComponent: { Code: COUNTER } }),
  );
  await v.loadModel('plan-2212-teardown.glb', { data: await objectToGlb(doc) });
  await v.whenSceneReady();
  await plugin.whenWired();
  const seen: unknown[] = [];
  (v as unknown as { on(e: string, fn: (d: unknown) => void): void }).on('simulation-run-ending', () => {
    const rows = v.stats.list().filter(s => s.id === 'scripts').flatMap(s => s.rows?.() ?? []);
    seen.push((rows.find(r => r.label === 'Beats') as { value?: unknown } | undefined)?.value);
  });
  return { h, v, plugin, seen };
}

async function runDesTo(w: World, t: number): Promise<SimDesControl> {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try { w.v.simulationKernel!.setMode('des'); } finally { info.mockRestore(); }
  const des = w.v.simulationKernel!.desControl()!;
  expect(w.plugin.instances[0]?.adapter?.mode).toBe('des');
  expect(await des.fastForwardUntil!(t)).toBe(true);
  return des;
}

let open: World | null = null;
afterEach(() => { open?.h.dispose(); open = null; });

describe('plan-2212 review #2 — real viewer teardown disposes scripts', () => {
  it('clearModel() mid-run: scripts are disposed', async () => {
    const w = (open = await load());
    await runDesTo(w, 17.5);
    expect(w.seen).toEqual([]);
    w.v.clearModel();
    expect(w.plugin.instances).toHaveLength(0);
  });

  it('dispose() mid-run: scripts are disposed', async () => {
    const w = await load();
    await runDesTo(w, 23.5);
    w.h.dispose();
    expect(w.plugin.instances).toHaveLength(0);
  });
});

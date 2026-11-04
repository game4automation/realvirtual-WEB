// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect } from 'vitest';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { createTestViewer } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
export const DT = 1 / 60;
export const yieldBrowser = () => new Promise<void>(r => setTimeout(r, 0));
export async function createAcceptanceViewer() {
  const h = await createTestViewer('webgl');
  h.viewer.loop.setPaused('model-acceptance', true);
  registerAllBehaviors(h.viewer.behaviors);
  return h;
}
export async function loadAcceptanceModel(v: RVViewer, url: string) {
  const res = await fetch(url);
  expect(res.ok, `${url}: HTTP ${res.status} (expected 200)`).toBe(true);
  const data = await res.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(4, data.byteLength)));
  expect(magic, `${url}: magic ${magic} (expected glTF)`).toBe('glTF');
  await v.loadModel(url, { data, modelName: url.split('/').pop()!, identityUrl: url });
  await v.whenSceneReady();
  v.scene.updateMatrixWorld(true);
}
export async function stepModel(v: RVViewer, name: string, seconds: number, observe = () => {}, wallLimitMs = 180_000) {
  const start = performance.now();
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    v._tickOnce(DT);
    v.scene.updateMatrixWorld(true);
    observe();
    if (i % 120 === 0) {
      if (performance.now() - start > wallLimitMs)
        throw new Error(`${name}: ${i * DT} s simulated in ${wallLimitMs / 1000} s wall (expected ${seconds} s sim)`);
      await yieldBrowser();
    }
  }
}
export function nodePath(node: { name: string; parent: any }): string {
  return node.parent ? `${nodePath(node.parent)}/${node.name}` : node.name;
}
export async function until(check: () => boolean, expected: string) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > 60_000) throw new Error(`${expected}: absent after 60 s (expected ready)`);
    await new Promise(r => setTimeout(r, 20));
  }
}

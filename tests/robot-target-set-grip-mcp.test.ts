// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it } from 'vitest';
import { robotRunHarness } from './helpers/robot-run-harness';
import { executeDelegateValue } from './helpers/execute-value';
import { McpRobotTools } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { setSceneStore } from '../src/core/hmi/scene/scene-store-ref';
import { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { Group } from 'three';
let h: Awaited<ReturnType<typeof robotRunHarness>>;
afterEach(() => { setSceneStore(null as unknown as SceneStore); h?.dispose(); });
async function setup() {
  h = await robotRunHarness();
  const registry = h.result.registry, target = h.path.targets[0];
  const scope = registry.enclosingScope(target.node).root;
  const rootPath = registry.getPathForNode(scope)!;
  expect(h.viewer.createComponentNode({ parentPath: rootPath, name: 'TestGrip', position: [0,0,0], quaternion: [0,0,0,1], scale: [1,1,1], components: { Grip: {} } })).toBe(true);
  const gripPath = `${rootPath}/TestGrip`, grip = registry.getByPath('Grip', gripPath);
  const tools = new McpRobotTools(() => h.viewer);
  const targetPath = registry.getPathForNode(target.node)!;
  return { registry, target, targetPath, gripPath, grip, tools, scope };
}
describe('ik.target.setGrip (T9)', () => {
  it('writes a picker reference, updates live state, warns, clears and restores through undo', async () => {
    const f = await setup();
    const store = new SceneStore(h.viewer); setSceneStore(store);
    const call = async (gripPath: string | null) => JSON.parse(await executeDelegateValue(f.tools, 'ik.target.setGrip', { targetPath: f.targetPath, gripPath }));
    const result = await call(f.gripPath);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.warnings.join(' ')).toContain('PickAndPlace');
    expect(f.target.gripTarget).toBe(f.grip);
    const saved = JSON.parse(JSON.stringify(f.target.node.userData.realvirtual.IKTarget.gripTarget));
    expect(saved).toMatchObject({ type: 'ComponentReference', componentType: 'Grip' });
    // Reload the serialized reference onto a fresh target instance, using the production resolver.
    const reloaded = new RVIKTarget(f.target.node); reloaded.refreshGrip(f.registry);
    expect(reloaded.gripTarget).toBe(f.grip);
    expect((await call(null)).ok).toBe(true); expect(f.target.gripTarget).toBeNull();
    await store.undo(); expect(f.target.gripTarget).toBe(f.grip);
    await store.undo(); expect(f.target.gripTarget).toBeNull();
    await store.redo(); expect(f.target.gripTarget).toBe(f.grip);
  }, 180000);
  it('reports an existing fixer without overwriting it', async () => {
    const f = await setup();
    const fixer = { type: 'ComponentReference', path: 'LegacyFixer', componentType: 'Grip' };
    f.target.node.userData.realvirtual.IKTarget.fixer = fixer;
    const result = JSON.parse(await executeDelegateValue(f.tools, 'ik.target.setGrip', { targetPath: f.targetPath, gripPath: f.gripPath }));
    expect(result.ok).toBe(true); expect(result.warnings.join(' ')).toContain('fixer');
    expect(f.target.node.userData.realvirtual.IKTarget.fixer).toEqual(fixer);
    expect(f.target.gripTarget).toBe(f.grip);
  }, 180000);
  it('refuses non-Grips and grips outside the target scope without writing', async () => {
    const f = await setup();
    const outside = new Group(); outside.name = 'Outside'; outside.userData.realvirtual = { Grip: {} };
    f.registry.registerNode('Outside', outside); f.registry.register('Grip', 'Outside', { node: outside });
    for (const gripPath of [f.targetPath, 'Outside', 'Missing']) {
      const r = JSON.parse(await executeDelegateValue(f.tools, 'ik.target.setGrip', { targetPath: f.targetPath, gripPath }));
      expect(r.error).toContain('Choose'); expect(r.candidates.length).toBeLessThanOrEqual(10);
      expect(f.target.gripTarget).toBeNull();
    }
  }, 180000);
  it('uses each placed scope even when two grips have the same authored name', async () => {
    const f = await setup();
    f.registry.registerScopeNames(f.scope, [f.scope.name]);
    const other = f.scope.clone(true); other.name = 'Robot2';
    f.scope.parent!.add(other); f.registry.registerScopeNames(other, [f.scope.name, 'Robot2']);
    f.registry.registerDocument(other, 'robot2');
    let secondTarget: RVIKTarget | undefined; let secondGrip: object | undefined;
    other.traverse(n => {
      const relative: string[] = []; for (let p = n; p !== other; p = p.parent!) relative.unshift(p.name);
      const path = ['Robot2', ...relative].join('/'); f.registry.registerNode(path, n);
      if (n.name === 'TestGrip') { secondGrip = { node: n }; f.registry.register('Grip', path, secondGrip); }
      if (n.name === f.target.node.name) { secondTarget = new RVIKTarget(n); }
    });
    // Stored picker spelling is deliberately identical; the referring target selects the occurrence.
    const r = JSON.parse(await executeDelegateValue(f.tools, 'ik.target.setGrip', { targetPath: f.targetPath, gripPath: f.gripPath }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    secondTarget!.node.userData.realvirtual.IKTarget.gripTarget = JSON.parse(JSON.stringify(f.target.node.userData.realvirtual.IKTarget.gripTarget));
    secondTarget!.refreshGrip(f.registry);
    expect(secondTarget!.gripTarget).toBe(secondGrip);
    expect(f.target.gripTarget).toBe(f.grip);
  }, 180000);
});

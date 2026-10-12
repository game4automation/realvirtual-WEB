import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { RVJavaScriptStep, StepState } from '../src/core/engine/rv-logic-step';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { RVSensor } from '../src/core/engine/rv-sensor';
import { processExtras, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import { createSdkComponent } from '../src/core/sdk/rv-component-sdk';
import { createSceneScriptAccess } from '../src/core/sdk/rv-sdk-scene';
import { WebComponentPlugin } from '../src/plugins/web-component-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { WebComponentEnvFactory } from '../src/core/engine/rv-web-component-registry';
import randomSourceCode from '../examples/scripts/random-source-step.js?raw';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.reverse()) dispose(); cleanup.length = 0; });

function fixture() {
  const scene = new Scene(), root = new Object3D(); root.name = 'Festo'; scene.add(root);
  const sourceNode = new Mesh(new BoxGeometry(.02, .02, .02), new MeshBasicMaterial());
  sourceNode.name = 'LogoSource'; sourceNode.position.y = 1;
  sourceNode.userData.realvirtual = { Source: { GenerateMU: false, AutomaticGeneration: false, Mass: .02 } };
  const stepNode = new Object3D(); stepNode.name = 'Script';
  stepNode.userData.realvirtual = { LogicStep_JavaScript: {} };
  const sinkNode = new Object3D(); sinkNode.name = 'Sink'; sinkNode.position.x = 10;
  sinkNode.userData.realvirtual = { Sink: {}, BoxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } } };
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor';
  sensorNode.userData.realvirtual = { Sensor: { ShowGizmo: false }, BoxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } } };
  root.add(sourceNode, stepNode, sinkNode, sensorNode); scene.updateMatrixWorld(true);
  const registry = new NodeRegistry(), signals = new SignalStore(), manager = new RVTransportManager();
  manager.scene = scene;
  processExtras(root, buildInitContext({ registry, signalStore: signals, transportManager: manager, scene }));
  const logic = RVLogicEngine.build(root, registry, signals);
  const step = logic.stepByPath.get('Festo/Script') as RVJavaScriptStep;
  return { root, registry, signals, manager, logic, step, stepNode, source: manager.sources[0] };
}

describe('web-native scripting scene API', () => {
  it('executes the 1–3 example through QuickJS and live plugin resolvers; caps, reset and lifecycle work', async () => {
    const f = fixture();
    expect(f.step).toBeInstanceOf(RVJavaScriptStep);
    const plugin = new WebComponentPlugin();
    const viewer = { transportManager: f.manager, logicEngine: f.logic } as RVViewer;
    const build = (plugin as unknown as { makeEnvFactory(result: LoadResult, viewer: RVViewer): WebComponentEnvFactory })
      .makeEnvFactory({ root: f.root, registry: f.registry, signalStore: f.signals } as LoadResult, viewer);
    const env = build({ nodePath: 'Festo/Script', nodeName: 'Script', node: f.stepNode, props: {},
      scheduler: { now: 0, in: () => 0, at: () => 0, cancel: () => {} }, addTeardown: fn => cleanup.push(fn) });
    const host = await RVScriptHost.create(); cleanup.push(() => host.dispose());
    const outputs: unknown[] = [];
    const probe = createSdkComponent(host, { ...env, log: (...args) => outputs.push(args) }, `
      function setup(self) {
        self.scene.set('Festo/LogoSource', 'Source', 'Enabled', false);
        self.log(self.scene.list('Source').length, self.scene.read('Festo/LogoSource', 'Source').Enabled);
        self.scene.set('Festo/LogoSource', 'Source', 'Enabled', true);
        self.source('Festo/LogoSource').interval = 0.75;
        self.sink('Festo/Sink').on(function(mu) { self.log(mu.id); });
        return {};
      }
    `, { callDeadlineMs: 200 });
    cleanup.push(() => probe.dispose());
    expect(probe.ok).toBe(true); expect(outputs).toEqual([[1, false]]);
    expect(f.source.spawnInterval).toBe(.75);
    const script = createSdkComponent(host, env, randomSourceCode, { callDeadlineMs: 200 });
    cleanup.push(() => script.dispose()); expect(script.ok).toBe(true);
    const counts = new Set<number>();
    for (let cycle = 0; cycle < 20; cycle++) {
      f.step.reset(); f.step.start();
      const before = f.manager.totalSpawned;
      // A capped source returns null and the script waits without completing.
      f.manager.maxLiveMUs = 0;
      expect(script.callHandler('continuous.fixedUpdate', .1).ok).toBe(true);
      expect(f.step.state).toBe(StepState.Active);
      f.manager.maxLiveMUs = 5000;
      for (let i = 0; i < 20 && f.step.state !== StepState.Finished; i++) {
        expect(script.callHandler('continuous.fixedUpdate', .1).ok).toBe(true);
      }
      expect(f.step.state).toBe(StepState.Finished);
      const count = f.manager.totalSpawned - before;
      expect(count).toBeGreaterThanOrEqual(1); expect(count).toBeLessThanOrEqual(3); counts.add(count);
    }
    expect([...counts].sort()).toEqual([1, 2, 3]);
    expect(f.source.Created).toBe(f.manager.totalSpawned);
    expect(f.manager.mus.every(mu => mu.physicsMassKg === .02)).toBe(true);
    f.manager.sinks[0].notifyConsumed(f.manager.mus[0]);
    expect(outputs).toHaveLength(2);
    probe.dispose();
    f.manager.sinks[0].notifyConsumed(f.manager.mus[0]);
    expect(outputs).toHaveLength(2); // disposal removes host subscriptions
  });

  it('reads registered fields and rejects private, readonly and invalid writes', () => {
    const f = fixture(), api = createSceneScriptAccess(f.registry, f.root);
    expect(api.list('Source')).toContainEqual({ path: 'Festo/LogoSource', type: 'Source' });
    expect(api.read('Festo/LogoSource', 'Source')?.Mass).toBe(.02);
    api.set('Festo/LogoSource', 'Source', 'Enabled', false); expect(f.source.Enabled).toBe(false);
    expect(() => api.set('Festo/LogoSource', 'Source', 'Created', 9)).toThrow();
    expect(() => api.set('Festo/LogoSource', 'Source', 'muTemplate', null)).toThrow();
    expect(() => api.set('Festo/LogoSource', 'Source', 'Mass', NaN)).toThrow();
    expect(api.read('LogoSource', 'Source')).toBeNull();
    expect(() => f.step.complete()).toThrow('not active');
  });

  it('changes sensor visibility live through the scene API without disabling detection', () => {
    const f = fixture(), api = createSceneScriptAccess(f.registry, f.root);
    const sensor = f.registry.getByPath<RVSensor>('Sensor', 'Festo/Sensor')!;
    expect(sensor.node.children).toHaveLength(2);
    expect(sensor.node.children.every(child => !child.visible)).toBe(true);
    api.set('Festo/Sensor', 'Sensor', 'ShowGizmo', true);
    expect(sensor.node.children.every(child => child.visible)).toBe(true);
    api.set('Festo/Sensor', 'Sensor', 'ShowGizmo', false);
    expect(sensor.node.children.every(child => !child.visible)).toBe(true);
    const mu = f.manager.spawnFromSource(f.source)!;
    sensor.applyPhysicsResult(mu);
    expect(sensor.occupied).toBe(true);
    expect(api.read('Festo/Sensor', 'Sensor')?.Occupied).toBe(true);
  });
});

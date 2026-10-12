import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';

function fixture(properties: Record<string, unknown> = {}) {
  const scene = new Scene(), root = new Object3D(); root.name = 'Test'; scene.add(root);
  const node = new Mesh(new BoxGeometry(.02, .02, .02), new MeshBasicMaterial());
  node.name = 'Source'; node.position.y = 1;
  node.userData.realvirtual = { Source: { GenerateMU: false, AutomaticGeneration: false, ...properties } };
  root.add(node); scene.updateMatrixWorld(true);
  for (const name of ['Generate', 'Distance']) {
    const signal = new Object3D(); signal.name = name;
    signal.userData.realvirtual = { PLCOutputBool: { Value: false } }; root.add(signal);
  }
  const manager = new RVTransportManager(); manager.scene = scene; manager.preferCloneMU = true;
  const signals = new SignalStore();
  processExtras(root, buildInitContext({ registry: new NodeRegistry(), signalStore: signals, transportManager: manager, scene }));
  const source = manager.sources[0];
  const tick = (dt = 1 / 60) => manager.update(dt);
  return { manager, source, tick, signals };
}

describe('Unity Source control semantics', () => {
  it('resolves PLCOutputBool signal slots and responds to generation edges and distance levels', () => {
    const ref = (name: string) => ({ type: 'ComponentReference', path: `Test/${name}`, componentType: 'realvirtual.PLCOutputBool' });
    const { source, manager, tick, signals } = fixture({ AutomaticGeneration: true,
      SourceGenerate: ref('Generate'), SourceGenerateOnDistance: ref('Distance') });
    tick(); expect(manager.mus).toHaveLength(0); expect(source.AutomaticGeneration).toBe(false);
    signals.setByPath('Test/Generate', true); tick(); tick();
    expect(manager.mus).toHaveLength(1);
    signals.setByPath('Test/Generate', false); tick();
    signals.setByPath('Test/Generate', true); tick(); expect(manager.mus).toHaveLength(2);
    signals.setByPath('Test/Distance', true); tick(); expect(source.AutomaticGeneration).toBe(true);
    signals.setByPath('Test/Distance', false); tick(); expect(source.AutomaticGeneration).toBe(false);
  });
  it('creates exactly one part per GenerateMU rising edge in free space', () => {
    const { source, manager, tick } = fixture();
    tick(); expect(manager.mus).toHaveLength(0);
    source.GenerateMU = true;
    for (let i = 0; i < 30; i++) tick();
    expect(manager.mus).toHaveLength(1);
    source.GenerateMU = false; tick(); source.GenerateMU = true; tick();
    expect(manager.mus).toHaveLength(2);
  });
  it('consumes disabled edges and enforces the lifetime count after deletion', () => {
    const { source, manager, tick } = fixture({ Enabled: false, LimitNumber: true, MaxNumberMUs: 1, Mass: .02 });
    source.GenerateMU = true; tick(); source.Enabled = true; tick();
    expect(manager.mus).toHaveLength(0);
    source.GenerateMU = false; tick(); source.GenerateMU = true; tick();
    expect(manager.mus[0].physicsMassKg).toBe(.02);
    source.DeleteAllMU = true; tick(); expect(manager.mus).toHaveLength(0);
    expect(source.Created).toBe(1);
    source.GenerateMU = false; tick(); source.GenerateMU = true; tick();
    expect(manager.mus).toHaveLength(0);
  });
  it('uses StartInterval and allows interval and edge generation independently', () => {
    const { source, manager, tick } = fixture({ Interval: .5, StartInterval: 1 });
    tick(.5); expect(manager.mus).toHaveLength(0);
    source.GenerateMU = true; tick(.5); expect(manager.mus).toHaveLength(2);
    tick(.5); expect(manager.mus).toHaveLength(3);
  });
  it('uses strict greater-than distance and rearms after the last MU is removed', () => {
    const { source, manager, tick } = fixture({ GenerateMU: true, AutomaticGeneration: true, GenerateIfDistance: 300 });
    tick(); expect(manager.mus).toHaveLength(1);
    manager.mus[0].node.position.x = .3; tick(); expect(manager.mus).toHaveLength(1);
    manager.mus[0].node.position.x = .301; tick(); expect(manager.mus).toHaveLength(2);
    manager.removeMU(manager.mus[1]); tick(); expect(source.Created).toBe(3);
  });
});

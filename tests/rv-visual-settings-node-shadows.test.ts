// plan-767 run 4: shadow rules for node renderers (WebGPU) in VisualSettingsManager —
// castShadow is never cleared, the shadow map type never changes (Toon = PCF radius 0), and a
// shadow map resize drops the cached render contexts. WebGL keeps BasicShadowMap ↔ PCFShadowMap.
import { describe, expect, it, vi } from 'vitest';
import { AmbientLight, BasicShadowMap, DirectionalLight, PCFShadowMap, Scene } from 'three';
import { invalidateNodeShadowBindings, VisualSettingsManager, type ViewerVisualState } from '../src/core/rv-visual-settings-manager';

function manager(isWebGPU: boolean) {
  const scene = new Scene();
  const dirLight = new DirectionalLight();
  dirLight.shadow.radius = 2;
  scene.add(dirLight);
  const renderer = { shadowMap: { enabled: false, type: PCFShadowMap } };
  const state = {
    scene, renderer, isWebGPU, ambientLight: new AmbientLight(), dirLight, sceneFixtures: new Set(),
    _shadowsDirty: false, _renderDirty: false,
  } as unknown as ViewerVisualState;
  const m = new VisualSettingsManager(state);
  // set the mode without applyLightingMode (it would load the HDR environment)
  const mode = (id: string) => { (m as unknown as { _lightingMode: string })._lightingMode = id; };
  return { m, renderer, dirLight, mode };
}

describe('VisualSettingsManager shadows on node renderers (plan-767 run 4)', () => {
  it('WebGPU: Toon keeps PCFShadowMap with radius 0, the user radius comes back, castShadow stays on', () => {
    const { m, renderer, dirLight, mode } = manager(true);
    mode('default');
    m.shadowEnabled = true;
    expect(dirLight.castShadow).toBe(true);
    mode('toon');
    m.shadowEnabled = true;
    expect(renderer.shadowMap.type).toBe(PCFShadowMap);
    expect(dirLight.shadow.radius).toBe(0);
    m.shadowRadius = 4; // user edit while Toon is active → applied after leaving Toon
    expect(dirLight.shadow.radius).toBe(0);
    m.shadowEnabled = false;
    expect(dirLight.castShadow, 'never cleared on a node renderer').toBe(true);
    mode('default');
    m.shadowEnabled = true;
    expect(renderer.shadowMap.type).toBe(PCFShadowMap);
    expect(dirLight.shadow.radius).toBe(4);
  });

  it('WebGL: Toon switches to BasicShadowMap and shadows off clears castShadow (unchanged)', () => {
    const { m, renderer, dirLight, mode } = manager(false);
    mode('toon');
    m.shadowEnabled = true;
    expect(renderer.shadowMap.type).toBe(BasicShadowMap);
    expect(dirLight.shadow.radius).toBe(2);
    m.shadowEnabled = false;
    expect(dirLight.castShadow).toBe(false);
  });

  it('invalidateNodeShadowBindings drops the render contexts only when an existing map changes size', () => {
    const dispose = vi.fn();
    const renderer = { _renderContexts: { dispose } };
    const light = new DirectionalLight();
    invalidateNodeShadowBindings(renderer, light, 1024); // no map yet
    expect(dispose).not.toHaveBeenCalled();
    (light.shadow as unknown as { map: { width: number; height: number } }).map = { width: 2048, height: 2048 };
    invalidateNodeShadowBindings(renderer, light, 2048);
    expect(dispose).not.toHaveBeenCalled();
    invalidateNodeShadowBindings(renderer, light, 1024);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => invalidateNodeShadowBindings({}, light, 512)).not.toThrow();
  });
});

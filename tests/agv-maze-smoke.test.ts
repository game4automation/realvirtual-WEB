// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { RVViewerPlugin } from '@rv/core/rv-plugin';
import type { RVViewer } from '@rv/core/rv-viewer';
import type { LoadResult } from '@rv/core/engine/rv-scene-loader';
import { gltfLoader } from '@rv/core/engine/rv-glb-parse';
import { getDefaultPathNetwork } from '@rv/core/engine/rv-path-network';
import { SignalStore } from '@rv/core/engine/rv-signal-store';
import { RVViewerProvider } from '@rv/hooks/use-viewer';
import { UIPluginRegistry } from '@rv/core/rv-ui-registry';
import { LeftPanelManager } from '@rv/core/hmi/left-panel-manager';
import { AgvMazePlugin } from '../src/plugins/models/agv-maze/index';
import { cellCenter } from '../src/plugins/models/agv-maze/maze-map';

const plugins: AgvMazePlugin[] = [];
const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const priorActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeEach(() => { reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
function fixture() {
  const scene = new Scene(), tasks: Promise<unknown>[] = [];
  const camera = new PerspectiveCamera(45, 1.44, 0.1, 1000);
  const events = new Map<string, () => void>();
  const viewer = { scene, currentModelUrl: '/demo-realvirtual/agv-maze.glb',
    camera, signalStore: new SignalStore(), markRenderDirty: () => {},
    animateCameraTo: (position: Vector3, target: Vector3) => { camera.position.copy(position); camera.lookAt(target); camera.updateMatrixWorld(true); },
    uiRegistry: new UIPluginRegistry(),
    leftPanelManager: new LeftPanelManager(),
    getPlugin: () => undefined,
    on: (name: string, callback: () => void) => { events.set(name, callback); return () => events.delete(name); },
    trackLoadingWork: (task: Promise<unknown>) => tasks.push(task) } as unknown as RVViewer;
  const plugin = new AgvMazePlugin(); plugins.push(plugin);
  plugin.init(viewer);
  const root = new Group(); scene.add(root);
  return { plugin, viewer, root, events, result: { root } as unknown as LoadResult, idle: () => Promise.all(tasks) };
}
function model() {
  const scene = new Group(); scene.add(new Mesh(new BoxGeometry(0.8, 0.5, 1), new MeshStandardMaterial()));
  return { scene } as Awaited<ReturnType<typeof gltfLoader.loadAsync>>;
}
afterEach(() => { for (const plugin of plugins) plugin.dispose(); plugins.length = 0; vi.restoreAllMocks(); getDefaultPathNetwork().clear(); reactEnvironment.IS_REACT_ACT_ENVIRONMENT = priorActEnvironment; });

describe('AGV Maze lifecycle and visible objects', () => {
  it('loads the shipped GLB through the real GLTFLoader and corrects its pivot', async () => {
    const f = fixture(); f.viewer.currentModelUrl = new URL('/demo-realvirtual/agv-maze.glb', window.location.href).href;
    f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    expect(f.plugin.error).toBe(''); expect(f.plugin.ready).toBe(true);
    let meshes = 0; f.plugin.vehicles[0].object.traverse(node => { if (node instanceof Mesh) meshes++; });
    expect(meshes).toBeGreaterThan(0);
    const playerObject = f.plugin.vehicles[0].object;
    const paints = new Set<number>();
    playerObject.children[0].traverse(node => {
      if (node instanceof Mesh) for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        const paint = material as MeshStandardMaterial;
        paints.add(paint.color.getHex()); expect(paint.metalness).toBe(0); expect(paint.emissiveIntensity).toBe(0);
        expect(paint.roughness).toBe(paint.color.getHex() === 0x383e42 ? 0.48 : 0.45);
      }
    });
    expect([...paints].sort()).toEqual([0x383e42, 0xfad201].sort());
    const beacon = playerObject.getObjectByName('player-beacon') as Mesh;
    expect(beacon.position.y).toBeGreaterThan(0.48); expect(beacon.position.y).toBeLessThan(0.65);
    expect((beacon.material as MeshStandardMaterial).color.getHex()).toBe(0xf2a900);
    const spot = playerObject.getObjectByName('blue-floor-spot') as Mesh;
    expect((spot.material as MeshStandardMaterial).color.getHex()).toBe(0x0057b8);
    expect((spot.material as MeshStandardMaterial).emissiveIntensity).toBe(4);
    expect(spot.position.y).toBe(0.027); expect(spot.position.z).toBeGreaterThan(0.5);
    expect(f.plugin.vehicles[0].traveler.s).toBe(0);
    const center = cellCenter(f.plugin.map, { r: 6, c: 7 }, new Vector3());
    const screen = center.clone().project(f.viewer.camera);
    const north = cellCenter(f.plugin.map, { r: 5, c: 7 }, new Vector3()).project(f.viewer.camera);
    const east = cellCenter(f.plugin.map, { r: 6, c: 8 }, new Vector3()).project(f.viewer.camera);
    expect(north.y).toBeGreaterThan(screen.y); expect(north.x).toBeCloseTo(screen.x, 10);
    expect(east.x).toBeGreaterThan(screen.x); expect(east.y).toBeCloseTo(screen.y, 10);
    const lanes = f.plugin.render!.root.getObjectByName('neon-lanes') as InstancedMesh;
    expect(lanes.count).toBe(104); expect(lanes.count * 2).toBe(f.plugin.graph!.edges.length);
  });
  it('starts on cell centers and moves visible unbatched meshes for 120 ticks', async () => {
    vi.spyOn(gltfLoader, 'loadAsync').mockImplementation(async () => model());
    const f = fixture(); f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    expect(f.root.visible).toBe(false); expect(f.plugin.vehicles).toHaveLength(5);
    const player = f.plugin.vehicles[0];
    expect(player.traveler.getPosition(new Vector3())).toEqual(cellCenter(f.plugin.map, f.plugin.map.playerStart, new Vector3()));
    const mesh = player.object.children[0].children[0]; f.viewer.scene.updateMatrixWorld(true);
    const before = mesh.getWorldPosition(new Vector3());
    expect(f.viewer.signalStore!.get('Maze.State')).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(f.viewer.signalStore!.get('Maze.State')).toBe(1);
    for (let i = 0; i < 120; i++) f.plugin.onFixedUpdatePre(1 / 60);
    f.viewer.scene.updateMatrixWorld(true);
    expect(mesh.getWorldPosition(new Vector3()).distanceTo(before)).toBeGreaterThan(1);
    expect(f.plugin.vehicles.every(vehicle => vehicle.object.parent === f.viewer.scene)).toBe(true);
    const beaconMaterial = (player.object.getObjectByName('player-beacon') as Mesh).material as MeshStandardMaterial;
    const flashes = (distance: number): number => {
      player.reset(); let transitions = 0, last = beaconMaterial.emissiveIntensity;
      for (let i = 0; i < 120; i++) {
        player.updateBeacon(1 / 60, false, distance * distance, f.plugin.map.cellSize);
        if (beaconMaterial.emissiveIntensity !== last) transitions++;
        last = beaconMaterial.emissiveIntensity;
      }
      return transitions;
    };
    const farFlashes = flashes(20), nearFlashes = flashes(0.6);
    expect(farFlashes).toBeGreaterThanOrEqual(3); expect(nearFlashes).toBeGreaterThan(farFlashes * 3);
    expect(flashes(0.6)).toBe(nearFlashes);
    f.plugin.restart(); f.plugin.setDesired('E');
    f.plugin.vehicles.slice(1).forEach((vehicle, i) => {
      vehicle.position.copy(player.position); vehicle.position.x += i === 0 ? 0.1 : 4 + i;
    });
    f.plugin.ghosts!.eat(0);
    const beaconUpdate = vi.spyOn(player, 'updateBeacon');
    const distanceChecks = vi.spyOn(player.position, 'distanceToSquared');
    f.plugin.onFixedUpdatePost(1 / 60);
    expect(distanceChecks).toHaveBeenCalledTimes(4);
    expect(beaconUpdate).toHaveBeenLastCalledWith(1 / 60, false, 25, 1.2);
    f.plugin.game!.arriveAt(f.plugin.map.powerPellets[0]); f.plugin.onFixedUpdatePost(1 / 60);
    expect(beaconMaterial.color.getHex()).toBe(0x008351);
    f.plugin.game!.tick(8); f.plugin.onFixedUpdatePost(1 / 60);
    expect(beaconMaterial.color.getHex()).toBe(0xf2a900);
    f.plugin.restart(); expect(beaconMaterial.emissiveIntensity).toBe(2);
  });
  it('drops delayed generations and rebuilds exactly five vehicles', async () => {
    let finish!: (value: ReturnType<typeof model>) => void;
    vi.spyOn(gltfLoader, 'loadAsync').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async () => model());
    const f = fixture();
    const visualizer: RVViewerPlugin = { id: 'path-visualizer', init: () => {}, onModelCleared: vi.fn() };
    let disabled = false;
    let userDisabled = false;
    let registered = true;
    f.viewer.getPlugin = (() => registered ? visualizer : undefined) as RVViewer['getPlugin'];
    f.viewer.isPluginDisabled = () => disabled;
    f.viewer.isPluginUserDisabled = () => userDisabled;
    f.viewer.getPluginOrigin = () => 'unknown';
    f.viewer.removePlugin = vi.fn(() => { registered = false; disabled = false; userDisabled = false; return true; });
    f.viewer.use = vi.fn(() => { registered = true; return f.viewer; });
    f.viewer.setPluginUserEnabled = vi.fn((_id: string, enabled: boolean) => { userDisabled = !enabled; disabled = !enabled; });
    f.viewer.disablePlugin = vi.fn(() => { disabled = true; });
    f.viewer.enablePlugin = vi.fn(() => { disabled = false; });
    f.plugin.onModelLoaded(f.result, f.viewer);
    expect(registered).toBe(false); expect(visualizer.onModelCleared).toHaveBeenCalledOnce();
    f.plugin.onModelCleared(); f.plugin.onModelLoaded(f.result, f.viewer);
    const stale = model(); const disposed = vi.spyOn((stale.scene.children[0] as Mesh).geometry, 'dispose');
    finish(stale); await f.idle();
    expect(disposed).toHaveBeenCalledOnce(); expect(f.plugin.vehicles).toHaveLength(5);
    expect(f.viewer.scene.children.filter(child => child.name.startsWith('ghost-') || child.name === 'maze-player')).toHaveLength(5);
    const paths = f.plugin.network.all().length;
    f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    expect(f.plugin.network.all()).toHaveLength(paths); expect(f.plugin.vehicles).toHaveLength(5);
    const lanes = f.plugin.render!.root.getObjectByName('neon-lanes') as InstancedMesh;
    const disposeLanes = vi.spyOn(lanes.geometry, 'dispose');
    const resources = new Set<{ dispose(): void }>();
    for (const vehicle of f.plugin.vehicles) vehicle.object.traverse(node => {
      if (node instanceof Mesh) {
        resources.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) resources.add(material);
      }
    });
    const disposedResources = [...resources].map(resource => vi.spyOn(resource, 'dispose'));
    f.plugin.onModelCleared(); expect(f.plugin.network.all()).toHaveLength(0);
    for (const disposedResource of disposedResources) expect(disposedResource).toHaveBeenCalledOnce();
    expect(registered).toBe(true); expect(disabled).toBe(false); expect(disposeLanes).toHaveBeenCalledOnce();
    expect(f.viewer.scene.children).toEqual([f.root]);
    disabled = true;
    const enables = vi.mocked(f.viewer.enablePlugin).mock.calls.length;
    f.plugin.onModelLoaded(f.result, f.viewer); await f.idle(); f.plugin.onModelCleared();
    expect(disabled).toBe(true); expect(f.viewer.enablePlugin).toHaveBeenCalledTimes(enables);
    userDisabled = true;
    f.plugin.onModelLoaded(f.result, f.viewer); await f.idle(); f.plugin.onModelCleared();
    expect(registered).toBe(true); expect(userDisabled).toBe(true); expect(disabled).toBe(true);
    expect(f.viewer.setPluginUserEnabled).toHaveBeenCalledWith('path-visualizer', false);
  });
  it('handles rejected vehicle work without tick exceptions', async () => {
    vi.spyOn(gltfLoader, 'loadAsync').mockRejectedValue(new Error('fixture failure')); vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture(); f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    expect(f.plugin.ready).toBe(false); expect(f.plugin.error).toContain('fixture failure');
    expect(() => { for (let i = 0; i < 60; i++) f.plugin.onFixedUpdatePre(1 / 60); }).not.toThrow();
    expect(f.viewer.signalStore!.get('Maze.State')).toBe(0);
    expect(f.plugin.getStatus()).toContain('fixture failure');
  });
  it('renders HUD slots and lets a pointer press use the same direction buffer as the keyboard', async () => {
    vi.spyOn(gltfLoader, 'loadAsync').mockImplementation(async () => model());
    const f = fixture(); f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(RVViewerProvider, { value: f.viewer },
        ...f.plugin.slots.map(entry => createElement(entry.component, { viewer: f.viewer, key: entry.slot })))));
      expect(host.textContent).toContain('Orders'); expect(host.textContent).toContain('Lives');
      const south = host.querySelector<HTMLButtonElement>('button[aria-label="Go south"]')!;
      await act(async () => south.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      expect(f.plugin.player!.desired).toBe('S');
      await act(async () => { for (let i = 0; i < 65; i++) f.plugin.onFixedUpdatePre(1 / 60); });
      expect(f.plugin.player!.direction).toBe('S');
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
      expect(f.plugin.player!.desired).toBe('S');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it('resets on simulation-reset and stays Ready when simulation-start follows', async () => {
    vi.spyOn(gltfLoader, 'loadAsync').mockImplementation(async () => model());
    const f = fixture(); f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    const paths = f.plugin.network.all(); f.plugin.setDesired('E'); f.plugin.onFixedUpdatePre(1.1);
    f.events.get('simulation-reset')!(); f.events.get('simulation-start')?.();
    expect(f.plugin.game!.state).toBe(0); expect(f.plugin.ghosts!.phaseIndex).toBe(0); expect(f.plugin.ghosts!.phaseElapsed).toBe(0);
    expect(f.plugin.vehicles[0].traveler.getPosition(new Vector3())).toEqual(cellCenter(f.plugin.map, f.plugin.map.playerStart, new Vector3()));
    expect(f.plugin.network.all()).toEqual(paths);
    f.plugin.onModelCleared(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(f.plugin.vehicles).toHaveLength(0); expect(f.plugin.network.hasRouter).toBe(false);
    expect(f.viewer.uiRegistry.getSlotComponents('kpi-bar')).toHaveLength(0);
  });
  it('keeps cabinet colors independent and only the signal column visible when Eaten', async () => {
    const paint = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText');
    vi.spyOn(gltfLoader, 'loadAsync').mockImplementation(async () => model());
    const f = fixture(); f.plugin.onModelLoaded(f.result, f.viewer); await f.idle();
    expect(paint).toHaveBeenCalledWith('STOERUNG  F-0471', 256, 48, 484);
    const lamps = f.plugin.vehicles.slice(1).map(vehicle => vehicle.object.getObjectByName('signal-column') as Mesh);
    const colors = lamps.map(lamp => (lamp.material as MeshStandardMaterial).color.getHex());
    expect(new Set(colors).size).toBe(4);
    expect(colors).toEqual([0x2271b3, 0x383e42, 0x57a639, 0xfad201]);
    f.plugin.vehicles[1].updateAppearance('frightened', 4);
    const ghost = f.plugin.vehicles[1], body = ghost.object.getObjectByName('cabinet-body')!;
    const lampMaterial = lamps[0].material as MeshStandardMaterial;
    expect(lampMaterial.color.getHex()).toBe(0xe30613); expect(lampMaterial.emissiveIntensity).toBe(5);
    const eyes = ghost.object.getObjectByName('indicator-eyes')!;
    const eyeMaterial = (eyes.children[0] as Mesh).material as MeshStandardMaterial;
    expect(eyes.children).toHaveLength(2); expect(eyeMaterial.color.getHex()).toBe(0xe30613);
    expect(eyeMaterial.emissiveIntensity).toBe(2);
    expect(ghost.object.getObjectByName('vent-grille')!.visible).toBe(false);
    expect(ghost.object.getObjectByName('fault-grille')!.visible).toBe(true);
    const rings = ghost.object.getObjectByName('bellows')!.children;
    expect(rings).toHaveLength(5); expect(rings[0].position.x).not.toBe(rings[1].position.x);
    const frame = ghost.object.getObjectByName('cabinet-frame') as Mesh;
    expect((frame.material as MeshStandardMaterial).metalness).toBe(1);
    expect((frame.material as MeshStandardMaterial).roughness).toBe(0.30);
    const position = ghost.position.clone(), quaternion = ghost.quaternion.clone();
    expect(body.rotation.y).toBe(Math.PI);
    ghost.updateAppearance('frightened', 3.7); expect(lampMaterial.emissiveIntensity).toBe(0.15);
    ghost.updateAppearance('frightened', 1.9); expect(lampMaterial.emissiveIntensity).toBe(0.15);
    ghost.updateAppearance('frightened', 1.8); expect(lampMaterial.emissiveIntensity).toBe(5);
    expect(ghost.position).toEqual(position); expect(ghost.quaternion).toEqual(quaternion);
    expect((lamps[1].material as MeshStandardMaterial).color.getHex()).toBe(colors[1]);
    expect(f.plugin.vehicles[1].object.getObjectByName('fault-front')!.visible).toBe(true);
    f.plugin.vehicles[1].updateAppearance('eaten', 0);
    expect(eyes.visible).toBe(false); expect(eyeMaterial.emissiveIntensity).toBe(0);
    expect(f.plugin.vehicles[1].object.children.filter(child => child.visible).map(child => child.name)).toEqual(['signal-column']);
    f.plugin.vehicles[1].updateAppearance('chase', 0);
    expect(f.plugin.vehicles[1].object.getObjectByName('cabinet-body')!.visible).toBe(true);
    expect(body.rotation.y).toBe(0); expect(lampMaterial.color.getHex()).toBe(colors[0]);
    expect(eyes.visible).toBe(true); expect(eyeMaterial.color.getHex()).toBe(0xffffff);
    expect(eyeMaterial.emissiveIntensity).toBe(3);
    expect(ghost.object.getObjectByName('vent-grille')!.visible).toBe(true);
    expect(ghost.object.getObjectByName('fault-grille')!.visible).toBe(false);
    const bubble = ghost.object.getObjectByName('speech-bubble')!;
    const sequence = (): string[] => {
      ghost.reset(); const phrases: string[] = [];
      for (let second = 0; second < 60; second++) {
        ghost.updateSpeech(1, 'chase');
        const visible = bubble.children.filter(child => child.visible);
        expect(visible.length).toBeLessThanOrEqual(1);
        if (bubble.visible) phrases.push(`${second}:${visible[0].name}`);
      }
      return phrases;
    };
    const first = sequence(); expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThanOrEqual(9);
    expect(sequence()).toEqual(first);
    ghost.reset(); ghost.updateSpeech(3, 'chase'); expect(bubble.visible).toBe(true);
    ghost.updateSpeech(3, 'chase'); expect(bubble.visible).toBe(false);
    ghost.reset(); ghost.updateSpeech(3, 'eaten'); expect(bubble.visible).toBe(false);
  });
});

// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import type { RVViewer } from '@rv/core/rv-viewer';
import type { RVViewerPlugin } from '@rv/core/rv-plugin';
import { createElement } from 'react';
import { Color, Light, PerspectiveCamera, Vector3 } from 'three';
import type { UISlotEntry } from '@rv/core/rv-ui-plugin';
import type { LoadResult } from '@rv/core/engine/rv-scene-loader';
import { getDefaultPathNetwork } from '@rv/core/engine/rv-path-network';
import { buildMazeGraph, type MazeGraph } from './maze-builder';
import { DEFAULT_MAZE, parseMazeMap, type Dir } from './maze-map';
import { createMazeVehicles, disposeMazeObject, loadPlayerObject, MazeDirectionIndicator, type MazeVehicle } from './maze-vehicles';
import { PlayerControl } from './player-control';
import { MazeAudio, MazeGame } from './game-state';
import { GhostRouter } from './ghost-router';
import { MazeRender } from './maze-render';
import { MazeOverlay, type MazeHudControl } from './maze-hud';

export class AgvMazePlugin implements RVViewerPlugin, MazeHudControl {
  readonly id = 'agv-maze';
  readonly map = parseMazeMap(DEFAULT_MAZE);
  readonly network = getDefaultPathNetwork();
  vehicles: MazeVehicle[] = [];
  graph: MazeGraph | null = null;
  ready = false;
  error = '';
  game: MazeGame | null = null;
  player: PlayerControl | null = null;
  render: MazeRender | null = null;
  ghosts: GhostRouter | null = null;
  readonly slots: UISlotEntry[] = [
    { slot: 'overlay', component: () => createElement(MazeOverlay, { control: this }) },
  ];
  private status = 'inactive';
  private readonly listeners = new Set<() => void>();
  private offKeyboard: (() => void) | null = null;
  private offReset: (() => void) | null = null;
  private offResize: (() => void) | null = null;
  private viewer: RVViewer | null = null;
  private readonly cameraCenter = new Vector3();
  private readonly cameraPosition = new Vector3();
  private readonly audio = new MazeAudio();
  private generation = 0;
  private hudMounted = false;
  onHudMounted(): () => void { this.hudMounted = true; return () => { this.hudMounted = false; }; }
  private restoreLook: (() => void) | null = null;
  private restorePathVisualizer: (() => void) | null = null;
  private indicator: MazeDirectionIndicator | null = null;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  readonly getStatus = (): string => this.status;
  private publishStatus(): void { for (const listener of this.listeners) listener(); }
  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.offReset = viewer.on('simulation-reset', () => this.restart());
  }
  setDesired(dir: Dir): void {
    if (!this.ready || !this.player || !this.game || (this.game.state !== 0 && this.game.state !== 1)) return;
    this.audio.unlock();
    this.player.setDesired(dir);
    if (this.game.state === 0) { this.game.start(); this.player.start(); }
  }
  restart(): void { if (this.ready) { this.audio.clear(); this.game?.restart(); } }
  toggleMute(): void { this.audio.muted = !this.audio.muted; this.game?.setMuted(this.audio.muted); if (!this.audio.muted) this.audio.unlock(); }
  private resetPositions(): void {
    for (const vehicle of this.vehicles) vehicle.reset();
    this.player?.reset();
    if (this.player) this.indicator?.update(this.player.direction, null);
  }
  private readonly frameCamera = (): void => {
    const viewer = this.viewer;
    if (!viewer || !this.ready) return;
    const camera = viewer.camera;
    const aspect = camera instanceof PerspectiveCamera ? Math.max(0.1, camera.aspect) : 1.5;
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 45;
    const elevation = 68 * Math.PI / 180;
    const halfWidth = this.map.cols * this.map.cellSize / 2;
    const halfDepth = this.map.rows * this.map.cellSize / 2;
    const tanFov = Math.tan(fov * Math.PI / 360);
    const distance = Math.max(halfWidth / (tanFov * aspect), halfDepth * Math.sin(elevation) / tanFov)
      * 1.12 + halfDepth * Math.cos(elevation);
    this.cameraCenter.set((this.map.cols - 1) * this.map.cellSize / 2, 0, (this.map.rows - 1) * this.map.cellSize / 2);
    this.cameraPosition.set(this.cameraCenter.x, distance * Math.sin(elevation), this.cameraCenter.z + distance * Math.cos(elevation));
    viewer.animateCameraTo(this.cameraPosition, this.cameraCenter, 0);
  };
  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.onModelCleared();
    this.viewer = viewer;
    viewer.uiRegistry.register(this);
    this.suppressPathVisualizer(viewer);
    const generation = this.generation;
    result.root.visible = false;
    this.graph = buildMazeGraph(this.map, this.network);
    this.game = new MazeGame(this.map, viewer.signalStore!, {
      resetPositions: () => this.resetPositions(),
      resetGhosts: () => this.ghosts?.reset(),
      frightened: active => this.ghosts?.setFrightened(active),
      eatGhost: index => this.ghosts?.eat(index),
      pellet: (index, power) => { this.render?.collect(index); this.audio.enqueue(power ? 1 : 0); },
      resetPellets: () => this.render?.reset(),
      captured: () => this.audio.enqueue(2),
    });
    this.game.setMuted(this.audio.muted);
    this.status = 'loading'; this.publishStatus();
    const vehicleUrl = viewer.currentModelUrl!;
    const work = loadPlayerObject(vehicleUrl).then(async player => {
      if (generation !== this.generation) { disposeMazeObject(player); return; }
      this.vehicles = createMazeVehicles(player, this.map, this.graph!, this.network);
      for (const vehicle of this.vehicles) viewer.scene.add(vehicle.object);
      this.player = new PlayerControl(this.vehicles[0].traveler, this.map, this.graph!, cell => this.game!.arriveAt(cell));
      this.indicator = new MazeDirectionIndicator();
      this.vehicles[0].object.add(this.indicator.root);
      this.ghosts = new GhostRouter(this.map, this.graph!, this.network, this.vehicles.slice(1).map(vehicle => vehicle.traveler), this.player);
      const render = new MazeRender(this.map);
      try { await render.loadPallets(new URL('library/PalletHandling/Europallet.glb', document.baseURI).href); }
      catch (error) { render.dispose(); throw error; }
      if (generation !== this.generation) { render.dispose(); return; }
      this.render = render; viewer.scene.add(render.root);
      this.offKeyboard = this.player.bindKeyboard(window, () => this.ready && (this.game?.state === 0 || this.game?.state === 1), dir => this.setDesired(dir));
      this.ready = true;
      this.game!.restart(); this.status = 'ready'; this.publishStatus();
      this.frameCamera();
      window.addEventListener('resize', this.frameCamera);
      this.offResize = () => window.removeEventListener('resize', this.frameCamera);
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.error = `AGV Maze: scene assets could not be loaded (${error instanceof Error ? error.message : String(error)}).`;
      this.ready = false; this.status = this.error; this.publishStatus();
    });
    viewer.trackLoadingWork(work);
  }
  onFixedUpdatePre(dt: number): void {
    if (!this.ready || this.game?.state !== 1) return;
    this.ghosts!.tick(dt);
    this.player!.tick(dt); this.vehicles[0].writePose();
    this.indicator?.update(this.player!.direction, this.player!.desired);
    for (let i = 1; i < this.vehicles.length; i++) {
      const vehicle = this.vehicles[i]; vehicle.traveler.v = this.ghosts!.speed(i - 1); vehicle.traveler.advance(dt); vehicle.writePose();
      vehicle.updateAppearance(this.ghosts!.modes[i - 1], this.game.frightenedLeft);
      vehicle.updateSpeech(dt, this.ghosts!.modes[i - 1]);
    }
    this.viewer?.markRenderDirty();
  }
  onFixedUpdatePost(dt: number): void {
    if (!this.ready || !this.game) return;
    let nearestSquared = Infinity;
    if (this.game.state === 1) {
      const position = this.vehicles[0].position, radius = this.map.cellSize * 0.45;
      for (let i = 1; i < this.vehicles.length; i++) {
        const distanceSquared = position.distanceToSquared(this.vehicles[i].position);
        if (distanceSquared < radius * radius) this.game.contact(i - 1, this.ghosts!.modes[i - 1]);
        if (this.ghosts!.modes[i - 1] !== 'eaten') nearestSquared = Math.min(nearestSquared, distanceSquared);
      }
    }
    this.game.tick(dt);
    this.vehicles[0].updateBeacon(dt, this.game.signals['Maze.Frightened'], nearestSquared, this.map.cellSize);
  }
  private applyNightLook(viewer: RVViewer): void {
    const scene = viewer.scene, background = scene.background, environmentIntensity = scene.environmentIntensity;
    const ground = viewer.groundMesh, groundVisible = ground?.visible;
    const reflection = viewer.reflectionEnabled;
    if (ground) ground.visible = false;
    if (typeof reflection === 'boolean') viewer.reflectionEnabled = false;
    const lights: Array<[Light, number]> = [];
    scene.traverse(node => {
      if (node instanceof Light && !this.render!.root.getObjectById(node.id)) {
        lights.push([node, node.intensity]); node.intensity = 0;
      }
    });
    const bloom = { enabled: viewer.bloomEnabled, intensity: viewer.bloomIntensity, threshold: viewer.bloomThreshold, radius: viewer.bloomRadius };
    scene.background = new Color(0x030507); scene.environmentIntensity = 0.08;
    if (typeof bloom.enabled === 'boolean') {
      viewer.bloomEnabled = true; viewer.bloomIntensity = 0.55; viewer.bloomThreshold = 0.85; viewer.bloomRadius = 0.4;
    }
    this.restoreLook = () => {
      scene.background = background; scene.environmentIntensity = environmentIntensity;
      if (ground) ground.visible = groundVisible!;
      if (typeof reflection === 'boolean') viewer.reflectionEnabled = reflection;
      for (const [light, intensity] of lights) light.intensity = intensity;
      if (typeof bloom.enabled === 'boolean') {
        viewer.bloomEnabled = bloom.enabled; viewer.bloomIntensity = bloom.intensity;
        viewer.bloomThreshold = bloom.threshold; viewer.bloomRadius = bloom.radius;
      }
    };
  }
  onRender(dt = 0): void {
    this.audio.flush();
    // Shared plugins may register after the model's async loading hook.
    if (this.ready && this.viewer) this.suppressPathVisualizer(this.viewer);
    // App applies persisted lighting in its mount effect. Wait for the HUD effect
    // before applying the model look so that initial settings cannot overwrite it.
    if (this.ready && this.hudMounted && !this.restoreLook && this.viewer) this.applyNightLook(this.viewer);
    if (this.ready) { this.render?.animate(dt); this.viewer?.markRenderDirty(); }
  }
  private suppressPathVisualizer(viewer: RVViewer): void {
    const visualizer = viewer.getPlugin('path-visualizer');
    if (visualizer && !this.restorePathVisualizer) {
      const disabled = viewer.isPluginDisabled(visualizer.id);
      const userDisabled = viewer.isPluginUserDisabled(visualizer.id);
      const origin = viewer.getPluginOrigin(visualizer.id);
      // Removal also detaches path-change and pointer listeners; merely disabling
      // render callbacks still lets graph registration rebuild the chevrons.
      visualizer.onModelCleared?.(viewer);
      if (viewer.removePlugin(visualizer.id)) this.restorePathVisualizer = () => {
        viewer.use(visualizer, origin);
        if (userDisabled) viewer.setPluginUserEnabled(visualizer.id, false);
        else if (disabled) viewer.disablePlugin(visualizer.id);
      };
    }
  }
  onModelCleared(): void {
    this.generation++; this.ready = false; this.error = ''; this.indicator = null;
    this.viewer?.uiRegistry.unregister(this.id);
    this.audio.dispose();
    this.restoreLook?.(); this.restoreLook = null;
    this.offResize?.(); this.offResize = null;
    this.offKeyboard?.(); this.offKeyboard = null; this.player?.dispose(); this.player = null;
    this.render?.dispose(); this.render = null; this.game = null;
    this.ghosts?.dispose(); this.ghosts = null;
    for (const vehicle of this.vehicles) disposeMazeObject(vehicle.object);
    this.vehicles.length = 0; this.graph?.dispose(); this.graph = null;
    this.restorePathVisualizer?.(); this.restorePathVisualizer = null;
    this.status = 'inactive'; this.publishStatus();
  }
  dispose(): void { this.onModelCleared(); this.offReset?.(); this.offReset = null; this.viewer = null; this.listeners.clear(); }
}

export function registerModelPlugins(viewer: RVViewer): void { viewer.use(new AgvMazePlugin()); }
export function unregisterModelPlugins(viewer: RVViewer): void { viewer.removePlugin('agv-maze'); }

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * webcomponent-des-fixture.ts — plan-2212 Phase 1 fixture: Model-Scripts
 * (`WebComponent` rv_extras) wired by the REAL `WebComponentPlugin` and a
 * REAL `DESRunner` that finds the plugin through its topology host
 * (`host.getPlugin('web-component')`) — the production binding path, no
 * injected script source. The viewer is a small double (event bus, stats
 * registry, address registry), like `tests/web-script-scene.test.ts`.
 *
 * Optional material flow (Source → Station → Sink) gives the runner live
 * instances, so runs open and archive (run lifecycle) like a real scene.
 */

import { afterEach, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { StatsRegistry } from '../../src/core/stats/rv-stats-registry';
import { StatisticsManager } from '../../src/core/material-flow/rv-statistics-manager';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../../src/core/rv-viewer';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import type { WebComponentInstance } from '../../src/core/engine/rv-web-component-registry';
import { runnerFixture } from './runner-fixture';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';

export interface ScriptSpec {
  name: string;
  code: string;
  desSafe?: boolean;
}

export interface WorldOptions {
  scripts: ScriptSpec[];
  /** Add a Source → Station → Sink line (live runner instances, run lifecycle). */
  flow?: boolean;
  seed?: number;
  allowScripts?: boolean;
  /** QuickJS host factory (cold / failing host). Default: a shared warm host. */
  createHost?: () => Promise<RVScriptHost>;
  /** Wait for the plugin's wiring before returning. Default true. */
  awaitWiring?: boolean;
  /** A prebuilt scene (e.g. placements with authored ids); `scripts` are added under `Scripts`. */
  scene?: Scene;
  /**
   * plan-2212 Phase 3: the node-address source of runner AND plugin (default: the
   * `#<name>` test registry). A real `NodeRegistry` adapter exercises the
   * production registration (placement occurrences, unregistered nodes).
   */
  addresses?: (scene: Scene) => DesAddressSource;
}

/** The `desAddresses` shape of a headless host (see `tests/helpers/test-address-registry.ts`). */
export interface DesAddressSource {
  getAddressForNode(node: Object3D): string | null;
  forEachNode(fn: (path: string, node: Object3D) => void): void;
}

let sharedHost: RVScriptHost | null = null;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* teardown best effort */ }
  }
});

/** One warm QuickJS host for the whole file (the plugin owns cold ones). */
export async function warmHost(): Promise<RVScriptHost> {
  sharedHost ??= await RVScriptHost.create();
  return sharedHost;
}

/** A host that is NOT disposed with the plugin (plugin.dispose disposes its host). */
export function borrowed(host: RVScriptHost): RVScriptHost {
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === 'dispose') return () => {};
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * Viewer double: event bus + stats registries + address registry. `simTime`
 * follows the COMMITTED mode like the real viewer: the kernel commits a mode
 * only after the incoming executor started, so during a switch it still
 * reads the outgoing mode's clock (`clock` is set by the world).
 */
export function makeViewerDouble(addresses: { getAddressForNode(node: Object3D): string | null }) {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const viewer = {
    stats: new StatsRegistry(),
    registry: { getAddressForNode: (node: Object3D) => addresses.getAddressForNode(node) },
    statisticsManager: new StatisticsManager(),
    clock: (): number => 0,
    get simTime(): number { return viewer.clock(); },
    on(event: string, fn: (data: unknown) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(fn);
      return () => set!.delete(fn);
    },
    emit(event: string, data?: unknown): void {
      emitted.push({ event, data });
      for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
    },
  };
  return { viewer, emitted };
}

export function scriptNode(spec: ScriptSpec): Object3D {
  const node = new Object3D();
  node.name = spec.name;
  node.userData.realvirtual = { WebComponent: { Code: spec.code, ...(spec.desSafe ? { DesSafe: true } : {}) } };
  return node;
}

/** Scene + runner + plugin. Call `start()` to bind the DES run. */
export async function makeWorld(opts: WorldOptions) {
  // Browser test files share one origin: another file's run settings (activeProjectId,
  // autoSaveInterval) leak in through localStorage at module load. Start from defaults.
  __resetDesRunSettingsForTest();
  const scene = opts.scene ?? new Scene();
  if (opts.flow) {
    for (const [name, props] of [
      ['Source', { Interval: 10 }],
      ['Station', { ProcessingTime: 5 }],
      ['Sink', {}],
    ] as const) {
      const node = new Object3D(); node.name = name;
      node.userData.realvirtual = { [name]: props }; scene.add(node);
    }
  }
  const scriptRoot = new Object3D(); scriptRoot.name = 'Scripts';
  if (opts.scripts.length > 0 || !opts.scene) scene.add(scriptRoot);
  for (const spec of opts.scripts) scriptRoot.add(scriptNode(spec));

  const fixture = runnerFixture(scene, opts.seed ?? 42);
  const { runner, manager, components, host } = fixture;
  if (opts.addresses) (host as { desAddresses: DesAddressSource }).desAddresses = opts.addresses(scene);
  if (opts.flow) {
    const [source, station, sink] = ['Source', 'Station', 'Sink'].map(n => components.find(c => c.node.name === n)!);
    source.nextComponents = [station]; station.previousComponents = [source];
    station.nextComponents = [sink]; sink.previousComponents = [station];
  }

  const { viewer, emitted } = makeViewerDouble(host.desAddresses);
  let mode: 'continuous' | 'des' = 'continuous';
  let contTime = 0;
  viewer.clock = () => mode === 'des' ? manager.currentTime : contTime;
  const createHost = opts.createHost ?? (async () => borrowed(await warmHost()));
  const plugin = new WebComponentPlugin({ allowScripts: opts.allowScripts ?? true, callDeadlineMs: 500, createHost });
  plugin.init(viewer as unknown as RVViewer);
  cleanups.push(() => plugin.dispose());

  // The runner reaches the plugin the production way: through its topology host.
  const runnerHost = host as unknown as Omit<typeof host, 'getPlugin'> & {
    getPlugin(id: string): unknown; stats: StatsRegistry; emit(event: string, data: unknown): void;
  };
  runnerHost.getPlugin = (id: string) => id === 'web-component' ? plugin : undefined;
  runnerHost.stats = viewer.stats;
  runnerHost.emit = (event, data) => viewer.emit(event, data);

  const load = { root: scene, registry: new NodeRegistry(), signalStore: host.signalStore } as unknown as LoadResult;
  plugin.onModelLoaded(load, viewer as unknown as RVViewer);
  if (opts.awaitWiring !== false) await plugin.whenWired();

  const world = {
    scene, runner, manager, plugin, viewer, emitted, host: runnerHost, scriptRoot,
    /** Bind the scene to the runner and start the DES run. */
    start(): void {
      runner.start([], { root: scene, host: runnerHost as never });
      mode = 'des';   // committed after the incoming start, like SimulationKernel.setMode
    },
    /** Instance of one script by node name. */
    inst(name: string): WebComponentInstance {
      const inst = plugin.instances.find(i => i.node.name === name);
      if (!inst) throw new Error(`no script instance '${name}'`);
      return inst;
    },
    /** Call the script's `state()` handler. */
    state(name: string): unknown {
      const r = world.inst(name).component!.callHandler('state');
      if (!r.ok) throw new Error(`state() failed: ${r.error?.message}`);
      return r.value;
    },
    /** FastForward the current run until `t` (sim end = t). */
    async runTo(t: number): Promise<void> {
      manager.duration = t;
      const ok = await runner.runFastForward();
      if (!ok) throw new Error('fast-forward did not complete');
    },
    /**
     * plan-2212 Phase 4: one viewer frame in DES mode, in the viewer's
     * `fixedUpdate` order — PRE plugins (script frame hooks) → runner tick
     * (event advance) → runner lateTick (tweens) → POST plugins.
     */
    frame(dt = 0.25): void {
      plugin.onFixedUpdatePre(dt);
      runner.tick(dt);
      runner.lateTick(dt);
      plugin.onFixedUpdatePost(dt);
    },
    /** Animated DES frames until the run completes at sim end `t` (plan-2212 Phase 4). */
    animateTo(t: number, dt = 0.25): void {
      manager.duration = t;
      runner.setSubMode('animated');
      for (let i = 0; i < 1_000_000 && !runner.runComplete; i++) world.frame(dt);
      if (!runner.runComplete) throw new Error('animated run did not complete');
    },
    /** Continuous frame ticks for `seconds` (fixed 1/60 s). */
    tickContinuous(seconds: number): void {
      const steps = Math.round(seconds * 60);
      for (let i = 0; i < steps; i++) { contTime += 1 / 60; plugin.onFixedUpdatePre(1 / 60); }
    },
    /** The kernel's switch DES → continuous (clearMUs + suspend). */
    switchToContinuous(): void {
      runner.clearMUs();
      runner.suspend();
      mode = 'continuous';
    },
    /** Script rows the stats window shows (`self.statValue`). */
    statRows(): Array<{ label: string; value: unknown; owner?: string }> {
      return viewer.stats.list().filter(s => s.id === 'scripts')
        .flatMap(s => s.rows?.() ?? []) as Array<{ label: string; value: unknown; owner?: string }>;
    },
  };
  return world;
}

/** mulberry32 — the guest PRNG of `self.random()` (rv-sdk-self.ts). */
export function mulberry32(seed: number): () => number {
  let rs = (seed >>> 0) || 1;
  return () => {
    rs = (rs + 0x6D2B79F5) | 0;
    let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A promise with external resolve/reject (cold QuickJS host). */
export function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}


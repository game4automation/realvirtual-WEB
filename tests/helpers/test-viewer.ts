// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test helper — minimal mock viewer for unit tests around the simulation
 * pause/reset surface and plugin-lifecycle behavior.
 *
 * Inspired by `webxr-plugin.test.ts:makeStubViewer()`. The returned object
 * is intentionally narrow: it implements the parts of `RVViewer` that
 * SimController + Layout-Planner-pause-wiring actually call. Cast to
 * `RVViewer` via `as unknown as RVViewer` at the call site.
 *
 * Time-Mocking
 * ────────────
 * Tests that need deterministic fixed-step behavior should NOT use
 * `vi.useFakeTimers()` here. The mock viewer exposes a synchronous
 * `tick(dt)` so tests step the simulation by calling it explicitly.
 * That avoids tangling with rAF / setTimeout fakery while still giving
 * the equivalent of one or many fixed-step ticks per test step.
 */

import { EventEmitter } from '../../src/core/rv-events';
import { TickStage } from '../../src/core/rv-tick-stages';
import { SignalReapplyRegistry } from '../../src/core/engine/rv-signal-reapply-registry';

/** Minimal MU snapshot — only counters that the reset tests inspect. */
export interface TestTransportManager {
  mus: unknown[];
  totalSpawned: number;
  totalConsumed: number;
  reset(): void;
}

/** Minimal LogicEngine — only `reset()` is exercised in the user-reset path. */
export interface TestLogicEngine {
  resetCalls: number;
  reset(): void;
}

/** Minimal SignalStore — only `clear()` and `get()` are exercised. */
export interface TestSignalStore {
  cleared: boolean;
  values: Map<string, boolean | number>;
  get(name: string): boolean | number | undefined;
  set(name: string, value: boolean | number): void;
}

/**
 * A minimal node registry for testing withNodes lookups.
 */
export interface TestNodeRegistry {
  getNode(path: string): { path: string; type?: string } | null;
  getPathForNode(node: unknown): string | null;
  forEachNode(fn: (node: { path: string; type?: string }, path: string) => void): void;
}

/**
 * Minimal pause API matching `RVViewer.setSimulationPaused`,
 * `clearPauseReasons`, `isSimulationPaused`, `simulationPauseReasons`.
 */
export interface TestViewer {
  /** Pause-reason set. */
  readonly _pauseReasons: Set<string>;
  readonly isSimulationPaused: boolean;
  readonly simulationPauseReasons: readonly string[];
  setSimulationPaused(reason: string, paused: boolean): void;
  clearPauseReasons(reason?: string): void;
  /** Emits 'simulation-pause-changed' on idle↔paused transitions. */
  emit: EventEmitter['emit'];
  on: EventEmitter['on'];
  off: EventEmitter['off'];
  /** Subsystems exposed for reset/test assertions. */
  transportManager: TestTransportManager;
  logicEngine: TestLogicEngine;
  /**
   * SignalStore reference. May be null after _setSignalStore(null) is called.
   * In normal usage (createTestViewer()) this is always initialized non-null.
   */
  signalStore: TestSignalStore | null;
  /** Viewer-owned re-apply registry (plan-427), mirroring `RVViewer.signalReapply`.
   *  `resetSimulation()` runs `reapplyAll()` on it as its last step. */
  signalReapply: SignalReapplyRegistry;
  /** User-facing reset facade — emits simulation-reset → (engine clear) →
   *  simulation-resetstat → simulation-start → signal re-apply, mirroring
   *  RVViewer. Clears MUs + LogicSteps and resets drives; leaves signals alone. */
  resetSimulation(): void;
  /** Plugin map (for layout-planner tests that do `viewer.getPlugin('layout-planner')`). */
  _plugins: Map<string, unknown>;
  getPlugin<T = unknown>(id: string): T | undefined;
  use(plugin: { id: string }): TestViewer;

  // ── Phase 0 additions (plan-182) ────────────────────────────────────────

  /** Mock drive array. Empty by default; Phase 5 wires real RVDrive instances. */
  drives: unknown[];

  /** Node registry populated from withNodes option, or null if none provided. */
  registry: TestNodeRegistry | null;

  /**
   * Slot for PluginContextImpl injected in Phase 4.
   * Default: null.
   */
  _pluginContext: unknown;

  /** Mock SimLoopFacade — allows onTick registration and _tickOnce stepping. */
  simLoop: {
    onTick(stage: TickStage, callback: (dt: number) => void, order?: number): () => void;
  };

  /**
   * Synchronously run all registered onTick callbacks in stage order
   * (PRE → SIM → POST), sorted by ascending order within each stage.
   * Uses a snapshot of the callback list so mid-tick registrations are
   * deferred to the next tick (defensive iteration).
   */
  _tickOnce(dt: number): void;

  /**
   * Replace the signalStore reference. Pass null to simulate a post-clearModel
   * state. Pass a new TestSignalStore to simulate a new model load.
   */
  _setSignalStore(store: TestSignalStore | null): void;

  /**
   * Remove a plugin by id. Returns true if the plugin was found and removed,
   * false if no plugin with that id existed.
   */
  removePlugin(id: string): boolean;
}

export interface CreateTestViewerOptions {
  /**
   * Number of MUs to pre-populate the transport manager with (so reset has
   * something to clear). Default: 0.
   */
  initialMus?: number;

  /**
   * Pre-populate the node registry with these nodes.
   * If provided, `viewer.registry` is non-null.
   */
  withNodes?: Array<{ path: string; type?: string }>;

  /**
   * Pre-populate the signalStore with these signal values.
   */
  withSignals?: Array<{ name: string; value: boolean | number }>;

  /**
   * Register a plugin via viewer.use() at the end of construction.
   */
  withPlugin?: { id: string; [k: string]: unknown };
}

/** Internal entry stored in the simLoop tick registry. */
interface TickEntry {
  cb: (dt: number) => void;
  order: number;
  id: number;
}

let _entryIdCounter = 0;

/**
 * Create a minimal test viewer instance suitable for SimController +
 * pause-reason + reset tests. Returns synchronously (no GLB loading).
 */
export function createTestViewer(options: CreateTestViewerOptions = {}): TestViewer {
  const emitter = new EventEmitter();
  const pauseReasons = new Set<string>();

  const transportManager: TestTransportManager = {
    mus: new Array(options.initialMus ?? 0).fill(null).map((_, i) => ({ id: `mu_${i}` })),
    totalSpawned: options.initialMus ?? 0,
    totalConsumed: 0,
    reset() {
      this.mus.length = 0;
      this.totalSpawned = 0;
      this.totalConsumed = 0;
    },
  };

  const logicEngine: TestLogicEngine = {
    resetCalls: 0,
    reset() { this.resetCalls++; },
  };

  const initialSignalStore: TestSignalStore = {
    cleared: false,
    values: new Map<string, boolean | number>(),
    get(name) { return this.values.get(name); },
    set(name, value) { this.values.set(name, value); },
  };

  // Pre-populate signals if requested
  if (options.withSignals) {
    for (const { name, value } of options.withSignals) {
      initialSignalStore.values.set(name, value);
    }
  }

  // Build node registry if requested
  let nodeRegistry: TestNodeRegistry | null = null;
  if (options.withNodes) {
    const nodeMap = new Map<string, { path: string; type?: string }>();
    for (const node of options.withNodes) {
      nodeMap.set(node.path, node);
    }
    nodeRegistry = {
      getNode(path) { return nodeMap.get(path) ?? null; },
      getPathForNode(node) {
        for (const [path, n] of nodeMap) {
          if (n === node) return path;
        }
        return null;
      },
      forEachNode(fn) {
        for (const [path, node] of nodeMap) {
          fn(node, path);
        }
      },
    };
  }

  // Re-entrancy guard scoped to setSimulationPaused — matches the
  // production guard added in Phase 1.
  let emittingPauseChange = false;

  const plugins = new Map<string, unknown>();

  // ── SimLoop tick registry ────────────────────────────────────────────────
  // Map<TickStage, TickEntry[]> — entries kept insertion-ordered, sorted by
  // `order` (ascending) at tick time. Array.sort is stable since ES2019.
  const tickRegistry = new Map<TickStage, TickEntry[]>([
    [TickStage.PRE, []],
    [TickStage.SIM, []],
    [TickStage.POST, []],
  ]);

  const simLoop = {
    onTick(stage: TickStage, callback: (dt: number) => void, order: number = 100): () => void {
      const entry: TickEntry = { cb: callback, order, id: ++_entryIdCounter };
      tickRegistry.get(stage)!.push(entry);
      return () => {
        const list = tickRegistry.get(stage)!;
        const idx = list.findIndex(e => e.id === entry.id);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  };

  // Mutable signalStore reference (controlled by _setSignalStore)
  let currentSignalStore: TestSignalStore | null = initialSignalStore;

  const viewer: TestViewer = {
    _pauseReasons: pauseReasons,
    get isSimulationPaused(): boolean { return pauseReasons.size > 0; },
    get simulationPauseReasons(): readonly string[] { return [...pauseReasons]; },
    setSimulationPaused(reason: string, paused: boolean): void {
      const was = pauseReasons.size > 0;
      if (paused) pauseReasons.add(reason);
      else pauseReasons.delete(reason);
      const now = pauseReasons.size > 0;
      if (was !== now) {
        if (emittingPauseChange) return;
        emittingPauseChange = true;
        try {
          emitter.emit('simulation-pause-changed', {
            paused: now,
            reasons: [...pauseReasons],
            reason,
          });
        } finally {
          emittingPauseChange = false;
        }
      }
    },
    clearPauseReasons(reason?: string): void {
      if (!pauseReasons.size) return;
      const was = pauseReasons.size > 0;
      if (reason) {
        pauseReasons.delete(reason);
      } else {
        pauseReasons.clear();
      }
      const now = pauseReasons.size > 0;
      if (was !== now) {
        if (emittingPauseChange) return;
        emittingPauseChange = true;
        try {
          emitter.emit('simulation-pause-changed', {
            paused: now,
            reasons: [...pauseReasons],
            reason: reason ?? '*',
          });
        } finally {
          emittingPauseChange = false;
        }
      }
    },
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    transportManager,
    logicEngine,
    get signalStore(): TestSignalStore | null { return currentSignalStore; },
    signalReapply: new SignalReapplyRegistry(),
    resetSimulation(): void {
      // Mirror RVViewer.resetSimulation()'s three-phase orchestration (minus the
      // statisticsManager the mock doesn't carry): RESET → engine clear →
      // RESETSTAT → START, so event-ordering assertions match production.
      emitter.emit('simulation-reset', undefined);
      for (const d of viewer.drives) (d as { reset?(): void }).reset?.();
      transportManager.reset();
      logicEngine.reset();
      emitter.emit('simulation-resetstat', undefined);
      emitter.emit('simulation-start', undefined);
      // plan-427: last step, AFTER the start subscribers — same position as in
      // RVViewer, so ordering assertions carry over.
      viewer.signalReapply.reapplyAll();
    },
    _plugins: plugins,
    getPlugin<T = unknown>(id: string): T | undefined {
      return plugins.get(id) as T | undefined;
    },
    use(plugin: { id: string }): TestViewer {
      plugins.set(plugin.id, plugin);
      return viewer;
    },

    // ── Phase 0 additions ────────────────────────────────────────────────
    drives: [],
    registry: nodeRegistry,
    _pluginContext: null,
    simLoop,

    _tickOnce(dt: number): void {
      // Iterate stages in ascending TickStage value order: PRE(0) → SIM(1) → POST(2)
      const stages: TickStage[] = [TickStage.PRE, TickStage.SIM, TickStage.POST];
      for (const stage of stages) {
        // Defensive snapshot — callbacks added during a tick are NOT called in the same tick
        const snapshot = (tickRegistry.get(stage) ?? []).slice();
        // Stable sort by ascending order (Array.sort is stable since ES2019 / V8 7.0)
        snapshot.sort((a, b) => a.order - b.order);
        for (const entry of snapshot) {
          entry.cb(dt);
        }
      }
    },

    _setSignalStore(store: TestSignalStore | null): void {
      currentSignalStore = store;
    },

    removePlugin(id: string): boolean {
      return plugins.delete(id);
    },
  };

  // Register withPlugin at the very end (after viewer is constructed)
  if (options.withPlugin) {
    viewer.use(options.withPlugin);
  }

  return viewer;
}

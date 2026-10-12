// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-mode.ts — Simulation / PLC mode of a model (plan-539 F15 / F15b).
 *
 * The viewer's global connection state gates every logic root with
 * `Active: Connected / Disconnected` (plan-538). It defaults to `Connected`
 * (Unity "Connected mode" parity), so a virtual PLC (`Active: Disconnected`)
 * never ran in a plain viewer. A model now says how it starts:
 *
 *  - **`ConnectionMode` component** (one per model, on a dedicated node) with
 *    `StartMode: 'Simulation' | 'PLC'`. `Simulation` → `Disconnected` (the
 *    virtual PLC runs), `PLC` → `Connected`. Absent → Simulation: a model
 *    without the component starts with its virtual PLC running; a real PLC
 *    still takes over on its first write (below).
 *  - **{@link ConnectionModeController}** — owned by the viewer. Applies the
 *    start mode at load (before the logic starts), switches on demand (the
 *    Simulation / PLC toggle, `web_sim_mode`) and writes `StartMode` back into
 *    the document so the next save keeps it.
 *
 * **Interface takeover (F15b).** A connected interface alone changes nothing
 * — CONNECT may carry an unrelated test interface. An interface TAKES OVER
 * (mode "PLC (interface)", toggle locked) only from its first write of a value
 * to one of the MODEL's PLC output signals (`PLCOutputBool/Float/Int` nodes of
 * the loaded model, `SIM_*` helpers excluded). The takeover switches the logic
 * BEFORE that batch reaches the store (via the host), so the plan-538
 * deactivation of the virtual PLC cannot overwrite what the PLC just wrote.
 * Released on the interface's disconnect, or when its discovered signals no
 * longer contain any model output → back to the saved `StartMode`.
 *
 * Engine layer: no viewer import — the controller talks to a narrow host.
 * Named "Simulation / PLC" on purpose: the workspace mode "Commissioning" is
 * something else.
 */

import type { Object3D } from 'three';
import type { ComponentSchema, RVComponent } from './rv-component-registry';
import { loadSchemaFromSpec, registerComponent, setComponentInstance } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';

/** Component type key. */
export const CONNECTION_MODE_TYPE = 'ConnectionMode';

/** The two start modes a model can declare. */
export type ConnectionStartMode = 'Simulation' | 'PLC';

/**
 * Where the current mode comes from:
 *  - `default`   — no component, viewer default (connected);
 *  - `model`     — the model's `StartMode`;
 *  - `toggle`    — switched by the user / an agent since the load;
 *  - `interface` — a live interface took over (it writes model outputs; locked).
 */
export type ConnectionModeSource = 'default' | 'model' | 'toggle' | 'interface';

/** Snapshot of the mode for UI / MCP. */
export interface ConnectionModeState {
  /** Effective mode: `Simulation` while disconnected, else `PLC`. */
  mode: ConnectionStartMode;
  source: ConnectionModeSource;
  /** True while an interface has taken over (the toggle is locked). */
  locked: boolean;
  /** True when an interface took over (it writes model PLC outputs). */
  takeover: boolean;
  /** True while at least one live interface is connected (taken over or not). */
  interfaceConnected: boolean;
  /** `StartMode` stored in the model, or null without a component. */
  startMode: ConnectionStartMode | null;
  /** Hierarchy path of the component node, or null. */
  componentPath: string | null;
}

/** Label shown in the button for a mode state (plan-539 F15 / F15b). */
export function connectionModeLabel(
  state: Pick<ConnectionModeState, 'mode' | 'source'> & Partial<Pick<ConnectionModeState, 'interfaceConnected'>>,
): string {
  if (state.source === 'interface') return 'PLC (interface)';
  const base = state.mode === 'Simulation' ? 'Simulation' : 'PLC';
  // F15b: connected, but the interface does not write any model output (yet).
  return state.interfaceConnected ? `${base} · interface connected` : base;
}

/** Normalise any authored value; unknown → `Simulation` (the schema default). */
export function parseStartMode(raw: unknown): ConnectionStartMode {
  return raw === 'PLC' ? 'PLC' : 'Simulation';
}

/** The scene-level component (pure data). */
export class RVConnectionMode implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(CONNECTION_MODE_TYPE);

  readonly node: Object3D;
  isOwner = true;
  StartMode: ConnectionStartMode = 'Simulation';

  constructor(node: Object3D) {
    this.node = node;
  }

  init(): void {
    this.StartMode = parseStartMode(this.StartMode);
  }
}

registerComponent({
  type: CONNECTION_MODE_TYPE,
  displayName: 'Connection Mode',
  schema: RVConnectionMode.schema,
  capabilities: { authorable: true, ui: { badge: '#26a69a' } },
  create: (node) => new RVConnectionMode(node),
  afterCreate: (instance, node) => setComponentInstance(node, instance),
});

/** What the controller needs from the viewer. */
export interface ConnectionModeHost {
  readonly connectionState: 'Connected' | 'Disconnected';
  setConnectionState(state: 'Connected' | 'Disconnected'): void;
  /**
   * Apply the connection state to the logic NOW (plan-538 transitions), not on
   * the next tick — used on an interface takeover so the virtual PLC is off
   * before the interface's batch is written (F15b). Optional.
   */
  syncLogicConnection?(): void;
}

/**
 * Persists a `StartMode` change into the active document (the viewer routes it
 * through the edit target, so the next save keeps it). Returns true when the
 * change landed in a document.
 */
export type ConnectionModeWriter = (
  nodePath: string, value: ConnectionStartMode, prev: ConnectionStartMode,
) => boolean;

const stateFor = (mode: ConnectionStartMode): 'Connected' | 'Disconnected' =>
  (mode === 'Simulation' ? 'Disconnected' : 'Connected');

/** Signal types whose nodes are model PLC outputs (F15b). */
const OUTPUT_TYPES = ['PLCOutputBool', 'PLCOutputFloat', 'PLCOutputInt'] as const;

/** Per connected interface. */
interface InterfaceEntry { takeover: boolean }

/** Owns the Simulation / PLC mode of the loaded model. */
export class ConnectionModeController {
  private _component: RVConnectionMode | null = null;
  private _componentPath: string | null = null;
  private _source: Exclude<ConnectionModeSource, 'interface'> = 'default';
  private readonly _interfaces = new Map<string, InterfaceEntry>();
  /** Names of the loaded model's PLC output signals (SIM_* excluded). */
  private _modelOutputs = new Set<string>();
  private readonly _listeners = new Set<() => void>();

  constructor(
    private readonly host: ConnectionModeHost,
    private readonly writer: ConnectionModeWriter | null = null,
  ) {}

  /** True while an interface has taken over. */
  get takenOver(): boolean {
    for (const e of this._interfaces.values()) if (e.takeover) return true;
    return false;
  }

  /** Current state (UI, MCP). */
  get state(): ConnectionModeState {
    const takeover = this.takenOver;
    return {
      mode: this.host.connectionState === 'Disconnected' ? 'Simulation' : 'PLC',
      source: takeover ? 'interface' : this._source,
      locked: takeover,
      takeover,
      interfaceConnected: this._interfaces.size > 0,
      startMode: this._component ? parseStartMode(this._component.StartMode) : null,
      componentPath: this._componentPath,
    };
  }

  /** The model output names a takeover is judged by (tests / tooling). */
  get modelOutputs(): ReadonlySet<string> { return this._modelOutputs; }

  /** Subscribe to mode changes; returns the unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  /**
   * Apply the model's start mode — called by the viewer at load, BEFORE the
   * logic starts, with the first `ConnectionMode` of the model (or null) and
   * the model's PLC output names. An interface that took over keeps the state
   * connected. Without a component the model starts in Simulation.
   */
  attach(component: RVConnectionMode | null, modelOutputs: Iterable<string> = []): void {
    this._component = component;
    this._componentPath = component ? NodeRegistry.computeNodePath(component.node) : null;
    this._source = component ? 'model' : 'default';
    this._modelOutputs = new Set([...modelOutputs].filter((n) => !n.startsWith('SIM_')));
    if (!this.takenOver) {
      // Without a component the model starts in Simulation: a plain viewer has no PLC,
      // and a real one still takes over on its first write (F15b).
      this.host.setConnectionState(component ? stateFor(parseStartMode(component.StartMode)) : 'Disconnected');
    }
    this._notify();
  }

  /** Find the first `ConnectionMode` in a registry (the model's). */
  static find(registry: NodeRegistry | null | undefined): RVConnectionMode | null {
    if (!registry) return null;
    const all = registry.getAll<RVConnectionMode>(CONNECTION_MODE_TYPE);
    return all.length > 0 ? all[0].instance : null;
  }

  /** Names of the model's PLC output signal nodes in a registry (F15b). */
  static outputNames(registry: NodeRegistry | null | undefined): string[] {
    if (!registry) return [];
    const names: string[] = [];
    for (const type of OUTPUT_TYPES) {
      for (const { instance } of registry.getAll<{ signalName?: string }>(type)) {
        if (instance?.signalName) names.push(instance.signalName);
      }
    }
    return names;
  }

  /**
   * Switch the mode (toggle, `web_sim_mode`). Refused while an interface has
   * taken over. Writes `StartMode` into the model's component (and through the
   * writer into the document) so the next save keeps it.
   * @returns the new state plus whether it was persisted, or an error text.
   */
  setMode(mode: ConnectionStartMode): (ConnectionModeState & { persisted: boolean }) | { error: string } {
    if (this.takenOver) {
      return { error: 'A live PLC interface writes the model outputs — the mode follows the interface (PLC). Disconnect it to switch.' };
    }
    this.host.setConnectionState(stateFor(mode));
    this._source = 'toggle';
    let persisted = false;
    const component = this._component;
    if (component) {
      const prev = parseStartMode(component.StartMode);
      component.StartMode = mode;
      const rv = (component.node.userData.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
      (rv[CONNECTION_MODE_TYPE] ??= {}).StartMode = mode;
      if (prev !== mode && this.writer && this._componentPath) {
        persisted = this.writer(this._componentPath, mode, prev);
      } else {
        persisted = prev === mode;
      }
    }
    this._notify();
    return { ...this.state, persisted };
  }

  /** A live industrial interface connected — no mode change by itself (F15b). */
  interfaceConnected(id = 'default'): void {
    if (this._interfaces.has(id)) return;
    this._interfaces.set(id, { takeover: false });
    this._notify();
  }

  /**
   * The interface is about to write these signals into the store. The first
   * write to a model PLC output takes over: state connected, logic switched
   * NOW (before the write lands), toggle locked.
   * @returns true when this call took over.
   */
  interfaceWrites(id: string, names: Iterable<string>): boolean {
    let entry = this._interfaces.get(id);
    if (entry?.takeover) return false;
    let hit = false;
    for (const n of names) {
      if (this._modelOutputs.has(n)) { hit = true; break; }
    }
    if (!hit) return false;
    if (!entry) {
      entry = { takeover: false };
      this._interfaces.set(id, entry);
    }
    entry.takeover = true;
    this.host.setConnectionState('Connected');
    this.host.syncLogicConnection?.();
    this._notify();
    return true;
  }

  /**
   * The interface's signal set changed (discovery): when it no longer contains
   * any model output, a takeover is released (F15b).
   */
  interfaceSources(id: string, names: Iterable<string>): void {
    const entry = this._interfaces.get(id);
    if (!entry?.takeover) return;
    for (const n of names) if (this._modelOutputs.has(n)) return;
    entry.takeover = false;
    this._release();
  }

  /**
   * A live interface disconnected. If it had taken over, the state returns to
   * the saved `StartMode` (without a component: `Disconnected`, the behaviour
   * before plan-539).
   */
  interfaceDisconnected(id = 'default'): void {
    const entry = this._interfaces.get(id);
    if (!entry) return;
    this._interfaces.delete(id);
    if (entry.takeover) this._release();
    else this._notify();
  }

  /** Back to the saved mode once no interface holds a takeover. */
  private _release(): void {
    if (!this.takenOver) {
      const component = this._component;
      if (component) {
        this._source = 'model';
        this.host.setConnectionState(stateFor(parseStartMode(component.StartMode)));
      } else {
        this._source = 'default';
        this.host.setConnectionState('Disconnected');
      }
      this.host.syncLogicConnection?.();
    }
    this._notify();
  }

  private _notify(): void {
    for (const cb of this._listeners) {
      try { cb(); } catch (e) { console.error('[ConnectionMode] listener failed:', e); }
    }
  }
}

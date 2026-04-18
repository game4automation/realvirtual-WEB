// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVWebSensor — TypeScript counterpart of Unity `WebSensor.cs`.
 *
 * State machine driven by either a PLCOutputBool (2-state: low/high) or a
 * PLCOutputInt (N-state via IntStateMap). Renders a state-colored gizmo
 * overlay (default: transparent-shell) + optional text label over the node.
 *
 * Single source of truth for visual styling: `WebSensorConfig`. Call
 * `initWebSensor(opts)` at startup (or in a model's index.ts) to override
 * Corporate-Design defaults.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance } from './rv-component-registry';
import type { GizmoHandle, GizmoShape } from './rv-gizmo-manager';

// ─── Types ─────────────────────────────────────────────────────────────

export type WebSensorState = 'low' | 'high' | 'warning' | 'error' | 'unbound';

export interface StateStyle {
  color: number;
  opacity: number;
  blinkHz: number;
}

// ─── Baked-in defaults (ISA-101 aligned) ────────────────────────────────

const BAKED_STATE_STYLES: Record<WebSensorState, StateStyle> = {
  // Hull material is always 'transparent: true' (forced in _buildMeshGlowHull),
  // so the blink loop can modulate opacity for active states.
  low:     { color: 0x808080, opacity: 0.85, blinkHz: 0 },
  high:    { color: 0x22cc44, opacity: 0.95, blinkHz: 0 },   // green
  warning: { color: 0xffaa00, opacity: 0.95, blinkHz: 1 },   // 1 Hz blink
  error:   { color: 0xff2020, opacity: 0.95, blinkHz: 2 },   // 2 Hz blink
  unbound: { color: 0x404040, opacity: 0.60, blinkHz: 0 },
};

/** Emissive intensity per state — non-zero values trigger UnrealBloomPass glow. */
const STATE_EMISSIVE: Record<WebSensorState, number> = {
  low:     0,    // flat MeshBasic, no glow
  high:    1.5,  // moderate glow
  warning: 2.5,  // strong glow
  error:   3.5,  // very strong glow
  unbound: 0,
};

const BAKED_INT_STATE_MAP: ReadonlyMap<number, WebSensorState> = new Map<number, WebSensorState>([
  [0, 'low'],
  [1, 'high'],
  [2, 'warning'],
  [3, 'error'],
]);

// Use an inverted-hull outline of the actual sensor mesh: solid colored "shell"
// slightly larger than the real geometry, so the sensor body is highlighted in
// its state color from any angle. No abstract sphere — the user sees the real
// CAD geometry with a colored outline.
const BAKED_SHAPE: GizmoShape = 'mesh-glow-hull';
const BAKED_SIZE = 1.0;
// Sensors without a bound signal automatically pick a random state so the scene
// is visually meaningful out of the box. Override via initWebSensor({ randomDemoStates: false }).
const BAKED_RANDOM_DEMO = true;

// ─── Mutable module state (override via initWebSensor) ──────────────────

export const WebSensorConfig = {
  stateStyles: { ...BAKED_STATE_STYLES } as Record<WebSensorState, StateStyle>,
  defaultIntStateMap: new Map(BAKED_INT_STATE_MAP) as Map<number, WebSensorState>,
  defaultShape: BAKED_SHAPE as GizmoShape,
  defaultSize: BAKED_SIZE,
  /** Demo: when true, sensors without a bound signal pick a random state at init
   *  (one of low/high/warning/error). Default false → unbound (neutral grey). */
  randomDemoStates: BAKED_RANDOM_DEMO,
};

// ─── Module-local warn-once set (F22 — no external warnOnce util) ──────

const _warnedSignals = new Set<string>();
function warnOnceForSignal(key: string, msg: string): void {
  if (_warnedSignals.has(key)) return;
  _warnedSignals.add(key);
  console.warn(`[WebSensor] ${msg}`);
}
/** Test-only reset of warn-once state. */
export function __resetWarnedSignals(): void {
  _warnedSignals.clear();
}

// ─── initWebSensor() API ────────────────────────────────────────────────

export interface WebSensorInitOptions {
  defaultIntStateMap?: Map<number, WebSensorState> | Record<number, WebSensorState>;
  stateStyles?: Partial<Record<WebSensorState, Partial<StateStyle>>>;
  defaultShape?: GizmoShape;
  defaultSize?: number;
  randomDemoStates?: boolean;
}

export function initWebSensor(opts: WebSensorInitOptions): void {
  if (opts.defaultIntStateMap) {
    WebSensorConfig.defaultIntStateMap =
      opts.defaultIntStateMap instanceof Map
        ? new Map(opts.defaultIntStateMap)
        : new Map(Object.entries(opts.defaultIntStateMap).map(([k, v]) => [Number(k), v]));
  }
  if (opts.stateStyles) {
    for (const s of Object.keys(opts.stateStyles) as WebSensorState[]) {
      const override = opts.stateStyles[s];
      if (override) {
        WebSensorConfig.stateStyles[s] = { ...WebSensorConfig.stateStyles[s], ...override };
      }
    }
  }
  if (opts.defaultShape) WebSensorConfig.defaultShape = opts.defaultShape;
  if (opts.defaultSize !== undefined) WebSensorConfig.defaultSize = opts.defaultSize;
  if (opts.randomDemoStates !== undefined) WebSensorConfig.randomDemoStates = opts.randomDemoStates;
}

export function resetWebSensorConfig(): void {
  WebSensorConfig.stateStyles        = { ...BAKED_STATE_STYLES };
  WebSensorConfig.defaultIntStateMap = new Map(BAKED_INT_STATE_MAP);
  WebSensorConfig.defaultShape       = BAKED_SHAPE;
  WebSensorConfig.defaultSize        = BAKED_SIZE;
  WebSensorConfig.randomDemoStates   = BAKED_RANDOM_DEMO;
}

// ─── IntStateMap parser ────────────────────────────────────────────────

const VALID_STATE_NAMES = new Set<WebSensorState>(['low', 'high', 'warning', 'error']);

/**
 * Parse `"0:low,1:high,2:warning,3:error"` → Map<int, state>.
 * Empty / fully-invalid input → WebSensorConfig.defaultIntStateMap clone.
 */
export function parseIntStateMap(raw: string): Map<number, WebSensorState> {
  if (!raw || !raw.trim()) return new Map(WebSensorConfig.defaultIntStateMap);
  const map = new Map<number, WebSensorState>();
  for (const pair of raw.split(',')) {
    const parts = pair.split(':').map(s => s?.trim().toLowerCase());
    const k = parts[0];
    const v = parts[1] as WebSensorState | undefined;
    const key = Number(k);
    if (!Number.isFinite(key) || !v || !VALID_STATE_NAMES.has(v)) continue;
    map.set(key, v);
  }
  if (map.size === 0) {
    console.warn(`[WebSensor] invalid IntStateMap "${raw}" — using defaults`);
    return new Map(WebSensorConfig.defaultIntStateMap);
  }
  return map;
}

// ─── RVWebSensor ────────────────────────────────────────────────────────

export class RVWebSensor implements RVComponent {
  static readonly schema: ComponentSchema = {
    SignalBool:  { type: 'componentRef' },
    SignalInt:   { type: 'componentRef' },
    IntStateMap: { type: 'string', default: '' },
    Label:       { type: 'string', default: '' },
  };

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated
  SignalBool: string | null = null;
  SignalInt: string | null = null;
  IntStateMap = '';
  Label = '';

  private _gizmo?: GizmoHandle;
  private _labelGizmo?: GizmoHandle;
  private _unsubscribe?: () => void;
  private _state: WebSensorState = 'low';
  private _intMap?: Map<number, WebSensorState>;
  private _warnedInts = new Set<number>();

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) {
      console.error('[WebSensor] gizmoManager missing in ComponentContext — skipping');
      return;
    }

    // Tag the node so the Panel and event dispatcher can find it
    this.node.userData._rvType = 'WebSensor';
    this.node.userData._rvTag = 'sensor';
    // Non-enumerable for the back-references (component → node → userData → component
    // would crash Three.js Object3D.clone() which JSON round-trips userData).
    Object.defineProperty(this.node.userData, '_rvWebSensor', {
      value: this, writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(this.node.userData, '_rvComponentInstance', {
      value: this, writable: true, configurable: true, enumerable: false,
    });

    const initialStyle = WebSensorConfig.stateStyles.low;
    this._gizmo = ctx.gizmoManager.create(this.node, {
      shape:   WebSensorConfig.defaultShape,
      color:   initialStyle.color,
      opacity: initialStyle.opacity,
      blinkHz: initialStyle.blinkHz,
      size:    WebSensorConfig.defaultSize,
      // Wider outline so small sensor bodies (~4 cm) are visible from far.
      outlineScale: 2.0,
    });
    // Note: GizmoOverlayManager auto-registers the sphere as an auxiliary
    // raycast target (resolving to this.node) when constructed with a
    // raycastManager — see GizmoOverlayManager constructor JSDoc.

    // Small text gizmo with the sensor ID — HIDDEN by default in the normal busy
    // scene; toggled on via setLabelVisible(true) only when sensor isolate-mode
    // is active (then labels help identify which sensor is which).
    if (this.Label) {
      this._labelGizmo = ctx.gizmoManager.create(this.node, {
        shape: 'text',
        text: this.Label,
        color: 0xffffff,
        opacity: 1.0,
        size: 0.15,   // small enough to not dominate the scene
        visible: false,
      });
    }

    // Warn if both bound — Int wins per spec
    if (this.SignalInt && this.SignalBool) {
      console.warn('[WebSensor] both SignalBool and SignalInt bound — using SignalInt');
    }

    if (this.SignalInt) {
      this._intMap = parseIntStateMap(this.IntStateMap);
      this._unsubscribe = ctx.signalStore.subscribeByPath(
        this.SignalInt,
        (v) => this._onIntChange(Number(v)),
      );
      const current = ctx.signalStore.getByPath(this.SignalInt);
      if (current !== undefined) this._onIntChange(Number(current));
    } else if (this.SignalBool) {
      this._unsubscribe = ctx.signalStore.subscribeByPath(
        this.SignalBool,
        (v) => this._onBoolChange(!!v),
      );
      const current = ctx.signalStore.getByPath(this.SignalBool);
      if (current !== undefined) this._onBoolChange(!!current);
    } else if (WebSensorConfig.randomDemoStates) {
      // Demo mode: assign a random state instead of 'unbound'.
      // State is stable per-sensor for the session (does not change).
      const states: WebSensorState[] = ['low', 'high', 'warning', 'error'];
      this._applyState(states[Math.floor(Math.random() * states.length)]);
    } else {
      this._applyState('unbound');
      warnOnceForSignal(this.Label || '(WebSensor)', 'no signal bound');
    }
  }

  private _onBoolChange(v: boolean): void {
    this._applyState(v ? 'high' : 'low');
  }

  private _onIntChange(v: number): void {
    const mapped = this._intMap?.get(v);
    if (mapped) {
      this._applyState(mapped);
    } else {
      if (!this._warnedInts.has(v)) {
        this._warnedInts.add(v);
        console.warn(`[WebSensor] int value ${v} not in IntStateMap — using 'low'`);
      }
      this._applyState('low');
    }
  }

  private _applyState(s: WebSensorState): void {
    if (s === this._state) return;
    this._state = s;
    const st = WebSensorConfig.stateStyles[s];
    // Glow via emissive intensity → picked up by UnrealBloomPass for bright states.
    // STATE_EMISSIVE: low/unbound = 0 (flat MeshBasic), active states 1.5-3.5 (bloom).
    this._gizmo?.update({
      color: st.color,
      opacity: st.opacity,
      blinkHz: st.blinkHz,
      emissiveIntensity: STATE_EMISSIVE[s],
    });
  }

  getCurrentState(): WebSensorState {
    return this._state;
  }

  /** Show/hide the small ID text gizmo above the sensor.
   *  Used by WebSensorPlugin to clear labels when sensors are isolated. */
  setLabelVisible(visible: boolean): void {
    this._labelGizmo?.setVisible(visible);
  }

  // ── Component event callbacks (F32/F33) ────────────────────────────────

  onHover(hovered: boolean): void {
    // Size-bump feedback on the state gizmo. Guarded for defaultSize=0.
    if (!this._gizmo) return;
    const base = WebSensorConfig.defaultSize;
    if (base <= 0) return;
    this._gizmo.update({ size: hovered ? base * 1.15 : base });
  }

  onClick(_event: { path: string; node: Object3D }): void {
    // Hook for plugins/subclasses. No-op by default.
  }

  onSelect(_selected: boolean): void {
    // Hook for plugins/subclasses. No-op by default.
  }

  dispose(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    // Aux raycast targets are auto-unregistered by GizmoOverlayManager.dispose().
    this._gizmo?.dispose();
    this._gizmo = undefined;
    this._labelGizmo?.dispose();
    this._labelGizmo = undefined;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'WebSensor',
  // Display as a regular Sensor in the hierarchy badge.
  displayName: 'Sensor',
  schema: RVWebSensor.schema,
  capabilities: {
    hoverable: true,
    hoverEnabledByDefault: true,   // ← enable hover/click out of the box
    selectable: true,
    // The "Web Sensors" filterLabel is kept for the dedicated SensorToolPanel + future filters.
    filterLabel: 'Web Sensors',
    badgeColor: '#66bb6a',   // matches BADGE_COLORS.Sensor (green)
    tooltipType: 'web-sensor',
  },
  create: (node) => new RVWebSensor(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'WebSensor';
    node.userData._rvTag = 'sensor';
    // Non-enumerable — JSON.stringify-safe (see rv-component-registry.ts)
    Object.defineProperty(node.userData, '_rvComponentInstance', {
      value: inst, writable: true, configurable: true, enumerable: false,
    });
    node.userData._rvComponentInstance = inst;
    setComponentInstance(node, inst);
  },
});

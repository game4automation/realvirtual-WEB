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
import { registerComponent } from './rv-component-registry';
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
  low:     { color: 0x808080, opacity: 0.35, blinkHz: 0 },
  high:    { color: 0x3080ff, opacity: 0.55, blinkHz: 0 },
  warning: { color: 0xffaa00, opacity: 0.70, blinkHz: 1 },
  error:   { color: 0xff2020, opacity: 0.85, blinkHz: 2 },
  unbound: { color: 0x404040, opacity: 0.20, blinkHz: 0 },
};

const BAKED_INT_STATE_MAP: ReadonlyMap<number, WebSensorState> = new Map<number, WebSensorState>([
  [0, 'low'],
  [1, 'high'],
  [2, 'warning'],
  [3, 'error'],
]);

const BAKED_SHAPE: GizmoShape = 'transparent-shell';
const BAKED_SIZE = 1.0;

// ─── Mutable module state (override via initWebSensor) ──────────────────

export const WebSensorConfig = {
  stateStyles: { ...BAKED_STATE_STYLES } as Record<WebSensorState, StateStyle>,
  defaultIntStateMap: new Map(BAKED_INT_STATE_MAP) as Map<number, WebSensorState>,
  defaultShape: BAKED_SHAPE as GizmoShape,
  defaultSize: BAKED_SIZE,
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
}

export function resetWebSensorConfig(): void {
  WebSensorConfig.stateStyles        = { ...BAKED_STATE_STYLES };
  WebSensorConfig.defaultIntStateMap = new Map(BAKED_INT_STATE_MAP);
  WebSensorConfig.defaultShape       = BAKED_SHAPE;
  WebSensorConfig.defaultSize        = BAKED_SIZE;
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
  private _textGizmo?: GizmoHandle;
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
    this.node.userData._rvWebSensor = this;
    this.node.userData._rvComponentInstance = this;

    const initialStyle = WebSensorConfig.stateStyles.low;
    this._gizmo = ctx.gizmoManager.create(this.node, {
      shape:   WebSensorConfig.defaultShape,
      color:   initialStyle.color,
      opacity: initialStyle.opacity,
      blinkHz: initialStyle.blinkHz,
      size:    WebSensorConfig.defaultSize,
    });

    if (this.Label) {
      this._textGizmo = ctx.gizmoManager.create(this.node, {
        shape: 'text',
        text: this.Label,
        color: initialStyle.color,
        opacity: 1.0,
        blinkHz: 0,
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
    this._gizmo?.update({ color: st.color, opacity: st.opacity, blinkHz: st.blinkHz });
    // Text label color follows state, but no blink
    this._textGizmo?.update({ color: st.color });
  }

  getCurrentState(): WebSensorState {
    return this._state;
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
    this._gizmo?.dispose();
    this._gizmo = undefined;
    this._textGizmo?.dispose();
    this._textGizmo = undefined;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'WebSensor',
  schema: RVWebSensor.schema,
  capabilities: {
    hoverable: true,
    selectable: true,
    filterLabel: 'Web Sensors',
    badgeColor: '#3080ff',
  },
  create: (node) => new RVWebSensor(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'WebSensor';
    node.userData._rvTag = 'sensor';
    node.userData._rvComponentInstance = inst;
  },
});

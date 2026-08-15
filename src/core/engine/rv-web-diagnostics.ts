// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVWebDiagnostics — TypeScript counterpart of Unity `WebDiagnostics.cs`
 * (plan-253). 3D-HMI marker that couples a PLC error signal to the AI error
 * diagnosis: a rising edge of `SignalBool` (or a non-zero edge of `SignalInt`)
 * emits a `diagnose-request` viewer event; the falling edge emits the same
 * event with `errorActive: false` so the diagnose plugin cleans up (F11).
 *
 * LAYERING: this engine component NEVER imports a diagnosis provider or plugin
 * code — it only emits on `ctx.events` (precedent: rv-safety-door.ts). The
 * WebDiagnosticsPlugin (private tier) subscribes and performs the backend call.
 *
 * Trigger hardening (F10):
 * - Leading-edge debounce (1 s window): the first edge fires immediately;
 *   flutter inside the window is suppressed (a trailing debounce would emit
 *   ZERO events on continuous flutter).
 * - Edge detection only — an unchanged value never re-fires.
 * - Path timing: subscription happens in init() AND is re-established in
 *   onSceneReady() (signal node may come after the marker node in the GLB —
 *   `subscribeByPath` before `buildIndex` would be a silent no-op).
 *
 * Unlike WebSensor there is NO random-demo fallback: without a bound signal
 * the component stays inactive (warn-once).
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { createLeadingEdgeDebounce, type LeadingEdgeDebounce } from '../../plugins/diagnose/debounce';
import { wireValueSignal } from './rv-signal-wiring';

/** Suppression window for the leading-edge debounce (ms). */
export const DIAGNOSE_DEBOUNCE_MS = 1000;

// Module-local warn-once set (mirrors rv-web-sensor.ts — no external util).
const _warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`[WebDiagnostics] ${msg}`);
}
/** Test-only reset of warn-once state. */
export function __resetWebDiagnosticsWarnings(): void {
  _warned.clear();
}

export class RVWebDiagnostics implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('WebDiagnostics');

  readonly node: Object3D;
  readonly path: string;
  isOwner = true;

  // Schema-populated
  SignalBool: string | null = null;
  SignalInt: string | null = null;
  DocFilter = '';
  ErrorId = '';
  Label = '';
  AutoOpen = true;

  private _ctx?: ComponentContext;
  private _unsubscribe?: () => void;
  private _debounce: LeadingEdgeDebounce = createLeadingEdgeDebounce(DIAGNOSE_DEBOUNCE_MS);
  /** Last seen bool level (edge detection). */
  private _lastBool = false;
  /** Last seen int value (edge detection; 0 = no error). */
  private _lastInt = 0;

  constructor(node: Object3D) {
    this.node = node;
    this.path = NodeRegistry.computeNodePath(node);
  }

  init(ctx: ComponentContext): void {
    this._ctx = ctx;

    this.node.userData._rvType = 'WebDiagnostics';
    // Non-enumerable back-reference (JSON.stringify/clone-safe, see WebSensor).
    Object.defineProperty(this.node.userData, '_rvComponentInstance', {
      value: this, writable: true, configurable: true, enumerable: false,
    });

    if (this.SignalInt && this.SignalBool) {
      warnOnce(this.path, `both SignalBool and SignalInt bound on '${this.path}' — using SignalInt`);
    }
    if (!this.SignalInt && !this.SignalBool) {
      // Inactive without a signal — NO random-demo fallback (unlike WebSensor).
      warnOnce(this.path, `no signal bound on '${this.path}' — diagnosis trigger inactive`);
      return;
    }

    this._subscribe(ctx);
  }

  /** Re-subscribe after the full scene is built: a signal node located AFTER
   *  the marker node in the GLB makes the init()-time subscribeByPath a silent
   *  no-op (plan-253 §2.5). Edge state is preserved, so no double-fire. */
  onSceneReady(ctx: ComponentContext): void {
    this._ctx = ctx;
    if (!this.SignalInt && !this.SignalBool) return;
    this._subscribe(ctx);
  }

  private _subscribe(ctx: ComponentContext): void {
    this._unsubscribe?.();
    // Int wins over Bool — the two slots are ALTERNATIVES, never both live, so
    // the single `_unsubscribe` handle always holds the one active wiring.
    // plan-427: both go through the helper, which registers a re-apply slot and
    // skips an unresolved path (the `current !== undefined` guard this
    // replaces). `_onIntChange`/`_onBoolChange` are explicit edge guards, so a
    // replay of an unchanged value fires no diagnose request.
    if (this.SignalInt) {
      this._unsubscribe = wireValueSignal(ctx.signalStore, this.SignalInt,
        (v) => this._onIntChange(Number(v)), undefined, ctx.reapply).unsubscribe;
    } else if (this.SignalBool) {
      this._unsubscribe = wireValueSignal(ctx.signalStore, this.SignalBool,
        (v) => this._onBoolChange(!!v), undefined, ctx.reapply).unsubscribe;
    }
  }

  private _onBoolChange(high: boolean): void {
    if (high === this._lastBool) return;
    this._lastBool = high;
    if (high) this._fireRisingEdge(undefined);
    else this._fireFallingEdge();
  }

  private _onIntChange(value: number): void {
    if (!Number.isFinite(value) || value === this._lastInt) return;
    const previous = this._lastInt;
    this._lastInt = value;
    if (value !== 0) {
      // Entering an error state OR switching to a new error code — both fire.
      this._fireRisingEdge(value);
    } else if (previous !== 0) {
      this._fireFallingEdge();
    }
  }

  private _fireRisingEdge(errorCode: number | undefined): void {
    if (!this._debounce.shouldFire()) return;
    this._ctx?.events?.emit('diagnose-request', {
      nodePath: this.path,
      errorCode,
      errorActive: true,
      docFilter: this.DocFilter || undefined,
      errorId: this.ErrorId || this.path,
      label: this.Label || undefined,
      autoOpen: this.AutoOpen,
    });
  }

  /** Falling edge is NEVER debounced — cleanup must always reach the plugin. */
  private _fireFallingEdge(): void {
    this._ctx?.events?.emit('diagnose-request', {
      nodePath: this.path,
      errorActive: false,
      errorId: this.ErrorId || this.path,
    });
  }

  dispose(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._debounce.dispose();
    this._ctx = undefined;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'WebDiagnostics',
  displayName: 'Diagnostics',
  schema: RVWebDiagnostics.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    badgeColor: '#ef5350',   // error red — matches the diagnosis card accent
  },
  create: (node) => new RVWebDiagnostics(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'WebDiagnostics';
    Object.defineProperty(node.userData, '_rvComponentInstance', {
      value: inst, writable: true, configurable: true, enumerable: false,
    });
    setComponentInstance(node, inst);
  },
});

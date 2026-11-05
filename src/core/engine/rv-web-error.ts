// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVWebError — TypeScript counterpart of Unity `WebError.cs`.
 *
 * A semantic error marker: binds a PLCOutputBool error signal + a plain-text
 * message to a node. While the signal is high the part carries a steady red
 * X-ray overlay (the highlight pipeline's aux channel in ERROR_COLOR — the same
 * fill + edges / chunk-overlay look as hover and selection, no per-mesh hull
 * copies, chunk-aware on baked models), ONE alarm flash fires on the rising
 * edge (the pulsing OutlinePass flash channel — the same pulse the error card
 * click re-triggers), and the error is registered in the central ErrorStore
 * (which drives the right-side error panel — the error TEXT lives only there,
 * there is no world-space badge). Very small parts (Auto heuristic / `Circle`) keep
 * the floor-disk ring gizmo, because an overlay on a 5 cm part is invisible;
 * without a highlighter in the context (minimal viewers, tests) the legacy
 * mesh-glow-hull gizmo is used. No latching, no acknowledgement — the error
 * mirrors the signal 1:1.
 *
 * Component naming/Gizmo patterns mirror RVWebSensor; the error registry
 * (ErrorStore) is the only new building block.
 */

import { type Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import type { GizmoHandle } from './rv-gizmo-manager';
import { NodeRegistry } from './rv-node-registry';
import { wireDisplaySignal } from './rv-signal-wiring';
import {
  ERROR_COLOR,
  normalizeHighlightStyle,
  resolveUseRing,
  createErrorHighlightGizmo,
  type HighlightStyle,
} from './rv-error-visual';

// ─── RVWebError ──────────────────────────────────────────────────────────

export class RVWebError implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  // HighlightStyle stays enum-tolerant: the spec's enumMap accepts the C# enum
  // string ('Auto') OR the legacy int index ('0'), like HIGHLIGHT_STYLE_FIELD did.
  static readonly schema: ComponentSchema = loadSchemaFromSpec('WebError');

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated (exact C# Inspector field names)
  SignalError: string | null = null;
  ErrorText = '';
  HighlightStyle: HighlightStyle = 'Auto';

  /** Node path — the ErrorStore key. Cached once at init. */
  readonly path: string;

  private _highlightGizmo?: GizmoHandle;
  private _unsubscribe?: () => void;
  private _ctx?: ComponentContext;
  private _active = false;
  /** True while the highlighter's aux channel shows this error (so an inactive
   *  error never triggers an aux rebuild). */
  private _auxShown = false;
  /** Set in onSceneReady: the mark goes through the highlight pipeline
   *  (overlay + flash) rather than a gizmo. */
  private _useHighlighter = false;

  constructor(node: Object3D) {
    this.node = node;
    this.path = NodeRegistry.computeNodePath(node);
  }

  init(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) {
      console.error('[WebError] gizmoManager missing in ComponentContext — skipping');
      return;
    }
    this._ctx = ctx;

    // Defensive: if applySchema left an int (raw number bypasses the string-only
    // enumMap match), normalize it to the named style here.
    this.HighlightStyle = normalizeHighlightStyle(this.HighlightStyle);

    this.node.userData._rvType = 'WebError';
    Object.defineProperty(this.node.userData, '_rvComponentInstance', {
      value: this, writable: true, configurable: true, enumerable: false,
    });

    // Subscribe only when a signal is bound (no signal → never active).
    // plan-427: the helper adds a re-apply slot so an error level held across a
    // reset re-raises the highlight. The FIRST call only CAPTURES the level —
    // the gizmos do not exist until onSceneReady(), which applies it (that was
    // the point of the hand-written initial read this replaces).
    if (this.SignalError) {
      let deferInitial = true;
      this._unsubscribe = wireDisplaySignal(ctx.signalStore, this.SignalError, (v) => {
        if (deferInitial) { deferInitial = false; this._active = !!v; return; }
        this._onChange(!!v);
      }, undefined, ctx.reapply).unsubscribe;
      deferInitial = false;
    }
  }

  /** Gizmo creation deferred to onSceneReady so the subtree AABB is correct
   *  AFTER kinematic re-parenting (matches RVSafetyDoor). */
  onSceneReady(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) return;
    this._ctx = ctx;

    // ── 3D mark: highlight pipeline (steady red X-ray overlay + one flash on
    // activation) for normal-sized parts when a highlighter is available;
    // the floor-disk ring gizmo for very small parts; the legacy glow-hull
    // gizmo only without a highlighter (minimal viewers, tests).
    this._useHighlighter = !!ctx.highlighter && !resolveUseRing(this.node, this.HighlightStyle);
    if (!this._useHighlighter) {
      this._highlightGizmo = createErrorHighlightGizmo(ctx.gizmoManager, this.node, this.HighlightStyle);
    }

    // No world-space error-text badge (removed 2026-10-12): the text lives in
    // the error card of the message panel; in 3D the mark is the overlay alone.

    // Apply the captured initial state now that gizmos exist.
    this._applyActive(this._active);
  }

  /** Test/inspection helper retained for the existing rv-web-error tests. */
  private _resolveUseRing(): boolean {
    return resolveUseRing(this.node, this.HighlightStyle);
  }

  private _onChange(active: boolean): void {
    if (active === this._active) {
      // Re-affirm store text in case ErrorText changed at runtime (rare).
      if (active) this._ctx?.errorStore?.setActive(this.path, true, this.ErrorText);
      return;
    }
    this._active = active;
    this._applyActive(active);
  }

  private _applyActive(active: boolean): void {
    this._highlightGizmo?.setVisible(active);
    this._applyHighlighterMark(active);
    this._ctx?.errorStore?.setActive(this.path, active, this.ErrorText);
  }

  /** Aux-channel id of this error's overlay (one set per error node). */
  private get _auxId(): string {
    return `web-error:${this.path}`;
  }

  /** Steady red X-ray overlay while active (aux channel) + ONE alarm flash on
   *  the rising edge (flash channel — the same pulse the error card re-fires
   *  on click, so both read as one effect). */
  private _applyHighlighterMark(active: boolean): void {
    const hl = this._ctx?.highlighter;
    if (!hl || !this._useHighlighter) return;
    if (active) {
      hl.setAuxEmphasis(this._auxId, [this.node], { color: ERROR_COLOR });
      this._auxShown = true;
      hl.flash([this.node], { color: ERROR_COLOR });
    } else if (this._auxShown) {
      hl.setAuxEmphasis(this._auxId, null);
      this._auxShown = false;
    }
  }

  /** Current active state (test/inspection helper). */
  isActive(): boolean {
    return this._active;
  }

  dispose(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    if (this._auxShown) {
      this._ctx?.highlighter?.setAuxEmphasis(this._auxId, null);
      this._auxShown = false;
    }
    this._highlightGizmo?.dispose();
    this._highlightGizmo = undefined;
    this._ctx?.errorStore?.remove(this.path);
    this._active = false;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'WebError',
  displayName: 'Error',
  schema: RVWebError.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    pick: 'none',
    ui: { filter: 'Web Errors', category: 'hmi', badge: '#ef5350' },
  },
  create: (node) => new RVWebError(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'WebError';
    Object.defineProperty(node.userData, '_rvComponentInstance', {
      value: inst, writable: true, configurable: true, enumerable: false,
    });
    setComponentInstance(node, inst);
  },
});

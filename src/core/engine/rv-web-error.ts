// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVWebError — TypeScript counterpart of Unity `WebError.cs`.
 *
 * A semantic error marker: binds a PLCOutputBool error signal + a plain-text
 * message to a node. While the signal is high the part is highlighted in red
 * (mesh-glow-hull flash, or a floor-disk ring for very small parts), a backed
 * error-text badge appears above the part, and the error is registered in the
 * central ErrorStore (which drives the right-side error panel). No latching,
 * no acknowledgement — the error mirrors the signal 1:1.
 *
 * Component naming/Gizmo patterns mirror RVWebSensor; the error registry
 * (ErrorStore) is the only new building block.
 */

import { type Object3D, type Texture } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import type { GizmoHandle } from './rv-gizmo-manager';
import { NodeRegistry } from './rv-node-registry';
import {
  normalizeHighlightStyle,
  resolveUseRing,
  createErrorHighlightGizmo,
  createErrorBadgeGizmo,
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
  private _badgeGizmo?: GizmoHandle;
  private _badgeTexture?: Texture;
  private _unsubscribe?: () => void;
  private _ctx?: ComponentContext;
  private _active = false;

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
    if (this.SignalError) {
      this._unsubscribe = ctx.signalStore.subscribeByPath(
        this.SignalError,
        (v) => this._onChange(!!v),
      );
      // Note: initial state is applied in onSceneReady once the gizmos exist —
      // we still read it here to capture a value set before init (no race).
      const current = ctx.signalStore.getByPath(this.SignalError);
      if (current !== undefined) this._active = !!current;
    }
  }

  /** Gizmo creation deferred to onSceneReady so the subtree AABB is correct
   *  AFTER kinematic re-parenting (matches RVSafetyDoor). */
  onSceneReady(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) return;
    this._ctx = ctx;

    // ── 3D highlight gizmo (red flash / floor-disk ring) ──
    this._highlightGizmo = createErrorHighlightGizmo(ctx.gizmoManager, this.node, this.HighlightStyle);

    // ── Backed error-text badge (dark panel + red border + white text) ──
    const badge = createErrorBadgeGizmo(ctx.gizmoManager, this.node, this.ErrorText);
    this._badgeGizmo = badge.gizmo;
    this._badgeTexture = badge.texture;

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
    this._badgeGizmo?.setVisible(active);
    this._ctx?.errorStore?.setActive(this.path, active, this.ErrorText);
  }

  /** Current active state (test/inspection helper). */
  isActive(): boolean {
    return this._active;
  }

  dispose(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._highlightGizmo?.dispose();
    this._highlightGizmo = undefined;
    this._badgeGizmo?.dispose();
    this._badgeGizmo = undefined;
    this._badgeTexture?.dispose();
    this._badgeTexture = undefined;
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
    hoverable: false,
    selectable: false,
    filterLabel: 'Web Errors',
    badgeColor: '#ef5350',
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

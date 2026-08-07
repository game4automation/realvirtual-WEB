// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVWebVisibility — TypeScript counterpart of Unity `WebVisibility.cs`.
 *
 * Two functions in one component:
 *  - Visibility: a PLCOutputBool signal shows/hides this node's subtree (and an
 *    optional list of additional target nodes). `node.visible = …` is the
 *    browser equivalent of Unity's `Renderer.enabled`. Invertible, with a
 *    default state when no signal is bound.
 *  - Error state: a second PLCOutputBool signal marks the part as faulty. While
 *    high the part flashes red (mesh-glow-hull / floor-disk ring), a backed
 *    error-text badge appears, and the error registers in the central
 *    `ErrorStore` (right-side error panel). This mirrors RVWebError 1:1.
 *
 * Priority rule (from WebVisibility.cs `ApplyError`): a HIDDEN part never shows
 * an error highlight — and is never an active ErrorStore entry. Visibility wins
 * over the error state.
 *
 * The error visualization (badge + highlight + small-part heuristic) is shared
 * with RVWebError via `rv-error-visual.ts`.
 */

import { type Object3D, type Texture } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import type { GizmoHandle } from './rv-gizmo-manager';
import { NodeRegistry } from './rv-node-registry';
import {
  ERROR_COLOR,
  ERROR_BLINK_HZ,
  normalizeHighlightStyle,
  parseColorToHex,
  createErrorHighlightGizmo,
  createErrorBadgeGizmo,
  type HighlightStyle,
} from './rv-error-visual';

// ─── RVWebVisibility ──────────────────────────────────────────────────────

export class RVWebVisibility implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  // Notes that still apply (see spec + _resolveAdditionalTargets/_readErrorColor):
  //  - AdditionalTargets is a GameObject ref list, resolved to Object3D nodes in
  //    onSceneReady, NOT by resolveComponentRefs.
  //  - HighlightStyle is enum-tolerant (named string OR legacy int index).
  //  - ErrorColor (Unity Color) is NOT in the schema — read raw in init().
  static readonly schema: ComponentSchema = loadSchemaFromSpec('WebVisibility');

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated (exact C# Inspector field names)
  SignalVisible: string | null = null;
  InvertSignal = false;
  DefaultVisible = true;
  AdditionalTargets: unknown[] = [];
  SignalError: string | null = null;
  ErrorText = '';
  HighlightStyle: HighlightStyle = 'Auto';
  BlinkSpeed = ERROR_BLINK_HZ;

  /** Node path — the ErrorStore key. Cached once at init. */
  readonly path: string;

  private _errorColorHex = ERROR_COLOR;
  private _blinkHz = ERROR_BLINK_HZ;

  /** Additional target nodes resolved from AdditionalTargets (onSceneReady). */
  private _additionalNodes: Object3D[] = [];

  private _highlightGizmo?: GizmoHandle;
  private _badgeGizmo?: GizmoHandle;
  private _badgeTexture?: Texture;
  private _unsubVisible?: () => void;
  private _unsubError?: () => void;
  private _ctx?: ComponentContext;
  private _visible = true;
  private _error = false;

  constructor(node: Object3D) {
    this.node = node;
    this.path = NodeRegistry.computeNodePath(node);
  }

  init(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) {
      console.error('[WebVisibility] gizmoManager missing in ComponentContext — skipping');
      return;
    }
    this._ctx = ctx;

    // Defensive: normalize an int HighlightStyle the enumMap may have left raw.
    this.HighlightStyle = normalizeHighlightStyle(this.HighlightStyle);
    this._errorColorHex = parseColorToHex(this._readErrorColor(), ERROR_COLOR);
    this._blinkHz = Number.isFinite(this.BlinkSpeed) && this.BlinkSpeed > 0 ? this.BlinkSpeed : ERROR_BLINK_HZ;

    this.node.userData._rvType = 'WebVisibility';
    Object.defineProperty(this.node.userData, '_rvComponentInstance', {
      value: this, writable: true, configurable: true, enumerable: false,
    });

    // ── Visibility signal ──
    if (this.SignalVisible) {
      this._unsubVisible = ctx.signalStore.subscribeByPath(
        this.SignalVisible,
        (v) => this._onVisibleChange(!!v),
      );
      const current = ctx.signalStore.getByPath(this.SignalVisible);
      // Read initial value (no flicker). XOR with InvertSignal.
      this._visible = current !== undefined ? (!!current !== this.InvertSignal) : this.DefaultVisible;
    } else {
      // No signal bound → apply the default once.
      this._visible = this.DefaultVisible;
    }

    // ── Error signal ──
    if (this.SignalError) {
      this._unsubError = ctx.signalStore.subscribeByPath(
        this.SignalError,
        (v) => this._onErrorChange(!!v),
      );
      const current = ctx.signalStore.getByPath(this.SignalError);
      if (current !== undefined) this._error = !!current;
    }
  }

  /** Gizmos + AdditionalTargets resolution deferred to onSceneReady so the
   *  subtree AABB and the final node hierarchy are correct AFTER kinematic
   *  re-parenting (matches RVWebError). */
  onSceneReady(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) return;
    this._ctx = ctx;

    this._resolveAdditionalTargets(ctx);

    // Error visualization (created hidden) — shared with RVWebError.
    this._highlightGizmo = createErrorHighlightGizmo(
      ctx.gizmoManager, this.node, this.HighlightStyle, this._errorColorHex, this._blinkHz,
    );
    const badge = createErrorBadgeGizmo(ctx.gizmoManager, this.node, this.ErrorText, this._errorColorHex);
    this._badgeGizmo = badge.gizmo;
    this._badgeTexture = badge.texture;

    // Apply the captured initial state now that everything exists.
    this._applyVisibility(this._visible);
    this._applyError();
  }

  /** Resolve AdditionalTargets (a List<GameObject>) to Object3D nodes. Reads the
   *  RAW rv_extras refs (not the mutated instance field) and resolves each path
   *  via the registry — GameObject refs aren't resolved by resolveComponentRefs. */
  private _resolveAdditionalTargets(ctx: ComponentContext): void {
    this._additionalNodes = [];
    const rv = this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    const raw = rv?.['WebVisibility']?.['AdditionalTargets'];
    const list = Array.isArray(raw) ? raw : this.AdditionalTargets;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const path = this._refToPath(item);
      if (!path) continue;
      const target = ctx.registry.getNode(path);
      if (target && target !== this.node) this._additionalNodes.push(target);
    }
  }

  /** Read the raw Unity Color from rv_extras (not in the schema — applySchema
   *  would stringify the object). Returns the raw value for parseColorToHex. */
  private _readErrorColor(): unknown {
    const rv = this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return rv?.['WebVisibility']?.['ErrorColor'] ?? null;
  }

  /** Extract a node path from an AdditionalTargets entry (raw ComponentRef object,
   *  or a plain path string left by the loader's ref-array fallback). */
  private _refToPath(item: unknown): string | null {
    if (typeof item === 'string') return item.length ? item : null;
    if (item && typeof item === 'object') {
      const p = (item as Record<string, unknown>).path;
      if (typeof p === 'string' && p.length) return p;
    }
    return null;
  }

  private _onVisibleChange(raw: boolean): void {
    const visible = raw !== this.InvertSignal; // XOR
    if (visible === this._visible) return;
    this._visible = visible;
    this._applyVisibility(visible);
    // Re-apply the error overlay according to the new visibility (priority rule).
    this._applyError();
  }

  private _onErrorChange(error: boolean): void {
    if (error === this._error) {
      // Re-affirm store text in case it changed at runtime (rare) and active.
      if (error && this._visible) this._ctx?.errorStore?.setActive(this.path, true, this.ErrorText);
      return;
    }
    this._error = error;
    this._applyError();
  }

  private _applyVisibility(visible: boolean): void {
    this.node.visible = visible;
    for (const t of this._additionalNodes) t.visible = visible;
    // Batched render path: node visibility must be mirrored into the
    // BatchedMesh instances (and the shadow map rebuilt) — the viewer
    // listens and re-syncs.
    this._ctx?.events?.emit('node-visibility-changed', undefined);
  }

  /** Priority rule: a hidden part shows NO error highlight and is NOT an active
   *  ErrorStore entry, even if SignalError is high. */
  private _applyError(): void {
    const effective = this._error && this._visible;
    this._highlightGizmo?.setVisible(effective);
    this._badgeGizmo?.setVisible(effective);
    this._ctx?.errorStore?.setActive(this.path, effective, this.ErrorText);
  }

  /** Current runtime visibility (test/inspection helper). */
  isVisibleNow(): boolean {
    return this._visible;
  }

  /** Current EFFECTIVE error state — error active AND visible (test helper). */
  isErrorActive(): boolean {
    return this._error && this._visible;
  }

  dispose(): void {
    this._unsubVisible?.();
    this._unsubVisible = undefined;
    this._unsubError?.();
    this._unsubError = undefined;
    this._highlightGizmo?.dispose();
    this._highlightGizmo = undefined;
    this._badgeGizmo?.dispose();
    this._badgeGizmo = undefined;
    this._badgeTexture?.dispose();
    this._badgeTexture = undefined;
    this._ctx?.errorStore?.remove(this.path);
    this._additionalNodes = [];
    this._error = false;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'WebVisibility',
  displayName: 'Visibility',
  schema: RVWebVisibility.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    hoverable: false,
    selectable: false,
    filterLabel: 'Web Visibility',
    badgeColor: '#ef5350',
  },
  create: (node) => new RVWebVisibility(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'WebVisibility';
    Object.defineProperty(node.userData, '_rvComponentInstance', {
      value: inst, writable: true, configurable: true, enumerable: false,
    });
    setComponentInstance(node, inst);
  },
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-mode.ts — the AAS mode (plan-682 Phase 2): a viewing state that makes
 * visible which parts carry an Asset Administration Shell.
 *
 * Switched by the AAS button in the left button bar. While on:
 *  - every resolvable AAS part is emphasised in Instrument Blue (fill + edges,
 *    `highlighter.setAuxEmphasis('aas-mode', …)` — works on baked/merged parts
 *    through their segments);
 *  - a small badge with the type code sits next to each part (overlay layer,
 *    {@link AasModeBadges});
 *  - only AAS parts are hoverable / pickable (a raycast allow filter that
 *    stacks on whatever filter was installed before, and restores it after).
 *
 * NOT dimmed: the plan's Phase-2 spike measured that the isolate pass cannot
 * reach AAS parts merged into an ancestor chunk, and that making `AASLink` a
 * chunk boundary costs more draw calls than the plan allows (Weg C, see plan
 * `## Spike-Ergebnis`). Dimming the rest is parked as a decision for Thomas.
 *
 * Lifecycle: the mode rebuilds when the resolution of AAS links changes and
 * when planner content is added or removed; it switches itself off when the
 * last AAS part disappears, on model clear, plugin deactivation and when the
 * editor mode is entered. It is a viewer state, never saved.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../core/rv-viewer';
import { ACCENT } from '../core/hmi/shared-sx';
import { NodeRegistry } from '../core/engine/rv-node-registry';
import { getActiveAasSource } from '../core/aas/rv-aas-source';
import { collectAasNodes, subscribeAasResolution } from './aas-resolution';
import { loadIndex } from './aas-link-parser';
import type { AasIndexEntry } from '../core/aas/rv-aas-source';
import { AasModeBadges } from './aas-mode-badges';
import { tooltipStore } from '../core/hmi/tooltip/tooltip-store';

/** Authoring modes without the AAS mode (Thomas 2026-11-04): its button is hidden there and
 *  entering one switches the mode off, so no AAS-only pick filter outlives its button. */
const NO_AAS_MODE_IN: ReadonlySet<string> = new Set(['editor', 'planner', 'des']);

/** Snapshot read by the AAS button (useSyncExternalStore). */
export interface AasModeState {
  on: boolean;
  /** Resolvable AAS parts in the scene. */
  count: number;
}

/** Aux-emphasis set id of the AAS mode. */
export const AAS_MODE_AUX_ID = 'aas-mode';
/** Instrument Blue — the product's one accent (shared-sx `ACCENT`). */
const AAS_MODE_COLOR = parseInt(ACCENT.slice(1), 16);

type Listener = () => void;

/**
 * The type-code text of a badge: product designation from the index metadata,
 * else the AASLink description, else the shell idShort without its
 * `AAS_Type_` / `AAS_` prefix.
 */
export function aasBadgeText(node: Object3D, index: Record<string, AasIndexEntry> | null): string {
  const link = node.userData?._rvAasLink as { aasId?: string; description?: string } | undefined;
  if (!link) return '';
  const entry = link.aasId && index ? index[link.aasId] : undefined;
  return entry?.productName?.trim()
    || link.description?.trim()
    || (entry?.idShort ?? '').replace(/^AAS_(Type_)?/i, '')
    || link.aasId
    || '';
}

/** One AAS mode per viewer (owned by AasLinkPlugin). */
export class AasModeController {
  private _on = false;
  private _nodes: Object3D[] = [];
  private _nodeSet = new Set<Object3D>();
  private _state: AasModeState = { on: false, count: 0 };
  private readonly _listeners = new Set<Listener>();
  private _badges: AasModeBadges | null = null;
  private _index: Record<string, AasIndexEntry> | null = null;
  private _generation = 0;
  private _offs: Array<() => void> = [];
  private _priorFilter: ((node: Object3D) => boolean) | null = null;
  private _ownFilter: ((node: Object3D) => boolean) | null = null;
  private _clickOff: (() => void) | null = null;

  constructor(private readonly viewer: RVViewer) {
    // The count is needed while the mode is OFF too (the button's badge), so
    // it follows the resolution and the planner content permanently.
    this._offs.push(subscribeAasResolution(() => this._onSceneChanged()));
    const on = (event: string, fn: (payload: never) => void) => {
      const off = (viewer.on as unknown as (e: string, f: (p: never) => void) => unknown)?.call(viewer, event, fn);
      if (typeof off === 'function') this._offs.push(off as () => void);
    };
    on('layout-content-added', () => this._onSceneChanged());
    on('layout-content-removed', () => this._onSceneChanged());
    on('mode-changed', (e: { to?: string }) => { if (e?.to && NO_AAS_MODE_IN.has(e.to)) this.setOn(false); });
    this._refreshCount();
    this._state = { on: false, count: this._nodes.length };
  }

  // ── Store ──────────────────────────────────────────────────────────

  subscribe = (l: Listener): (() => void) => { this._listeners.add(l); return () => { this._listeners.delete(l); }; };
  getSnapshot = (): AasModeState => this._state;

  get isOn(): boolean { return this._on; }
  /** The AAS parts currently emphasised (empty while off). */
  get nodes(): readonly Object3D[] { return this._on ? this._nodes : []; }
  /** Badges of the current activation (tests, diagnostics). */
  get badges(): AasModeBadges | null { return this._badges; }

  private _emit(): void {
    const count = this._nodes.length;
    if (this._state.on === this._on && this._state.count === count) return;
    this._state = { on: this._on, count };
    for (const l of this._listeners) l();
  }

  // ── Switching ──────────────────────────────────────────────────────

  /** Switch the mode on or off. Ignored (stays off) without any AAS part or in an authoring mode. */
  setOn(on: boolean): void {
    if (on === this._on) return;
    if (on) {
      this._refreshCount();
      if (this._nodes.length === 0 || NO_AAS_MODE_IN.has(this.viewer.modes?.activeMode ?? '')) { this._emit(); return; }
      this._on = true;
      this._apply();
      this._installPickFilter();
      this._installBadgeClick();
      this._loadIndexForBadges();
    } else {
      this._on = false;
      this._generation++;
      this.viewer.highlighter?.setAuxEmphasis(AAS_MODE_AUX_ID, null);
      this._badges?.dispose();
      this._badges = null;
      this._removePickFilter();
      this._clickOff?.();
      this._clickOff = null;
    }
    this._emit();
  }

  toggle(): void { this.setOn(!this._on); }

  /** Model cleared / plugin deactivated: off, and forget the model's nodes. */
  reset(): void {
    this.setOn(false);
    this._nodes = [];
    this._nodeSet.clear();
    this._index = null;
    this._emit();
  }

  /** Per-frame: keep badges on moving parts. Cheap no-op while off. */
  update(): void {
    if (this._on) this._badges?.update();
  }

  dispose(): void {
    this.setOn(false);
    for (const off of this._offs) off();
    this._offs = [];
    this._listeners.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────

  private _refreshCount(): void {
    collectAasNodes(this.viewer.scene, this._nodes);
    this._nodeSet = new Set(this._nodes);
  }

  private _onSceneChanged(): void {
    this._refreshCount();
    if (this._on) {
      if (this._nodes.length === 0) { this.setOn(false); return; }
      this._apply();
    }
    this._emit();
  }

  private _apply(): void {
    this.viewer.highlighter?.setAuxEmphasis(AAS_MODE_AUX_ID, this._nodes, { color: AAS_MODE_COLOR });
    if (!this._badges) {
      this._badges = new AasModeBadges(ACCENT);
      this.viewer.scene.add(this._badges.group);
    }
    this._badges.build(this._nodes, (n) => aasBadgeText(n, this._index));
    this.viewer.markRenderDirty();
  }

  private _loadIndexForBadges(): void {
    const generation = ++this._generation;
    loadIndex(getActiveAasSource()).then((index) => {
      if (generation !== this._generation || !this._on) return;
      this._index = index;
      this._badges?.build(this._nodes, (n) => aasBadgeText(n, this._index));
      this.viewer.markRenderDirty();
    }).catch(() => { /* badges keep the description fallback */ });
  }

  /** Is `node` an AAS part or inside one? */
  private _inAas(node: Object3D): boolean {
    let cur: Object3D | null = node;
    while (cur) {
      if (this._nodeSet.has(cur)) return true;
      cur = cur.parent;
    }
    return false;
  }

  private _installPickFilter(): void {
    const rm = this.viewer.raycastManager;
    if (!rm) return;
    const prior = rm.getAllowFilter();
    this._priorFilter = prior;
    this._ownFilter = (node) => (prior ? prior(node) : true) && this._inAas(node);
    rm.setAllowFilter(this._ownFilter);
  }

  private _removePickFilter(): void {
    const rm = this.viewer.raycastManager;
    if (rm && this._ownFilter && rm.getAllowFilter() === this._ownFilter) rm.setAllowFilter(this._priorFilter);
    this._ownFilter = null;
    this._priorFilter = null;
  }

  /** Badge click / tap → select the part, which pins its AAS tooltip. */
  private _installBadgeClick(): void {
    const el = this.viewer.renderer?.domElement as HTMLElement | undefined;
    if (!el) return;
    let down: { x: number; y: number; node: Object3D } | null = null;
    // plan-2215 2.6: no screen pick while a render strategy draws other cameras.
    const hit = (e: PointerEvent): Object3D | null => (this.viewer.pointerPickBlocked ? null
      : this._badges?.hitTest(e.clientX, e.clientY, this.viewer.camera, el.getBoundingClientRect()) ?? null);
    const onDown = (e: PointerEvent) => {
      const node = hit(e);
      down = node ? { x: e.clientX, y: e.clientY, node } : null;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const d = down;
      down = null;
      if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4 || hit(e) !== d.node) return;
      // After the viewer's own click handling (which may have selected the
      // part behind the badge or cleared the selection).
      setTimeout(() => {
        if (!this._on) return;
        const path = NodeRegistry.computeNodePath(d.node);
        // A hit point marks it as a 3D click — that is what pins the tooltip.
        if (!path) return;
        this.viewer.selectionManager.select(path, this._badges?.anchorOf(d.node) ?? undefined);
        // Already selected (pin dismissed by auto-hide / orbit / wheel / tap):
        // select() of the same path is a no-op, so ask for the pin explicitly.
        tooltipStore.requestPin();
      }, 0);
    };
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointerup', onUp, { capture: true });
    this._clickOff = () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointerup', onUp, { capture: true });
    };
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ViewerHost — Minimales Capability-Interface das engine/-Klassen sehen sollen.
 *
 * Wird von ComponentEventDispatcher und SelectionManager statt RVViewer importiert.
 * RVViewer implementiert ViewerHost via Struktural-Typing (kein `implements`-Keyword nötig).
 *
 * Phase 2 of plan-182 (architecture refactoring): bricht die Zyklik
 *   engine/ -> rv-viewer.ts -> engine/.
 */

import type { Object3D } from 'three';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';

/** Subset von NodeRegistry den der ViewerHost exponiert. */
export interface ViewerHostRegistry {
  getNode(path: string): Object3D | null;
  getPathForNode(node: Object3D): string | null;
}

/** Subset von RVHighlightManager den der ViewerHost exponiert. */
export interface ViewerHostHighlighter {
  clearSelection(): void;
  highlightSelection(nodes: Object3D[], opts?: { includeChildDrives?: boolean }): void;
}

/** Subset of GroupRegistry the ViewerHost exposes (F frames a kinematic's whole group). */
export interface ViewerHostGroups {
  get(name: string): { nodes: Object3D[] } | undefined;
}

/**
 * ViewerHost bündelt genau das, was ComponentEventDispatcher und
 * SelectionManager vom Viewer brauchen — kein mehr, kein weniger.
 */
export interface ViewerHost {
  // Event-API (von EventEmitter<ViewerEvents> geerbt — RVViewer hat das)
  on: EventEmitter<ViewerEvents>['on'];
  emit: EventEmitter<ViewerEvents>['emit'];
  /** Central signature-provenance execution gate (older test hosts may omit). */
  readonly logicRunState?: 'active' | 'gated' | 'activating';

  // Subsystem-Zugriff (Subsets)
  readonly registry: ViewerHostRegistry | null;
  readonly highlighter: ViewerHostHighlighter;

  /** Frame these nodes (F key). Optional: test hosts and the embed viewer
   *  may not provide it, and the shortcut simply does nothing then. */
  fitToNodes?(nodes: Object3D[]): void;
  /** Frame the whole scene (Shift+F, and F with an empty selection). */
  frameSceneContent?(animate?: boolean): void;
  /** Group registry — F expands a selected kinematic axis to its collected group. */
  readonly groups?: ViewerHostGroups | null;
  /**
   * The viewer's own keyboard scope (plan-515 R3-2): its container element,
   * focusable (`tabindex=0`). F / Shift+F / Escape are handled for key events
   * INSIDE this element only, so several viewers on one page do not all react.
   * Absent (test hosts without DOM) = the historical document-wide listener.
   */
  readonly keyboardScope?: HTMLElement | null;
  /**
   * The PRIMARY viewer of the page (the main viewer) additionally takes key
   * events whose target lies outside every registered viewer scope — focus in
   * the HMI (hierarchy, panels) or on the body — so F keeps framing the
   * selection after a hierarchy click. Events inside another viewer's scope
   * never reach it.
   */
  readonly keyboardScopeIsPrimary?: boolean;
}

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
}

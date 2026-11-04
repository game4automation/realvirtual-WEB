// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-glb-three.mjs (plan-673 Phase 4b). */

import type { Object3D } from 'three';

/** A glTF-Transform `NodeIO` that can decode AND re-encode Draco. */
export function dracoIO(): Promise<unknown>;

export interface GlbThreeTree {
  /** The asset's single scene root (a library asset always has exactly one). */
  root: Object3D;
  /** Asset-relative path (root segment included) → node. */
  byPath: Map<string, Object3D>;
  /** Every node in depth-first scene order. */
  nodes: Object3D[];
  /** The glTF-Transform document, for callers that also want to write. */
  document: unknown;
  /** The reader/writer the document was read with. */
  io: unknown;
}

/**
 * Read a GLB into a plain three.js tree: names, local TRS, `extras` under
 * `userData`, and one child `Mesh` per primitive carrying `position` (+ index).
 * Enough for mass integration and bounding boxes; NOT a render-faithful load.
 */
export function loadGlbAsThree(file: string): Promise<GlbThreeTree>;

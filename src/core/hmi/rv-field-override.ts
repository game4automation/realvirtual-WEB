// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-override.ts — "is this field overridden?" answered the way the
 * Property Inspector answers it, for callers outside the inspector (plan-512).
 *
 * Two sources, one answer (plan-703 F7): the scene overlay's own overrides and
 * the `AssetOverrides` an enclosing reference node carries for this node. They
 * are the same idea addressed two ways — "this file changes that value". The
 * inspector's override dot unions both; the unit auto-scale's write rule must
 * see exactly what the dot shows, or it would overwrite a value the user can
 * see as their own.
 *
 * React-free and read-only.
 */

import type { RVViewer } from '../rv-viewer';
import type { RVViewerPlugin } from '../rv-plugin';
import { getOverriddenFields, type RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import { overrideTargetOf, overriddenFieldsOf } from '../ops/rv-reference-guard';

const NO_FIELDS: readonly string[] = [];

interface OverlaySource extends RVViewerPlugin {
  getSnapshot(): { overlay: RVExtrasOverlay | null };
}

/**
 * Fields of `componentType` that an enclosing `AssetReference` overrides for
 * this node (plan-703 F7).
 *
 * Empty in `viewer` mode by decision 9 — not because the data is absent, but
 * because the badge is an EDIT affordance: it is clickable and it reverts. A
 * kiosk must not offer that, and hiding the control while leaving it reachable
 * would be worse than not showing it.
 */
export function referenceOverriddenFields(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
): readonly string[] {
  if (viewer.modes?.activeMode === 'viewer') return NO_FIELDS;
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return NO_FIELDS;
  const target = overrideTargetOf(node, viewer.currentModelRoot ?? null);
  if (!target) return NO_FIELDS;
  return overriddenFieldsOf(target.referenceNode, target.nodeId, componentType);
}

/** Fields of `componentType` the scene overlay (rv-extras editor) overrides on `nodePath`. */
export function sceneOverlayOverriddenFields(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
): readonly string[] {
  const overlay = viewer.getPlugin?.<OverlaySource>('rv-extras-editor')?.getSnapshot().overlay;
  return overlay ? getOverriddenFields(nodePath, componentType, overlay) : NO_FIELDS;
}

/**
 * True when `componentType.field` on `nodePath` carries an override from
 * EITHER source — the same union the inspector's override dot shows. A node or
 * component that no longer exists (e.g. an undo deleted the whole component
 * key) is simply not overridden.
 */
export function isFieldOverridden(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
  field: string,
): boolean {
  return sceneOverlayOverriddenFields(viewer, nodePath, componentType).includes(field)
    || referenceOverriddenFields(viewer, nodePath, componentType).includes(field);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * Authored-change inventory (line numbers refreshed with this chunk):
 * src/core/params/rv-param-field.ts:255 bumpModelEditEpoch('component-field');
 * src/core/params/rv-param-field.ts:281 bumpModelEditEpoch('component-field');
 * src/core/hmi/rv-command-registry.ts:345 if ((desc.macro || desc.undoLabel) && modelEditEpoch() === epochBefore) bumpModelEditEpoch('model-command');
 * src/core/ops/rv-document.ts:554 if (authored(op)) bumpModelEditEpoch('document-edit');
 * src/core/engine/rv-transform-gizmo.ts:439 if (moved) bumpModelEditEpoch('transform-commit');
 * src/core/engine/rv-placement-instancer.ts:969 bumpModelEditEpoch('placement-instance');
 * src/core/engine/rv-placement-instancer.ts:1000 if (removed) bumpModelEditEpoch('placement-removal');
 * Layout planner and editor model edits share RvDocument history; view state
 * (camera, selection, groups-panel hide/isolate) is not an authored document operation.
 */
export const MODEL_EDIT_PATHS = [
  'component-field', 'model-command', 'document-edit', 'transform-commit',
  'placement-instance', 'placement-removal',
] as const;
export type ModelEditPath = typeof MODEL_EDIT_PATHS[number];
let epoch = 0;
export function modelEditEpoch(): number { return epoch; }
export function bumpModelEditEpoch(_path: ModelEditPath): void { epoch++; }

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MaintenanceViewRow — "Save current view" / "Clear view" on a
 * `LogicStep_MaintenanceStep` (plan-522 §2.4.5). Writes the editor camera into
 * `CameraPosition` / `CameraTarget` (viewer coordinates) through the normal
 * field-edit path, as ONE transaction. Renders nothing without an edit target
 * that can capture the view (`EditTarget.captureView`, editor only) — the
 * community build without the asset editor shows the plain fields only.
 */

import { useSyncExternalStore } from 'react';
import { Button } from '@mui/material';
import { InspectorActionRow, inspectorActionButtonSx } from './rv-inspector-blocks';
import { getActiveEditTarget, getEditTargetVersion, subscribeEditTarget } from './rv-edit-target';

/** The component type the row belongs to. */
export const MAINTENANCE_STEP_TYPE_FOR_VIEW = 'LogicStep_MaintenanceStep';

const ZERO = { x: 0, y: 0, z: 0 };
const vec = ([x, y, z]: [number, number, number]) => ({ x, y, z });

export interface MaintenanceViewRowProps {
  /** Writes one field of the step component (the section's field-edit path). */
  onEdit: (field: 'CameraPosition' | 'CameraTarget', value: { x: number; y: number; z: number }) => void;
}

export function MaintenanceViewRow({ onEdit }: MaintenanceViewRowProps) {
  useSyncExternalStore(subscribeEditTarget, getEditTargetVersion);
  const target = getActiveEditTarget();
  const capture = target.captureView?.bind(target);
  if (!capture) return null;

  const write = (position: { x: number; y: number; z: number }, look: { x: number; y: number; z: number }, label: string) => {
    void target.withTransaction(label, async () => {
      onEdit('CameraPosition', position);
      onEdit('CameraTarget', look);
    });
  };

  return (
    <InspectorActionRow data-testid="rv-maintenance-view-row">
      <Button
        size="small"
        variant="outlined"
        color="primary"
        title="Save the current camera as this step's view"
        onClick={() => {
          const v = capture();
          write(vec(v.position), vec(v.target), 'Save current view');
        }}
        sx={inspectorActionButtonSx}
      >
        Save current view
      </Button>
      <Button
        size="small"
        variant="outlined"
        color="primary"
        title="No camera move for this step"
        onClick={() => write(ZERO, ZERO, 'Clear view')}
        sx={inspectorActionButtonSx}
      >
        Clear view
      </Button>
    </InspectorActionRow>
  );
}

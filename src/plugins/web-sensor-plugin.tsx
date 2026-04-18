// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * web-sensor-plugin.tsx — Registers the "Sensors" toolbar button.
 *
 * The button is a single toggle for isolating WebSensors:
 *  - Click → viewer.autoFilters.isolate('WebSensor')   (3-pass dim composite)
 *  - Click again → viewer.autoFilters.showAll()         (restore)
 *
 * Sensor gizmos are always visible (not toggled here). Tooltip on hover/click
 * stays available regardless of isolate state.
 */

import { useCallback, useState, useEffect } from 'react';
import { Sensors } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';
import { NavButton } from '../core/hmi/NavButton';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
} from '../core/hmi/group-visibility-store';
import type { RVWebSensor } from '../core/engine/rv-web-sensor';

const FILTER_TYPE = 'WebSensor';

/** Walk all WebSensors in the scene and toggle their ID text label visibility. */
function setAllSensorLabelsVisible(viewer: RVViewer, visible: boolean): void {
  const reg = viewer.registry;
  if (!reg) return;
  const instances = reg.getAll(FILTER_TYPE) as Array<{ path: string }>;
  for (const inst of instances) {
    const node = reg.getNode(inst.path);
    const ws = node?.userData?._rvWebSensor as RVWebSensor | undefined;
    ws?.setLabelVisible(visible);
  }
}

function SensorToolButton({ viewer }: UISlotProps) {
  // Track local isolate state so the button reflects current mode.
  const [isolated, setIsolated] = useState(false);

  // Sync initial state with persisted store on mount (in case page was reloaded
  // with sensors isolated).
  useEffect(() => {
    const saved = loadGroupVisibilitySettings();
    const initIsolated = saved.isolatedAutoFilter === FILTER_TYPE;
    setIsolated(initIsolated);
    // Labels are visible only in isolate mode (helps identify which sensor is which).
    setAllSensorLabelsVisible(viewer, initIsolated);
  }, [viewer]);

  const handleClick = useCallback(() => {
    if (!viewer.autoFilters) return;
    const current = loadGroupVisibilitySettings();
    if (isolated) {
      // Currently isolated → show all (back to normal) + hide labels (busy view).
      viewer.autoFilters.showAll();
      viewer.markShadowsDirty?.();
      setAllSensorLabelsVisible(viewer, false);
      setIsolated(false);
      saveGroupVisibilitySettings({
        ...current,
        isolatedAutoFilter: null,
      });
    } else {
      // Not isolated → isolate WebSensors with softer dim + show labels so
      // each sensor can be identified by its ID.
      viewer.autoFilters.isolate(FILTER_TYPE, { dimOpacity: 0.55, dimDesaturate: true });
      viewer.markShadowsDirty?.();
      setAllSensorLabelsVisible(viewer, true);
      setIsolated(true);
      saveGroupVisibilitySettings({
        ...current,
        isolatedGroup: null,
        isolatedAutoFilter: FILTER_TYPE,
      });
    }
  }, [viewer, isolated]);

  return (
    <NavButton
      icon={<Sensors />}
      label="Isolate Sensors"
      active={isolated}
      onClick={handleClick}
    />
  );
}

export class WebSensorPlugin implements RVViewerPlugin {
  readonly id = 'web-sensor-plugin';

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: SensorToolButton, order: 20 },
  ];
}

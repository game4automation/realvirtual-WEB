// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * web-sensor-plugin.tsx — registers the Web Sensors toolbar button in the
 * `button-group` UI slot and toggles the SensorToolPanel via
 * viewer.leftPanelManager.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { Sensors } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { NavButton } from '../core/hmi/NavButton';

const PANEL_ID = 'sensor-tool';
const PANEL_WIDTH = 320;

function SensorToolButton({ viewer }: UISlotProps) {
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isActive = panelSnap.activePanel === PANEL_ID;

  const handleClick = useCallback(() => {
    lpm.toggle(PANEL_ID, PANEL_WIDTH);
  }, [lpm]);

  return (
    <NavButton
      icon={<Sensors />}
      label="Web Sensors"
      active={isActive}
      onClick={handleClick}
    />
  );
}

export class WebSensorPlugin implements RVViewerPlugin {
  readonly id = 'web-sensor-plugin';

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: SensorToolButton, order: 50 },
  ];
}

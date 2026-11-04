// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Box } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { FLOATING_TOP_MARGIN } from './layout-constants';
import { isMobileDevice, useMobileLayout } from '../../hooks/use-mobile-layout';
import type { UIVisibilityRule } from './ui-context-store';

/**
 * Default visibility of the KPI bar. 'mode:commissioning' (plan-423) drops the
 * operator HMI; a plugin may lift single contexts while it is registered
 * (see `SimulatedKpiPlugin.showInModes`).
 */
export const KPI_BAR_DEFAULT_RULE: UIVisibilityRule = {
  hiddenIn: ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning'],
};

/** Core layout container for the KPI bar (top center). Renders 'kpi-bar' slot entries. */
export function KpiBar() {
  const viewer = useViewer();
  const entries = useSlot('kpi-bar');
  // Center over the actual 3D view (between the docked windows), not the whole
  // window, so the cards stay centered on the viewport as panels open/resize.
  const insets = useViewportInsets();
  const compact = useMobileLayout();
  if (compact || isMobileDevice() || entries.length === 0) return null;

  return (
    <Box
      sx={{
        // KPI cards float at the top-center of the viewport (there is no top app
        // bar anymore). The mode/sim and camera clusters float at the same height
        // in the left/right corners, so the centered cards never collide.
        position: 'fixed',
        top: insets.top + FLOATING_TOP_MARGIN,
        left: insets.left,
        right: insets.right,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: { xs: 0.75, sm: 1.5 },
        px: { xs: 0.5, sm: 0 },
        flexWrap: 'nowrap',
        pointerEvents: 'none',
        /* hide scrollbar but allow swipe */
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      {entries.map((entry, i) => {
        const Comp = entry.component;
        return <Box key={`kpi-${i}`} data-ui-panel><Comp viewer={viewer} /></Box>;
      })}
    </Box>
  );
}

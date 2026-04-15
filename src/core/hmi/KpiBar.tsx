// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Box } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';

/** Core layout container for the KPI bar (top center). Renders 'kpi-bar' slot entries. */
export function KpiBar() {
  const viewer = useViewer();
  const entries = useSlot('kpi-bar');
  if (entries.length === 0) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        top: { xs: 44, sm: 8 },
        left: 0,
        right: 0,
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

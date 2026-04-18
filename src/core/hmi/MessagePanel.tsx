// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { ChevronRight, ChevronLeft } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useMaintenanceMode } from '../../hooks/use-maintenance-mode';
import {
  useMessagePanelOpen,
  useMessagePanelMinimized,
  toggleMessagePanelMinimized,
} from './message-panel-store';
import { MaintenancePanel } from './MaintenancePanel';

/** Core layout container for messages (right side). Renders 'messages' slot entries.
 *  When maintenance mode is active, swaps to the MaintenancePanel stepper.
 *  Desktop supports a minimized peek mode that expands individual cards on hover. */
export function MessagePanel() {
  const viewer = useViewer();
  const entries = useSlot('messages');
  const isMobile = useMobileLayout();
  const [expandedIdx, setExpandedIdx] = useState(-1);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const maintenanceState = useMaintenanceMode();
  const messagePanelOpen = useMessagePanelOpen();
  const minimized = useMessagePanelMinimized();

  const isMaintenanceActive = maintenanceState.mode !== 'idle';

  // ── Maintenance Mode: show MaintenancePanel instead of messages ──
  if (isMaintenanceActive) {
    return (
      <Box
        data-ar-show
        sx={{
          position: 'fixed',
          right: 8,
          top: 0,
          bottom: 0,
          width: 320,
          zIndex: 1200,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 1,
        }}
      >
        <MaintenancePanel />
      </Box>
    );
  }

  if (!messagePanelOpen) return null;
  if (entries.length === 0) return null;

  // ── Desktop: vertical centered column on the right ──
  if (!isMobile) {
    // Minimized desktop mode: peek tabs, expand individual card on hover.
    if (minimized) {
      return (
        <Box
          data-ar-show
          sx={{
            position: 'fixed',
            right: 0,
            top: 0,
            bottom: 0,
            zIndex: 1200,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 0.5,
            pointerEvents: 'none',
          }}
        >
          <Box sx={{ alignSelf: 'flex-end', pointerEvents: 'auto', mb: 0.5 }}>
            <Tooltip title="Expand messages" placement="left">
              <IconButton
                size="small"
                onClick={toggleMessagePanelMinimized}
                sx={{ bgcolor: 'rgba(0,0,0,0.4)', '&:hover': { bgcolor: 'rgba(0,0,0,0.6)' } }}
              >
                <ChevronLeft fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          {entries.map((entry, i) => {
            const Comp = entry.component;
            const isHovered = hoveredIdx === i;
            return (
              <Box
                key={`msg-${i}`}
                data-ui-panel
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(-1)}
                sx={{
                  pointerEvents: 'auto',
                  width: 300,
                  transform: isHovered ? 'translateX(0)' : 'translateX(calc(100% - 36px))',
                  transition: 'transform 0.25s ease',
                }}
              >
                <Comp viewer={viewer} />
              </Box>
            );
          })}
        </Box>
      );
    }

    // Full desktop column with a minimize button at the top.
    return (
      <Box
        data-ar-show
        sx={{
          position: 'fixed',
          right: 8,
          top: 0,
          bottom: 0,
          width: 300,
          zIndex: 1200,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 1,
          overflow: 'auto',
        }}
      >
        <Box sx={{ alignSelf: 'flex-end', pointerEvents: 'auto' }}>
          <Tooltip title="Minimize messages" placement="left">
            <IconButton
              size="small"
              onClick={toggleMessagePanelMinimized}
              sx={{ bgcolor: 'rgba(0,0,0,0.4)', '&:hover': { bgcolor: 'rgba(0,0,0,0.6)' } }}
            >
              <ChevronRight fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        {entries.map((entry, i) => {
          const Comp = entry.component;
          return <Box key={`msg-${i}`} data-ui-panel><Comp viewer={viewer} /></Box>;
        })}
      </Box>
    );
  }

  // ── Mobile: peek tabs at right edge, slide-in on tap ──
  // Each card renders fully but is shifted off-screen via translateX.
  // Only the left ~36px (colored border + icon) peeks from the right edge.
  // Tapping slides the full card into view.
  return (
    <Box
      data-ar-show
      sx={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: 1200,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 0.5,
        pointerEvents: 'none',
      }}
    >
      {entries.map((entry, i) => {
        const Comp = entry.component;
        const isOpen = expandedIdx === i;
        return (
          <Box
            key={`msg-${i}`}
            onClick={() => setExpandedIdx(isOpen ? -1 : i)}
            sx={{
              pointerEvents: 'auto',
              width: 300,
              transform: isOpen ? 'translateX(0)' : 'translateX(calc(100% - 36px))',
              transition: 'transform 0.25s ease',
              cursor: 'pointer',
            }}
          >
            <Comp viewer={viewer} />
          </Box>
        );
      })}
    </Box>
  );
}

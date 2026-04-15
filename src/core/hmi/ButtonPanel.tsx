// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useSyncExternalStore } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { Circle } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { useMcpBridge } from '../../hooks/use-mcp-bridge';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { SETTINGS_PANEL_WIDTH, INSPECTOR_PANEL_WIDTH } from './layout-constants';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { WelcomeModal } from './WelcomeModal';

/* Logo URL: use BASE_URL so it resolves correctly under sub-folder deploys (e.g. Bunny CDN /demo/) */
const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

// ── Logo Badge (always visible, independent of ButtonPanel) ─────────────

/** Logo + connection status badge — always visible at top-left. */
const WELCOME_DISMISSED_KEY = 'rv-welcome-dismissed';

export function LogoBadge() {
  const [aboutOpen, setAboutOpen] = useState(() => !localStorage.getItem(WELCOME_DISMISSED_KEY));
  const isMobile = useMobileLayout();
  const mcp = useMcpBridge();

  return (
    <>
      <Paper
        elevation={4}
        data-ui-panel
        sx={{
          position: 'fixed',
          left: 8,
          top: 8,
          zIndex: 1200,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.25,
          py: 0.5,
          borderRadius: 2,
          pointerEvents: 'auto',
          cursor: 'pointer',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
        onClick={() => setAboutOpen(true)}
      >
        <img src={logoUrl} alt="realvirtual" style={{ height: 18, width: 18 }} />
        {!isMobile && (
          <Typography sx={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.5, color: 'text.primary' }}>
            realvirtual
          </Typography>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Circle sx={{ fontSize: 6, color: '#66bb6a' }} />
          {!isMobile && (
            <Typography sx={{ fontSize: 10, fontWeight: 500, color: 'rgba(102,187,106,0.85)', letterSpacing: 0.3 }}>
              online
            </Typography>
          )}
        </Box>
        {mcp.connected && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1 }}>
            <Circle sx={{ fontSize: 6, color: '#66bb6a' }} />
            {!isMobile && (
              <Typography sx={{ fontSize: 10, fontWeight: 500, color: 'rgba(102,187,106,0.85)', letterSpacing: 0.3 }}>
                ai
              </Typography>
            )}
          </Box>
        )}
      </Paper>

      <WelcomeModal open={aboutOpen} onClose={() => { setAboutOpen(false); localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); }} />
    </>
  );
}

// ── Button Panel (slot-driven button group) ─────────────────────────────

/** Slot-driven button group sidebar. */
export function ButtonPanel() {
  const viewer = useViewer();
  const entries = useSlot('button-group');

  // Check if hierarchy panel is open (and its width) to shift the button group right
  const { state: editorState } = useEditorPlugin();

  const isMobile = useMobileLayout();

  // Read leftPanelManager for panels managed outside of the extras-editor plugin
  const lpm = viewer.leftPanelManager;
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);

  // Shift right for hierarchy panel, property inspector, or settings panel
  const inspectorExtra = editorState.panelOpen && editorState.showInspector && editorState.selectedNodePath ? INSPECTOR_PANEL_WIDTH + 8 : 0;
  const settingsWidth = editorState.settingsOpen ? SETTINGS_PANEL_WIDTH + 8 + 8 : 0; // panel + 8px left + 8px gap
  const hierarchyWidth = editorState.panelOpen && !editorState.settingsOpen ? 8 + editorState.panelWidth + 8 + inspectorExtra : 0;
  // Also account for panels managed by leftPanelManager (e.g. machine-control)
  const lpmWidth = (panelSnapshot.activePanel && panelSnapshot.activePanel !== 'settings' && panelSnapshot.activePanel !== 'hierarchy')
    ? 8 + panelSnapshot.activePanelWidth + 8 : 0;
  const buttonLeftOffset = Math.max(settingsWidth, hierarchyWidth, lpmWidth) || 8;

  if (entries.length === 0) return null;

  return (
    <Box
      sx={isMobile ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1200,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        pb: 'env(safe-area-inset-bottom, 0px)',
      } : {
        position: 'fixed',
        left: buttonLeftOffset,
        top: 44,
        bottom: 8,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'none',
        transition: 'left 0.2s ease',
      }}
    >
      <Paper
        elevation={4}
        data-ui-panel
        sx={{
          display: 'flex',
          flexDirection: isMobile ? 'row' : 'column',
          gap: 0.25,
          p: 0.5,
          borderRadius: isMobile ? '12px 12px 0 0' : 2,
          pointerEvents: 'auto',
        }}
      >
        {entries.map((entry, i) => {
          const Comp = entry.component;
          return <Comp key={`btn-${i}`} viewer={viewer} />;
        })}
      </Paper>
    </Box>
  );
}

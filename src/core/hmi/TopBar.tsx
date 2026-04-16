// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useCallback, useSyncExternalStore, useRef } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { Typography, Box, IconButton, Paper, Tabs, Tab, Tooltip } from '@mui/material';
import { Settings, Close, AccountTree, ViewInAr, People, PushPin } from '@mui/icons-material';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useViewer } from '../../hooks/use-viewer';
import { isSettingsLocked, isTabLocked } from './rv-app-config';
import { HierarchyBrowser } from './rv-hierarchy-browser';
import { PropertyInspector } from './rv-property-inspector';
import { AasDetailPanel } from '../../plugins/aas-link-plugin';
import { LeftPanel } from './LeftPanel';
import { SETTINGS_PANEL_WIDTH } from './layout-constants';
import { MachineControlPanel } from './MachineControlPanel';
import { MultiuserPanel } from './MultiuserPanel';
import { SlotRenderer } from './HMIShell';
import { useMultiuser } from '../../hooks/use-multiuser';
import { loadMultiuserSettings } from './multiuser-settings-store';
import type { MultiuserPluginAPI, WebXRPluginAPI } from '../types/plugin-types';

// Settings tab components (extracted for maintainability)
import { ModelTab, VisualTab, PhysicsTab, InterfacesTab, MultiuserTab, McpTab, DevToolsTab, TestsTab, GroupsTab } from './settings';
import { usePluginSettingsTabs, PluginSettingsTabContent } from './PluginSettingsTabs';

export function TopBar() {
  const viewer = useViewer();
  const [settingsTab, setSettingsTab] = useState(0);
  const [vrOpen, setVrOpen] = useState(false);
  const [muOpen, setMuOpen] = useState(false);
  const pluginSettingsTabs = usePluginSettingsTabs(viewer);

  // Hierarchy panel state from plugin
  const { plugin, state: pluginState } = useEditorPlugin();
  const hierarchyOpen = pluginState.panelOpen;
  const settingsOpen = pluginState.settingsOpen;

  const lpm = viewer.leftPanelManager;

  const setSettingsOpen = useCallback((open: boolean) => {
    plugin?.setSettingsOpen(open);
    // Sync with leftPanelManager so MachineControlPanel knows to close
    if (open) {
      lpm.open('settings', SETTINGS_PANEL_WIDTH);
    } else if (lpm.isOpen('settings')) {
      lpm.close('settings');
    }
  }, [plugin, lpm]);

  const toggleHierarchy = useCallback(() => {
    if (!plugin) return;
    plugin.togglePanel();
    setSettingsOpen(false);
    setVrOpen(false);
    // Sync with leftPanelManager
    if (!plugin.panelOpen) {
      // Was closed, now opening (togglePanel already flipped)
      lpm.open('hierarchy', pluginState.panelWidth);
    } else {
      lpm.close('hierarchy');
    }
  }, [plugin, setSettingsOpen, lpm, pluginState.panelWidth]);

  // Listen to leftPanelManager changes — if another panel opens, close settings/hierarchy
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const hierarchyOpenRef = useRef(hierarchyOpen);
  hierarchyOpenRef.current = hierarchyOpen;
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;
  useEffect(() => {
    if (panelSnapshot.activePanel && panelSnapshot.activePanel !== 'settings' && panelSnapshot.activePanel !== 'hierarchy') {
      // Another panel opened (e.g. machine-control) — close our panels
      if (settingsOpenRef.current) pluginRef.current?.setSettingsOpen(false);
      if (hierarchyOpenRef.current) pluginRef.current?.togglePanel();
    }
  }, [panelSnapshot.activePanel]);

  const isMobile = useMobileLayout();

  // WebXR plugin for AR button on mobile
  const xrPlugin = viewer.getPlugin<WebXRPluginAPI>('webxr');
  // Show AR button on any touch device that supports WebXR AR (phones + tablets)
  const hasTouchInput = isMobile || navigator.maxTouchPoints > 0;
  const showMobileAR = hasTouchInput && xrPlugin?.arSupported;

  // Multiuser plugin — only show button when enabled in settings
  const muPlugin = viewer.getPlugin<MultiuserPluginAPI>('multiuser');
  const muState = useMultiuser();
  const [muEnabled, setMuEnabled] = useState(() => loadMultiuserSettings().enabled);
  const showMultiuser = !!muPlugin && muEnabled;

  return (
    <>
      {/* Hierarchy + VR + Settings buttons — fixed top-right */}
      <Paper elevation={4} data-ui-panel sx={{ position: 'fixed', top: 8, right: 8, borderRadius: 2, pointerEvents: 'auto', zIndex: 9001, display: 'flex', gap: isMobile ? 0.5 : 0.25, px: isMobile ? 0.5 : 0.25 }}>
        {plugin && !isMobile && (
          <Tooltip title={hierarchyOpen ? 'Close Hierarchy' : 'Hierarchy'} placement="bottom">
            <IconButton
              size="small"
              color={hierarchyOpen ? 'primary' : 'inherit'}
              sx={{ p: 0.75 }}
              onClick={toggleHierarchy}
            >
              {hierarchyOpen ? <Close fontSize="small" /> : <AccountTree fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        <SlotRenderer slot="toolbar-button" />
        {!isMobile && (
          <Tooltip title="Annotations" placement="bottom">
            <IconButton
              size="small"
              color={panelSnapshot.activePanel === 'annotations' ? 'primary' : 'inherit'}
              sx={{ p: 0.75 }}
              onClick={() => {
                lpm.toggle('annotations', 280);
                setVrOpen(false);
                setMuOpen(false);
                setSettingsOpen(false);
                if (hierarchyOpen) plugin?.togglePanel();
              }}
            >
              {panelSnapshot.activePanel === 'annotations' ? <Close fontSize="small" /> : <PushPin fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        {showMultiuser && !isMobile && (
          <Tooltip title={muOpen ? 'Close Multiuser' : 'Multiuser'} placement="bottom">
            <IconButton
              size="small"
              color={muOpen ? 'primary' : 'inherit'}
              sx={{ p: 0.75, position: 'relative' }}
              onClick={() => { setMuOpen(!muOpen); setVrOpen(false); setSettingsOpen(false); if (hierarchyOpen) plugin?.togglePanel(); }}
            >
              {muOpen ? <Close fontSize="small" /> : <People fontSize="small" />}
              {muState.connected && !muOpen && (
                <Box sx={{ position: 'absolute', top: 4, right: 4, width: 6, height: 6, borderRadius: '50%', bgcolor: '#66bb6a' }} />
              )}
            </IconButton>
          </Tooltip>
        )}
        {!isMobile && (
          <Tooltip title={vrOpen ? 'Close VR/AR' : 'VR / AR'} placement="bottom">
            <IconButton
              size="small"
              color={vrOpen ? 'primary' : 'inherit'}
              sx={{ p: 0.75 }}
              onClick={() => { setVrOpen(!vrOpen); setMuOpen(false); setSettingsOpen(false); if (hierarchyOpen) plugin?.togglePanel(); }}
            >
              {vrOpen ? <Close fontSize="small" /> : <Typography sx={{ fontSize: 11, fontWeight: 700, px: 0.25 }}>VR</Typography>}
            </IconButton>
          </Tooltip>
        )}
        {showMobileAR && (
          <Tooltip title="Start AR" placement="bottom">
            <IconButton
              sx={{ p: 1, color: '#81c784' }}
              onClick={() => xrPlugin?.startAR()}
            >
              <ViewInAr />
            </IconButton>
          </Tooltip>
        )}
        {!isSettingsLocked() && (
          <Tooltip title={settingsOpen ? 'Close Settings' : 'Settings'} placement="bottom">
            <IconButton
              size={isMobile ? 'medium' : 'small'}
              color={settingsOpen ? 'primary' : 'inherit'}
              sx={{ p: isMobile ? 1 : 0.75 }}
              onClick={() => { setSettingsOpen(!settingsOpen); setVrOpen(false); setMuOpen(false); if (hierarchyOpen) plugin?.togglePanel(); }}
            >
              {settingsOpen ? <Close fontSize={isMobile ? 'medium' : 'small'} /> : <Settings fontSize={isMobile ? 'medium' : 'small'} />}
            </IconButton>
          </Tooltip>
        )}
      </Paper>

      {/* Hierarchy browser panel (disabled on mobile, hidden when settings open) */}
      {!isMobile && hierarchyOpen && !settingsOpen && <HierarchyBrowser viewer={viewer} />}

      {/* Property inspector — docked: requires hierarchy open; detached: independent */}
      {!isMobile && !settingsOpen && pluginState.showInspector && pluginState.selectedNodePath
        && (hierarchyOpen || localStorage.getItem('rv-inspector-detached') === 'true')
        && <PropertyInspector viewer={viewer} />}

      {/* Machine Control Panel */}
      <MachineControlPanel />

      {/* AAS detail floating panel */}
      <AasDetailPanel />

      {/* Slot-based overlay panels (Layout Planner, etc.) */}
      <SlotRenderer slot="overlay" />

      {/* Multiuser popup */}
      {muOpen && <MultiuserPanel onClose={() => setMuOpen(false)} />}

      {/* VR/AR modal */}
      {vrOpen && <VRModal onClose={() => setVrOpen(false)} />}

      {/* Settings side panel */}
      {settingsOpen && (
        <LeftPanel
          title={<Typography variant="subtitle2" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>Settings</Typography>}
          onClose={() => setSettingsOpen(false)}
          width={SETTINGS_PANEL_WIDTH}
          headerSx={{ px: 1.5, py: 0.75 }}
        >
          {/* Tabs - scrollable with visible scroll buttons on mobile (MUI hides them by default). */}
          <Tabs
            value={settingsTab}
            onChange={(_, v: number) => setSettingsTab(v)}
            variant="scrollable"
            scrollButtons
            allowScrollButtonsMobile
            sx={{
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              minHeight: 40,
              flexShrink: 0,
              '& .MuiTab-root': { minHeight: 40, py: 1, textTransform: 'none', fontSize: 13, minWidth: 0, px: { xs: 1, sm: 2 } },
              '& .MuiTabs-scrollButtons.Mui-disabled': { opacity: 0.3 },
            }}
          >
            {!isTabLocked('model') && <Tab label="Model" value={0} />}
            {!isTabLocked('visual') && <Tab label="Visual" value={1} />}
            {!isTabLocked('physics') && <Tab label="Physics" value={2} />}
            {!isTabLocked('interfaces') && <Tab label="Interfaces" value={3} />}
            {!isTabLocked('multiuser') && muPlugin && <Tab label="Multiuser" value={4} />}
            {!isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && <Tab label="AI" value={5} />}
            {!isTabLocked('devtools') && <Tab label="Dev Tools" value={6} />}
            {!isTabLocked('tests') && <Tab label="Tests" value={7} />}
            {!isTabLocked('groups') && <Tab label="Groups" value={8} />}
            {/* Plugin-registered settings-tab slots (value = 100..N).
                Rendered inline (not wrapped in a component) so MUI Tabs
                enumerates them via React.Children.map. */}
            {pluginSettingsTabs.map((entry, i) => (
              <Tab key={entry.pluginId ?? i} label={entry.label ?? 'Tab'} value={100 + i} />
            ))}
          </Tabs>

          {/* Tab content - minHeight: 0 for correct flexbox scrolling */}
          <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, px: { xs: 1.5, sm: 2 }, py: 1.5 }}>
            {settingsTab === 0 && !isTabLocked('model') && <ModelTab />}
            {settingsTab === 1 && !isTabLocked('visual') && <VisualTab />}
            {settingsTab === 2 && !isTabLocked('physics') && <PhysicsTab />}
            {settingsTab === 3 && !isTabLocked('interfaces') && <InterfacesTab />}
            {settingsTab === 4 && !isTabLocked('multiuser') && muPlugin && <MultiuserTab muEnabled={muEnabled} onMuEnabledChange={setMuEnabled} />}
            {settingsTab === 5 && !isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && <McpTab />}
            {settingsTab === 6 && !isTabLocked('devtools') && <DevToolsTab />}
            {settingsTab === 7 && !isTabLocked('tests') && <TestsTab />}
            {settingsTab === 8 && !isTabLocked('groups') && <GroupsTab />}
            {settingsTab >= 100 && (
              <PluginSettingsTabContent viewer={viewer} value={settingsTab} offset={100} />
            )}
          </Box>
        </LeftPanel>
      )}
    </>
  );
}

/* ─── VR/AR Modal ─── */

function VRModal({ onClose }: { onClose: () => void }) {
  const vrUrl = window.location.origin + window.location.pathname;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=121212&color=ffffff&data=${encodeURIComponent(vrUrl)}`;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.5)',
        pointerEvents: 'auto',
      }}
      onClick={onClose}
    >
      <Paper
        elevation={12}
        sx={{ borderRadius: 2, width: 420, maxWidth: '95vw', p: { xs: 2.5, sm: 4 }, display: 'flex', flexDirection: 'column', gap: 2.5, alignItems: 'center', maxHeight: '90dvh', overflow: 'auto' }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <Typography variant="h6" sx={{ fontWeight: 700, color: '#4fc3f7' }}>
          VR / AR
        </Typography>

        <Box
          component="img"
          src={qrUrl}
          alt="QR Code"
          sx={{ width: 200, height: 200, borderRadius: 1, border: '1px solid rgba(255,255,255,0.1)' }}
        />

        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', lineHeight: 1.7 }}>
          Scan this QR code with your phone or enter the URL in your <strong style={{ color: '#fff' }}>Meta Quest</strong> browser.
        </Typography>

        <Box
          sx={{
            width: '100%',
            bgcolor: 'rgba(0,0,0,0.3)',
            borderRadius: 1,
            p: 1.5,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            cursor: 'pointer',
            '&:hover': { bgcolor: 'rgba(79,195,247,0.1)' },
          }}
          onClick={() => navigator.clipboard.writeText(vrUrl)}
          title="Click to copy URL"
        >
          <Typography
            variant="body2"
            sx={{
              color: '#4fc3f7',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              flex: 1,
              textAlign: 'center',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {vrUrl}
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>
            COPY
          </Typography>
        </Box>

        <Box sx={{ width: '100%', borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            How to start
          </Typography>
          <StepRow n={1} text="Put on your headset and open the browser" />
          <StepRow n={2} text="Enter the URL above or scan the QR code with your phone" />
          <StepRow n={3} text="Wait for the scene to load, then tap 'Enter VR'" />
        </Box>

        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
          WebXR requires WebGL renderer. WebGPU does not support VR/AR sessions.
        </Typography>
      </Paper>
    </Box>
  );
}

function StepRow({ n, text }: { n: number; text: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
      <Box sx={{
        width: 22, height: 22, borderRadius: '50%', bgcolor: 'rgba(79,195,247,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Typography variant="caption" sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 11 }}>{n}</Typography>
      </Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 13 }}>{text}</Typography>
    </Box>
  );
}

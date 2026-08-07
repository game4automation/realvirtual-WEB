// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SettingsPanel — the Settings left-docked window.
 *
 * Extracted from TopBar so the activity bar can open it via leftPanelManager
 * without TopBar owning the (large) tab UI. Renders the scrollable settings
 * tabs inside a resizable LeftPanel.
 */

import { useState, useEffect, lazy } from 'react';
import { Box, Tabs, Tab, Typography } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { LeftPanel, clampWidth } from './LeftPanel';
import { SETTINGS_PANEL_WIDTH } from './layout-constants';
import { isTabLocked } from './rv-app-config';
import { LazyPanelBoundary } from './LazyPanelBoundary';
import { usePluginSettingsTabs, PluginSettingsTabContent } from './PluginSettingsTabs';
import { useRequestedSettingsTab, clearRequestedSettingsTab } from './settings-tab-store';
import { AiBridgeGate } from './AiBridgeGate';
import { formatVersionFull } from '../rv-version';

// ── Code-split settings tabs (plan-344 Phase 4) ─────────────────────────────
// Settings are a configuration surface, not a runtime one: a session may never
// open them, and most sessions open at most one or two tabs. The tab BODIES were
// nevertheless part of the startup bundle. Unlike the Matrix / Layout Library,
// these already unmount on tab switch (`{settingsTab === N && …}` below) and hold
// no long-lived local state, so the existing gate is exactly the gate lazy
// loading needs — nothing about the tab lifecycle changes here.
const BackupTab = lazy(() => import('./settings/ModelTab').then(m => ({ default: m.BackupTab })));
const MouseTab = lazy(() => import('./settings/MouseTab').then(m => ({ default: m.MouseTab })));
const VisualTab = lazy(() => import('./settings/VisualTab').then(m => ({ default: m.VisualTab })));
const SimulationTab = lazy(() => import('./settings/SimulationTab').then(m => ({ default: m.SimulationTab })));
const InterfacesTab = lazy(() => import('./settings/InterfacesTab').then(m => ({ default: m.InterfacesTab })));
const MultiuserTab = lazy(() => import('./settings/MultiuserTab').then(m => ({ default: m.MultiuserTab })));
const McpTab = lazy(() => import('./settings/McpTab').then(m => ({ default: m.McpTab })));
const DevToolsTab = lazy(() => import('./settings/DevToolsTab').then(m => ({ default: m.DevToolsTab })));
const TestsTab = lazy(() => import('./settings/TestsTab').then(m => ({ default: m.TestsTab })));
const GroupsTab = lazy(() => import('./settings/GroupsTab').then(m => ({ default: m.GroupsTab })));

const LS_KEY_SETTINGS_WIDTH = 'rv-settings-panel-width';
const SETTINGS_MIN_WIDTH = 360;
const SETTINGS_MAX_WIDTH = 900;

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const viewer = useViewer();
  const isMobile = useMobileLayout();
  const [settingsTab, setSettingsTab] = useState(0);
  const pluginSettingsTabs = usePluginSettingsTabs(viewer);
  const muPlugin = viewer.getPlugin('multiuser');

  // Honour an external "open on tab X" request (e.g. the AI activity button →
  // the AI tab). Consumed once so a later manual tab change isn't overridden.
  const requestedTab = useRequestedSettingsTab();
  useEffect(() => {
    if (requestedTab != null) {
      setSettingsTab(requestedTab);
      clearRequestedSettingsTab();
    }
  }, [requestedTab]);

  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(LS_KEY_SETTINGS_WIDTH));
    return clampWidth(stored, SETTINGS_MIN_WIDTH, SETTINGS_MAX_WIDTH) === stored && stored
      ? stored : SETTINGS_PANEL_WIDTH;
  });
  const handleResize = (w: number) => {
    setWidth(w);
    try { localStorage.setItem(LS_KEY_SETTINGS_WIDTH, String(w)); } catch { /* ignore */ }
  };

  // Keep leftPanelManager's tracked width in sync with the real (possibly
  // persisted/resized) panel width, so floating viewport controls and the
  // camera offset shift to the correct position immediately.
  const lpm = viewer.leftPanelManager;
  useEffect(() => {
    if (lpm.getActiveWidth('left') !== width) lpm.open('settings', width);
  }, [lpm, width]);

  return (
    <LeftPanel
      title="Settings"
      onClose={onClose}
      width={width}
      resizable
      minWidth={SETTINGS_MIN_WIDTH}
      maxWidth={SETTINGS_MAX_WIDTH}
      onResize={handleResize}
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
        {!isTabLocked('model') && <Tab label="Backup" value={0} />}
        {/* Plugin-registered settings-tab slots (value = 100..N), rendered right
            after Model so project-level tabs (e.g. "Start View") appear prominently.
            Rendered inline (not wrapped in a component) so MUI Tabs
            enumerates them via React.Children.map. */}
        {pluginSettingsTabs.map((entry, i) => (
          <Tab key={entry.pluginId ?? i} label={entry.label ?? 'Tab'} value={100 + i} />
        ))}
        {!isTabLocked('mouse') && <Tab label="Mouse & Touch" value={9} />}
        {!isTabLocked('visual') && <Tab label="Visual" value={1} />}
        {!isTabLocked('simulation') && <Tab label="Simulation" value={12} />}
        {!isTabLocked('interfaces') && <Tab label="Interfaces" value={3} />}
        {!isTabLocked('multiuser') && muPlugin && <Tab label="Multiuser" value={4} />}
        {/* Dev Tools / Tests are developer tabs — hidden on mobile. AI is not:
            the mobile activity bar has no room for the AI button, so this tab is
            the ONLY mobile entry to the bridge (plan-366, decision 7). */}
        {!isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && <Tab label="AI" value={5} />}
        {!isMobile && !isTabLocked('devtools') && <Tab label="Dev Tools" value={6} />}
        {!isMobile && !isTabLocked('tests') && <Tab label="Tests" value={7} />}
        {!isTabLocked('groups') && <Tab label="Groups" value={8} />}
        <Tab label="Local Folder" value={11} />
      </Tabs>

      {/* Tab content - minHeight: 0 for correct flexbox scrolling.
          One boundary for all tabs: only ever one is mounted, and a chunk that
          fails to load must not take the surrounding Settings window with it. */}
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, px: 0.75, py: 1 }}>
        <LazyPanelBoundary label="Settings tab">
        {settingsTab === 0 && !isTabLocked('model') && <BackupTab />}
        {settingsTab === 9 && !isTabLocked('mouse') && <MouseTab />}
        {settingsTab === 1 && !isTabLocked('visual') && <VisualTab />}
        {settingsTab === 12 && !isTabLocked('simulation') && <SimulationTab />}
        {settingsTab === 3 && !isTabLocked('interfaces') && <InterfacesTab />}
        {settingsTab === 4 && !isTabLocked('multiuser') && muPlugin && <MultiuserTab />}
        {/* The gate is in front of the MOUNT, not in the button that opens this
            tab: this tab is directly reachable and is the only mobile entry, so a
            click-handler check would be walked around. `<McpTab />` is a lazy
            element — creating it does not fetch its chunk, only rendering does. */}
        {settingsTab === 5 && !isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && (
          <AiBridgeGate><McpTab /></AiBridgeGate>
        )}
        {settingsTab === 6 && !isTabLocked('devtools') && <DevToolsTab />}
        {settingsTab === 7 && !isTabLocked('tests') && <TestsTab />}
        {settingsTab === 8 && !isTabLocked('groups') && <GroupsTab />}
        {settingsTab >= 100 && (
          <PluginSettingsTabContent viewer={viewer} value={settingsTab} offset={100} />
        )}
        </LazyPanelBoundary>
      </Box>

      {/* Version footer — always visible, independent of the active tab. */}
      <Box
        sx={{
          flexShrink: 0,
          px: 1.5,
          py: 0.5,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Typography
          variant="caption"
          title="realvirtual WEB build version"
          sx={{ color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', fontSize: 10 }}
        >
          realvirtual WEB {formatVersionFull()}
        </Typography>
      </Box>
    </LeftPanel>
  );
}

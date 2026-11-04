// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';
import { SETTINGS_LAST_TAB_KEY } from './rv-storage-keys';

/**
 * SettingsPanel — the Settings left-docked window.
 *
 * Extracted from TopBar so the activity bar can open it via leftPanelManager
 * without TopBar owning the (large) tab UI. Renders the scrollable settings
 * tabs inside a resizable LeftPanel.
 */

import { useState, useEffect, lazy, type ReactElement } from 'react';
import { Box, Tabs, Tab, Typography, Link } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { LeftPanel, clampWidth } from './LeftPanel';
import { SETTINGS_PANEL_WIDTH } from './layout-constants';
import { isTabLocked } from './rv-app-config';
import { LazyPanelBoundary } from './LazyPanelBoundary';
import { usePluginSettingsTabs, PluginSettingsTabContent } from './PluginSettingsTabs';
import { useRequestedSettingsTab, clearRequestedSettingsTab } from './settings-tab-store';
import { AiBridgeGate } from './AiBridgeGate';
import { useDevTestApi } from './use-dev-test-api';
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
const ConnectChannelRow = lazy(() => import('./settings/ConnectChannelRow').then(m => ({ default: m.ConnectChannelRow })));
const DevToolsTab = lazy(() => import('./settings/DevToolsTab').then(m => ({ default: m.DevToolsTab })));
const TestsTab = lazy(() => import('./settings/TestsTab').then(m => ({ default: m.TestsTab })));
const GroupsTab = lazy(() => import('./settings/GroupsTab').then(m => ({ default: m.GroupsTab })));
const HelpDiagnosticsTab = lazy(() => import('./settings/HelpDiagnosticsTab').then(m => ({ default: m.HelpDiagnosticsTab })));

const LS_KEY_SETTINGS_WIDTH = 'rv-settings-panel-width';
const SETTINGS_MIN_WIDTH = 360;
const SETTINGS_MAX_WIDTH = 900;

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const viewer = useViewer();
  const isMobile = useMobileLayout();
  // null = nothing chosen yet -> the first visible tab of the merged order (see below).
  const [chosenTab, setSettingsTab] = useState<number | null>(null);
  const pluginSettingsTabs = usePluginSettingsTabs(viewer);
  const muPlugin = viewer.getPlugin('multiuser');
  // The Tests tab appears only where the test API actually answers — asked once
  // per session, never inferred from the build mode (see core/rv-dev-api.ts).
  // `null` (no answer yet, or none to be had) keeps the tab out, which is the
  // state of every delivered build: a visitor of the public demo clicked
  // "Run Tests", the static host answered `index.html` with HTTP 200, and the
  // tab showed them the JSON parser's "Unexpected token '<'".
  const devTestApi = useDevTestApi();

  // ── Tab order ─────────────────────────────────────────────────────────────
  // ONE merged list: fixed tabs and plugin `settings-tab` slots are interleaved by an
  // order number (ascending). The tab VALUES are independent of the order and stay
  // stable (fixed tabs 0..13, plugin slot i = 100 + i) because requestSettingsTab()
  // callers and the tab bodies below address tabs by value.
  // Scale for plugin authors (`order` of the slot entry; default 500):
  //   100-199 viewing/input (Visual 100, Start View 110, Mouse & Touch 120)
  //   200-299 runtime        (Simulation 200, Interfaces 210, Multiuser 220, AI 230)
  //   300-399 project/data   (Groups 300, Backup 310)
  //   400-799 devices & add-ons (SpaceMouse 400, Stereo 3D 410)
  //   800+    admin/developer (Features 800, Dev Tools 900, Tests 910, Help & diagnostics 990)
  const orderedTabs: { order: number; id: string; value: number; el: ReactElement }[] = [];
  if (!isTabLocked('visual')) orderedTabs.push({ order: 100, id: 'visual', value: 1, el: <Tab key="visual" label="Visual" value={1} /> });
  if (!isTabLocked('mouse')) orderedTabs.push({ order: 120, id: 'mouse', value: 9, el: <Tab key="mouse" label="Mouse & Touch" value={9} /> });
  if (!isTabLocked('simulation')) orderedTabs.push({ order: 200, id: 'simulation', value: 12, el: <Tab key="simulation" label="Simulation" value={12} /> });
  if (!isTabLocked('interfaces')) orderedTabs.push({ order: 210, id: 'interfaces', value: 3, el: <Tab key="interfaces" label="Interfaces" value={3} /> });
  if (!isTabLocked('multiuser') && muPlugin) orderedTabs.push({ order: 220, id: 'multiuser', value: 4, el: <Tab key="multiuser" label="Multiuser" value={4} /> });
  // AI is not hidden on mobile: the mobile activity bar has no room for the AI button,
  // so this tab is the ONLY mobile entry to the bridge (plan-366, decision 7).
  if (!isTabLocked('mcp') && viewer.getPlugin('mcp-bridge')) orderedTabs.push({ order: 230, id: 'mcp', value: 5, el: <Tab key="mcp" label="AI" value={5} /> });
  if (!isTabLocked('groups')) orderedTabs.push({ order: 300, id: 'groups', value: 8, el: <Tab key="groups" label="Groups" value={8} /> });
  if (!isTabLocked('model')) orderedTabs.push({ order: 310, id: 'model', value: 0, el: <Tab key="model" label="Backup" value={0} /> });
  // Dev Tools / Tests are developer tabs — hidden on mobile.
  if (!isMobile && !isTabLocked('devtools')) orderedTabs.push({ order: 900, id: 'devtools', value: 6, el: <Tab key="devtools" label="Dev Tools" value={6} /> });
  if (!isMobile && !isTabLocked('tests') && devTestApi !== null) orderedTabs.push({ order: 910, id: 'tests', value: 7, el: <Tab key="tests" label="Tests" value={7} /> });
  orderedTabs.push({ order: 990, id: 'help', value: 13, el: <Tab key="help" label="Help & diagnostics" value={13} /> });
  pluginSettingsTabs.forEach((entry, i) => {
    const id = `plugin:${entry.pluginId ?? entry.label ?? i}`;
    orderedTabs.push({ order: entry.order ?? 500, id, value: 100 + i, el: <Tab key={id} label={entry.label ?? 'Tab'} value={100 + i} /> });
  });
  // Array.prototype.sort is stable: equal orders keep insertion order (fixed before plugin).
  orderedTabs.sort((a, b) => a.order - b.order);
  // Direct <Tab> elements (no wrapper component) — MUI Tabs enumerates its children.
  const tabElements = orderedTabs.map(t => t.el);
  // Which tab is open: explicit request (below) > this session's choice > the last tab
  // stored for this installation (by STABLE id, only if still visible) > first visible tab.
  const storedId = readLocalStorage(SETTINGS_LAST_TAB_KEY);
  const storedValue = storedId ? orderedTabs.find(t => t.id === storedId)?.value : undefined;
  const settingsTab = chosenTab ?? storedValue ?? orderedTabs[0]?.value ?? 0;
  const selectTab = (value: number) => {
    setSettingsTab(value);
    const id = orderedTabs.find(t => t.value === value)?.id;
    if (id) writeLocalStorage(SETTINGS_LAST_TAB_KEY, id);
  };

  // Honour an external "open on tab X" request (e.g. the AI activity button →
  // the AI tab). Consumed once so a later manual tab change isn't overridden.
  const requestedTab = useRequestedSettingsTab();
  useEffect(() => {
    if (requestedTab != null) {
      selectTab(requestedTab); // a request wins and becomes the remembered tab
      clearRequestedSettingsTab();
    }
  }, [requestedTab]);

  const [width, setWidth] = useState<number>(() => {
    const stored = Number(readLocalStorage(LS_KEY_SETTINGS_WIDTH));
    return clampWidth(stored, SETTINGS_MIN_WIDTH, SETTINGS_MAX_WIDTH) === stored && stored
      ? stored : SETTINGS_PANEL_WIDTH;
  });
  const handleResize = (w: number) => {
    setWidth(w);
    try { writeLocalStorage(LS_KEY_SETTINGS_WIDTH, String(w)); } catch { /* ignore */ }
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
        onChange={(_, v: number) => selectTab(v)}
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
        {tabElements}
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
        {/* plan-668: the CONNECT channel row is NOT behind the gate — the channel is
            CONNECT infrastructure (SolidCraft, server log), on whether or not AI control is. */}
        {settingsTab === 5 && !isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && (
          <>
            <ConnectChannelRow />
            <AiBridgeGate><McpTab /></AiBridgeGate>
          </>
        )}
        {settingsTab === 6 && !isTabLocked('devtools') && <DevToolsTab />}
        {settingsTab === 7 && !isTabLocked('tests') && devTestApi !== null && <TestsTab />}
        {settingsTab === 8 && !isTabLocked('groups') && <GroupsTab />}
        {settingsTab === 13 && <HelpDiagnosticsTab />}
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
          display: 'flex',
          alignItems: 'baseline',
          gap: 0.75,
          flexWrap: 'wrap',
        }}
      >
        <Typography
          variant="caption"
          title="realvirtual WEB build version"
          sx={{ color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', fontSize: 10 }}
        >
          realvirtual WEB {formatVersionFull()}
        </Typography>
        <OpenSourceLicensesLink />
      </Box>
    </LeftPanel>
  );
}

/**
 * "Open-source licenses" — opens the THIRD-PARTY-NOTICES.txt every build ships next to
 * index.html (plan-544 F7). Relative to the deploy base, so it works on every channel
 * (hosted sub-paths, CONNECT's /webviewer, a customer workspace). The dev server answers the
 * same URL with a development preview.
 */
export function OpenSourceLicensesLink() {
  return (
    <Link
      href={`${import.meta.env.BASE_URL}THIRD-PARTY-NOTICES.txt`}
      target="_blank"
      rel="noopener noreferrer"
      underline="hover"
      title="Third-party software notices"
      data-testid="settings-open-source-licenses"
      sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, '&:hover': { color: 'rgba(255,255,255,0.6)' } }}
    >
      · Open-source licenses ↗
    </Link>
  );
}

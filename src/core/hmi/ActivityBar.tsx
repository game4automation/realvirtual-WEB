// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ActivityBar — the VSCode-style left vertical icon strip that owns the buttons
 * which OPEN a left-docked window. Core windows (Models, Hierarchy, Annotations,
 * Settings) render directly; plugins contribute via the `activity-bar` slot
 * (e.g. Connect, Order Manager). All open/close state lives in leftPanelManager
 * / the editor plugin (single source of truth); the docked windows render
 * edge-to-edge to the bar's right (see LeftPanel.buildPanelSx).
 *
 * NOT to be confused with the floating ButtonPanel, which hosts contextual
 * mode TOOLS (planner delete/grid/snap, measurement, …) as a floating toolbar.
 *
 * Desktop: flush vertical bar (width ACTIVITY_BAR_WIDTH). Mobile: a "⋮"
 * overflow menu pinned to the top-right corner (NOT a bottom strip — the
 * ButtonPanel owns the bottom edge there).
 */

import { useState, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Paper, IconButton, Tooltip, Divider, Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
import { FolderOpen, AccountTree, PushPin, Settings, ViewInAr, Memory, MoreVert, Bolt, HelpOutline } from '@mui/icons-material';
import { useMcpBridge } from '../../hooks/use-mcp-bridge';
import { useAiActivity } from './ai-activity-store';
import { probeConnectReachable } from './ai-consent-store';
import { AiBridgeDownloadDialog } from './AiBridgeGate';
import { requestSettingsTab } from './settings-tab-store';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import {
  ACTIVITY_BAR_WIDTH, ANNOTATION_PANEL_WIDTH, LEFT_PANEL_ZINDEX,
  SCENE_PANEL_WIDTH, SETTINGS_PANEL_WIDTH,
} from './layout-constants';
import { isSettingsLocked } from './rv-app-config';
import { getSceneStore } from './scene/scene-store-singleton';
import { getProjectStore } from '../project/project-store';
import {
  getProjectsDashboardSnapshot,
  subscribeProjectsDashboard,
  toggleProjectsDashboard,
} from './projects/projects-dashboard-store';
import { useActiveContexts, evaluateVisibilityRule, useUIVisible } from './ui-context-store';
import {
  HELP_UI_ELEMENT_ID, HELP_VISIBILITY_RULE, helpAriaLabel, helpTooltip,
  openCurrentHelp, useHelpTopic,
} from './help-context';
import { LogoBadge } from './ButtonPanel';
import { MultiuserButton } from './MultiuserPanel';
import { DirtyDot } from './rv-dirty-dot';
import type { WebXRPluginAPI } from '../types/plugin-types';

/** Stand-in subscribe for the boot window in which there is no scene store. */
const NO_STORE_SUBSCRIBE = () => () => {};

/**
 * What the unsaved mark means, in the two cases that differ for the user.
 *
 * A transient workspace — a shared link, an Example — persists nothing at all
 * by design, so "unsaved" there is not a chore to get around to but a warning:
 * the work exists only in this tab. Saying so is the difference between the
 * user copying it somewhere and losing it to a reload.
 */
export function unsavedTitle(transient: boolean): string {
  return transient
    ? 'Unsaved — this scene is not stored anywhere yet; reloading discards it'
    : 'Unsaved changes';
}

/** Tooltip of the Projects entry: which project, plus the unsaved state. */
export function projectsEntryTitle(
  projectName: string | null,
  dirty: boolean,
  transient: boolean,
): string {
  const base = projectName ? `Projects — ${projectName}` : 'Projects';
  return dirty ? `${base} · ${unsavedTitle(transient)}` : base;
}

/**
 * Tooltip of the AI Bridge entry — the icon's accent says "connected", the
 * tooltip says to what. While a tool call is running the label rides along, so
 * the button alone answers "is something driving my scene right now?" even when
 * the AiActivityOverlay pill is off-screen or covered.
 */
export function aiBridgeTitle(
  mcp: { connected: boolean; enabled: boolean; toolCount: number },
  activity: string | null,
): string {
  if (!mcp.connected) return mcp.enabled ? 'AI Bridge — connecting…' : 'AI Bridge — off';
  const base = `AI Bridge — connected (${mcp.toolCount} tools)`;
  return activity ? `${base} · ${activity}` : base;
}

/** One icon button in the activity bar. */
function ActivityButton({
  title, active, onClick, placement, children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  placement: 'right' | 'top';
  children: ReactNode;
}) {
  return (
    <Tooltip title={title} placement={placement}>
      <IconButton size="medium" color={active ? 'primary' : 'inherit'} onClick={onClick}>
        {children}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Context-sensitive help (plan-370) — the bottom-most entry.
 *
 * Opens the documentation page matching the current state in a new tab. Never
 * disabled and never a dead end: without a derivable context it opens the
 * documentation root. `active` is permanently false — this button does not open
 * a state inside the viewer, it leaves it.
 *
 * The accessible name carries the target AND the tab change, because
 * `target="_blank"` is not reliably announced by screen readers. The tooltip is
 * an addition to that name, never its only carrier.
 */
function HelpButton({ placement }: { placement: 'right' | 'top' }) {
  const viewer = useViewer();
  const topic = useHelpTopic();
  return (
    <Tooltip title={helpTooltip(topic)} placement={placement}>
      <IconButton
        size="medium"
        color="inherit"
        aria-label={helpAriaLabel(topic)}
        onClick={() => openCurrentHelp(viewer)}
      >
        <HelpOutline />
      </IconButton>
    </Tooltip>
  );
}

export type ActivityBarEntryId =
  | 'about'
  | 'models'
  | 'hierarchy'
  | 'annotations'
  | 'settings'
  | 'multiuser'
  | 'omniverse'
  | 'ai-bridge'
  | 'ar'
  | 'help'
  | `plugin:${string}`;

interface ActivityBarProps {
  /** Optional local allowlist used by constrained shells such as CONNECT embed. */
  entryAllowlist?: readonly ActivityBarEntryId[];
}

/**
 * Omniverse RTX backend toggle (internal/experimental tier only).
 * Switches the 3D render layer between the local Three.js renderer and an
 * Omniverse RTX WebRTC stream (connects to the configured signaling port,
 * default 49100). Only shown when the omniverse backend factory is registered
 * (__RV_INTERNAL__ builds) — customer builds never see it.
 */
function OmniverseButton({ placement }: { placement: 'right' | 'top' }) {
  const viewer = useViewer();
  const [backend, setBackend] = useState(viewer.renderBackend);
  useEffect(() => viewer.onRenderBackendChange(setBackend), [viewer]);
  if (!__RV_INTERNAL__ || !viewer.hasRenderBackend('omniverse')) return null;
  const active = backend === 'omniverse';
  return (
    <ActivityButton
      title={active ? 'Omniverse RTX Stream (on) — click for Three.js' : 'Omniverse RTX Stream'}
      active={active}
      onClick={() => { void viewer.setRenderBackend(active ? 'three' : 'omniverse'); }}
      placement={placement}
    >
      <Bolt />
    </ActivityButton>
  );
}

export function ActivityBar({ entryAllowlist }: ActivityBarProps = {}) {
  const viewer = useViewer();
  const { plugin, state: editorState } = useEditorPlugin();
  const isMobile = useMobileLayout();
  const lpm = viewer.leftPanelManager;
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const sceneStore = getSceneStore();
  // Projects dashboard state + the open project drive the entry's title, its
  // active state and the ambient writable-project dot (§3.5).
  const dashboardSnapshot = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);
  const projectStore = getProjectStore();
  const projectSnapshot = useSyncExternalStore(projectStore.subscribe, projectStore.getSnapshot);
  // Unsaved work on the Projects icon — the same amber mark the asset card and
  // the breadcrumb use, so one glance at the rail answers "did I leave
  // something unsaved?" without opening the dashboard. Selects two primitives
  // rather than the snapshot object: the store does cache the snapshot, but a
  // component that re-renders on every scene notification would repaint the
  // whole rail for an undo label it does not show.
  //
  // Both halves are called through `?.`: the rail is mounted by shells and
  // tests that supply a partial scene store (subscribe but no snapshot, or
  // neither), and a missing method here would take down the whole ActivityBar —
  // help button, settings, AI entry — over a dot. `ProjectStore` reads the same
  // seam the same way.
  const sceneSubscribe = typeof sceneStore?.subscribe === 'function'
    ? sceneStore.subscribe
    : NO_STORE_SUBSCRIBE;
  const sceneDirty = useSyncExternalStore(
    sceneSubscribe,
    () => sceneStore?.getSnapshot?.()?.dirty === true,
  );
  const sceneTransient = useSyncExternalStore(
    sceneSubscribe,
    () => sceneStore?.getSnapshot?.()?.transient === true,
  );
  const placement = isMobile ? 'top' as const : 'right' as const;
  // Mobile: anchor for the top-right "⋮" window-opener menu.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const isEntryAllowed = (entry: ActivityBarEntryId) =>
    !entryAllowlist || entryAllowlist.includes(entry);

  // Help is offered by default; kiosk deployments (and any `ui.visibilityOverrides`
  // that redefines the rule) can take it away. The F1 route reads the SAME rule.
  const helpVisible = useUIVisible(HELP_UI_ELEMENT_ID, HELP_VISIBILITY_RULE);
  const showHelp = isEntryAllowed('help') && helpVisible;

  // plan-387: the bar itself stays in the Viewer workspace — it carries the
  // logo/About, Settings and Help, which the viewer keeps. Everything that opens
  // an authoring or engineering surface is gated away here (F4). Plugin-
  // contributed buttons carry their own rules (see the slot filter below).
  const showProjectsEntry = useUIVisible('activity-projects', { hiddenIn: ['mode:viewer'] });
  const showHierarchyEntry = useUIVisible('activity-hierarchy', { hiddenIn: ['mode:viewer'] });
  const showAnnotationsEntry = useUIVisible('activity-annotations', { hiddenIn: ['mode:viewer'] });
  const showMultiuserEntry = useUIVisible('activity-multiuser', { hiddenIn: ['mode:viewer'] });
  const showOmniverseEntry = useUIVisible('activity-omniverse', { hiddenIn: ['mode:viewer'] });
  const showAiBridgeEntry = useUIVisible('activity-ai-bridge', { hiddenIn: ['mode:viewer'] });

  /**
   * One gate per entry, combining the shell allowlist (CONNECT embed) with the
   * context rules above. Entries with no rule default to visible, so 'about',
   * 'settings', 'ar', 'help' and plugin entries pass through untouched.
   * Every call site below uses this instead of `isEntryAllowed` so the desktop
   * bar and the mobile "⋮" menu can never drift apart.
   */
  const modeGated: Partial<Record<ActivityBarEntryId, boolean>> = {
    models: showProjectsEntry,
    hierarchy: showHierarchyEntry,
    annotations: showAnnotationsEntry,
    multiuser: showMultiuserEntry,
    omniverse: showOmniverseEntry,
    'ai-bridge': showAiBridgeEntry,
  };
  const isEntryShown = (entry: ActivityBarEntryId) =>
    isEntryAllowed(entry) && (modeGated[entry] ?? true);

  // Plugin-contributed window-opener buttons (Connect, Order Manager, …).
  const contexts = useActiveContexts();
  const slotEntries = useSlot('activity-bar').filter(
    (e) => isEntryAllowed(`plugin:${e.pluginId ?? 'unknown'}`)
      && (!e.visibilityRule || evaluateVisibilityRule(e.visibilityRule, contexts)),
  );
  const pluginButtons = slotEntries.map((entry, i) => {
    const Comp = entry.component;
    return <Comp key={`act-${i}`} viewer={viewer} />;
  });

  // ── Core left-window button handlers (single source of truth = lpm/plugin) ──
  // plan-372 §3.5: the entry point is the Projects dashboard, not the docked
  // "scene" left panel. The dashboard owns its own open state (it is a
  // full-screen overlay with no width to negotiate), so this no longer goes
  // through the LeftPanelManager.
  const toggleScene = () => toggleProjectsDashboard();
  const toggleHierarchy = () => plugin?.togglePanel();
  const toggleAnnotations = () => lpm.toggle('annotations', ANNOTATION_PANEL_WIDTH);
  const toggleSettings = () => {
    const open = editorState.settingsOpen;
    plugin?.setSettingsOpen(!open);
    if (!open) lpm.open('settings', SETTINGS_PANEL_WIDTH);
    else lpm.close('settings');
  };

  // AI activity button (above Settings). Visible whether or not a bridge is
  // connected — gating it on `mcp.connected` hid the entry from exactly the
  // people who do not know CONNECT exists yet (plan-366 Phase 6). Click opens the
  // Settings panel on the AI tab, where AiBridgeGate asks for consent before the
  // panel mounts. The status text rides beside the button over the 3D scene via
  // AiActivityOverlay.
  //
  // The accent (`active`) tracks the CONNECTION, not the momentary tool call: a
  // live bridge is a standing state of this session and is worth seeing at rest,
  // whereas the 3s activity flicker made the icon look broken between calls. The
  // per-call signal stays where it reads better — the AiActivityOverlay pill and
  // the tooltip.
  const mcp = useMcpBridge();
  const aiActivity = useAiActivity();
  const [aiProbe, setAiProbe] = useState<'idle' | 'probing' | 'unreachable'>('idle');
  const openAiSettings = () => {
    if (!editorState.settingsOpen) {
      plugin?.setSettingsOpen(true);
      lpm.open('settings', SETTINGS_PANEL_WIDTH);
    }
    requestSettingsTab(5); // AI tab
  };
  // Three states, decided at click time so nothing polls localhost in the
  // background: a live bridge goes straight through, otherwise `/health` decides
  // between the AI panel and the download dead end.
  const openAiEntry = async () => {
    if (aiProbe === 'probing') return;
    if (mcp.connected) { openAiSettings(); return; }
    setAiProbe('probing');
    const reachable = await probeConnectReachable();
    setAiProbe(reachable ? 'idle' : 'unreachable');
    if (reachable) openAiSettings();
  };

  // Hierarchy is desktop-only (no usable tree on phones).
  const hasCoreTopEntries = isEntryShown('annotations')
    || (isEntryShown('models') && !!sceneStore)
    || (isEntryShown('hierarchy') && !!plugin && !isMobile);
  const coreTop = (
    <>
      {isEntryShown('models') && sceneStore && (
        <ActivityButton
          title={projectsEntryTitle(projectSnapshot.project?.name ?? null, sceneDirty, sceneTransient)}
          active={dashboardSnapshot.open}
          onClick={toggleScene}
          placement={placement}
        >
          <FolderOpen />
          {/* One corner, two possible marks, unsaved wins. The ambient dot says
              "a writable project is open", which is worth knowing but never as
              urgent as "you have work that is not saved"; showing both would put
              two dots of different meaning in the same 6px corner. */}
          {sceneDirty ? (
            <DirtyDot
              size={6}
              title={unsavedTitle(sceneTransient)}
              sx={{ position: 'absolute', right: 6, top: 6 }}
            />
          ) : projectSnapshot.project && projectSnapshot.writable && (
            <Box
              sx={{
                position: 'absolute',
                right: 6,
                top: 6,
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: 'primary.main',
              }}
            />
          )}
        </ActivityButton>
      )}
      {isEntryShown('hierarchy') && plugin && !isMobile && (
        <ActivityButton title="Hierarchy" active={editorState.panelOpen} onClick={toggleHierarchy} placement={placement}>
          <AccountTree />
        </ActivityButton>
      )}
      {isEntryShown('annotations') && (
        <ActivityButton title="Annotations" active={panelSnapshot.activePanel === 'annotations'} onClick={toggleAnnotations} placement={placement}>
          <PushPin />
        </ActivityButton>
      )}
    </>
  );

  const settingsButton = isEntryAllowed('settings') && !isSettingsLocked() && plugin && (
    <ActivityButton title="Settings" active={editorState.settingsOpen} onClick={toggleSettings} placement={placement}>
      <Settings />
    </ActivityButton>
  );

  // Mobile-only AR entry (moved here from the removed top bar). Shown on any
  // touch device whose WebXR supports AR.
  const xrPlugin = viewer.getPlugin<WebXRPluginAPI>('webxr');
  const hasTouchInput = isMobile || navigator.maxTouchPoints > 0;
  const arButton = isEntryAllowed('ar') && hasTouchInput && xrPlugin?.arSupported && (
    <ActivityButton title="Start AR" active={false} onClick={() => xrPlugin?.startAR()} placement={placement}>
      <ViewInAr />
    </ActivityButton>
  );

  if (isMobile && !entryAllowlist) {
    // Mobile: a single "⋮" menu in the top-right corner replaces the bottom nav
    // strip. It holds the window openers (Models, Annotations, Settings). PLC
    // Connect and the Hierarchy tree are intentionally NOT exposed on mobile.
    // Neither is the AI bridge BUTTON — there is no room in the strip, so mobile
    // reaches the AI panel through Settings ▸ AI instead (plan-366, decision 7).
    // Multiuser + AR ride as their own buttons beside the menu.
    const closeMenu = () => setMenuAnchor(null);
    const run = (fn: () => void) => () => { fn(); closeMenu(); };
    return (
      <Box
        sx={{
          position: 'fixed',
          top: 'calc(8px + env(safe-area-inset-top, 0px))',
          right: 8,
          zIndex: LEFT_PANEL_ZINDEX,
          display: 'flex', alignItems: 'center', pointerEvents: 'auto',
        }}
      >
        {/* One pill holding Multiuser / AR / ⋮ at top-bar height (≈34px). */}
        <Paper
          elevation={4}
          data-ui-panel
          sx={{
            borderRadius: 1, display: 'flex', alignItems: 'center',
            bgcolor: 'rgba(38,38,38,0.95)', backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
            '& .MuiIconButton-root': { width: 40, height: 34, borderRadius: 1, color: 'rgba(255,255,255,0.92)' },
            '& .MuiSvgIcon-root': { fontSize: 20 },
          }}
        >
          {isEntryShown('multiuser') && <MultiuserButton placement="top" />}
          {arButton}
          <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="Menu">
            <MoreVert />
          </IconButton>
        </Paper>
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={closeMenu}>
          {isEntryShown('models') && sceneStore && (
            <MenuItem onClick={run(toggleScene)} sx={{ fontSize: 13 }}>
              <ListItemIcon><FolderOpen fontSize="small" /></ListItemIcon>
              <ListItemText>Projects</ListItemText>
            </MenuItem>
          )}
          {isEntryShown('annotations') && (
            <MenuItem onClick={run(toggleAnnotations)} sx={{ fontSize: 13 }}>
              <ListItemIcon><PushPin fontSize="small" /></ListItemIcon>
              <ListItemText>Annotations</ListItemText>
            </MenuItem>
          )}
          {settingsButton && (
            <MenuItem onClick={run(toggleSettings)} sx={{ fontSize: 13 }}>
              <ListItemIcon><Settings fontSize="small" /></ListItemIcon>
              <ListItemText>Settings</ListItemText>
            </MenuItem>
          )}
          {showHelp && (
            <MenuItem onClick={run(() => openCurrentHelp(viewer))} sx={{ fontSize: 13 }}>
              <ListItemIcon><HelpOutline fontSize="small" /></ListItemIcon>
              <ListItemText>Help</ListItemText>
            </MenuItem>
          )}
        </Menu>
      </Box>
    );
  }

  // Desktop: flush, edge-to-edge vertical activity bar, full height from the top.
  return (
    <Box
      data-ui-panel
      sx={{
        position: 'fixed', left: 0, top: 0, bottom: 0,
        width: ACTIVITY_BAR_WIDTH, zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25, py: 0.5,
        bgcolor: 'rgba(38,38,38,0.95)', backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
        borderRight: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.92)', pointerEvents: 'auto',
      }}
    >
      {/* realvirtual logo — the top-left corner mark; opens the About modal. */}
      {isEntryAllowed('about') && (
        <>
          <LogoBadge />
          <Divider flexItem sx={{ mx: 0.75, my: 0.25, borderColor: 'rgba(255,255,255,0.12)' }} />
        </>
      )}
      {coreTop}
      {pluginButtons.length > 0 && hasCoreTopEntries && (
        <Divider flexItem sx={{ mx: 0.75, my: 0.25, borderColor: 'rgba(255,255,255,0.12)' }} />
      )}
      {pluginButtons}
      {/* Spacer pushes the bottom group (Multiuser, Settings) down (VSCode convention). */}
      <Box sx={{ flex: 1 }} />
      {isEntryShown('multiuser') && <MultiuserButton placement={placement} />}
      {isEntryShown('omniverse') && <OmniverseButton placement={placement} />}
      {/* Always offered — except where a deploy removed the entry through the
          feature matrix; `isEntryAllowed` still beats "always visible". */}
      {isEntryShown('ai-bridge') && (
        <ActivityButton
          title={aiBridgeTitle(mcp, aiActivity)}
          active={mcp.connected}
          onClick={() => { void openAiEntry(); }}
          placement={placement}
        >
          <Memory />
        </ActivityButton>
      )}
      {settingsButton}
      {/* Bottom-most entry — the way out of the product into the documentation. */}
      {showHelp && <HelpButton placement={placement} />}
      {isEntryShown('ai-bridge') && (
        <AiBridgeDownloadDialog open={aiProbe === 'unreachable'} onClose={() => setAiProbe('idle')} />
      )}
    </Box>
  );
}

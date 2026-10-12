// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { Box, CssBaseline, IconButton, Tooltip } from '@mui/material';

// Inter is the product font (DESIGN.md); without these imports every non-MUI
// element falls back to the browser default serif.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import { VisibilityOff } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import {
  ackRecordingFrame,
  getRecordingFrame,
  isRecordingHmiActive,
  isRecordingOverlayAllowed,
  subscribeRecordingFrame,
  subscribeRecordingHmi,
} from '../engine/rv-recording-hmi';
import { OperatorPanelController } from './operator-devices/operator-panel-model';
import type { UISlotEntry } from '../rv-ui-plugin';
import type { RVViewer } from '../rv-viewer';

// Core HMI components
import { rvDarkTheme, createBrandedTheme } from './theme';
import { useCustomBranding } from './branding-store';
import { HMIShell, SlotRenderer } from './HMIShell';
import { TopBar } from './TopBar';
import { TitleBar } from './TitleBar';
import { KpiBar } from './KpiBar';
import { ActivityBar } from './ActivityBar';
import { ViewportFrame } from './ViewportFrame';
import { ButtonPanel } from './ButtonPanel';
import { MessagePanel } from './MessagePanel';
import { ProblemsPanel } from './ProblemsPanel';
import { BottomBar } from './BottomBar';
import { GroupsOverlay } from './GroupsOverlay';

import { loadVisualSettings } from './visual-settings-store';
import { useHmiVisible, toggleHmiVisible, useHmiToggleShortcut } from './hmi-visibility-store';
import { useUIVisible } from './ui-context-store';
import { ANNOTATION_PANEL_GATE, CONNECT_PANEL_GATE, ORDER_PANEL_GATE } from './left-panel-visibility';
import { useHelpShortcut } from './help-context';

// Generic tooltip system (replaces former DriveTooltip)
import { TooltipLayer } from './tooltip/TooltipLayer';
import { AnchoredPopover } from './AnchoredPopover';
import { MobileSelectionSheet } from './MobileSelectionSheet';
import { SignalDragGhost } from './SignalDragGhost';
import './IKTargetQuickEdit'; // self-registers the 'ik-target' popover content
import '../../plugins/signal-bind/SignalBindPopover'; // self-registers the 'signal-bind' popover content
import { tooltipRegistry } from './tooltip/tooltip-registry';
// Import tooltip content providers (triggers self-registration of content + data resolvers).
// Drive tooltip is NOT imported here — it's optional and lives in per-model plugin packs
// (DemoRealvirtualWeb side-effect-imports it). Side-effect-import the file from your
// own model plugin if you want the live drive HUD floating over the scene.
import './tooltip/PipeTooltipContent';
import './tooltip/TankTooltipContent';
import './tooltip/PumpTooltipContent';
import './tooltip/ProcessingUnitTooltipContent';
import './tooltip/MetadataTooltipContent';
import './tooltip/WebSensorTooltipContent';
import './tooltip/LampTooltipContent';
import './tooltip/PdfTooltipSection';
// Generic PDF viewer bridge (self-registers as controller)
import './pdf-viewer-store';
// Generic info overlay bridge (self-registers as controller)
import './info-overlay-store';
// Generic controller replaces DriveTooltipController, PipelineTooltipController, MetadataTooltipController
import './tooltip/GenericTooltipController';
import { tooltipStore } from './tooltip/tooltip-store';
// Import custom field renderers to trigger self-registration
import './rv-metadata-field-renderer';
import './rv-ik-path-field-renderer';
import './rv-ribbon-path-rollers-field-renderer';
import './rv-custom-runtime-instruction-field-renderer';
import './rv-node-knowledge-field-renderer';
import './rv-web-label-text-field-renderer';
// plan-543: WebOperatorPanel.Config JSON editor (+ the operator-window overlay module)
import './operator-devices/WebOperatorPanelHost';
// plan-525: BoxCollider center/size in mm + thin-wall warning
import './rv-box-collider-field-renderer';
// plan-498: Fmu inspector renderer, editor attach/detach actions, context menu, tooltip
import './FmuAttachAction';
import './rv-fmu-parameters-field-renderer';
// plan-596: AASLink.AASId picker + "Import AASX…" (project aasx/ folder)
import './rv-aaslink-aasid-field-renderer';

// Context menu (plugin-extensible right-click / long-press menu)
import { ContextMenuLayer } from './ContextMenuLayer';
import { KeyBadgeLayer } from './KeyBadgeLayer';
import { SetPositionDialog } from './SetPositionDialog';

// Generic Instruction Overlay (unified positional text/callout/banner primitive)
import { InstructionLayer } from './InstructionLayer';

// Annotation & Shared View overlays
import { AnnotationPanel } from './AnnotationPanel';
import { SharedViewBanner } from './SharedViewBanner';
import { GPUWarningBanner } from './GPUWarningBanner';
import { StorageNoticeBanner } from './StorageNoticeBanner';
import { SigWarningBanner } from './SigWarningBanner';
import { CommissioningTrustBanner } from './CommissioningTrustBanner';
import { AutoQualityDialog } from './AutoQualityDialog';
import { ReloadHintHost } from './reload-hint-store';
import { NewsDialogHost } from './NewsDialog';
import { OmniverseStatusOverlay } from './OmniverseStatusOverlay';
import { AgentActivityRow } from './AgentActivityRow';
import { AiActivityOverlay } from './AiActivityOverlay';
import { AgentEyeMonitorBadge } from './AgentEyeMonitorBadge';
import { AgentEyeMonitorPanel } from './AgentEyeMonitorPanel';
import { AnnotationEditModal } from './AnnotationEditModal';

// Measurement panel
import { MeasurementPanel } from './MeasurementPanel';

// Clipping / section panel
import { ClippingPanel } from './ClippingPanel';

// Order Manager panel
import { OrderPanel } from '../../plugins/order-manager-plugin';

// Sensor History Panel (opens from pinned WebSensor tooltip "Show" button)
import { SensorHistoryPanel } from './SensorHistoryPanel';

// Connect panel (realvirtual CONNECT gateway)
import { ConnectPanel } from './ConnectPanel';
// Models panel host — shared by the full HMI (via TopBar) and the embed shell.
// Dev-server-only badge naming the served checkout (eliminated from builds).
import { ServeSessionBadge } from './ServeSessionBadge';
import {
  ConnectEmbedDemoControls,
  ConnectEmbedGate,
} from '../../plugins/connect-embed/ConnectEmbedGate';
import {
  getConnectEmbedSnapshot,
  isConnectEmbedMinimalShell,
  subscribeConnectEmbedStore,
} from '../../plugins/connect-embed/connect-embed-store';

// Positive list — a forgotten id removes the button silently. 'models' is in it
// since plan-373: the Models panel is where the embedded demo is opened and
// closed, so the gated shell must be able to reach it. The entry id is 'models';
// 'scene' is the LeftPanelManager slot name, not an activity-bar id.
const CONNECT_EMBED_ACTIVITY_BAR_ALLOWLIST = ['about', 'models', 'plugin:connect', 'problems', 'help'] as const;



/** Apply persisted visual settings to the viewer on startup (batch — single recompile). */
function useApplyPersistedSettings() {
  const viewer = useViewer();
  useEffect(() => {
    const s = loadVisualSettings();
    viewer.applyVisualSettings(s);
  }, [viewer]);
}

/**
 * Global F1 route to the context-sensitive help (plan-370). Mounted on the app
 * shell rather than on the button, because the activity bar is hidden in FPV and
 * the key has to keep working there. Renders nothing.
 */
function HelpShortcut() {
  useHelpShortcut();
  useHmiToggleShortcut();
  return null;
}

/** Connect tooltip store to viewer for model-cleared cleanup. */
function useTooltipStoreConnection() {
  const viewer = useViewer();
  useEffect(() => {
    tooltipStore.connectViewer(viewer);
  }, [viewer]);
}

export function App() {
  useApplyPersistedSettings();
  useTooltipStoreConnection();
  const hmiVisible = useHmiVisible();
  const branding = useCustomBranding();
  // plan-556: a recording of the HMI renders the recording shell — no chrome, a stored
  // `hmiVisible = false` is overridden (the recording decides what is in the frame).
  const recording = useSyncExternalStore(subscribeRecordingHmi, isRecordingHmiActive, isRecordingHmiActive);
  const connectEmbed = useSyncExternalStore(
    subscribeConnectEmbedStore,
    getConnectEmbedSnapshot,
    getConnectEmbedSnapshot,
  );

  // Build theme: apply custom branding colors if set
  const theme = useMemo(
    () => branding?.primaryColor || branding?.secondaryColor
      ? createBrandedTheme(branding.primaryColor, branding.secondaryColor)
      : rvDarkTheme,
    [branding?.primaryColor, branding?.secondaryColor],
  );

  // Context-aware visibility: each area declares its default hiddenIn rule.
  // These defaults can be overridden by settings.json `ui.visibilityOverrides`.
  // 'mode:editor' hides runtime/monitoring UI in the CAD Editor workspace
  // (raw geometry editing — no KPIs, alarms or charts), like the Planner does.
  // 'mode:viewer' (plan-387) is the spectator workspace: the model, the running
  // kinematics, Settings and the view/grouping controls — nothing else.
  // 'mode:commissioning' (plan-423) drops the OPERATOR HMI only — KPI cards,
  // the message stack, the views slot and the AI activity overlay. Everything an
  // integrator needs (Inspector, Hierarchy, CONNECT, AI bridge, ButtonPanel)
  // stays, which is why those lines carry no commissioning string at all.
  const showKpiBar = useUIVisible('kpi-bar', { hiddenIn: ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning'] });
  // top-bar and activity-bar stay MOUNTED in the viewer: they carry Settings,
  // the camera cluster and the Groups button. Their children are gated one by
  // one inside TopBar/ActivityBar instead.
  const showTopBar = useUIVisible('top-bar', { hiddenIn: ['xr'] });
  // ButtonPanel stays visible in planner mode — the planner now contributes
  // its own grid/snap/drop toolbar buttons there (PlannerToolbarButtons.tsx).
  // FPV / XR remain in the hidden list because they own the entire viewport.
  // The recording shell (plan-556) does not mount the activity bar at all; its full-bleed
  // viewport comes from the recording style (rv-recording-hmi.ts), so this rule stays untouched.
  const showActivityBar = useUIVisible('activity-bar', { hiddenIn: ['fpv', 'xr'] });
  const showButtonPanel = useUIVisible('button-panel', { hiddenIn: ['fpv', 'xr', 'mode:viewer'] });
  const showMessagePanel = useUIVisible('message-panel', { hiddenIn: ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning'] });
  const showViewsSlot = useUIVisible('views-slot', { hiddenIn: ['fpv', 'planner', 'xr', 'mode:editor', 'mode:viewer', 'mode:commissioning'] });

  return (
    <ThemeProvider theme={theme}>
      {/* Applies the theme's global styles (MuiCssBaseline overrides in theme.ts:
          Inter on body, transparent background, touch font-size). Without this
          mount, non-MUI elements render in the browser's default serif. */}
      <CssBaseline />
      {/* Outside both shells on purpose: it must show in the CONNECT embed
          shell too, and staying out of HMIShell keeps it clear of the shell's
          CSS zoom, so the badge holds one size at any UI scale. */}
      {!recording && <ServeSessionBadge />}
      {/* Outside both shells so F1 reaches the docs in the CONNECT embed too. */}
      <HelpShortcut />
      {recording ? (
        <RecordingHmiShell />
      ) : isConnectEmbedMinimalShell(connectEmbed) ? (
        <ConnectEmbedMinimalShell />
      ) : (
        <FullHmiShell
          hmiVisible={hmiVisible}
          branding={branding}
          showKpiBar={showKpiBar}
          showTopBar={showTopBar}
          showActivityBar={showActivityBar}
          showButtonPanel={showButtonPanel}
          showMessagePanel={showMessagePanel}
          showViewsSlot={showViewsSlot}
        />
      )}
    </ThemeProvider>
  );
}

/** Dedicated gate subtree so switching shells never changes hooks within one component instance. */
function ConnectEmbedMinimalShell() {
  return (
    <HMIShell>
      <ActivityBar entryAllowlist={CONNECT_EMBED_ACTIVITY_BAR_ALLOWLIST} />
      <ConnectPanel />
      {/* Same host as the full shell — one slot condition, so the Models panel
          and the CONNECT panel can never occupy the LEFT slot at once. */}
      <ConnectEmbedGate />
      <NewsDialogHost includeWeb={false} />
      <SigWarningBanner compact />
    </HMIShell>
  );
}

interface FullHmiShellProps {
  hmiVisible: boolean;
  branding: ReturnType<typeof useCustomBranding>;
  showKpiBar: boolean;
  showTopBar: boolean;
  showActivityBar: boolean;
  showButtonPanel: boolean;
  showMessagePanel: boolean;
  showViewsSlot: boolean;
}

/** Normal hosted/demo-running HMI subtree, mounted separately from the CONNECT gate shell. */
function FullHmiShell({
  hmiVisible,
  branding,
  showKpiBar,
  showTopBar,
  showActivityBar,
  showButtonPanel,
  showMessagePanel,
  showViewsSlot,
}: FullHmiShellProps) {
  // ── plan-387 Schicht B: the hard-mounted shell ────────────────────────────
  // These elements belong to no plugin, so no `modes` declaration reaches them
  // (see doc-ui-visibility.md §2, case 2). They are attached to the SAME rule
  // system the KpiBar/MessagePanel/ViewsSlot already use with 'mode:editor', so
  // every one of them stays overridable via `ui.visibilityOverrides`.
  //
  // Deliberately NOT gated — these are what the viewer IS: ViewportFrame,
  // TooltipLayer, AnchoredPopover, InstructionLayer, TitleBar, GPUWarningBanner,
  // AutoQualityDialog, HmiRestoreButton, MeasurementPanel, ClippingPanel and
  // SharedViewBanner (a shared link is the viewer's whole reason to exist).
  const showSensorHistory = useUIVisible('sensor-history-panel', { hiddenIn: ['mode:viewer'] });
  // The context menu is a full authoring back door (Edit Script, Set Position,
  // snap points, …) — the single most important entry point to close for F4.
  const showContextMenu = useUIVisible('context-menu', { hiddenIn: ['mode:viewer'] });
  const showKeyBadges = useUIVisible('key-badge-layer', { hiddenIn: ['mode:viewer'] });
  const showSetPositionDialog = useUIVisible('set-position-dialog', { hiddenIn: ['mode:viewer'] });
  const showMobileSelectionSheet = useUIVisible('mobile-selection-sheet', { hiddenIn: ['mode:viewer'] });
  const showSignalDragGhost = useUIVisible('signal-drag-ghost', { hiddenIn: ['mode:viewer'] });
  const showSigWarningBanner = useUIVisible('sig-warning-banner', { hiddenIn: ['mode:viewer'] });
  const showNewsDialog = useUIVisible('news-dialog', { hiddenIn: ['mode:viewer'] });
  const showOmniverseStatus = useUIVisible('omniverse-status-overlay', { hiddenIn: ['mode:viewer'] });
  // The AI *bridge* stays reachable in commissioning (ActivityBar entry, Settings
  // tab) — only the floating activity overlay is operator chrome and goes.
  const showAiActivity = useUIVisible('ai-activity-overlay', { hiddenIn: ['mode:viewer', 'mode:commissioning'] });
  const showAnnotationEditModal = useUIVisible('annotation-edit-modal', { hiddenIn: ['mode:viewer'] });
  // These three panels own a leftPanelManager slot, so their gate is not a local
  // literal: it is the shared pairing TopBar reconciles the slot against. Hiding
  // the panel without dropping the slot leaves its width reserved — see
  // left-panel-visibility.ts.
  const showAnnotationPanel = useUIVisible(ANNOTATION_PANEL_GATE.id, ANNOTATION_PANEL_GATE.rule);
  const showOrderPanel = useUIVisible(ORDER_PANEL_GATE.id, ORDER_PANEL_GATE.rule);
  const showConnectPanel = useUIVisible(CONNECT_PANEL_GATE.id, CONNECT_PANEL_GATE.rule);
  // The BottomBar (search) had NO gate at all until now — not even `hmiVisible`.
  // It sat bare between two `hmiVisible &&` lines. Gating it here fixes that on
  // the way past. GroupsOverlay used to be its child but is NOT part of the
  // search bar: it portals to #rv-floating-panel-root and owns its own state, so
  // it is mounted as a sibling below and stays visible in the viewer (F3).
  const showSearchBar = useUIVisible('search-bar', { hiddenIn: ['fpv', 'xr', 'mode:viewer'] });

  return (
    <>
      <HMIShell>
        {/* Confines the WebGL canvas to the central region (must run even when
            the HMI is hidden, to restore full-bleed). */}
        <ViewportFrame />
        <TooltipLayer />
        <AnchoredPopover />
        {/* Ghost chip following the cursor during signal Shift+Drag (plan-246 F8). */}
        {showSignalDragGhost && <SignalDragGhost />}
        {showSensorHistory && <SensorHistoryPanel />}
        {showContextMenu && <ContextMenuLayer />}
        {/* Blender-style screencast-keys chord badge (lower-left). */}
        {showKeyBadges && <KeyBadgeLayer />}
        <InstructionLayer />
        {showSetPositionDialog && <SetPositionDialog />}
        {/* Mobile-only: half-height selection sheet (breadcrumb + children +
            inspector) shown on double-click instead of the fullscreen panels. */}
        {showMobileSelectionSheet && <MobileSelectionSheet />}
        {hmiVisible && branding?.titleBar && <TitleBar />}
        {hmiVisible && showKpiBar && <KpiBar />}
        {hmiVisible && showTopBar && <TopBar />}
        {/* ActivityBar: mobile = "⋮" window-opener menu top-right (self-positioned);
            desktop = left vertical bar. ButtonPanel (contextual tools) docks at the
            bottom on mobile — the only bottom bar there, so no stacking needed. */}
        {hmiVisible && showActivityBar && <ActivityBar />}
        {hmiVisible && showButtonPanel && <ButtonPanel />}
        {/* Active machine alarms remain visible in working modes that hide other messages. */}
        {hmiVisible && <MessagePanel alarmsOnly={!showMessagePanel} />}
        {/* Document problems (plan-703 §2.8) — content-driven: renders nothing
            while the list is empty, so it costs no viewport in the normal case.
            Not gated on `showMessagePanel`: that switch hides MACHINE messages
            in editor/planner, and an unresolvable reference is exactly the thing
            an author in those modes has to see. */}
        {hmiVisible && <ProblemsPanel />}
        {showSearchBar && <BottomBar />}
        {/* Groups / Display overlay — a SIBLING of the search bar, never its
            child: it portals to #rv-floating-panel-root and keeps its own open
            state (viewer.groupsOverlayOpen), so moving it out of BottomBar is
            visually a no-op. Ungated on purpose — the view/grouping settings are
            exactly what the viewer keeps (plan-387 F3). */}
        <GroupsOverlay />
        {hmiVisible && showViewsSlot && <SlotRenderer slot="views" />}
        <SharedViewBanner />
        <GPUWarningBanner />
        <StorageNoticeBanner />
        {showSigWarningBanner && <SigWarningBanner />}
        {/* plan-423 F6. Gates itself: it owns its own `useUIVisible` rule
            (commissioning only) AND renders nothing unless the model on screen
            actually came from a shared link — two independent reasons, neither
            of which belongs in this list. Its own banner sits BELOW the
            signature one in z-order: an invalid signature is the more serious
            of the two and must stay on top when both apply. */}
        <CommissioningTrustBanner />
        <AutoQualityDialog />
        {/* plan-591: the antialias reload hint. Ungated and always mounted —
            it derives its own visibility from settings vs. renderer and gates
            itself on touch devices (F13); a condition here would be a second,
            competing rule. Its own small state, deliberately NOT the shared
            info overlay (§2.5). */}
        <ReloadHintHost />
        {showNewsDialog && <NewsDialogHost includeWeb />}
        {showOmniverseStatus && <OmniverseStatusOverlay />}
        {/* Agent Eye Monitor (plan-481). Gated on `hmiVisible` ONLY — not on
            `mcp.connected` and not on "are there captures": the badge is the
            only way into the monitor, and hiding it while the history is empty
            would make the empty state (F8) unreachable exactly when it is the
            thing worth reading. The panel is always mounted so the auto-open
            effect can see a new capture number; it renders nothing while
            closed. */}
        <AgentActivityRow>
          {hmiVisible && <AgentEyeMonitorBadge />}
          {showAiActivity && <AiActivityOverlay />}
        </AgentActivityRow>
        {hmiVisible && <AgentEyeMonitorPanel />}
        {hmiVisible && showAnnotationPanel && <AnnotationPanel />}
        {hmiVisible && <MeasurementPanel />}
        {hmiVisible && <ClippingPanel />}
        {hmiVisible && showOrderPanel && <OrderPanel />}
        {hmiVisible && showConnectPanel && <ConnectPanel />}
        <ConnectEmbedDemoControls />
        {showAnnotationEditModal && <AnnotationEditModal />}
        {/* When the HMI is hidden, the eye toggle in the top bar's right
            region is gone too — keep a minimal always-present restore control
            so touch users (no 'H' key) can bring the HMI back. */}
        {!hmiVisible && <HmiRestoreButton />}
      </HMIShell>
      {tooltipRegistry.getControllers().map((ctrl, i) => {
        const C = ctrl.component;
        return <C key={i} />;
      })}
    </>
  );
}

// ─── Recording shell (plan-556 F3) ───────────────────────────────────────

/**
 * What the full shell mounts and what a recording does with it (F3 inventory). `kept` = rendered by
 * the recording shell, `hidden` = not mounted in a recording. tests/rv-recording-hmi.test.tsx
 * checks every element of `FullHmiShell` (and the App root) is listed here.
 */
export const RECORDING_SHELL_INVENTORY: Readonly<Record<string, 'kept' | 'hidden'>> = {
  // App root
  ServeSessionBadge: 'hidden', HelpShortcut: 'kept',
  // FullHmiShell
  HMIShell: 'hidden', ViewportFrame: 'kept', TooltipLayer: 'hidden', AnchoredPopover: 'hidden',
  SignalDragGhost: 'hidden', SensorHistoryPanel: 'hidden', ContextMenuLayer: 'hidden', KeyBadgeLayer: 'hidden',
  InstructionLayer: 'hidden', SetPositionDialog: 'hidden', MobileSelectionSheet: 'hidden', TitleBar: 'hidden',
  KpiBar: 'hidden', TopBar: 'hidden', ActivityBar: 'hidden', ButtonPanel: 'hidden', MessagePanel: 'hidden',
  ProblemsPanel: 'hidden', BottomBar: 'hidden', GroupsOverlay: 'hidden', SlotRenderer: 'hidden',
  SharedViewBanner: 'hidden', GPUWarningBanner: 'hidden', StorageNoticeBanner: 'hidden', SigWarningBanner: 'hidden',
  CommissioningTrustBanner: 'hidden', AutoQualityDialog: 'hidden', ReloadHintHost: 'hidden',
  NewsDialogHost: 'hidden',
  OmniverseStatusOverlay: 'hidden', AgentActivityRow: 'hidden', AgentEyeMonitorBadge: 'hidden',
  AiActivityOverlay: 'hidden', AgentEyeMonitorPanel: 'hidden', AnnotationPanel: 'hidden', MeasurementPanel: 'hidden',
  ClippingPanel: 'hidden', OrderPanel: 'hidden', ConnectPanel: 'kept', ConnectEmbedDemoControls: 'hidden',
  AnnotationEditModal: 'hidden', HmiRestoreButton: 'hidden',
  // The overlay slot (TopBar renders it normally): only operator panels + the allow-list.
  'SlotRenderer[overlay]': 'kept',
};

/** Overlay slot entries a recording keeps: operator panels and allow-listed plugins (F3). */
export function recordingOverlayEntries(entries: readonly UISlotEntry[], viewer: Pick<RVViewer, 'getPlugin'>): UISlotEntry[] {
  return entries.filter((e) => {
    const plugin = e.pluginId ? viewer.getPlugin(e.pluginId) as { controller?: unknown } | undefined : undefined;
    return isRecordingOverlayAllowed(e.pluginId, plugin?.controller instanceof OperatorPanelController);
  });
}

/** The overlay slot of a recording: operator panels + allow-listed entries, nothing else. */
function RecordingOverlaySlot() {
  const viewer = useViewer();
  useSyncExternalStore(viewer.uiRegistry.subscribe, viewer.uiRegistry.getSnapshot);
  const entries = recordingOverlayEntries(viewer.uiRegistry.getSlotComponents('overlay'), viewer);
  return (
    <>
      {entries.map((entry, i) => {
        const Comp = entry.component;
        return <Comp key={`overlay-${entry.pluginId ?? i}-${i}`} viewer={viewer} />;
      })}
    </>
  );
}

/**
 * Acknowledges every committed recording frame (the commit barrier of the HMI settle, F4): the
 * layout effect runs after React committed the render that read the bumped counter.
 */
export function RecordingFrameProbe() {
  const f = useSyncExternalStore(subscribeRecordingFrame, getRecordingFrame, getRecordingFrame);
  useLayoutEffect(() => { ackRecordingFrame(f); }, [f]);
  return null;
}

/**
 * The shell of a recording (F3): the viewport frame (full-bleed), the operator panels and other
 * allow-listed overlay entries, the CONNECT panel when it is open, the frame probe. Everything
 * else of {@link FullHmiShell} is not mounted. Same layering as HMIShell (z-index 1000, the
 * floating-panel portal root first) at UI zoom 1.
 */
export function RecordingHmiShell() {
  return (
    <Box
      data-rv-recording-shell=""
      sx={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1000, '& > *': { pointerEvents: 'auto' } }}
    >
      <div id="rv-floating-panel-root" style={{ pointerEvents: 'none' }} />
      <ViewportFrame />
      <RecordingOverlaySlot />
      <ConnectPanel />
      <RecordingFrameProbe />
    </Box>
  );
}

/** Minimal restore affordance shown only while the HMI is hidden — a single
 *  eye button in the top-right corner that toggles the full HMI back on. */
function HmiRestoreButton() {
  return (
    <Tooltip title="Show HMI (H)" placement="left">
      <IconButton
        onClick={toggleHmiVisible}
        sx={{
          position: 'fixed', top: 8, right: 8, zIndex: 9001,
          bgcolor: 'rgba(20,20,20,0.85)', backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
          color: 'rgba(255,255,255,0.85)',
          '&:hover': { bgcolor: 'rgba(40,40,40,0.95)' },
        }}
      >
        <VisibilityOff fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

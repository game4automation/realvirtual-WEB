// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useSyncExternalStore, useRef } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { Typography, Box, Paper } from '@mui/material';
import { Layers } from '@mui/icons-material';
import { useMobileLayout, isMobileDevice } from '../../hooks/use-mobile-layout';
import { useViewer } from '../../hooks/use-viewer';
import { useMode } from '../../hooks/use-mode';
import { HierarchyBrowser } from './rv-hierarchy-browser';
import { PropertyInspector } from './rv-property-inspector';
import { AasDetailPanel } from '../../plugins/aas-link-plugin';
import { FLOATING_TOP_MARGIN, ACTIVITY_BAR_WIDTH } from './layout-constants';
import { useLeftWindowWidth, useRightWindowWidth } from '../../hooks/use-left-window-width';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { useUIVisible } from './ui-context-store';
import { ModeDropdown } from './ModeDropdown';
import { CameraBookmarks, HmiToggleButton, FpvBarButton, FollowCamButton, SitOnCamButton } from './CameraBar';
import { useOverlayVisibilityState } from '../../hooks/use-overlay-visible';
import { ActionGroupPill, ActionSegment, ActionDivider } from './action-group';
import { SettingsPanel } from './SettingsPanel';
import { getSceneStore } from './scene/scene-store-singleton';
import { MachineControlPanel } from './MachineControlPanel';
import {
  hiddenLeftPanelSlots,
  HIERARCHY_BROWSER_GATE, ANNOTATION_PANEL_GATE, CONNECT_PANEL_GATE,
  ORDER_PANEL_GATE, MACHINE_CONTROL_PANEL_GATE,
} from './left-panel-visibility';
import { SlotRenderer } from './HMIShell';
import { useSlot } from '../../hooks/use-slot';

/**
 * Detect a left-panel slot that is "open" in the leftPanelManager but whose
 * renderer is not actually present, so the panel never renders into the space
 * the canvas inset + floating toolbar reserve for it (the empty grey strip).
 *
 * Two independent things can keep a panel from mounting:
 *
 * 1. **State desync**, per panel — `renderer`. The lpm slot (`activePanel`)
 *    persists in localStorage and is restored on boot, but the gates that
 *    actually mount each panel do not all persist the same way:
 *    - `settings` / `hierarchy` render off the editor plugin's `settingsOpen` /
 *      `panelOpen` flags; `settingsOpen` is NOT persisted, so after a reload the
 *      lpm can claim settings is open while the flag is false.
 *    - `scene` (Models) renders only once the SceneStore singleton exists; if the
 *      slot is restored before the store is built the panel can't mount yet.
 * 2. **Mode visibility (plan-387)**, uniform across panels — `hiddenSlots`. The
 *    viewer workspace hides five left panels through `useUIVisible` but leaves
 *    their lpm slot — and the width it reserves — untouched, so switching INTO
 *    the viewer with any of them open produces the same empty grey strip. The
 *    caller passes the slots whose gate is shut (`hiddenLeftPanelSlots`) and they
 *    are reclaimed through the machinery that already existed for case 1, rather
 *    than through five copies of the same check.
 *
 * Returns the orphaned slot id to close, or null when slot and renderer agree.
 * (A panel whose backing PLUGIN is absent is a third case, handled by the panel
 * itself — see `useDropOrphanedPanelSlot`.)
 */
export function orphanedLeftSlot(
  active: string | null,
  renderer: { settingsOpen: boolean; hierarchyOpen: boolean },
  hiddenSlots: ReadonlySet<string>,
): string | null {
  if (!active) return null;
  // The workspace hides this panel — no per-panel state can make it render.
  if (hiddenSlots.has(active)) return active;
  if (active === 'settings' && !renderer.settingsOpen) return 'settings';
  if (active === 'hierarchy' && !renderer.hierarchyOpen) return 'hierarchy';
  // plan-372 Phase 13 deleted the Scene window, so the 'scene' slot has no
  // renderer at all any more: a persisted one is ALWAYS orphaned. Reporting it
  // is what reclaims the width an older session reserved for a panel that can
  // no longer appear. The value stays in the return type so `lpm.close` — and
  // the migration of that stale state — still accept it.
  if (active === 'scene') return 'scene';
  return null;
}

export function TopBar() {
  const viewer = useViewer();
  const [vrOpen, setVrOpen] = useState(false);
  const sceneStore = getSceneStore();
  // Display panel is reachable when there are groups OR overlay categories (plan-250).
  const overlayPresent = useOverlayVisibilityState().present.length > 0;

  // Hierarchy panel state from plugin
  const { plugin, state: pluginState } = useEditorPlugin();
  const hierarchyOpen = pluginState.panelOpen;
  const settingsOpen = pluginState.settingsOpen;

  const lpm = viewer.leftPanelManager;
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);

  const isMobile = useMobileLayout();

  // Re-render when a model loads so the right-region Groups button appears
  // once the loaded scene exposes groups (groupCount > 0).
  const [, setModelTick] = useState(0);
  useEffect(() => {
    const handler = () => setModelTick(t => t + 1);
    viewer.on('model-loaded', handler);
    return () => { viewer.off('model-loaded', handler); };
  }, [viewer]);

  // Shift the floating mode switcher right to stay in the *visible* viewport
  // next to an open left-docked window (shared with the floating tool toolbar).
  const openWindowWidth = useLeftWindowWidth();
  const modeLeftOffset = ACTIVITY_BAR_WIDTH + (openWindowWidth > 0 ? openWindowWidth + 8 : 8);
  // A mode-locked (kiosk / single-purpose HMI like Mauser) workspace hides the
  // Play/Pause + Reset sim controls along with the mode dropdown — there is no
  // workspace to drive, only a fixed display.
  const { locked: modeLocked } = useMode();
  // plan-387: the TopBar itself stays mounted in the Viewer workspace — it hosts
  // Settings, the camera cluster and the Groups button, which are exactly what
  // the viewer keeps. Its AUTHORING children are gated one by one instead.
  // The leading slot additionally carries plugin toolbars (Play/Pause, DES); the
  // slot-level rules cover the known ones, this gate covers any that arrive later.
  const showToolbarLeading = useUIVisible('toolbar-leading-slot', { hiddenIn: ['mode:viewer'] });
  const showPropertyInspector = useUIVisible('property-inspector', { hiddenIn: ['mode:viewer'] });
  const showAasDetail = useUIVisible('aas-detail-panel', { hiddenIn: ['mode:viewer'] });
  // The five gates that hide a panel owning a leftPanelManager slot. TopBar reads
  // ALL of them — including the three whose panel App.tsx renders — because it is
  // the one always-mounted component that reconciles the lpm, and a hidden panel
  // must not keep reserving its width. Ids and rules come from the shared
  // pairings so the mount site and this reconciliation cannot drift apart.
  const showHierarchyBrowser = useUIVisible(HIERARCHY_BROWSER_GATE.id, HIERARCHY_BROWSER_GATE.rule);
  const showMachineControl = useUIVisible(MACHINE_CONTROL_PANEL_GATE.id, MACHINE_CONTROL_PANEL_GATE.rule);
  const showAnnotationPanel = useUIVisible(ANNOTATION_PANEL_GATE.id, ANNOTATION_PANEL_GATE.rule);
  const showConnectPanel = useUIVisible(CONNECT_PANEL_GATE.id, CONNECT_PANEL_GATE.rule);
  const showOrderPanel = useUIVisible(ORDER_PANEL_GATE.id, ORDER_PANEL_GATE.rule);
  const hasSimControls = useSlot('toolbar-button-leading').length > 0 && !modeLocked && showToolbarLeading;

  // leftPanelManager is the single source of truth for which left window is
  // open (the activity bar buttons drive it). The Hierarchy plugin and Settings
  // keep their own open flags, so reconcile them here whenever the active left
  // panel changes — closing any plugin-tracked panel that lost the slot.
  //
  // Sits BELOW the visibility gates on purpose: a mode switch changes those
  // gates without touching `activePanel`, so they are part of the reconciliation
  // input and of the dependency list. Without them the effect never re-runs on a
  // workspace switch and the slot keeps its reserved width (the grey strip).
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const hierarchyOpenRef = useRef(hierarchyOpen);
  hierarchyOpenRef.current = hierarchyOpen;
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;
  useEffect(() => {
    const active = panelSnapshot.activePanel;
    if (active !== 'settings' && settingsOpenRef.current) {
      pluginRef.current?.setSettingsOpen(false);
    }
    if (active !== 'hierarchy' && hierarchyOpenRef.current) {
      pluginRef.current?.togglePanel();
    }
    // Reverse direction: drop a slot the lpm claims is open but whose renderer is
    // absent (after a reload, or because the active workspace hides it — see
    // orphanedLeftSlot) so the canvas inset and floating toolbar don't reserve
    // width for a panel that never renders.
    //
    // Dropping 'hierarchy' here only reclaims the lpm width; the hierarchy's own
    // width comes from the plugin's `panelOpen` (useLeftWindowWidth). Closing the
    // slot makes `activePanel` null, which brings the branch above around on the
    // next pass and clears that flag too.
    const orphan = orphanedLeftSlot(
      active,
      { settingsOpen: settingsOpenRef.current, hierarchyOpen: hierarchyOpenRef.current },
      hiddenLeftPanelSlots({
        [HIERARCHY_BROWSER_GATE.id]: showHierarchyBrowser,
        [ANNOTATION_PANEL_GATE.id]: showAnnotationPanel,
        [CONNECT_PANEL_GATE.id]: showConnectPanel,
        [ORDER_PANEL_GATE.id]: showOrderPanel,
        [MACHINE_CONTROL_PANEL_GATE.id]: showMachineControl,
      }),
    );
    if (orphan) lpm.close(orphan);
  }, [
    panelSnapshot.activePanel, lpm,
    showHierarchyBrowser, showAnnotationPanel, showConnectPanel, showOrderPanel, showMachineControl,
  ]);

  // Shift the floating camera cluster left of an open right-docked window
  // (e.g. the Layout Planner library) so it stays visible — same as the left.
  const rightWindowWidth = useRightWindowWidth();
  const camRightOffset = rightWindowWidth > 0 ? rightWindowWidth + 8 : 8;
  // Push the floating top-left cluster below the optional title bar when present.
  const topInset = useViewportInsets().top;

  return (
    <>
      {/* The top app bar was removed — the realvirtual logo now lives at the top
          of the left activity bar, window-openers live in the activity bar, and
          the sim/mode + camera/view controls float in the viewport corners
          (below). TopBar remains the HMI host for those floating clusters, the
          docked windows, and the modals. */}

      {/* Floating top-left cluster — workspace mode switcher + the sim-control
          action group (Play/Pause + Reset). Sits in the 3D viewport's top-left
          corner, just right of the activity bar's logo, and shifts right past an
          open left-docked window so it stays in the visible view. */}
      <Box
        sx={{
          position: 'fixed',
          top: topInset + FLOATING_TOP_MARGIN,
          left: { xs: 8, sm: modeLeftOffset },
          zIndex: 1200,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          pointerEvents: 'none',
          '& > *': { pointerEvents: 'auto' },
        }}
      >
        <ModeDropdown />
        {/* Project context — one level ABOVE the model selection: it scopes the
            Models panel, it does not replace it (§4.5). Rendered inline rather
            than through a slot because the slots are the plugin surface and
            `toolbar-button-leading` additionally lives and dies with the sim
            controls. Hidden in a mode-locked kiosk, like the mode switcher, and
            self-hides where File System Access is unavailable. */}
        {/* Sim-control action group (Play/Pause + Reset) — renders the
            toolbar-button-leading slot as its own glassy pill. */}
        {hasSimControls && (
          <ActionGroupPill>
            <SlotRenderer slot="toolbar-button-leading" />
          </ActionGroupPill>
        )}
      </Box>

      {/* Floating BOTTOM-right cluster — separate camera / view action groups,
          each its own glassy pill (CAM bookmarks, HMI toggle, optional Groups,
          FPV). Shifts left of an open right-docked window so it stays visible.
          The orientation gizmo now owns the top-right corner. Hidden on mobile. */}
      <Box
        sx={{
          position: 'fixed',
          bottom: FLOATING_TOP_MARGIN,
          right: camRightOffset,
          zIndex: 1200,
          display: { xs: 'none', sm: 'flex' },
          alignItems: 'center',
          gap: 0.5,
          pointerEvents: 'none',
          '& > *': { pointerEvents: 'auto' },
        }}
      >
        <SlotRenderer slot="toolbar-button-trailing" />
        <ActionGroupPill>
          <CameraBookmarks />
          {/* Follow / Sit-On sit next to the camera bookmarks. Right-click drag
              for Sit-On look has no touch equivalent → desktop only. */}
          {!isMobileDevice() && (
            <>
              <ActionDivider />
              <FollowCamButton />
              <ActionDivider />
              <SitOnCamButton />
            </>
          )}
        </ActionGroupPill>
        <ActionGroupPill><HmiToggleButton /></ActionGroupPill>
        {((viewer.groups && viewer.groups.groupCount > 0) || overlayPresent) && (
          <ActionGroupPill>
            <ActionSegment
              title="Toggle Display panel"
              active={viewer.groupsOverlayOpen}
              onClick={() => viewer.toggleGroupsOverlay()}
              icon={<Layers />}
            />
          </ActionGroupPill>
        )}
        {/* VR/AR + First-Person share one action group. */}
        {(() => {
          const showVr = !isMobile;
          const showFpv = !isMobileDevice();
          if (!showVr && !showFpv) return null;
          return (
            <ActionGroupPill>
              {showVr && (
                <ActionSegment
                  title={vrOpen ? 'Close VR/AR' : 'VR / AR'}
                  active={vrOpen}
                  onClick={() => setVrOpen(!vrOpen)}
                  label="VR"
                />
              )}
              {showVr && showFpv && <ActionDivider />}
              {showFpv && <FpvBarButton />}
            </ActionGroupPill>
          );
        })()}
      </Box>

      {/* Hierarchy browser panel (disabled on mobile, hidden when settings open) */}
      {showHierarchyBrowser && !isMobile && hierarchyOpen && !settingsOpen && <HierarchyBrowser viewer={viewer} />}

      {/* Property inspector — docked: requires hierarchy open; detached: independent */}
      {showPropertyInspector && !isMobile && !settingsOpen && pluginState.showInspector && pluginState.selectedNodePath
        && (hierarchyOpen || localStorage.getItem('rv-inspector-detached') === 'true')
        && <PropertyInspector viewer={viewer} />}

      {/* Machine Control Panel */}
      {showMachineControl && <MachineControlPanel />}

      {/* AAS detail floating panel */}
      {showAasDetail && <AasDetailPanel />}

      {/* Slot-based overlay panels (Layout Planner, etc.) */}
      <SlotRenderer slot="overlay" />

      {/* VR/AR modal */}
      {vrOpen && <VRModal onClose={() => setVrOpen(false)} />}

      {/* Settings side panel (opened from the activity bar) */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => { plugin?.setSettingsOpen(false); lpm.close('settings'); }}
        />
      )}

      {/* Scene / Models panel (opened from the activity bar). The slot condition
          lives in the host, shared with the CONNECT embed shell. */}
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

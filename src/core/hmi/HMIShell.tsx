// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Suspense, lazy, useEffect, useRef, useSyncExternalStore } from 'react';
import { Box } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import type { UISlot } from '../rv-ui-plugin';
import { useActiveContexts, isUIElementVisible, registerUIElement, useUIVisible } from './ui-context-store';
import { subscribeUIZoom, getUIZoom } from './visual-settings-store';
import { getSceneStore } from './scene/scene-store-singleton';
import { ForceConfirmDialog } from './ForceConfirmDialog';
import { ProjectCodeConsentDialog } from './ProjectCodeConsentDialog';
import { SceneTransitionOverlay } from './SceneTransitionOverlay';
import { ProjectDialogHost } from '../project/rv-project-conflict-dialog';
import { mountDragAnnouncer } from './drag-announcer';

/** Lazy: most sessions never open the Projects dashboard (plan-372 Phase 7). */
const ProjectsDashboardHost = lazy(() =>
  import('./projects/ProjectsDashboardHost').then(m => ({ default: m.ProjectsDashboardHost })));

interface HMIShellProps {
  children: React.ReactNode;
}

/**
 * SlotRenderer — Renders all UI plugin components registered for a given slot.
 * Use alongside (or instead of) hardcoded children in HMIShell.
 *
 * Reactive: re-renders when plugins are registered/unregistered via UIPluginRegistry.
 * Entries with a `visibilityRule` are filtered by the active UI contexts.
 * Entries WITHOUT a `visibilityRule` are ALWAYS visible (invariant).
 */
export function SlotRenderer({ slot }: { slot: UISlot }) {
  const viewer = useViewer();
  // Subscribe to registry changes so we re-render when model plugins load/unload
  useSyncExternalStore(viewer.uiRegistry.subscribe, viewer.uiRegistry.getSnapshot);
  const entries = viewer.uiRegistry.getSlotComponents(slot);
  const contexts = useActiveContexts();

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry, i) => {
        // Register plugin-declared visibility rule if present
        if (entry.visibilityId && entry.visibilityRule) {
          registerUIElement(entry.visibilityId, entry.visibilityRule);
        }

        // Entries without visibilityRule are always visible (invariant)
        if (entry.visibilityId) {
          if (!isUIElementVisible(entry.visibilityId, contexts)) return null;
        }

        const Comp = entry.component;
        return <Comp key={`${slot}-${i}`} viewer={viewer} />;
      })}
    </>
  );
}

export function HMIShell({ children }: HMIShellProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  // plan-387: the shell's own dialog hosts are not slot entries, so no plugin
  // `modes` declaration reaches them — they get their rules here (Schicht B).
  const showForceConfirm = useUIVisible('force-confirm-dialog', { hiddenIn: ['mode:viewer'] });
  const showProjectDialogs = useUIVisible('project-dialog-host', { hiddenIn: ['mode:viewer'] });
  const showProjectsDashboard = useUIVisible('projects-dashboard', { hiddenIn: ['mode:viewer'] });

  // Apply zoom directly to DOM — avoids re-rendering the entire child tree on every slider tick.
  useEffect(() => {
    function applyZoom() {
      const el = boxRef.current;
      if (!el) return;
      const z = getUIZoom();
      el.style.zoom = z !== 1 ? String(z) : '';
    }
    applyZoom();
    return subscribeUIZoom(applyZoom);
  }, []);

  // ── Screen-reader live region for signal drags (plan-341 F12) ──────
  // One region for the whole shell, mounted for the shell's whole life: a live
  // region must already be in the DOM when its text changes, so it cannot be
  // created at drag start.
  useEffect(() => mountDragAnnouncer(), []);

  // ── Global undo/redo keyboard shortcuts ────────────────────────────
  // Ctrl/Cmd+Z      → undo
  // Ctrl/Cmd+Shift+Z OR Ctrl+Y → redo
  // Suppressed when focus is in a text input or contentEditable element
  // (so browser-default per-field undo still works).
  useEffect(() => {
    function isTextInput(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isTextInput(e.target)) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const sceneStore = getSceneStore();
      if (!sceneStore) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void sceneStore.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        void sceneStore.redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Box
      ref={boxRef}
      sx={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1000,
        '& > *': {
          pointerEvents: 'auto',
        },
      }}
    >
      {/*
        Portal target for floating panels (FloatingPanel, DESStatsPanel, …).
        Direct child of HMIShell so panels inherit the CSS `zoom` but
        bypass the deeper Paper hierarchy. Ancestor Papers carry
        `backdrop-filter: blur(...)` from the theme (theme.ts) which per
        CSS spec creates a containing block for `position: fixed`
        descendants — so a panel rendered inside e.g. ButtonPanel's
        Paper would have its `top: 0` snapped to the Paper's top, not
        the viewport top. Portaling here gives panels HMIShell as their
        containing block, which is what the drag/clamp math assumes.

        Plain `<div>` with no styling: no transform / filter /
        backdrop-filter / will-change / contain → does not establish a
        containing block of its own.
      */}
      <div id="rv-floating-panel-root" style={{ pointerEvents: 'none' }} />
      {children}
      {/* Scene-transition mask (plan-410 F4). Mounted unconditionally and NOT as
          a plugin slot entry: the editor's exit overlay has to stay on screen
          while `_restorePreviousScene` runs — by which time the editor plugin
          and its slots are already gone. Renders null unless a transition is
          holding it. */}
      <SceneTransitionOverlay />
      {/* Signal forcing is an engineering action — no force dialog in the Viewer. */}
      {showForceConfirm && <ForceConfirmDialog />}
      {/* Native project code needs this project's explicit consent before it
          runs (plan-718 2b.3). Mounted UNCONDITIONALLY and in every mode: the
          request denies when no host is mounted, so hiding the dialog would
          silently disable a project's code rather than ask about it. Renders
          null until a project actually carries runnable code. */}
      <ProjectCodeConsentDialog />
      {/* Collision notices (plan-394) live as cards in the right-side messages
          slot (CollisionAlertPlugin) — no modal here anymore. */}
      {/* Project folder ↔ cache conflict prompt + the switch dirty guard (§4c/§4e).
          Renders nothing until a project raises one of the two. */}
      {showProjectDialogs && <ProjectDialogHost />}
      {/* Projects dashboard (plan-372). Lazy: most sessions never open it, and
          it pulls in the rail, the card grid and the detail pane. The Suspense
          fallback is deliberately null — the overlay simply appears a tick
          later rather than flashing a spinner over the viewport. */}
      {showProjectsDashboard && (
        <Suspense fallback={null}>
          <ProjectsDashboardHost />
        </Suspense>
      )}
    </Box>
  );
}

/**
 * Look up the floating-panel portal root. Returns null on the server
 * or before HMIShell has mounted; callers should fall back to inline
 * rendering in that case.
 */
export function getFloatingPanelRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('rv-floating-panel-root');
}

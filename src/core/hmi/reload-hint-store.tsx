// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * reload-hint-store — the antialias "Reload now" hint, with its OWN state
 * (plan-591 F3).
 *
 * `antialias` is a `WebGLRenderer` CONSTRUCTOR parameter. A preset that flips
 * it is applied and persisted like every other field, but the picture only
 * changes after a page reload — so the one honest thing the viewer can do is
 * say so, without reloading behind the user's back (camera, simulation state
 * and open panels would be gone; plan-591 §7 alt. 4).
 *
 * **Derived, not imperative.** There is no `showReloadHint()`: the host reads
 * `settings.antialias !== viewer.antialiasActive`. A stale hint is therefore
 * impossible — the moment the mismatch is gone, so is the hint, and nobody has
 * to remember to withdraw it. `viewer.antialiasActive` needs no subscription of
 * its own: it is written once at renderer creation and never changes within a
 * session, which leaves the settings as the single moving side — and those are
 * reactive through `subscribeVisualSettings()`. That also covers the path
 * `render-mode-changed` does NOT cover: the antialias switch in the Visual tab,
 * which only persists.
 *
 * **The dismiss epoch.** A bare mismatch boolean would be a one-way door: once
 * dismissed, the very same apply could never show the hint again. So the hint
 * is visible while `mismatch && applyEpoch !== dismissedEpoch`, with the epoch
 * counted by the apply itself (`visual-presets.ts`). Every apply shows it
 * again, the identical one included; a dismiss holds exactly until then. Both
 * numbers are session state — nothing is persisted.
 *
 * **Why not `info-overlay-store`.** That store has ONE state slot, a global
 * delayed `hideInfoOverlay()` and a full-screen scrim: a model load would
 * overwrite this hint, a concurrent operation would blank it while it still
 * applies, and an open-ended hint must not dim the scene. Hence a small host of
 * its own; the shared overlay is not touched (plan-591 §2.5).
 */

import { useMemo, useSyncExternalStore } from 'react';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { Close, RestartAlt } from '@mui/icons-material';
import { useOptionalViewer } from '../../hooks/use-viewer';
import { isMobileDevice } from '../../hooks/use-mobile-layout';
import type { RVViewer } from '../rv-viewer';
import { loadVisualSettings, subscribeVisualSettings } from './visual-settings-store';
import { getVisualPresetApplyEpoch } from './visual-presets';
import { FS, INK_HIGH, WARN_LIGHT } from './shared-sx';

/** The apply epoch the user last dismissed at; -1 = never dismissed. */
let _dismissedEpoch = -1;
const _listeners = new Set<() => void>();

function notify(): void {
  for (const l of _listeners) {
    try { l(); } catch { /* a listener never breaks the dismiss */ }
  }
}

/** Hide the hint until the next preset apply (see the epoch note above). */
export function dismissReloadHint(): void {
  _dismissedEpoch = getVisualPresetApplyEpoch();
  notify();
}

/** Test seam: forget the dismiss. Never called by the UI. */
export function resetReloadHintDismiss(): void {
  _dismissedEpoch = -1;
  notify();
}

/**
 * Why the hint is suppressed on touch devices — the seam to plan-592 (F13).
 *
 * `main.ts` vetoes antialias on every touch device regardless of the stored
 * preset, so the mismatch there is PERMANENT and a reload could never resolve
 * it: an everlasting hint with a button that does nothing is worse than no
 * hint. `isMobileDevice()` is used on purpose — the very function `main.ts`
 * evaluates as `isTouchDevice`, exported and result-cached. NOT the
 * `useTouchDevice()` hook: that is
 * `useMediaQuery('(hover: none) and (pointer: coarse)') || isMobileDevice()`,
 * a genuine SUPERSET, and would also hide the hint on devices where the boot
 * veto does not apply — i.e. hide a situation that a reload WOULD fix.
 *
 * plan-592 makes a deliberate quality choice beat that veto; this gate is
 * removed there.
 */
export function reloadHintSuppressedByTouch(): boolean {
  return isMobileDevice();
}

/** True when a reload would change the rendered picture. */
export function antialiasNeedsReload(viewer: RVViewer): boolean {
  return loadVisualSettings().antialias !== viewer.antialiasActive;
}

/** Primitive snapshot — an object here would re-render in a loop. */
function snapshot(viewer: RVViewer): string {
  return `${antialiasNeedsReload(viewer)}|${getVisualPresetApplyEpoch()}|${_dismissedEpoch}`;
}

function subscribe(cb: () => void): () => void {
  const offSettings = subscribeVisualSettings(cb);
  _listeners.add(cb);
  return () => {
    offSettings();
    _listeners.delete(cb);
  };
}

/** Should the reload hint be on screen right now? */
export function useReloadHintVisible(viewer: RVViewer | undefined): boolean {
  const sub = useMemo(
    () => (cb: () => void) => (viewer ? subscribe(cb) : () => { /* no viewer, nothing moves */ }),
    [viewer],
  );
  const value = useSyncExternalStore(sub, () => (viewer ? snapshot(viewer) : 'none'));
  if (!viewer) return false;
  // After the hooks, so the hook order never depends on the device class.
  if (reloadHintSuppressedByTouch()) return false;
  const [mismatch, epoch, dismissed] = value.split('|');
  return mismatch === 'true' && epoch !== dismissed;
}

/**
 * The hint itself. Registered beside the other global overlays in `App.tsx`;
 * dims nothing and changes no `pointer-events` on any shared surface — only
 * this small box is clickable.
 */
export function ReloadHintHost() {
  const viewer = useOptionalViewer();
  const visible = useReloadHintVisible(viewer ?? undefined);
  if (!visible) return null;
  return (
    <Box
      data-ui-panel
      data-testid="reload-hint"
      role="status"
      sx={{
        position: 'fixed',
        bottom: 72,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9300,
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 2,
        py: 1,
        maxWidth: 'calc(100vw - 32px)',
        borderRadius: 2,
        border: `1px solid ${WARN_LIGHT}`,
        bgcolor: 'background.paper',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
      }}
    >
      <Typography sx={{ fontSize: FS.body, color: INK_HIGH, lineHeight: 1.3 }}>
        Antialiasing needs a reload to take effect.
      </Typography>
      <Button
        size="small"
        variant="outlined"
        data-testid="reload-hint-reload"
        onClick={() => window.location.reload()}
        startIcon={<RestartAlt />}
        sx={{
          flexShrink: 0,
          fontSize: FS.label,
          textTransform: 'none',
          py: 0,
          borderColor: WARN_LIGHT,
          color: WARN_LIGHT,
        }}
      >
        Reload now
      </Button>
      <IconButton
        size="small"
        aria-label="Dismiss"
        data-testid="reload-hint-dismiss"
        onClick={dismissReloadHint}
        sx={{ color: INK_HIGH }}
      >
        <Close sx={{ fontSize: FS.title }} />
      </IconButton>
    </Box>
  );
}

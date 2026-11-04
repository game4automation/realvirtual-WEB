// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  useState, useRef, useCallback, useEffect, type ReactElement, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Vector3 } from 'three';
import {
  Visibility, VisibilityOff, DirectionsWalk, BookmarkAddOutlined, GpsFixed, EventSeat,
} from '@mui/icons-material';
import { keyframes } from '@mui/material/styles';
import { useViewer } from '../../hooks/use-viewer';
import type { FpvPluginAPI, CameraFollowPluginAPI } from '../types/plugin-types';
import { loadVisualSettings, saveVisualSettings, type CameraBookmark } from './visual-settings-store';
import { toggleHmiVisible, useHmiVisible } from './hmi-visibility-store';
import { ActionSegment } from './action-group';
import { getActiveAssetContext } from '../editor/active-asset-store';
import { isEditableTarget } from './search-shortcut';
import { INK_HIGH, INK_LOW, SUCCESS } from './shared-sx';
import { ensureCameraCommandsRegistered } from './camera-commands';
import { ensureSelectionCommandsRegistered } from './selection-commands';
import { ensureUiPanelCommandsRegistered } from './ui-panel-commands';

ensureCameraCommandsRegistered();
ensureSelectionCommandsRegistered();
ensureUiPanelCommandsRegistered();

const LONG_PRESS_MS = 500;
const FLASH_MS = 800;
/** Bookmark slots in the persisted settings — the schema is unchanged (§2.2). */
const SLOTS = [0, 1, 2] as const;

/**
 * Which bookmark a keydown addresses: **1 / 2 / 3** restore, **Shift+1/2/3**
 * store the current view. Physical `code`, not `key` — Shift+1 is `!` on a US
 * and a German layout alike. Not while typing, not with Ctrl/Alt/Meta (browser
 * and OS accelerators) and not in the asset editor, like the **H** shortcut.
 * Pure — unit-tested.
 */
export function cameraBookmarkKey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>,
  ctx: { typing: boolean; editorActive: boolean },
): { slot: number; save: boolean } | null {
  const m = /^Digit([1-3])$/.exec(e.code);
  if (!m) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  if (ctx.typing || ctx.editorActive) return null;
  return { slot: Number(m[1]) - 1, save: e.shiftKey };
}

/** A segment that appears with the selection fades in instead of popping. */
const segmentEnter = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

/**
 * useCameraSegments — the CAM viewpoint bookmarks as a FLAT list of the
 * segments that are actually visible (plan-578 §2.7, F9/F11).
 *
 * A hook returning an array rather than a component returning a Fragment: the
 * host interpolates the dividers over the already-filtered list, so a
 * conditional segment can never produce a leading, doubled or missing divider.
 *
 * Only OCCUPIED slots get a segment; behind them sits one `+` segment that
 * stores the current view in the first free slot (and disappears once all three
 * are taken). Click restores, long-press overwrites — both unchanged, including
 * the green flash. The persisted shape (`cameras: (CameraBookmark|null)[]`,
 * three slots) is untouched; only its presentation changed.
 */
export function useCameraSegments(): ReactElement[] {
  const viewer = useViewer();
  const [cameras, setCameras] = useState<(CameraBookmark | null)[]>(() => loadVisualSettings().cameras);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  /** Index that was just saved — drives the green flash feedback */
  const [savedIdx, setSavedIdx] = useState<number | null>(null);

  const save = useCallback((idx: number) => {
    const state = viewer.getCameraState();
    const p = state.position;
    const t = state.target;
    const bm: CameraBookmark = { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z };
    const next = [...cameras];
    next[idx] = bm;
    setCameras(next);
    const s = loadVisualSettings();
    s.cameras = next;
    saveVisualSettings(s);
    setSavedIdx(idx);
    setTimeout(() => setSavedIdx(null), FLASH_MS);
  }, [viewer, cameras]);

  const restore = useCallback((idx: number) => {
    const bm = cameras[idx];
    if (!bm) return;
    viewer.animateCameraTo(
      new Vector3(bm.px, bm.py, bm.pz),
      new Vector3(bm.tx, bm.ty, bm.tz),
    );
  }, [viewer, cameras]);

  const handlePointerDown = (idx: number) => {
    didLongPress.current = false;
    pressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      save(idx);
    }, LONG_PRESS_MS);
  };

  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  /**
   * Restore runs on CLICK, not on pointer-up: a ButtonBase click is what Enter
   * and Space produce too, so the bookmark works from the keyboard (WCAG 2.1.1).
   * A long press already saved — its trailing click must not also restore.
   */
  const handleClick = (idx: number) => {
    cancelPress();
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    restore(idx);
  };

  // The global 1/2/3 (restore) and Shift+1/2/3 (save) shortcuts. Read through a
  // ref so the listener is bound once and still sees the current bookmarks.
  const keyActions = useRef({ save, restore });
  keyActions.current = { save, restore };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hit = cameraBookmarkKey(e, {
        typing: isEditableTarget(e.target),
        editorActive: getActiveAssetContext() !== null,
      });
      if (!hit) return;
      e.preventDefault();
      if (hit.save) keyActions.current.save(hit.slot);
      else keyActions.current.restore(hit.slot);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const segments: ReactElement[] = [];
  for (const i of SLOTS) {
    if (!cameras[i]) continue;
    const n = i + 1;
    segments.push(
      <ActionSegment
        key={`cam-${i}`}
        title={`Camera ${n} — Click or ${n}: restore · Hold or Shift+${n}: save current view`}
        color={savedIdx === i ? SUCCESS : INK_HIGH}
        label={n}
        onClick={() => handleClick(i)}
        sx={{ minWidth: 22 }}
        buttonProps={{
          'data-testid': `camera-bookmark-${n}`,
          'aria-label': `Camera ${n}`,
          'aria-keyshortcuts': `${n} Shift+${n}`,
          onPointerDown: () => handlePointerDown(i),
          onPointerUp: cancelPress,
          onPointerLeave: cancelPress,
          onKeyDown: (e: ReactKeyboardEvent) => {
            // Shift+Enter overwrites from the keyboard — the long press's twin.
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              save(i);
            }
          },
        }}
      />,
    );
  }
  const firstFree = SLOTS.find((i) => !cameras[i]);
  if (firstFree !== undefined) {
    segments.push(
      <ActionSegment
        key="cam-add"
        title={`Save current view as camera ${firstFree + 1} (Shift+${firstFree + 1})`}
        color={savedIdx === firstFree ? SUCCESS : INK_HIGH}
        icon={<BookmarkAddOutlined />}
        onClick={() => save(firstFree)}
        buttonProps={{ 'data-testid': 'camera-bookmark-add' }}
      />,
    );
  }
  return segments;
}

/** HMI-visibility toggle (the "eye") as a single action-group segment. */
export function HmiToggleButton() {
  const hmiVisible = useHmiVisible();
  return (
    <ActionSegment
      key="hmi-toggle"
      title="Toggle HMI (H)"
      onClick={toggleHmiVisible}
      color={hmiVisible ? undefined : INK_LOW}
      icon={hmiVisible ? <Visibility /> : <VisibilityOff />}
      buttonProps={{ 'data-testid': 'hmi-toggle', 'aria-pressed': hmiVisible, 'aria-keyshortcuts': 'H' }}
    />
  );
}

/**
 * Hook: is the First-Person View running?
 *
 * Exported because the FPV entry moved behind the cluster's overflow dropdown
 * (plan-578 F13): the HOST needs this state while the menu is CLOSED, so the
 * overflow trigger can show that FPV is engaged.
 */
export function useFpvActive(): boolean {
  const viewer = useViewer();
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onEnter = () => setActive(true);
    const onExit = () => setActive(false);
    viewer.on('fpv-enter', onEnter);
    viewer.on('fpv-exit', onExit);
    return () => { viewer.off('fpv-enter', onEnter); viewer.off('fpv-exit', onExit); };
  }, [viewer]);
  return active;
}

/** Toggle the First-Person View plugin (the overflow menu's FPV entry). */
export function useFpvToggle(): () => void {
  const viewer = useViewer();
  return useCallback(() => {
    viewer.getPlugin<FpvPluginAPI>('fpv')?.toggle();
  }, [viewer]);
}

/** The FPV icon — shared between the overflow menu row and its trigger. */
export const FPV_ICON = <DirectionsWalk />;

/** Hook: subscribe to the camera follow mode + whether the selection is followable. */
function useCameraFollowState(): { mode: 'follow' | 'siton' | null; canFollow: boolean } {
  const viewer = useViewer();
  const [mode, setMode] = useState<'follow' | 'siton' | null>(null);
  const [canFollow, setCanFollow] = useState(false);
  useEffect(() => {
    const plugin = () => viewer.getPlugin<CameraFollowPluginAPI>('camera-follow');
    const onMode = () => setMode(plugin()?.mode ?? null);
    const onSel = () => setCanFollow(!!plugin()?.canFollow());
    viewer.on('camera-mode-changed', onMode);
    viewer.on('selection-changed', onSel);
    onSel(); // initial state
    onMode();
    return () => {
      viewer.off('camera-mode-changed', onMode);
      viewer.off('selection-changed', onSel);
    };
  }, [viewer]);
  return { mode, canFollow };
}

/**
 * useFollowSegments — Follow and Sit-On, but ONLY while the selection is
 * followable (plan-578 F12).
 *
 * Returns an empty array otherwise, so the host's divider interpolation sees
 * nothing rather than two dead buttons. There is no "active without a
 * selection" state to cover: the plugin exits the mode itself when the
 * selection stops being followable (`camera-follow-plugin.tsx:50-51`), so these
 * segments follow that lifecycle instead of inventing one. A rendered segment
 * is therefore always clickable — the former grey-out colour and the
 * `canFollow` click guard are gone with it.
 *
 * Sit-On's right-drag look has no touch equivalent, so the host still gates
 * both on a desktop pointer.
 */
export function useFollowSegments(): ReactElement[] {
  const viewer = useViewer();
  const { mode, canFollow } = useCameraFollowState();
  if (!canFollow) return [];
  // They appear with the selection, at the strip's OUTER end, so nothing else in
  // the cluster moves — and fade in so the arrival is noticed, not a jump.
  const enterSx = { animation: `${segmentEnter} 120ms ease-out` };
  return [
    <ActionSegment
      key="follow"
      title="Follow selected part"
      active={mode === 'follow'}
      icon={<GpsFixed />}
      command={{
        id: 'camera.follow', viewer, buttonKey: 'follow',
        args: () => ({ mode: viewer.getPlugin<CameraFollowPluginAPI>('camera-follow')?.mode === 'follow' ? 'off' : 'follow' }),
      }}
      sx={enterSx}
      buttonProps={{ 'data-testid': 'camera-follow', 'aria-pressed': mode === 'follow' }}
    />,
    <ActionSegment
      key="siton"
      title="Sit on selected part (right-drag to look)"
      active={mode === 'siton'}
      icon={<EventSeat />}
      command={{
        id: 'camera.follow', viewer, buttonKey: 'siton',
        args: () => ({ mode: viewer.getPlugin<CameraFollowPluginAPI>('camera-follow')?.mode === 'siton' ? 'off' : 'siton' }),
      }}
      sx={enterSx}
      buttonProps={{ 'data-testid': 'camera-siton', 'aria-pressed': mode === 'siton' }}
    />,
  ];
}

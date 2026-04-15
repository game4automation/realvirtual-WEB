// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef, useCallback } from 'react';
import { Vector3 } from 'three';
import { Button, ButtonGroup, IconButton, Tooltip } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { loadVisualSettings, saveVisualSettings, type CameraBookmark } from './visual-settings-store';
import { toggleHmiVisible, useHmiVisible } from './hmi-visibility-store';

const LONG_PRESS_MS = 500;
const FLASH_MS = 800;

/**
 * Camera bookmark bar: click to restore, long-press to save.
 * Shared with the Visual settings tab via localStorage.
 */
export function CameraBar() {
  const viewer = useViewer();
  const hmiVisible = useHmiVisible();
  const [cameras, setCameras] = useState<(CameraBookmark | null)[]>(() => loadVisualSettings().cameras);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  /** Index that was just saved — drives the green flash feedback */
  const [savedIdx, setSavedIdx] = useState<number | null>(null);

  const save = useCallback((idx: number) => {
    const p = viewer.camera.position;
    const t = viewer.controls.target;
    const bm: CameraBookmark = { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z };
    const next = [...cameras];
    next[idx] = bm;
    setCameras(next);
    const s = loadVisualSettings();
    s.cameras = next;
    saveVisualSettings(s);
    // Flash feedback
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

  const handlePointerUp = (idx: number) => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (!didLongPress.current) {
      restore(idx);
    }
  };

  const handlePointerLeave = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <>
      <ButtonGroup variant="outlined" size="small">
        {[0, 1, 2].map((i) => {
          const isSaved = savedIdx === i;
          const hasBookmark = !!cameras[i];
          return (
            <Tooltip key={i} title={hasBookmark ? 'Click: restore | Hold: save' : 'Hold to save current view'} placement="top">
              <Button
                sx={{
                  minWidth: 48,
                  fontWeight: hasBookmark ? 700 : 400,
                  color: isSaved ? '#66bb6a' : hasBookmark ? '#4fc3f7' : undefined,
                  borderColor: isSaved ? '#66bb6a' : hasBookmark ? 'rgba(79,195,247,0.4)' : undefined,
                  bgcolor: isSaved ? 'rgba(102,187,106,0.15)' : undefined,
                  transition: 'all 0.2s',
                }}
                onPointerDown={() => handlePointerDown(i)}
                onPointerUp={() => handlePointerUp(i)}
                onPointerLeave={handlePointerLeave}
              >
                {isSaved ? 'Saved' : `CAM ${i + 1}`}
              </Button>
            </Tooltip>
          );
        })}
      </ButtonGroup>
      <IconButton size="small" color="inherit" title="Toggle HMI (H)" onClick={toggleHmiVisible}>
        {hmiVisible ? <Visibility fontSize="small" /> : <VisibilityOff fontSize="small" sx={{ opacity: 0.5 }} />}
      </IconButton>
    </>
  );
}

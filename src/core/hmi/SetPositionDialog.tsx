// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SetTransformDialog — Draggable floating panel for setting position and
 * rotation of layout objects.
 *
 * Triggered by the "Set Transform" context menu item. Operates on one or more
 * LayoutObject nodes. Uses a module-level store so context menu actions can
 * open it without React prop drilling.
 *
 * Draggable by the title bar (same pattern as ChartPanel / DriveChartOverlay).
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  Paper,
  Button,
  Box,
  Typography,
  IconButton,
} from '@mui/material';
import { Close } from '@mui/icons-material';
import { MathUtils } from 'three';
import type { RVViewer } from '../rv-viewer';
import { Vector3Editor } from './rv-field-editors';

// ─── Module-level store ─────────────────────────────────────────────────

interface SetTransformRequest {
  open: boolean;
  paths: string[];
  viewer: RVViewer | null;
}

const CLOSED: SetTransformRequest = Object.freeze({ open: false, paths: [], viewer: null });
let _state: SetTransformRequest = CLOSED;
const _listeners = new Set<() => void>();

function notify() {
  for (const l of _listeners) l();
}

/** Open the Set Transform dialog for the given layout object paths. */
export function openSetPositionDialog(viewer: RVViewer, paths: string[]): void {
  _state = { open: true, paths: [...paths], viewer };
  notify();
}

/** Close the Set Transform dialog. */
export function closeSetPositionDialog(): void {
  if (!_state.open) return;
  _state = CLOSED;
  notify();
}

function subscribe(listener: () => void) {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

function getSnapshot() {
  return _state;
}

// ─── Drag hook (simplified from ChartPanel) ─────────────────────────────

function useDrag(initialPos: { x: number; y: number }) {
  const [pos, setPos] = useState(initialPos);
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't drag from interactive elements
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SVG' || tag === 'PATH') return;
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return { pos, setPos, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

// ─── Component ──────────────────────────────────────────────────────────

export function SetPositionDialog() {
  const req = useSyncExternalStore(subscribe, getSnapshot);
  const [position, setPosition] = useState({ x: 0, y: 0, z: 0 });
  const [rotation, setRotation] = useState({ x: 0, y: 0, z: 0 });
  const drag = useDrag({ x: Math.round(window.innerWidth / 2 - 160), y: Math.round(window.innerHeight / 2 - 120) });

  // Track whether the user is actively editing a field (suppress polling during edits)
  const editingRef = useRef(false);

  // Read live node transform into state
  const readNodeTransform = useCallback(() => {
    if (!req.viewer?.registry || req.paths.length === 0) return;
    const node = req.viewer.registry.getNode(req.paths[0]);
    if (!node) return;
    setPosition({
      x: +node.position.x.toFixed(4),
      y: +node.position.y.toFixed(4),
      z: +node.position.z.toFixed(4),
    });
    setRotation({
      x: +MathUtils.radToDeg(node.rotation.x).toFixed(2),
      y: +MathUtils.radToDeg(node.rotation.y).toFixed(2),
      z: +MathUtils.radToDeg(node.rotation.z).toFixed(2),
    });
  }, [req.viewer, req.paths]);

  // Seed initial values + re-center on open
  useEffect(() => {
    if (!req.open) return;
    readNodeTransform();
    drag.setPos({ x: Math.round(window.innerWidth / 2 - 160), y: Math.round(window.innerHeight / 2 - 120) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.open]);

  // Poll node transform at 200ms while dialog is open (for gizmo drag updates)
  useEffect(() => {
    if (!req.open) return;
    const id = setInterval(() => {
      if (!editingRef.current) readNodeTransform();
    }, 200);
    return () => clearInterval(id);
  }, [req.open, readNodeTransform]);

  const applyTransform = useCallback((pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number }) => {
    if (!req.viewer?.registry) return;
    for (const path of req.paths) {
      const node = req.viewer.registry.getNode(path);
      if (!node) continue;
      const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv?.LayoutObject?.Locked) continue;

      node.position.set(pos.x, pos.y, pos.z);
      node.rotation.set(MathUtils.degToRad(rot.x), MathUtils.degToRad(rot.y), MathUtils.degToRad(rot.z));
      node.updateMatrixWorld(true);
      req.viewer.emit('layout-transform-update', {
        path,
        position: [pos.x, pos.y, pos.z] as [number, number, number],
        rotation: [rot.x, rot.y, rot.z] as [number, number, number],
      });
    }
    req.viewer.markRenderDirty();
  }, [req.viewer, req.paths]);

  const handlePositionChange = useCallback((v: { x: number; y: number; z: number }) => {
    editingRef.current = true;
    setPosition(v);
    applyTransform(v, rotation);
    // Release editing lock after a short delay (allows polling to resume)
    setTimeout(() => { editingRef.current = false; }, 300);
  }, [applyTransform, rotation]);

  const handleRotationChange = useCallback((v: { x: number; y: number; z: number }) => {
    editingRef.current = true;
    setRotation(v);
    applyTransform(position, v);
    setTimeout(() => { editingRef.current = false; }, 300);
  }, [applyTransform, position]);

  // ESC to close
  useEffect(() => {
    if (!req.open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSetPositionDialog(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [req.open]);

  if (!req.open) return null;

  const count = req.paths.length;
  const title = count > 1 ? `Set Transform (${count})` : 'Set Transform';
  const labelSx = { fontSize: 10, color: 'text.secondary', width: 55, flexShrink: 0 };

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        left: drag.pos.x,
        top: drag.pos.y,
        zIndex: 2000,
        width: 320,
        bgcolor: 'rgba(30, 30, 30, 0.95)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 1,
        pointerEvents: 'auto',
        overflow: 'hidden',
      }}
    >
      {/* Title bar — draggable */}
      <Box
        {...drag.handlers}
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1.5,
          py: 0.75,
          bgcolor: 'rgba(255,255,255,0.04)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          cursor: 'move',
          userSelect: 'none',
        }}
      >
        <Typography sx={{ fontSize: 11, fontWeight: 600, flex: 1, color: 'text.primary' }}>
          {title}
        </Typography>
        <IconButton size="small" onClick={closeSetPositionDialog} sx={{ p: 0.25, color: 'text.secondary' }}>
          <Close sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      {/* Position */}
      <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
          <Typography sx={labelSx}>Position</Typography>
          <Box sx={{ flex: 1 }}>
            <Vector3Editor value={position} onChange={handlePositionChange} />
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Typography sx={labelSx}>Rotation</Typography>
          <Box sx={{ flex: 1 }}>
            <Vector3Editor value={rotation} onChange={handleRotationChange} />
          </Box>
        </Box>
      </Box>

      {/* Footer */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1.5, py: 0.75, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Button size="small" onClick={closeSetPositionDialog} sx={{ fontSize: 10, textTransform: 'none', color: 'text.secondary', minWidth: 0, px: 1 }}>
          Close
        </Button>
      </Box>
    </Paper>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveTooltipContent — Renders drive info (name, direction, position, speed, etc.)
 * inside the generic TooltipLayer.
 *
 * Extracted from the former DriveTooltip.tsx. Receives typed data props and the
 * viewer instance. Self-registers in the TooltipContentRegistry at module load.
 *
 * Speed calculation uses an exponential moving average for smooth display.
 */

import { useRef, useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';
import type { RVDrive } from '../../engine/rv-drive';
import type { RVViewer } from '../../rv-viewer';

const SMOOTH_FACTOR = 0.15; // Exponential moving average weight (lower = smoother)
const REFRESH_MS = 100;

/** Data shape for drive tooltips. */
export interface DriveTooltipData extends TooltipData {
  type: 'drive';
  driveName: string;
}

/** Compute effective speed from refs (no React state, called from interval). */
function calcEffectiveSpeed(
  drive: RVDrive,
  prevPos: { current: number },
  prevTime: { current: number },
  smoothSpeed: { current: number },
): number {
  const now = performance.now();
  const dt = (now - prevTime.current) / 1000;
  const posDelta = Math.abs(drive.currentPosition - prevPos.current);

  if (dt > 0.01 && dt < 0.5) {
    const rawSpeed = drive.currentSpeed > 0.1 ? drive.currentSpeed : posDelta / dt;
    smoothSpeed.current += SMOOTH_FACTOR * (rawSpeed - smoothSpeed.current);
  }

  prevPos.current = drive.currentPosition;
  prevTime.current = now;
  return smoothSpeed.current;
}

/** Find drive by name in viewer.drives array. */
function findDrive(viewer: RVViewer, name: string): RVDrive | null {
  return viewer.drives.find(d => d.name === name) ?? null;
}

/** Row helper: label on left, value on right in monospace. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: '#fff', fontSize: 11, fontFamily: 'monospace' }}>
        {value}
      </Typography>
    </Box>
  );
}

/** Drive tooltip content provider component. */
export function DriveTooltipContent({ data, viewer }: TooltipContentProps<DriveTooltipData>) {
  const prevPosRef = useRef(0);
  const prevTimeRef = useRef(0);
  const smoothSpeedRef = useRef(0);

  const [driveState, setDriveState] = useState<{
    drive: RVDrive;
    speed: number;
  } | null>(null);

  // Reset speed tracking when drive name changes
  const prevNameRef = useRef<string | null>(null);
  if (data.driveName !== prevNameRef.current) {
    prevNameRef.current = data.driveName;
    prevPosRef.current = 0;
    prevTimeRef.current = 0;
    smoothSpeedRef.current = 0;
  }

  // Periodic refresh of drive data + speed
  useEffect(() => {
    const tick = () => {
      const drive = findDrive(viewer, data.driveName);
      if (!drive) {
        setDriveState(null);
        return;
      }
      const speed = calcEffectiveSpeed(drive, prevPosRef, prevTimeRef, smoothSpeedRef);
      setDriveState({ drive, speed });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.driveName]);

  if (!driveState) return null;

  const { drive, speed } = driveState;
  const unit = drive.isRotary ? '\u00B0' : 'mm';

  return (
    <>
      {/* Drive name */}
      <Typography
        variant="subtitle2"
        sx={{ color: '#ffa040', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {drive.name}
      </Typography>

      {/* Direction */}
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        {drive.Direction}{drive.ReverseDirection ? ' (rev)' : ''}
      </Typography>

      {/* Position & Speed */}
      <Row label="Position" value={`${drive.currentPosition.toFixed(1)}${unit}`} />
      <Row label="Speed" value={`${speed.toFixed(1)} ${unit}/s`} />

      {/* Target (if running) */}
      {drive.isRunning && (
        <Row label="Target" value={`${drive.targetPosition.toFixed(1)}${unit}`} />
      )}

      {/* Limits (if enabled) */}
      {drive.UseLimits && (
        <Row
          label="Limits"
          value={`${drive.LowerLimit.toFixed(0)} \u2026 ${drive.UpperLimit.toFixed(0)}${unit}`}
        />
      )}
    </>
  );
}

// ── Self-registration ──
// DriveTooltipContent accepts a narrower data type (DriveTooltipData) than the
// generic TooltipContentProps, which is safe at runtime since the store guarantees
// the correct data shape via the 'drive' content type.
tooltipRegistry.register({
  contentType: 'drive',
  component: DriveTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('drive', (node, viewer) => {
  const drive = viewer.drives.find(d => d.node === node)
    ?? viewer.registry?.findInParent<RVDrive>(node, 'Drive')
    ?? null;
  if (!drive) return null;
  return { type: 'drive', driveName: drive.name };
});

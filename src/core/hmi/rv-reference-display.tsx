// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-display.tsx — Reference display components for the Property Inspector.
 *
 * Shows ComponentReference and ScriptableObject references as clickable badges
 * with live signal values and link status indicators.
 */

import { useCallback } from 'react';
import {
  Box,
  Typography,
  Tooltip,
  Chip,
} from '@mui/material';
import { Link, LinkOff } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import { RvExtrasEditorPlugin } from './rv-extras-editor';
import type { SignalStore } from '../engine/rv-signal-store';
import {
  isSignalRefType,
  isSensorRefType,
  signalTypeLabel,
  formatRefSignalValue,
  formatSensorStatus,
  componentColor,
  getRefSignalColor,
  getSensorRefColor,
} from './rv-inspector-helpers';

// ── navigateToRef ────────────────────────────────────────────────────────

/** Navigate to a referenced node: open hierarchy, expand tree, select + show inspector. */
export function navigateToRef(viewer: RVViewer | null, path: string): void {
  if (!viewer) return;
  const plugin = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
  if (!plugin) return;
  plugin.selectAndReveal(path, true);
}

// ── ReferenceDisplay ─────────────────────────────────────────────────────

/** Display a ComponentReference — single badge, clickable to navigate. */
export function ReferenceDisplay({ value, viewer, signalStore }: {
  value: { type: string; path: string; componentType: string };
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
}) {
  const resolvedNode = viewer?.registry?.getNode(value.path);
  const isLinked = !!resolvedNode;
  const shortName = value.path.split('/').pop() ?? value.path;
  const shortType = value.componentType?.split('.').pop() ?? '';

  const handleClick = useCallback(() => navigateToRef(viewer, value.path), [viewer, value.path]);

  // Signal references -> single combined badge with live value, gray when off
  if (isSignalRefType(value.componentType)) {
    const liveColor = isLinked ? getRefSignalColor(shortType, signalStore, value.path) : '#ef5350';
    const typeLabel = signalTypeLabel(shortType);
    const valueStr = formatRefSignalValue(shortType, signalStore, value.path);

    return (
      <Tooltip title={`${isLinked ? 'Linked' : 'Unlinked'} \u2192 ${value.path}\nClick to navigate`} placement="top">
        <Chip
          label={`${shortName} ${typeLabel} ${valueStr}`}
          size="small"
          onClick={handleClick}
          sx={{
            height: 16,
            fontSize: 9,
            fontWeight: 500,
            cursor: 'pointer',
            bgcolor: liveColor + '18',
            color: liveColor,
            border: `1px solid ${liveColor}44`,
            '& .MuiChip-label': { px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis' },
            '&:hover': { bgcolor: liveColor + '28' },
          }}
        />
      </Tooltip>
    );
  }

  // Sensor references -> gray when not occupied, green when occupied
  if (isSensorRefType(value.componentType)) {
    const liveColor = isLinked ? getSensorRefColor(signalStore, value.path) : '#ef5350';
    const statusStr = formatSensorStatus(signalStore, value.path);
    return (
      <Tooltip title={`${isLinked ? 'Linked' : 'Unlinked'} \u2192 ${value.path}\nClick to navigate`} placement="top">
        <Chip
          label={`${shortName} Sensor ${statusStr}`}
          size="small"
          onClick={handleClick}
          sx={{
            height: 16,
            fontSize: 9,
            fontWeight: 500,
            cursor: 'pointer',
            bgcolor: liveColor + '18',
            color: liveColor,
            border: `1px solid ${liveColor}44`,
            '& .MuiChip-label': { px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis' },
            '&:hover': { bgcolor: liveColor + '28' },
          }}
        />
      </Tooltip>
    );
  }

  // Non-signal reference -> link icon badge, clickable to navigate
  return (
    <Tooltip title={`${isLinked ? 'Linked' : 'Unlinked'} \u2192 ${value.path}\nClick to navigate`} placement="top">
      <Chip
        icon={isLinked ? <Link sx={{ fontSize: 11 }} /> : <LinkOff sx={{ fontSize: 11 }} />}
        label={shortName + (shortType ? ` ${shortType}` : '')}
        size="small"
        onClick={handleClick}
        sx={{
          height: 16,
          fontSize: 9,
          fontWeight: 500,
          cursor: 'pointer',
          bgcolor: isLinked ? 'rgba(102,187,106,0.1)' : 'rgba(239,83,80,0.1)',
          color: isLinked ? '#66bb6a' : '#ef5350',
          border: `1px solid ${isLinked ? 'rgba(102,187,106,0.3)' : 'rgba(239,83,80,0.3)'}`,
          '& .MuiChip-label': { px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis' },
          '& .MuiChip-icon': { color: 'inherit', ml: 0.25 },
          '&:hover': { bgcolor: isLinked ? 'rgba(102,187,106,0.18)' : 'rgba(239,83,80,0.15)' },
        }}
      />
    </Tooltip>
  );
}

// ── ScriptableObjectDisplay ──────────────────────────────────────────────

/** Display a ScriptableObject reference (always read-only). */
export function ScriptableObjectDisplay({ value }: { value: Record<string, unknown> }) {
  const name = (value['name'] as string) ?? 'ScriptableObject';
  return (
    <Tooltip title={`ScriptableObject: ${name}`} placement="top">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.375, overflow: 'hidden' }}>
        <Link sx={{ fontSize: 12, color: '#7e57c2', flexShrink: 0 }} />
        <Typography sx={{
          fontSize: 10,
          fontFamily: 'monospace',
          color: '#7e57c2',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {name}
        </Typography>
      </Box>
    </Tooltip>
  );
}

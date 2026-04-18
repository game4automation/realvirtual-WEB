// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-badge.tsx — Central signal rendering for the WebViewer HMI.
 *
 * Provides:
 * - SignalBadge: Chip-style signal badge (OutBool ●, InBool ○) used by
 *   hierarchy browser, tooltip, and property inspector
 * - useSignalValues: Hook for live signal polling with direction/type info
 * - Utility functions for signal direction, color, and label resolution
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Typography, Chip } from '@mui/material';
import type { RVViewer } from '../rv-viewer';

const REFRESH_MS = 200;

// ── Signal direction ──────────────────────────────────────────────────

/** Signal direction derived from the node's PLCInput/PLCOutput type. */
export type SignalDirection = 'input' | 'output' | 'unknown';

/** Active color for signal values: green = PLCOutput, red = PLCInput. */
export function signalActiveColor(dir: SignalDirection): string {
  if (dir === 'output') return '#66bb6a';  // green
  if (dir === 'input') return '#ef5350';   // red
  return '#fff';
}

/** Short badge label from full PLC type — matches hierarchy browser. */
export function signalBadgeLabel(plcType: string): string {
  if (plcType === 'PLCOutputBool') return 'OutBool';
  if (plcType === 'PLCOutputFloat') return 'OutFloat';
  if (plcType === 'PLCOutputInt') return 'OutInt';
  if (plcType === 'PLCInputBool') return 'InBool';
  if (plcType === 'PLCInputFloat') return 'InFloat';
  if (plcType === 'PLCInputInt') return 'InInt';
  if (plcType.startsWith('PLCOutput')) return 'Out:' + plcType.replace('PLCOutput', '');
  if (plcType.startsWith('PLCInput')) return 'In:' + plcType.replace('PLCInput', '');
  return plcType;
}

/** Resolve signal direction and full PLC type from registry or signal store. */
export function resolveSignalInfo(viewer: RVViewer, signalName: string): { direction: SignalDirection; plcType: string } {
  // Primary: check SignalStore (always knows the PLC type, even when Signal.Name differs from node name)
  const storeType = viewer.signalStore?.getType(signalName);
  if (storeType) {
    const direction: SignalDirection = storeType.startsWith('PLCOutput') ? 'output'
      : storeType.startsWith('PLCInput') ? 'input' : 'unknown';
    return { direction, plcType: storeType };
  }
  // Fallback: search registry by node name
  const reg = viewer.registry;
  if (!reg) return { direction: 'unknown', plcType: '' };
  const results = reg.search(signalName);
  if (results.length === 0) return { direction: 'unknown', plcType: '' };
  const types = results[0].types;
  const plcType = types.find(t => t.startsWith('PLCOutput') || t.startsWith('PLCInput')) ?? '';
  const direction: SignalDirection = plcType.startsWith('PLCOutput') ? 'output'
    : plcType.startsWith('PLCInput') ? 'input' : 'unknown';
  return { direction, plcType };
}

// ── SignalBadge ───────────────────────────────────────────────────────

/** Chip-style signal badge: "OutBool ●" / "InBool ○" with direction coloring. */
export function SignalBadge({ direction, plcType, raw }: {
  direction: SignalDirection;
  plcType?: string;
  raw: boolean | number | undefined;
}) {
  const isActive = raw === true;
  const isBool = typeof raw === 'boolean' || raw === undefined;
  const color = (isBool && isActive) ? signalActiveColor(direction) : '#808080';
  const typeLabel = plcType ? signalBadgeLabel(plcType)
    : (direction === 'output' ? 'Out' : direction === 'input' ? 'In' : '');
  const valueStr = raw === undefined ? '—'
    : isBool ? (isActive ? '\u25CF' : '\u25CB')
    : typeof raw === 'number' ? (Number.isInteger(raw) ? String(raw) : raw.toFixed(1))
    : String(raw);
  const label = typeLabel ? `${typeLabel} ${valueStr}` : valueStr;

  return (
    <Chip
      label={label}
      size="small"
      sx={{
        height: 14,
        fontSize: 8,
        fontWeight: 600,
        letterSpacing: 0.3,
        bgcolor: color + '22',
        color: color,
        border: `1px solid ${color}44`,
        flexShrink: 0,
        '& .MuiChip-label': { px: 0.4, py: 0 },
      }}
    />
  );
}

// ── SignalRow ─────────────────────────────────────────────────────────

/** Label on left, SignalBadge on right. */
export function SignalRow({ label, direction, plcType, raw }: {
  label: string;
  direction: SignalDirection;
  plcType?: string;
  raw: boolean | number | undefined;
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, minHeight: 18 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
      <SignalBadge direction={direction} plcType={plcType} raw={raw} />
    </Box>
  );
}

// ── useSignalValues hook ─────────────────────────────────────────────

export interface SignalInfo {
  value: string;
  raw: boolean | number | undefined;
  direction: SignalDirection;
  plcType: string;
}

/** Poll signal values with direction/type info for a list of signal names. */
export function useSignalValues(viewer: RVViewer, signalNames: string[]): Map<string, SignalInfo> {
  const [values, setValues] = useState<Map<string, SignalInfo>>(new Map());

  const sigMeta = useMemo(() => {
    const map = new Map<string, { direction: SignalDirection; plcType: string }>();
    for (const name of signalNames) {
      map.set(name, resolveSignalInfo(viewer, name));
    }
    return map;
  }, [viewer, signalNames.join(',')]);

  const formatSignal = useCallback((raw: boolean | number | undefined): string => {
    if (raw === undefined) return '—';
    if (typeof raw === 'boolean') return raw ? 'True' : 'False';
    if (typeof raw === 'number') {
      return Number.isInteger(raw) ? String(raw) : raw.toFixed(2);
    }
    return String(raw);
  }, []);

  useEffect(() => {
    if (signalNames.length === 0) return;
    const tick = () => {
      const next = new Map<string, SignalInfo>();
      for (const name of signalNames) {
        const raw = viewer.signalStore?.get(name);
        const meta = sigMeta.get(name);
        next.set(name, {
          value: formatSignal(raw),
          raw,
          direction: meta?.direction ?? 'unknown',
          plcType: meta?.plcType ?? '',
        });
      }
      setValues(next);
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, signalNames.join(','), formatSignal, sigMeta]);

  return values;
}

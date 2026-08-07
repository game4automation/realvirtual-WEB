// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import type { RVLamp } from '../../engine/rv-lamp';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

export interface LampTooltipData extends TooltipData {
  type: 'lamp';
  nodePath: string;
  label: string;
}

/** Live state tooltip for Lamp components. */
export function LampTooltipContent({ data, viewer }: TooltipContentProps<LampTooltipData>) {
  const [state, setState] = useState<{
    lit: boolean;
    flashing: boolean;
    color: number;
    signalOn: string | null;
    signalFlash: string | null;
  } | null>(null);

  useEffect(() => {
    const node = viewer?.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const lamp = node.userData._rvLamp as RVLamp | undefined;
      if (!lamp) return;
      setState({
        lit: lamp.isLit(),
        flashing: lamp.Flashing,
        color: lamp.getOnColorHex(),
        signalOn: lamp.SignalLampOn,
        signalFlash: lamp.SingalLampFlashing,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  const color = `#${(state?.color ?? 0x808080).toString(16).padStart(6, '0')}`;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
        <Typography variant="subtitle2" sx={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>
          {data.label}
        </Typography>
        <Typography variant="caption" sx={{ color, ml: 'auto', fontWeight: 700, fontSize: 11 }}>
          {state?.lit ? (state.flashing ? 'FLASH' : 'ON') : 'OFF'}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.68)', fontSize: 11 }}>
        Color {color.toUpperCase()}
      </Typography>
      {state?.signalOn && (
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.68)', fontSize: 11 }}>
          On: {state.signalOn}
        </Typography>
      )}
      {state?.signalFlash && (
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.68)', fontSize: 11 }}>
          Flash: {state.signalFlash}
        </Typography>
      )}
    </Box>
  );
}

tooltipRegistry.register({
  contentType: 'lamp',
  component: LampTooltipContent as any,
});

tooltipRegistry.registerDataResolver('lamp', (node, viewer) => {
  const path = viewer.registry?.getPathForNode(node) ?? '';
  if (!path) return null;
  return {
    type: 'lamp',
    nodePath: path,
    label: node.name || path.split('/').pop() || 'Lamp',
  };
});

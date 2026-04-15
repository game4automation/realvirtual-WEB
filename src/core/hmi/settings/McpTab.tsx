// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect } from 'react';
import { Typography, Box, Button, Switch, TextField } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { useMcpBridge } from '../../../hooks/use-mcp-bridge';
import type { McpBridgePluginAPI } from '../../types/plugin-types';
import { StatRow } from './settings-helpers';

export function McpTab() {
  const viewer = useViewer();
  const mcp = useMcpBridge();
  const mcpPlugin = viewer.getPlugin<McpBridgePluginAPI>('mcp-bridge');
  const [portInput, setPortInput] = useState(mcp.port);
  const [portError, setPortError] = useState(false);

  // Sync portInput when mcp.port changes externally
  useEffect(() => { setPortInput(mcp.port); }, [mcp.port]);

  const stateColor = mcp.connected ? '#66bb6a'
    : mcp.reconnectAttempt > 0 ? '#ffa726'
    : mcp.enabled ? '#ef5350'
    : 'rgba(255,255,255,0.5)';

  const stateLabel = mcp.connected ? 'Connected'
    : mcp.reconnectAttempt > 0 ? `Reconnecting (${mcp.reconnectAttempt})...`
    : mcp.enabled ? 'Disconnected'
    : 'Disabled';

  const validatePort = (val: string): boolean => {
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };

  const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPortInput(val);
    setPortError(val !== '' && !validatePort(val));
  };

  const handlePortBlur = () => {
    if (portInput !== mcp.port && validatePort(portInput)) {
      mcpPlugin?.reconnect(portInput);
    } else if (!validatePort(portInput)) {
      setPortInput(mcp.port);
      setPortError(false);
    }
  };

  const handlePortKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Enable toggle */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>AI Bridge</Typography>
        <Switch size="small" checked={mcp.enabled}
          onChange={(_, v) => mcpPlugin?.setEnabled(v)} />
      </Box>

      {/* Status */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <StatRow label="State" value={stateLabel} color={stateColor} />
        <StatRow label="Tools" value={String(mcp.toolCount)} />
        <StatRow label="Port" value={mcp.port} />
      </Box>

      {/* Port config */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <TextField
          label="Port"
          size="small"
          type="number"
          value={portInput}
          onChange={handlePortChange}
          onBlur={handlePortBlur}
          onKeyDown={handlePortKeyDown}
          error={portError}
          helperText={portError ? '1-65535' : undefined}
          disabled={!mcp.enabled}
          slotProps={{ htmlInput: { min: 1, max: 65535 } }}
          sx={{ width: 110, '& input': { fontFamily: 'monospace', fontSize: 13 } }}
        />
      </Box>

      {/* Retry button */}
      {mcp.enabled && !mcp.connected && (
        <Button size="small" variant="outlined" onClick={() => mcpPlugin?.reconnect()}
          sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>
          Retry Now
        </Button>
      )}

      {/* Tool list */}
      {mcp.toolNames.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
            Registered Tools ({mcp.toolNames.length})
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, pl: 1 }}>
            {mcp.toolNames.map(name => (
              <Typography key={name} variant="caption"
                sx={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                {name}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

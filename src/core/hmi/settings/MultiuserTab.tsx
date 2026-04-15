// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useCallback, useRef } from 'react';
import { Typography, Box, Button, Select, MenuItem, Switch, TextField } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { useMultiuser } from '../../../hooks/use-multiuser';
import { loadMultiuserSettings, saveMultiuserSettings, type MultiuserSettings } from '../multiuser-settings-store';
import type { MultiuserPluginAPI } from '../../types/plugin-types';
import { StatRow } from './settings-helpers';

export function MultiuserTab({ muEnabled, onMuEnabledChange }: { muEnabled: boolean; onMuEnabledChange: (v: boolean) => void }) {
  const viewer = useViewer();
  const mu = useMultiuser();
  const muPlugin = viewer.getPlugin<MultiuserPluginAPI>('multiuser');

  // Load persisted settings
  const settingsRef = useRef(loadMultiuserSettings());
  const [serverUrl, setServerUrl] = useState(settingsRef.current.serverUrl);
  const [role, setRole] = useState<string>(settingsRef.current.role);
  const [name, setName] = useState(settingsRef.current.displayName);
  const [joinCode, setJoinCode] = useState(settingsRef.current.joinCode);

  const persist = useCallback((patch: Partial<MultiuserSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveMultiuserSettings(settingsRef.current);
  }, []);

  // Keep in sync when connected
  useEffect(() => {
    if (mu.connected) {
      setServerUrl(mu.serverUrl);
      setName(mu.localName);
      setRole(mu.localRole);
    }
  }, [mu.connected, mu.serverUrl, mu.localName, mu.localRole]);

  const stateColor = mu.connected ? '#66bb6a' : 'rgba(255,255,255,0.5)';
  const stateLabel = mu.connected ? `Connected (${mu.playerCount + 1} users)` : 'Disconnected';

  const handleConnect = () => {
    muPlugin?.joinSession(serverUrl, name, undefined, role, joinCode || undefined);
  };

  const handleDisconnect = () => {
    muPlugin?.leaveSession();
  };

  const handleEnabledToggle = (_: unknown, v: boolean) => {
    persist({ enabled: v });
    onMuEnabledChange(v);
    if (!v && mu.connected) muPlugin?.leaveSession();
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Enable toggle */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>Multiuser</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>
            Show multiuser button in toolbar
          </Typography>
        </Box>
        <Switch size="small" checked={muEnabled} onChange={handleEnabledToggle} />
      </Box>

      {/* Status */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <StatRow label="State" value={stateLabel} color={stateColor} />
        {mu.connected && <StatRow label="Server" value={mu.serverUrl} />}
        {mu.connected && <StatRow label="Role" value={mu.localRole} />}
      </Box>

      {/* Server URL */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5, display: 'block' }}>
          Server URL
        </Typography>
        <TextField
          fullWidth size="small"
          placeholder="ws://192.168.1.5:7000"
          value={serverUrl}
          onChange={(e) => { setServerUrl(e.target.value); persist({ serverUrl: e.target.value }); }}
          disabled={mu.connected}
          sx={{ '& input': { fontFamily: 'monospace', fontSize: 12 } }}
        />
      </Box>

      {/* Join Code (optional session/room identifier) */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5, display: 'block' }}>
          Join Code (optional)
        </Typography>
        <TextField
          fullWidth size="small"
          placeholder="e.g. ABC123"
          value={joinCode}
          onChange={(e) => { setJoinCode(e.target.value); persist({ joinCode: e.target.value }); }}
          disabled={mu.connected}
          sx={{ '& input': { fontFamily: 'monospace', fontSize: 12, textTransform: 'uppercase' } }}
        />
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontSize: 10 }}>
          Identifies the session on a relay server hosting multiple models
        </Typography>
      </Box>

      {/* Display Name */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5, display: 'block' }}>
          Display Name
        </Typography>
        <TextField
          fullWidth size="small"
          placeholder="Browser"
          value={name}
          onChange={(e) => { setName(e.target.value); persist({ displayName: e.target.value }); }}
          disabled={mu.connected}
          sx={{ '& input': { fontSize: 12 } }}
        />
      </Box>

      {/* Role */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5, display: 'block' }}>
          Role
        </Typography>
        <Select
          fullWidth size="small"
          value={role}
          onChange={(e) => { setRole(e.target.value); persist({ role: e.target.value as 'observer' | 'operator' }); }}
          disabled={mu.connected}
          sx={{ fontSize: 12 }}
        >
          <MenuItem value="observer" sx={{ fontSize: 12 }}>Observer (watch only)</MenuItem>
          <MenuItem value="operator" sx={{ fontSize: 12 }}>Operator (full control)</MenuItem>
        </Select>
      </Box>

      {/* Connect / Disconnect */}
      {!mu.connected ? (
        <Button size="small" variant="contained" onClick={handleConnect}
          disabled={!serverUrl.trim()}
          sx={{ alignSelf: 'flex-start', textTransform: 'none', bgcolor: '#1565c0', '&:hover': { bgcolor: '#1976d2' } }}>
          Connect
        </Button>
      ) : (
        <Button size="small" variant="outlined" onClick={handleDisconnect}
          sx={{
            alignSelf: 'flex-start', textTransform: 'none',
            borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.65)',
            '&:hover': { borderColor: '#ef5350', color: '#ef5350', bgcolor: 'rgba(239,83,80,0.06)' },
          }}>
          Disconnect
        </Button>
      )}

      {/* Connected players */}
      {mu.connected && mu.players.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
            Connected Users ({mu.players.length + 1})
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, pl: 1 }}>
            {mu.players.map(p => (
              <Box key={p.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: p.color, flexShrink: 0 }} />
                <Typography variant="caption" sx={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                  {p.name}
                </Typography>
                <Typography variant="caption" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', ml: 'auto' }}>
                  {p.role}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

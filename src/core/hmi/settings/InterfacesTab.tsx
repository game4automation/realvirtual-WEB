// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect } from 'react';
import { Typography, Box, Button, CircularProgress, Select, MenuItem, Switch, TextField } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { loadInterfaceSettings, saveInterfaceSettings, type InterfaceSettings, type InterfaceType, INTERFACE_DEFAULTS } from '../../../interfaces/interface-settings-store';
import { InterfaceManager } from '../../../interfaces/interface-manager';
import { StatRow, tfSx } from './settings-helpers';

const INTERFACE_OPTIONS: { value: InterfaceType; label: string; available: boolean }[] = [
  { value: 'none', label: 'None', available: true },
  { value: 'websocket-realtime', label: 'WebSocket Realtime', available: true },
  { value: 'ctrlx', label: 'ctrlX (Bosch Rexroth)', available: true },
  { value: 'twincat-hmi', label: 'TwinCAT HMI', available: false },
  { value: 'mqtt', label: 'MQTT', available: false },
  { value: 'keba', label: 'KEBA', available: false },
];

export function InterfacesTab() {
  const viewer = useViewer();
  const manager = viewer.getPlugin<InterfaceManager>('interface-manager');
  const [settings, setSettings] = useState<InterfaceSettings>(loadInterfaceSettings);
  const [connectionState, setConnectionState] = useState<string>(
    manager?.getActive()?.connectionState ?? 'disconnected',
  );
  const [signalCount, setSignalCount] = useState(
    manager?.getActive()?.discoveredSignals.length ?? 0,
  );
  const [connecting, setConnecting] = useState(false);

  // Poll connection state
  useEffect(() => {
    const interval = setInterval(() => {
      const active = manager?.getActive();
      setConnectionState(prev => {
        const next = active?.connectionState ?? 'disconnected';
        return prev === next ? prev : next;
      });
      setSignalCount(prev => {
        const next = active?.discoveredSignals.length ?? 0;
        return prev === next ? prev : next;
      });
    }, 200);
    return () => clearInterval(interval);
  }, [manager]);

  const persist = (patch: Partial<InterfaceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveInterfaceSettings(next);
  };

  const isWsBased = settings.activeType === 'websocket-realtime'
    || settings.activeType === 'ctrlx'
    || settings.activeType === 'twincat-hmi'
    || settings.activeType === 'keba';

  const isMqtt = settings.activeType === 'mqtt';
  const isConnected = connectionState === 'connected';
  const showSettings = settings.activeType !== 'none';

  const handleConnect = async () => {
    if (!manager) return;
    setConnecting(true);
    try {
      await manager.activate(settings.activeType, settings);
    } catch {
      // Error already handled via state
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    if (!manager) return;
    manager.deactivate();
    setConnectionState('disconnected');
    setSignalCount(0);
  };

  const stateColor = connectionState === 'connected' ? '#66bb6a'
    : connectionState === 'connecting' ? '#ffa726'
    : connectionState === 'error' ? '#ef5350'
    : 'rgba(255,255,255,0.5)';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* Interface selector */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Interface Protocol
        </Typography>
        <Select
          size="small"
          fullWidth
          value={settings.activeType}
          onChange={(e) => {
            const type = e.target.value as InterfaceType;
            if (isConnected) handleDisconnect();
            persist({ activeType: type });
          }}
          sx={{ mt: 0.5, fontSize: 13, '& .MuiSelect-select': { py: 0.75 } }}
        >
          {INTERFACE_OPTIONS.map((opt) => (
            <MenuItem key={opt.value} value={opt.value} disabled={!opt.available} sx={{ fontSize: 13 }}>
              {opt.label}
              {!opt.available && (
                <Typography component="span" sx={{ ml: 1, fontSize: 10, color: 'text.disabled' }}>coming soon</Typography>
              )}
            </MenuItem>
          ))}
        </Select>
      </Box>

      {/* WebSocket-based settings */}
      {showSettings && isWsBased && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Connection
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              label="Address"
              size="small"
              fullWidth
              value={settings.wsAddress}
              onChange={(e) => persist({ wsAddress: e.target.value })}
              placeholder="localhost"
              sx={tfSx}
            />
            <TextField
              label="Port"
              size="small"
              type="number"
              value={settings.wsPort}
              onChange={(e) => persist({ wsPort: Number(e.target.value) || INTERFACE_DEFAULTS.wsPort })}
              sx={{ ...tfSx, width: 90, flexShrink: 0 }}
            />
          </Box>
          <TextField
            label="Path"
            size="small"
            fullWidth
            value={settings.wsPath}
            onChange={(e) => persist({ wsPath: e.target.value })}
            placeholder="/"
            sx={tfSx}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.primary', fontSize: 13 }}>Use SSL (wss://)</Typography>
            <Switch size="small" checked={settings.wsUseSSL} onChange={(_, v) => persist({ wsUseSSL: v })} />
          </Box>
          {(settings.wsUseSSL || settings.activeType === 'ctrlx') && (
            <TextField
              label="Auth Token"
              size="small"
              fullWidth
              type="password"
              value={settings.wsAuthToken}
              onChange={(e) => persist({ wsAuthToken: e.target.value })}
              placeholder="Bearer token (ctrlX SSL)"
              sx={tfSx}
            />
          )}
        </Box>
      )}

      {/* MQTT settings */}
      {showSettings && isMqtt && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            MQTT Broker
          </Typography>
          <TextField
            label="Broker URL"
            size="small"
            fullWidth
            value={settings.mqttBrokerUrl}
            onChange={(e) => persist({ mqttBrokerUrl: e.target.value })}
            placeholder="ws://localhost:8080/mqtt"
            sx={tfSx}
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              label="Username"
              size="small"
              fullWidth
              value={settings.mqttUsername}
              onChange={(e) => persist({ mqttUsername: e.target.value })}
              sx={tfSx}
            />
            <TextField
              label="Password"
              size="small"
              fullWidth
              type="password"
              value={settings.mqttPassword}
              onChange={(e) => persist({ mqttPassword: e.target.value })}
              sx={tfSx}
            />
          </Box>
          <TextField
            label="Topic Prefix"
            size="small"
            fullWidth
            value={settings.mqttTopicPrefix}
            onChange={(e) => persist({ mqttTopicPrefix: e.target.value })}
            placeholder="rv/"
            sx={tfSx}
          />
        </Box>
      )}

      {/* Auto-connect toggle */}
      {showSettings && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box>
            <Typography variant="body2" sx={{ color: 'text.primary', fontSize: 13 }}>Auto-Connect</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>
              Connect automatically when a model is loaded
            </Typography>
          </Box>
          <Switch size="small" checked={settings.autoConnect} onChange={(_, v) => persist({ autoConnect: v })} />
        </Box>
      )}

      {/* Connect / Disconnect button */}
      {showSettings && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {isConnected ? (
            <Button
              variant="outlined"
              size="small"
              color="warning"
              onClick={handleDisconnect}
              sx={{ fontSize: 11, textTransform: 'none' }}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              variant="contained"
              size="small"
              onClick={handleConnect}
              disabled={connecting || !manager}
              startIcon={connecting ? <CircularProgress size={12} color="inherit" /> : undefined}
              sx={{ fontSize: 11, textTransform: 'none' }}
            >
              {connecting ? 'Connecting...' : 'Connect'}
            </Button>
          )}
        </Box>
      )}

      {/* Status */}
      {showSettings && (
        <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Status
          </Typography>
          <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <StatRow label="State" value={connectionState} color={stateColor} />
            <StatRow label="Signals" value={isConnected ? String(signalCount) : '--'} />
            <StatRow label="Protocol" value={INTERFACE_OPTIONS.find(o => o.value === settings.activeType)?.label ?? '--'} />
          </Box>
        </Box>
      )}

      {!manager && (
        <Typography variant="caption" sx={{ color: '#ef5350' }}>
          InterfaceManager not registered. Add it to the viewer plugins in main.ts.
        </Typography>
      )}
    </Box>
  );
}

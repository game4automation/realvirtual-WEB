// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect } from 'react';
import { Typography, Box, Button, CircularProgress, Select, MenuItem, Switch, TextField } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { loadInterfaceSettings, saveInterfaceSettings, type InterfaceSettings, type InterfaceType, INTERFACE_DEFAULTS } from '../../../interfaces/interface-settings-store';
import { InterfaceManager } from '../../../interfaces/interface-manager';
import { StatRow, tfSx, SettingsSection, FieldRow } from './settings-helpers';
import { connectionStateColor } from '../isa-colors';
import { useSignalDisplaySettings, setChipVariant, setTooltipField, type SignalChipVariant } from '../signal-display-store';

const INTERFACE_OPTIONS: { value: InterfaceType; label: string; available: boolean }[] = [
  { value: 'none', label: 'None', available: true },
  { value: 'websocket-realtime', label: 'WebSocket Realtime', available: true },
  { value: 'ctrlx', label: 'ctrlX (Bosch Rexroth)', available: true },
  { value: 'twincat-hmi', label: 'TwinCAT HMI (Beckhoff)', available: true },
  { value: 'mqtt', label: 'MQTT', available: true },
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
  const display = useSignalDisplaySettings();

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

  const stateColor = connectionStateColor(connectionState) ?? 'rgba(255,255,255,0.5)';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Interface selector */}
      <SettingsSection id="interfaces-protocol" title="Interface Protocol">
        <FieldRow label="Protocol">
          <Select
            size="small"
            fullWidth
            value={settings.activeType}
            onChange={(e) => {
              const type = e.target.value as InterfaceType;
              if (isConnected) handleDisconnect();
              persist({ activeType: type });
            }}
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
        </FieldRow>
      </SettingsSection>

      {/* WebSocket-based settings */}
      {showSettings && isWsBased && (
        <SettingsSection id="interfaces-connection" title="Connection">
          <FieldRow label="Address">
            <Box sx={{ display: 'flex', gap: 1, flex: 1, minWidth: 0 }}>
              <TextField
                size="small"
                fullWidth
                value={settings.wsAddress}
                onChange={(e) => persist({ wsAddress: e.target.value })}
                placeholder="localhost"
                sx={tfSx}
              />
              <TextField
                size="small"
                type="number"
                value={settings.wsPort}
                onChange={(e) => persist({ wsPort: Number(e.target.value) || INTERFACE_DEFAULTS.wsPort })}
                placeholder="Port"
                sx={{ ...tfSx, width: 90, flexShrink: 0 }}
              />
            </Box>
          </FieldRow>
          <FieldRow label="Path">
            <TextField
              size="small"
              fullWidth
              value={settings.wsPath}
              onChange={(e) => persist({ wsPath: e.target.value })}
              placeholder="/"
              sx={tfSx}
            />
          </FieldRow>
          <FieldRow label="Use SSL (wss://)">
            <Switch size="small" checked={settings.wsUseSSL} onChange={(_, v) => persist({ wsUseSSL: v })} />
          </FieldRow>
          {(settings.wsUseSSL || settings.activeType === 'ctrlx' || settings.activeType === 'twincat-hmi') && (
            <FieldRow label="Auth Token">
              <TextField
                size="small"
                fullWidth
                type="password"
                value={settings.wsAuthToken}
                onChange={(e) => persist({ wsAuthToken: e.target.value })}
                placeholder={settings.activeType === 'twincat-hmi' ? 'Session token (cid)' : 'Bearer token (ctrlX SSL)'}
                sx={tfSx}
              />
            </FieldRow>
          )}
        </SettingsSection>
      )}

      {/* MQTT settings */}
      {showSettings && isMqtt && (
        <SettingsSection id="interfaces-mqtt" title="MQTT Broker">
          <FieldRow label="Broker URL">
            <TextField
              size="small"
              fullWidth
              value={settings.mqttBrokerUrl}
              onChange={(e) => persist({ mqttBrokerUrl: e.target.value })}
              placeholder="ws://localhost:8080/mqtt"
              sx={tfSx}
            />
          </FieldRow>
          <FieldRow label="Username">
            <TextField
              size="small"
              fullWidth
              value={settings.mqttUsername}
              onChange={(e) => persist({ mqttUsername: e.target.value })}
              sx={tfSx}
            />
          </FieldRow>
          <FieldRow label="Password">
            <TextField
              size="small"
              fullWidth
              type="password"
              value={settings.mqttPassword}
              onChange={(e) => persist({ mqttPassword: e.target.value })}
              sx={tfSx}
            />
          </FieldRow>
          <FieldRow label="Topic Prefix">
            <TextField
              size="small"
              fullWidth
              value={settings.mqttTopicPrefix}
              onChange={(e) => persist({ mqttTopicPrefix: e.target.value })}
              placeholder="rv/"
              sx={tfSx}
            />
          </FieldRow>
        </SettingsSection>
      )}

      {/* Connection control — auto-connect toggle + connect/disconnect */}
      {showSettings && (
        <SettingsSection id="interfaces-control" title="Connection Control">
          <FieldRow label="Auto-Connect" hint="Connect automatically when a model is loaded">
            <Switch size="small" checked={settings.autoConnect} onChange={(_, v) => persist({ autoConnect: v })} />
          </FieldRow>

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
        </SettingsSection>
      )}

      {/* Status */}
      {showSettings && (
        <SettingsSection id="interfaces-status" title="Status">
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <StatRow label="State" value={connectionState} color={stateColor} />
            <StatRow label="Signals" value={isConnected ? String(signalCount) : '--'} />
            <StatRow label="Protocol" value={INTERFACE_OPTIONS.find(o => o.value === settings.activeType)?.label ?? '--'} />
          </Box>
        </SettingsSection>
      )}

      {/* Signal Display — how signal chips + tooltips render (persisted in the browser) */}
      <SettingsSection id="interfaces-signal-display" title="Signal Display">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <FieldRow label="Signal chips" hint="Global default for how signal chips render (per-usage overrides win).">
            <Select
              size="small"
              value={display.chipVariant}
              onChange={(e) => setChipVariant(e.target.value as SignalChipVariant)}
              renderValue={(v) => v === 'full' ? 'Full' : v === 'standard' ? 'Standard' : 'Minimal'}
              sx={tfSx}
            >
              <MenuItem value="full">
                Full
                <Typography component="span" sx={{ ml: 1, fontSize: 10, color: 'text.disabled' }}>
                  Conveyor.Start OutBool ●
                </Typography>
              </MenuItem>
              <MenuItem value="standard">
                Standard
                <Typography component="span" sx={{ ml: 1, fontSize: 10, color: 'text.disabled' }}>
                  Conveyor.Start ●
                </Typography>
              </MenuItem>
              <MenuItem value="minimal">
                Minimal
                <Typography component="span" sx={{ ml: 1, fontSize: 10, color: 'text.disabled' }}>
                  O ●
                </Typography>
              </MenuItem>
            </Select>
          </FieldRow>
          <FieldRow label="Tooltip: value">
            <Switch size="small" checked={display.tooltip.value} onChange={(e) => setTooltipField('value', e.target.checked)} />
          </FieldRow>
          <FieldRow label="Tooltip: address / source">
            <Switch size="small" checked={display.tooltip.address} onChange={(e) => setTooltipField('address', e.target.checked)} />
          </FieldRow>
          <FieldRow label="Tooltip: comment">
            <Switch size="small" checked={display.tooltip.comment} onChange={(e) => setTooltipField('comment', e.target.checked)} />
          </FieldRow>
          <FieldRow label="Tooltip: binding">
            <Switch size="small" checked={display.tooltip.binding} onChange={(e) => setTooltipField('binding', e.target.checked)} />
          </FieldRow>
        </Box>
      </SettingsSection>

      {!manager && (
        <Typography variant="caption" sx={{ color: '#ef5350' }}>
          InterfaceManager not registered. Add it to the viewer plugins in main.ts.
        </Typography>
      )}
    </Box>
  );
}

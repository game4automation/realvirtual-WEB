// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MultiuserPanel — Simplified join/share popup for the TopBar.
 *
 * Default flow: enter name + session code → Join & Share.
 * Auto-detects mode: ws:// input = direct connection, otherwise = relay with join code.
 * Advanced "Direct Connection" section is collapsible for power users.
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  IconButton,
  Divider,
  Collapse,
} from '@mui/material';
import { Close, PersonOutline, WifiOff, Wifi, Share, ExpandMore, ExpandLess } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMultiuser } from '../../hooks/use-multiuser';
import { loadMultiuserSettings, saveMultiuserSettings } from './multiuser-settings-store';
import type { MultiuserPluginAPI } from '../types/plugin-types';
import type { PlayerInfo } from '../engine/rv-avatar-manager';

// ── Styling constants ─────────────────────────────────────────────────────

const PANEL_WIDTH = 260;
const BG = 'rgba(18,22,30,0.96)';
const BORDER = 'rgba(255,255,255,0.07)';
const INPUT_SX = {
  '& .MuiInputBase-input': { fontSize: 12, color: 'rgba(255,255,255,0.85)', py: 0.75 },
  '& .MuiOutlinedInput-notchedOutline': { borderColor: BORDER },
  '& .MuiOutlinedInput-root': { bgcolor: 'rgba(255,255,255,0.04)' },
};

// ── Sub-components ────────────────────────────────────────────────────────

const PlayerRow = memo(function PlayerRow({ player }: { player: PlayerInfo }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.3 }}>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%',
        bgcolor: player.color,
        flexShrink: 0,
        boxShadow: `0 0 4px ${player.color}`,
      }} />
      <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {player.name}
      </Typography>
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>
        {player.xrMode !== 'none' ? player.xrMode.toUpperCase() : player.role}
      </Typography>
    </Box>
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Returns true if the input looks like a WebSocket URL (direct connection). */
function isDirectUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.startsWith('ws://') || v.startsWith('wss://');
}

// ── Panel ─────────────────────────────────────────────────────────────────

interface MultiuserPanelProps {
  onClose: () => void;
}

export function MultiuserPanel({ onClose }: MultiuserPanelProps) {
  const viewer = useViewer();
  const mu = useMultiuser();

  // State
  const [localName, setLocalName] = useState(() => {
    const s = loadMultiuserSettings();
    return s.displayName || 'Browser';
  });
  const [joinCode, setJoinCode] = useState(() => {
    const s = loadMultiuserSettings();
    return s.joinCode || '';
  });
  const [relayUrl, setRelayUrl] = useState(() => {
    const s = loadMultiuserSettings();
    return s.relayUrl || 'wss://download.realvirtual.io/relay';
  });
  const [directUrl, setDirectUrl] = useState(() => {
    const s = loadMultiuserSettings();
    return s.serverUrl || '';
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);

  // Sync from plugin/URL on mount
  const directUrlRef = useRef(directUrl);
  directUrlRef.current = directUrl;
  useEffect(() => {
    const plugin = viewer.getPlugin<MultiuserPluginAPI>('multiuser');
    if (plugin) {
      if (plugin.localName) setLocalName(plugin.localName);
      if (plugin.joinCode) setJoinCode(plugin.joinCode);
    }
    const params = new URLSearchParams(window.location.search);
    const urlServer = params.get('server') ?? params.get('relay') ?? params.get('multiuserServer');
    const urlName = params.get('name') ?? params.get('multiuserName');
    const urlCode = params.get('joinCode') ?? params.get('code');
    // If URL has a server that looks like ws://, pre-fill direct; otherwise treat as relay
    if (urlServer) {
      if (isDirectUrl(urlServer)) {
        setDirectUrl(urlServer);
        setShowAdvanced(true);
      } else {
        setRelayUrl(urlServer);
      }
    }
    if (urlName) setLocalName(urlName);
    if (urlCode) setJoinCode(urlCode);
  }, [viewer]);

  // Keep in sync when connected
  useEffect(() => {
    if (mu.connected && mu.localName) setLocalName(mu.localName);
  }, [mu.connected, mu.localName]);

  // Determine connection mode from current state
  const useDirectMode = showAdvanced && directUrl.trim() && isDirectUrl(directUrl);

  const handleJoin = useCallback(() => {
    const plugin = viewer.getPlugin<MultiuserPluginAPI>('multiuser');
    if (!plugin) return;

    // Persist
    const settings = loadMultiuserSettings();
    settings.connectionMode = useDirectMode ? 'local' : 'relay';
    settings.serverUrl = directUrl;
    settings.relayUrl = relayUrl;
    settings.displayName = localName;
    settings.joinCode = joinCode;
    saveMultiuserSettings(settings);

    const url = useDirectMode ? directUrl : relayUrl;
    const role = plugin.localRole || 'observer';
    plugin.joinSession(url, localName, undefined, role, useDirectMode ? undefined : (joinCode || undefined));
  }, [viewer, useDirectMode, directUrl, relayUrl, localName, joinCode]);

  const handleDisconnect = useCallback(() => {
    viewer.getPlugin<MultiuserPluginAPI>('multiuser')?.leaveSession();
  }, [viewer]);

  const buildShareUrl = useCallback(() => {
    const base = window.location.origin + window.location.pathname;
    const shareParams = new URLSearchParams();
    const activeServer = mu.serverUrl || (useDirectMode ? directUrl : relayUrl);
    if (activeServer) shareParams.set('server', activeServer);
    if (joinCode) shareParams.set('joinCode', joinCode);
    shareParams.set('name', 'Guest');
    const currentModel = new URLSearchParams(window.location.search).get('model');
    if (currentModel) shareParams.set('model', currentModel);
    return base + '?' + shareParams.toString();
  }, [mu.serverUrl, useDirectMode, directUrl, relayUrl, joinCode]);

  const copyShareLink = useCallback(() => {
    navigator.clipboard.writeText(buildShareUrl()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [buildShareUrl]);

  const handleJoinAndShare = useCallback(() => {
    handleJoin();
    copyShareLink();
  }, [handleJoin, copyShareLink]);

  const canJoin = useDirectMode
    ? !!directUrl.trim()
    : !!joinCode.trim();

  const isConnected = mu.connected;
  const players: PlayerInfo[] = mu.players;

  return (
    <Box data-ui-panel sx={{
      position: 'fixed',
      top: 44,
      right: 8,
      width: PANEL_WIDTH,
      bgcolor: BG,
      border: `1px solid ${BORDER}`,
      borderRadius: 1,
      p: 1.25,
      zIndex: 9000,
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      backdropFilter: 'blur(8px)',
      pointerEvents: 'auto',
    }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.75 }}>
        {isConnected
          ? <Wifi sx={{ fontSize: 14, color: '#66bb6a', mr: 0.5 }} />
          : <WifiOff sx={{ fontSize: 14, color: 'rgba(255,255,255,0.35)', mr: 0.5 }} />}
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', flexGrow: 1 }}>
          Multiuser
        </Typography>
        <IconButton size="small" onClick={onClose} sx={{ color: 'rgba(255,255,255,0.4)', p: 0.25 }}>
          <Close sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      <Divider sx={{ borderColor: BORDER, mb: 1 }} />

      {/* ── Join form (disconnected) ── */}
      {!isConnected && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <TextField
            fullWidth size="small"
            placeholder="Your Name"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canJoin) handleJoinAndShare(); }}
            sx={INPUT_SX}
          />

          <TextField
            fullWidth size="small"
            placeholder="Session Code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canJoin) handleJoinAndShare(); }}
            sx={{ ...INPUT_SX, '& .MuiInputBase-input': { ...INPUT_SX['& .MuiInputBase-input'], textTransform: 'uppercase', fontFamily: 'monospace', letterSpacing: '0.1em' } }}
          />

          {/* Primary action */}
          <Button
            fullWidth variant="contained" size="small"
            onClick={handleJoinAndShare}
            disabled={mu.status === 'connecting' || !canJoin}
            startIcon={<Share sx={{ fontSize: 14 }} />}
            sx={{
              fontSize: 12, textTransform: 'none', mt: 0.25, py: 0.75,
              bgcolor: '#1565c0', '&:hover': { bgcolor: '#1976d2' },
              '&.Mui-disabled': { bgcolor: 'rgba(21,101,192,0.3)', color: 'rgba(255,255,255,0.3)' },
            }}
          >
            {mu.status === 'connecting' ? 'Connecting…' : copied ? 'Link Copied!' : 'Join & Share'}
          </Button>

          {mu.statusMessage && (
            <Typography sx={{
              fontSize: 10, mt: 0.25, textAlign: 'center',
              color: mu.status === 'error' ? '#ef5350' : 'rgba(255,255,255,0.45)',
            }}>
              {mu.statusMessage}
            </Typography>
          )}

          {/* Advanced: direct connection */}
          <Box
            onClick={() => setShowAdvanced(!showAdvanced)}
            sx={{
              display: 'flex', alignItems: 'center', cursor: 'pointer',
              mt: 0.25, py: 0.25,
              '&:hover': { '& .MuiTypography-root': { color: 'rgba(255,255,255,0.55)' } },
            }}
          >
            {showAdvanced
              ? <ExpandLess sx={{ fontSize: 14, color: 'rgba(255,255,255,0.3)' }} />
              : <ExpandMore sx={{ fontSize: 14, color: 'rgba(255,255,255,0.3)' }} />}
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', ml: 0.25 }}>
              Direct connection
            </Typography>
          </Box>

          <Collapse in={showAdvanced}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              <TextField
                fullWidth size="small"
                placeholder="ws://192.168.1.5:7000"
                value={directUrl}
                onChange={(e) => setDirectUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canJoin) handleJoin(); }}
                sx={INPUT_SX}
              />
              {directUrl.trim() && isDirectUrl(directUrl) && (
                <Button
                  fullWidth variant="outlined" size="small"
                  onClick={handleJoin}
                  disabled={mu.status === 'connecting'}
                  sx={{
                    fontSize: 11, textTransform: 'none',
                    borderColor: 'rgba(255,255,255,0.15)',
                    color: 'rgba(255,255,255,0.65)',
                    '&:hover': { borderColor: '#4fc3f7', color: '#4fc3f7', bgcolor: 'rgba(79,195,247,0.06)' },
                  }}
                >
                  {mu.status === 'connecting' ? 'Connecting…' : 'Connect Direct'}
                </Button>
              )}
            </Box>
          </Collapse>
        </Box>
      )}

      {/* ── Connected state ── */}
      {isConnected && (
        <Box>
          {/* Local player */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.3 }}>
            <PersonOutline sx={{ fontSize: 12, color: '#2196F3' }} />
            <Typography sx={{ fontSize: 11, color: '#2196F3', flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {mu.localName} (You)
            </Typography>
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>
              {mu.localRole}
            </Typography>
          </Box>

          {/* Remote players */}
          {players.map((p) => (
            <PlayerRow key={p.id} player={p} />
          ))}

          {players.length === 0 && (
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', py: 0.5, textAlign: 'center' }}>
              No other players connected
            </Typography>
          )}

          <Divider sx={{ borderColor: BORDER, my: 0.75 }} />

          <Button
            fullWidth variant="outlined" size="small"
            onClick={copyShareLink}
            startIcon={<Share sx={{ fontSize: 12 }} />}
            sx={{
              fontSize: 11, textTransform: 'none', mb: 0.5,
              borderColor: 'rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.65)',
              '&:hover': { borderColor: '#4fc3f7', color: '#4fc3f7', bgcolor: 'rgba(79,195,247,0.06)' },
            }}
          >
            {copied ? 'Link Copied!' : 'Share Session Link'}
          </Button>

          <Button
            fullWidth variant="outlined" size="small"
            onClick={handleDisconnect}
            sx={{
              fontSize: 11, textTransform: 'none',
              borderColor: 'rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.65)',
              '&:hover': { borderColor: '#ef5350', color: '#ef5350', bgcolor: 'rgba(239,83,80,0.06)' },
            }}
          >
            Disconnect
          </Button>
        </Box>
      )}
    </Box>
  );
}

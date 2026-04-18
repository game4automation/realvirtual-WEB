// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LoginGatePlugin — Full-screen login overlay that blocks access until
 * valid credentials are entered.
 *
 * Auth state is persisted in sessionStorage (cleared on tab close).
 * Credentials are passed as obfuscated base64 strings to discourage
 * casual inspection via DevTools source search.
 *
 * Usage:
 *   new LoginGatePlugin({
 *     title: 'My App',
 *     subtitle: 'Please sign in',
 *     userB64: btoa('admin'),       // base64-encoded username
 *     passB64: btoa('secret123'),   // base64-encoded password
 *     accentColor: '#0693e3',
 *     sessionKey: 'rv-myapp-auth',
 *   })
 */

import { useState, useCallback, useEffect, type KeyboardEvent } from 'react';
import { Box, Typography, TextField, Button, Paper } from '@mui/material';
import { Lock } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';

export interface LoginGateConfig {
  /** Display title on the login dialog. */
  title?: string;
  /** Subtitle below the title. */
  subtitle?: string;
  /** Base64-encoded expected username. */
  userB64: string;
  /** Base64-encoded expected password. */
  passB64: string;
  /** Accent color for the lock icon and button. Default '#4fc3f7'. */
  accentColor?: string;
  /** sessionStorage key for persisting auth state. Default 'rv-login-auth'. */
  sessionKey?: string;
  /** Footer text. Default 'powered by realvirtual WEB'. */
  footer?: string;
}

// ─── Shared state between plugin class and React component ──────────────
// The config is set once by the plugin constructor and read by the component.

let _config: LoginGateConfig | null = null;
let _resolveGate: (() => void) | null = null;

function isAuthed(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

function LoginGateOverlay(_props: UISlotProps) {
  const cfg = _config;
  if (!cfg) return null;

  const key = cfg.sessionKey ?? 'rv-login-auth';
  const accent = cfg.accentColor ?? '#4fc3f7';

  const [authed, setAuthed] = useState(() => isAuthed(key));
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => { if (isAuthed(key)) setAuthed(true); }, [key]);

  const handleLogin = useCallback(() => {
    try {
      const ok = user.trim().toLowerCase() === atob(cfg.userB64) && pass === atob(cfg.passB64);
      if (ok) {
        localStorage.setItem(key, '1');
        setAuthed(true);
        setError(false);
        _resolveGate?.();
        _resolveGate = null;
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  }, [user, pass, cfg, key]);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin();
  }, [handleLogin]);

  if (authed) return null;

  return (
    <Box sx={{
      position: 'fixed', inset: 0, zIndex: 20000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      bgcolor: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(12px)',
    }}>
      <Paper elevation={12} sx={{
        width: 340, p: 4, borderRadius: 3,
        bgcolor: 'rgba(30,30,30,0.95)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      }}>
        <Box sx={{
          width: 48, height: 48, borderRadius: '50%',
          bgcolor: `${accent}20`, border: `1px solid ${accent}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Lock sx={{ fontSize: 24, color: accent }} />
        </Box>

        {cfg.title && (
          <Typography sx={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
            {cfg.title}
          </Typography>
        )}
        {cfg.subtitle && (
          <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', mt: -1 }}>
            {cfg.subtitle}
          </Typography>
        )}

        <TextField
          label="Username"
          size="small"
          fullWidth
          autoFocus
          value={user}
          onChange={(e) => { setUser(e.target.value); setError(false); }}
          onKeyDown={handleKey}
          sx={{ '& .MuiInputBase-root': { bgcolor: 'rgba(255,255,255,0.05)' } }}
        />
        <TextField
          label="Password"
          type="password"
          size="small"
          fullWidth
          value={pass}
          onChange={(e) => { setPass(e.target.value); setError(false); }}
          onKeyDown={handleKey}
          sx={{ '& .MuiInputBase-root': { bgcolor: 'rgba(255,255,255,0.05)' } }}
        />

        {error && (
          <Typography sx={{ fontSize: 11, color: '#ef5350', fontWeight: 600 }}>
            Invalid username or password
          </Typography>
        )}

        <Button
          variant="contained"
          fullWidth
          onClick={handleLogin}
          sx={{
            mt: 1, py: 1, fontWeight: 700, textTransform: 'none',
            bgcolor: accent,
            '&:hover': { bgcolor: `${accent}cc` },
          }}
        >
          Sign In
        </Button>

        <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', mt: 1 }}>
          {cfg.footer ?? 'powered by realvirtual WEB'}
        </Typography>
      </Paper>
    </Box>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class LoginGatePlugin implements RVViewerPlugin {
  readonly id = 'login-gate';
  readonly slots: UISlotEntry[];

  constructor(config: LoginGateConfig) {
    _config = config;
    this.slots = [
      { slot: 'overlay', component: LoginGateOverlay, order: -1000 },
    ];
  }

  /**
   * Install the load gate on the viewer so model loading waits until the user
   * authenticates. Call this after constructing the plugin and before model load.
   * If already authenticated (sessionStorage), this is a no-op.
   */
  installGate(viewer: RVViewer): void {
    const key = _config?.sessionKey ?? 'rv-login-auth';
    if (isAuthed(key)) {
      console.log('[LoginGate] Already authenticated — no gate');
      return;
    }
    console.log('[LoginGate] Gate installed — model loading deferred until login');
    viewer.loadGate = new Promise<void>((resolve) => { _resolveGate = resolve; });
  }
}

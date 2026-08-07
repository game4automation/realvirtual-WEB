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

import {
  useState, useCallback, useEffect, useMemo, useSyncExternalStore, type KeyboardEvent,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Box, Typography, TextField, Button, Paper, Menu, MenuItem } from '@mui/material';
import { Lock, SwapHoriz } from '@mui/icons-material';
import { RVViewerProvider } from '../hooks/use-viewer';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { subscribeModelCatalog, getModelCatalogVersion } from '../core/rv-model-catalog';

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
  /**
   * Show a "Load a different model" link below Sign In. Default: true.
   * The link opens a menu of available models from `viewer.availableModels`;
   * picking one navigates to `?model=<url>` (overrides both saved-last-model
   * and settings.json `defaultModel`). Set `false` to hide on locked-down
   * deployments where switching scenes is not desired.
   */
  showModelPicker?: boolean;
}

// ─── Shared state between plugin class and React component ──────────────
// The config is set once by the plugin constructor and read by the component.

let _config: LoginGateConfig | null = null;
let _resolveGate: (() => void) | null = null;

// Standalone overlay mounted by installGate() so the login dialog is visible DURING the loading
// screen — the main HMI (which also hosts the overlay slot) only mounts after the model loads, so
// without this the gate would deadlock (model waits for login, login UI waits for model).
let _standaloneRoot: Root | null = null;
let _standaloneEl: HTMLElement | null = null;

function teardownStandalone(): void {
  if (!_standaloneRoot) return;
  const root = _standaloneRoot;
  const el = _standaloneEl;
  _standaloneRoot = null;
  _standaloneEl = null;
  // Defer unmount so it doesn't run during the component's own render/commit.
  setTimeout(() => {
    try { root.unmount(); } catch { /* ignore */ }
    if (el?.parentNode) el.parentNode.removeChild(el);
  }, 0);
}

function isAuthed(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

function LoginGateOverlay({ viewer }: UISlotProps) {
  const cfg = _config;
  if (!cfg) return null;

  const key = cfg.sessionKey ?? 'rv-login-auth';
  const accent = cfg.accentColor ?? '#4fc3f7';

  // The gate is mounted in its own React root (mountStandalone) OUTSIDE the
  // app's dark MUI ThemeProvider, so MUI falls back to its LIGHT theme — input
  // text + label render near-black on the dark glass and become unreadable.
  // Pin the field colors explicitly so it looks right in both mount paths.
  const fieldSx = {
    '& .MuiInputBase-root': { bgcolor: 'rgba(255,255,255,0.05)' },
    '& .MuiInputBase-input': { color: 'rgba(255,255,255,0.92)' },
    '& .MuiInputBase-input::placeholder': { color: 'rgba(255,255,255,0.45)', opacity: 1 },
    '& .MuiInputLabel-root': { color: 'rgba(255,255,255,0.5)' },
    '& .MuiInputLabel-root.Mui-focused': { color: accent },
    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.15)' },
    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.3)' },
    '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: accent },
  } as const;

  const [authed, setAuthed] = useState(() => isAuthed(key));
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => { if (isAuthed(key)) setAuthed(true); }, [key]);

  // Filter the viewer's known models. We exclude the current one (no point
  // "switching" to the same scene) — the project default that triggered this
  // gate is the most likely current model. `availableModels` is populated
  // during main.ts model discovery before plugins register, so it should
  // already be ready by the time this overlay renders.
  //
  // The catalogue version is a real dependency, not decoration: since plan-365 a
  // model can be published while this gate is on screen, and memoising on the
  // viewer alone would never see it — the reference is stable and the list is
  // replaced behind it.
  const catalogVersion = useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const otherModels = useMemo(() => {
    const all = viewer?.availableModels ?? [];
    const current = viewer?.currentModelUrl ?? viewer?.pendingModelUrl ?? null;
    return current ? all.filter((m) => m.url !== current) : [...all];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, catalogVersion]);

  const handleLogin = useCallback(() => {
    try {
      const ok = user.trim().toLowerCase() === atob(cfg.userB64) && pass === atob(cfg.passB64);
      if (ok) {
        localStorage.setItem(key, '1');
        setAuthed(true);
        setError(false);
        _resolveGate?.();
        _resolveGate = null;
        teardownStandalone(); // remove the loading-screen overlay; the model load now proceeds
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

  const handlePickModel = useCallback((url: string) => {
    setPickerAnchor(null);
    // Navigate with ?model=<url>. URL param wins over both the saved-last-model
    // and settings.json defaultModel, so the gate's project doesn't reload.
    const target = new URL(window.location.href);
    target.search = '';
    target.searchParams.set('model', url);
    window.location.href = target.toString();
  }, []);

  if (authed) return null;

  return (
    <Box sx={{
      position: 'fixed', inset: 0, zIndex: 20000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      bgcolor: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
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
          sx={fieldSx}
        />
        <TextField
          label="Password"
          type="password"
          size="small"
          fullWidth
          value={pass}
          onChange={(e) => { setPass(e.target.value); setError(false); }}
          onKeyDown={handleKey}
          sx={fieldSx}
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

        {(cfg.showModelPicker ?? true) && otherModels.length > 0 && (
          <>
            <Button
              size="small"
              startIcon={<SwapHoriz sx={{ fontSize: 16 }} />}
              onClick={(e) => setPickerAnchor(e.currentTarget)}
              sx={{
                mt: -0.5, textTransform: 'none', fontSize: 11,
                color: 'rgba(255,255,255,0.55)',
                '&:hover': { color: accent, bgcolor: 'transparent' },
              }}
            >
              Load a different model
            </Button>
            <Menu
              anchorEl={pickerAnchor}
              open={!!pickerAnchor}
              onClose={() => setPickerAnchor(null)}
              MenuListProps={{ dense: true }}
              PaperProps={{
                sx: {
                  bgcolor: 'rgba(30,30,30,0.97)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  maxHeight: 320,
                },
              }}
            >
              {otherModels.map((m) => (
                <MenuItem
                  key={m.url}
                  onClick={() => handlePickModel(m.url)}
                  sx={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}
                >
                  {m.label}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}

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
    this.mountStandalone(viewer);
  }

  // Mounts the login overlay in its own DOM root (above the loading overlay, with pointer events
  // enabled) so the user can authenticate while the model is still gated. The main HMI's overlay
  // slot also renders this component, but only after the model loads — too late for the gate.
  private mountStandalone(viewer: RVViewer): void {
    if (typeof document === 'undefined' || _standaloneRoot) return;
    const el = document.createElement('div');
    el.id = 'rv-login-gate-root';
    // #loading-overlay is z-index 1000; sit above it and re-enable pointer events.
    el.style.cssText = 'position:fixed;inset:0;z-index:21000;pointer-events:auto;';
    document.body.appendChild(el);
    _standaloneEl = el;
    _standaloneRoot = createRoot(el);
    _standaloneRoot.render(
      <RVViewerProvider value={viewer}>
        <LoginGateOverlay viewer={viewer} />
      </RVViewerProvider>,
    );
  }
}

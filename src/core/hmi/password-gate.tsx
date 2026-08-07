// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * password-gate.tsx — plan-267 runtime half. Full-screen password prompt that
 * decrypts a zero-knowledge AES-256-GCM model (RVE1 envelope) BEFORE it reaches
 * GLTFLoader.parse. The model is never parsed until the password is correct.
 *
 * Lives in the PUBLIC tree (like login-gate / consent-gate) so it ships in EVERY
 * deploy — a customer's encrypted deploy would be unopenable if the gate were
 * gated out of the customer build.
 *
 * Two secrets combine into the key (rv-crypto-utils.ts): the 32-byte fragment
 * secret from the URL (#k=, read + cleared at boot) and the password typed here.
 */

import { useState, useCallback, type KeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Box, Typography, TextField, Button, Paper, IconButton, InputAdornment } from '@mui/material';
import { Lock, Visibility, VisibilityOff } from '@mui/icons-material';
import {
  parseFragmentSecret,
  isEncryptedEnvelope,
  parseEnvelopeHeader,
  deriveMasterKey,
  verifyKey,
  decryptEnvelope,
} from '../persistence/rv-crypto-utils';

// ─── Fragment secret (URL factor) ──────────────────────────────────────────

let _fragment: Uint8Array | null = null;
let _fragmentInit = false;

/** Strip the `k=` token from a hash body, preserving any other params. */
function hashWithoutK(hash: string): string {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  return body.split('&').filter((p) => p.split('=')[0] !== 'k').join('&');
}

/**
 * Read the `#k=` fragment secret and immediately scrub it from the address bar
 * (plan-267 F6). Call ONCE at the very top of boot, before any network request.
 * Idempotent. Note: the secret can still linger in the Performance navigation
 * timeline — only a strict no-third-party-script CSP fully contains it (§5.3).
 */
export function initFragmentSecret(): void {
  if (_fragmentInit || typeof window === 'undefined') return;
  _fragmentInit = true;
  try {
    _fragment = parseFragmentSecret(window.location.hash);
    if (_fragment && typeof history !== 'undefined') {
      const rest = hashWithoutK(window.location.hash);
      const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
      history.replaceState(null, '', url);
    }
  } catch {
    _fragment = null;
  }
}

/** The parsed fragment secret, or null when the link is incomplete/invalid. */
export function getFragmentSecret(): Uint8Array | null {
  return _fragment;
}

// ─── Overlay ───────────────────────────────────────────────────────────────

let _root: Root | null = null;
let _el: HTMLElement | null = null;

function unmountGate(): void {
  if (!_root) return;
  const root = _root;
  const el = _el;
  _root = null;
  _el = null;
  setTimeout(() => {
    try { root.unmount(); } catch { /* ignore */ }
    if (el?.parentNode) el.parentNode.removeChild(el);
  }, 0);
}

function mountGate(node: React.ReactNode): void {
  if (typeof document === 'undefined' || _root) return;
  const el = document.createElement('div');
  el.id = 'rv-password-gate-root';
  // #loading-overlay is z-index 1000 — sit above it with pointer events on.
  el.style.cssText = 'position:fixed;inset:0;z-index:21000;pointer-events:auto;';
  document.body.appendChild(el);
  _el = el;
  _root = createRoot(el);
  _root.render(node);
}

const fieldSx = {
  '& .MuiInputBase-root': { bgcolor: 'rgba(255,255,255,0.05)' },
  '& .MuiInputBase-input': { color: 'rgba(255,255,255,0.92)' },
  '& .MuiInputLabel-root': { color: 'rgba(255,255,255,0.5)' },
  '& .MuiInputLabel-root.Mui-focused': { color: '#4fc3f7' },
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.15)' },
  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.3)' },
  '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#4fc3f7' },
} as const;

function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      bgcolor: 'rgba(10,14,20,0.82)', backdropFilter: 'blur(calc(6px * var(--rv-ui-blur-scale, 1)))',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    }}>
      <Paper elevation={8} sx={{
        width: 380, maxWidth: '90vw', p: 4, borderRadius: 2,
        bgcolor: 'rgba(20,26,34,0.96)', border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      }}>
        <Lock sx={{ fontSize: 40, color: '#4fc3f7' }} />
        {children}
      </Paper>
    </Box>
  );
}

/** Terminal state: link is missing the `#k=` secret — cannot decrypt at all. */
function IncompleteOverlay() {
  return (
    <GateShell>
      <Typography sx={{ color: 'rgba(255,255,255,0.92)', fontWeight: 600, fontSize: 18 }}>
        Incomplete link
      </Typography>
      <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center' }}>
        This protected model needs the full link you were given. The part after
        the “#” is missing, so it cannot be opened.
      </Typography>
    </GateShell>
  );
}

interface PasswordOverlayProps {
  onSubmit: (password: string) => Promise<{ ok: boolean; msg?: string }>;
}

function PasswordOverlay({ onSubmit }: PasswordOverlayProps) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  const submit = useCallback(async () => {
    if (busy || !pass) return;
    setBusy(true);
    setError(null);
    const r = await onSubmit(pass);
    if (!r.ok) {
      setError(r.msg ?? 'Wrong password.');
      setBusy(false);
    }
    // On success the orchestrator unmounts this overlay.
  }, [busy, pass, onSubmit]);

  const onKey = useCallback((e: KeyboardEvent) => { if (e.key === 'Enter') void submit(); }, [submit]);

  return (
    <GateShell>
      <Typography sx={{ color: 'rgba(255,255,255,0.92)', fontWeight: 600, fontSize: 18 }}>
        Password protected
      </Typography>
      <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center' }}>
        This model is encrypted. Enter the password to open it.
      </Typography>
      <TextField
        type={show ? 'text' : 'password'} label="Password" value={pass} autoFocus fullWidth size="small" sx={fieldSx}
        onChange={(e) => setPass(e.target.value)} onKeyDown={onKey} disabled={busy}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={show ? 'Hide password' : 'Show password'}
                  onClick={() => setShow((s) => !s)}
                  edge="end" size="small" tabIndex={-1}
                  sx={{ color: 'rgba(255,255,255,0.5)', '&:hover': { color: 'rgba(255,255,255,0.8)' } }}
                >
                  {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      {error && (
        <Typography sx={{ color: '#ff6b6b', fontSize: 13, alignSelf: 'flex-start' }}>{error}</Typography>
      )}
      <Button
        variant="contained" fullWidth onClick={() => void submit()} disabled={busy || !pass}
        sx={{ mt: 1, bgcolor: '#4fc3f7', '&:hover': { bgcolor: '#29b6f6' }, color: '#08121b', fontWeight: 700 }}
      >
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </GateShell>
  );
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/**
 * Show the password gate and return the decrypted model bytes. Blocks the model
 * load until the correct password is entered. When the link is missing `#k=`,
 * shows a terminal "incomplete link" overlay and rejects. Wrong password keeps
 * the gate open with an error; a valid password but corrupt/tampered payload
 * surfaces a distinct "damaged data" message (plan-267 §10.4).
 */
export async function decryptModelData(data: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  if (!isEncryptedEnvelope(bytes)) return data; // defensive — caller pre-checks

  const fragment = getFragmentSecret();
  if (!fragment) {
    mountGate(<IncompleteOverlay />);
    throw new Error('Encrypted model: link is missing the #k= secret');
  }

  const header = await parseEnvelopeHeader(bytes);

  return new Promise<ArrayBuffer>((resolve) => {
    const onSubmit = async (password: string): Promise<{ ok: boolean; msg?: string }> => {
      let key: CryptoKey;
      try {
        key = await deriveMasterKey(password, fragment, header.salt, header.iterations);
      } catch {
        return { ok: false, msg: 'Unlock failed.' };
      }
      if (!(await verifyKey(bytes, key))) {
        return { ok: false, msg: 'Wrong password.' };
      }
      // Correct password — the full payload may still be corrupt in a later chunk.
      try {
        const plain = await decryptEnvelope(bytes, key);
        unmountGate();
        resolve(plain);
        return { ok: true };
      } catch {
        return { ok: false, msg: 'Model data is damaged or was tampered with.' };
      }
    };
    mountGate(<PasswordOverlay onSubmit={onSubmit} />);
  });
}

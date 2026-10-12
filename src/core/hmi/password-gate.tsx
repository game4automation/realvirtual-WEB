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
  PROBE_PLAINTEXT,
  MAX_SHARE_KDF_ITERATIONS,
} from '../persistence/rv-crypto-utils';
import { getSessionKey, setSessionKey } from '../persistence/rv-served-bytes';
import type { RVAppConfig } from '../rv-app-config';
import { ShareDecryptError } from '../share/rv-share-decrypt';
import { INK_MID } from './shared-sx';

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
  /** Overlay headline; defaults to the plan-267 model wording. */
  title?: string;
  /** Overlay explanation; defaults to the plan-267 model wording. */
  subtitle?: string;
  /** When set, a Cancel button (and Escape) abandons the gate — usable while unlocking (plan-560). */
  onCancel?: () => void;
  /** Submit button label; defaults to "Unlock". */
  submitLabel?: string;
  /** Submit button label while the key is derived; defaults to "Unlocking…". */
  busyLabel?: string;
}

function PasswordOverlay({ onSubmit, title, subtitle, onCancel, submitLabel, busyLabel }: PasswordOverlayProps) {
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

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') void submit();
    else if (e.key === 'Escape' && onCancel) onCancel();
  }, [submit, onCancel]);

  return (
    <GateShell>
      <Typography sx={{ color: 'rgba(255,255,255,0.92)', fontWeight: 600, fontSize: 18 }}>
        {title ?? 'Password protected'}
      </Typography>
      <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center' }}>
        {subtitle ?? 'This model is encrypted. Enter the password to open it.'}
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
      <Box sx={{ display: 'flex', gap: 1, width: '100%', mt: 1 }}>
        {onCancel && (
          <Button
            variant="text" fullWidth onClick={onCancel}
            sx={{ color: INK_MID, fontWeight: 600 }}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="contained" fullWidth onClick={() => void submit()} disabled={busy || !pass}
          sx={{ bgcolor: '#4fc3f7', '&:hover': { bgcolor: '#29b6f6' }, color: '#08121b', fontWeight: 700 }}
        >
          {busy ? (busyLabel ?? 'Unlocking…') : (submitLabel ?? 'Unlock')}
        </Button>
      </Box>
    </GateShell>
  );
}

// ─── Orchestration ─────────────────────────────────────────────────────────

export { ShareDecryptError } from '../share/rv-share-decrypt';

/** Options of {@link decryptModelData}. */
export interface DecryptModelDataOptions {
  /**
   * Opt-in for the `?glb=` share path (plan-560): a missing `#k=` rejects with
   * `ShareDecryptError('link-incomplete')` instead of mounting the terminal
   * "incomplete link" overlay, and the overlay offers Cancel (also while the key
   * is being derived), which rejects with `ShareDecryptError('cancelled')`.
   */
  cancellable?: boolean;
}

/**
 * Show the password gate and return the decrypted model bytes. Blocks the model
 * load until the correct password is entered.
 *
 * Contract (plan-267, hardened by plan-560):
 * - a wrong password — or a damaged FIRST chunk, which cannot be told apart —
 *   keeps the gate open with "Wrong password or damaged file.";
 * - a structurally broken header, a header demanding more than
 *   {@link MAX_SHARE_KDF_ITERATIONS} iterations (checked before any derivation)
 *   and a later chunk failing authentication reject with
 *   `ShareDecryptError('damaged')`;
 * - a gate that is already open rejects a second call at once with
 *   `ShareDecryptError('cancelled', 'gate busy')` instead of hanging;
 * - without `#k=` the link is incomplete: with `cancellable` that is a typed
 *   rejection without overlay, without it the terminal overlay as before;
 * - the overlay is unmounted on every outcome.
 */
export async function decryptModelData(
  data: ArrayBuffer,
  opts: DecryptModelDataOptions = {},
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  if (!isEncryptedEnvelope(bytes)) return data; // defensive — caller pre-checks
  const cancellable = opts.cancellable === true;

  if (_root) throw new ShareDecryptError('cancelled', 'gate busy');

  const fragment = getFragmentSecret();
  if (!fragment) {
    if (!cancellable) mountGate(<IncompleteOverlay />);
    throw new ShareDecryptError('link-incomplete', 'Encrypted model: link is missing the #k= secret');
  }

  let header: Awaited<ReturnType<typeof parseEnvelopeHeader>>;
  try {
    header = await parseEnvelopeHeader(bytes);
  } catch (e) {
    throw new ShareDecryptError('damaged', `Encrypted model: ${(e as Error)?.message ?? 'malformed envelope'}`);
  }
  if (header.iterations > MAX_SHARE_KDF_ITERATIONS) {
    throw new ShareDecryptError('damaged', 'key derivation limit exceeded');
  }
  // A second call may have opened a gate while the header was being hashed.
  if (_root) throw new ShareDecryptError('cancelled', 'gate busy');

  return new Promise<ArrayBuffer>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      unmountGate();
      outcome();
    };

    const onSubmit = async (password: string): Promise<{ ok: boolean; msg?: string }> => {
      let key: CryptoKey;
      try {
        key = await deriveMasterKey(password, fragment, header.salt, header.iterations);
      } catch {
        if (settled) return { ok: true };
        return { ok: false, msg: 'Unlock failed.' };
      }
      // Cancelled while deriving: the late key is dropped and nothing loads.
      if (settled) return { ok: true };
      if (!(await verifyKey(bytes, key))) {
        if (settled) return { ok: true };
        return { ok: false, msg: 'Wrong password or damaged file.' };
      }
      if (settled) return { ok: true };
      // Correct password — the full payload may still be corrupt in a later chunk.
      let plain: ArrayBuffer;
      try {
        plain = await decryptEnvelope(bytes, key);
      } catch {
        finish(() => reject(new ShareDecryptError('damaged', 'Model data is damaged or was tampered with.')));
        return { ok: true };
      }
      finish(() => resolve(plain));
      return { ok: true };
    };

    const onCancel = cancellable
      ? () => finish(() => reject(new ShareDecryptError('cancelled', 'Opening was cancelled.')))
      : undefined;

    mountGate(
      <PasswordOverlay
        onSubmit={onSubmit}
        onCancel={onCancel}
        {...(cancellable ? {
          title: 'Encrypted model',
          subtitle: 'Enter the password you received separately.',
          submitLabel: 'Open',
          busyLabel: 'Decrypting…',
        } : {})}
      />,
    );
  });
}

// ─── Boot gate of a hosted deploy (plan-759 F5) ────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The password gate of a hosted deploy, BEFORE the dashboard: resolves at once
 * when the deploy is not encrypted or the key for its publish is already held;
 * otherwise mounts the overlay and resolves only after the typed password,
 * combined with the `#k=` fragment, opens the `encryption.probe` of
 * settings.json. The verified key is then held per salt for every document
 * fetch of this tab ({@link setSessionKey}); a reload asks again (a CryptoKey
 * does not survive it — accepted, D7).
 *
 * A link without `#k=` shows the terminal "incomplete link" overlay and never
 * resolves: without the fragment there is nothing this page could show.
 */
export async function requireHostedPassword(cfg: RVAppConfig): Promise<void> {
  const probeB64 = cfg.encryption?.enabled ? cfg.encryption.probe : undefined;
  if (!probeB64) return;
  let probe: Uint8Array;
  let header: Awaited<ReturnType<typeof parseEnvelopeHeader>>;
  try {
    probe = base64ToBytes(probeB64);
    header = await parseEnvelopeHeader(probe);
  } catch (e) {
    throw new Error(`This deploy's settings.json carries an unreadable encryption probe: ${(e as Error)?.message ?? e}`);
  }
  if (getSessionKey(header.salt)) return;

  const fragment = getFragmentSecret();
  if (!fragment) {
    mountGate(<IncompleteOverlay />);
    return new Promise<void>(() => { /* terminal: the card is the answer */ });
  }

  const projectName = typeof document !== 'undefined' ? (document.title || '').trim() : '';
  return new Promise<void>((resolve) => {
    const onSubmit = async (password: string): Promise<{ ok: boolean; msg?: string }> => {
      let key: CryptoKey;
      try {
        key = await deriveMasterKey(password, fragment, header.salt, header.iterations);
      } catch {
        return { ok: false, msg: 'Unlock failed.' };
      }
      if (!(await verifyKey(probe, key))) {
        return { ok: false, msg: 'Wrong password.' };
      }
      try {
        const plain = new TextDecoder().decode(await decryptEnvelope(probe, key));
        if (plain !== PROBE_PLAINTEXT) return { ok: false, msg: 'This deploy is damaged: its key probe does not verify.' };
      } catch {
        return { ok: false, msg: 'This deploy is damaged: its key probe does not verify.' };
      }
      setSessionKey(header.salt, key);
      unmountGate();
      resolve();
      return { ok: true };
    };
    mountGate(
      <PasswordOverlay
        onSubmit={onSubmit}
        title={projectName ? `${projectName}` : 'Password protected'}
        subtitle="This project is password protected. Enter the password to open it."
      />,
    );
  });
}

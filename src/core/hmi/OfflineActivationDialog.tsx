// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, Link, Radio, RadioGroup, TextField, Typography,
} from '@mui/material';
import {
  importLicenseToken, LICENSE_TERMS_URL, requestOfflineActivationCode,
  type OfflineActivationKind,
} from './license-store';

interface OfflineActivationDialogProps {
  open: boolean;
  onClose: () => void;
  serverUrl: string;
  initialLicenseKey?: string;
}

function trimToken(value: string): string {
  return value.replace(/^\uFEFF/, '').trim();
}

async function readFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the licence file.'));
    reader.readAsText(file);
  });
}

export function OfflineActivationDialog({
  open, onClose, serverUrl, initialLicenseKey = '',
}: OfflineActivationDialogProps) {
  const [kind, setKind] = useState<OfflineActivationKind>('commercial');
  const [licenseKey, setLicenseKey] = useState(initialLicenseKey);
  const [email, setEmail] = useState('');
  const [requestCode, setRequestCode] = useState('');
  const [portalUrl, setPortalUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ severity: 'success' | 'error'; message: string } | null>(null);
  const requestCodeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setLicenseKey(initialLicenseKey);
      return;
    }
    setKind('commercial');
    setLicenseKey('');
    setEmail('');
    setRequestCode('');
    setPortalUrl('');
    setToken('');
    setBusy(false);
    setCopied(false);
    setResult(null);
  }, [open, initialLicenseKey]);

  const createRequest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const response = await requestOfflineActivationCode(serverUrl, { kind, licenseKey, email });
      setRequestCode(response.code);
      setPortalUrl(response.portalUrl);
    } catch (error) {
      setResult({ severity: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const importToken = async (value = token) => {
    setBusy(true);
    setResult(null);
    try {
      await importLicenseToken(serverUrl, value, kind === 'commercial' ? licenseKey : undefined);
      setResult({ severity: 'success', message: 'Licence imported. CONNECT is now licensed.' });
    } catch (error) {
      setResult({ severity: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(requestCode);
      else {
        requestCodeRef.current?.select();
        document.execCommand('copy');
      }
      setCopied(true);
    } catch {
      requestCodeRef.current?.select();
      document.execCommand('copy');
      setCopied(true);
    }
  };

  const saveCode = () => {
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(new Blob([requestCode], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'connect-activation-request.txt';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const value = trimToken(await readFile(file));
      setToken(value);
      await importToken(value);
    } catch (error) {
      setResult({ severity: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth slotProps={{ paper: {
      elevation: 0,
      sx: {
        bgcolor: 'rgba(30,30,30,0.78)',
        backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
        backgroundImage: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px',
      },
    } }}>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>Activate offline</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>1. Create a request code</Typography>
          <RadioGroup value={kind} onChange={(event) => { setKind(event.target.value as OfflineActivationKind); setRequestCode(''); setCopied(false); }}>
            <FormControlLabel value="commercial" control={<Radio size="small" />} label="Commercial licence" slotProps={{ typography: { sx: { fontSize: 11 } } }} />
            <FormControlLabel value="community" control={<Radio size="small" />} label="Free community licence (20 signals)" slotProps={{ typography: { sx: { fontSize: 11 } } }} />
          </RadioGroup>
          {kind === 'commercial' ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <TextField fullWidth size="small" label="License key" value={licenseKey} disabled={busy}
                onChange={(event) => { setLicenseKey(event.target.value); setRequestCode(''); setCopied(false); }} inputProps={{ spellCheck: false }}
                sx={{ '& .MuiInputBase-input': { fontSize: 12, fontFamily: 'monospace' } }} />
              <TextField fullWidth size="small" label="Email (optional)" value={email} disabled={busy}
                onChange={(event) => { setEmail(event.target.value); setRequestCode(''); setCopied(false); }} sx={{ '& .MuiInputBase-input': { fontSize: 12 } }} />
            </Box>
          ) : (
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              The licence is issued to the email of the portal account.
            </Typography>
          )}
          <Button size="small" variant="contained" onClick={() => void createRequest()} disabled={busy || (kind === 'commercial' && !licenseKey.trim())}
            sx={{ mt: 1, fontSize: 11, textTransform: 'none' }}>{busy ? 'Working...' : 'Create request code'}</Button>
        </Box>

        {requestCode && <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <TextField multiline minRows={3} fullWidth label="Request code" value={requestCode} inputRef={requestCodeRef}
            data-testid="offline-request-code" slotProps={{ input: { readOnly: true } }}
            sx={{ '& .MuiInputBase-input': { fontSize: 11, fontFamily: 'monospace' } }} />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button size="small" onClick={() => void copyCode()} disabled={busy} sx={{ fontSize: 11, textTransform: 'none' }}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button size="small" onClick={saveCode} disabled={busy} sx={{ fontSize: 11, textTransform: 'none' }}>Save as file</Button>
          </Box>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            On a computer with internet access, open{' '}
            <Link href={portalUrl} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 11 }}>{portalUrl.replace(/^https?:\/\//, '')}</Link>, sign in,
            paste the code (or upload the file) and download the licence.
          </Typography>
        </Box>}

        <Box>
          <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1 }}>2. Import the licence</Typography>
          <TextField multiline minRows={3} fullWidth label="Activation token" value={token} disabled={busy}
            onChange={(event) => setToken(event.target.value)} inputProps={{ spellCheck: false }}
            sx={{ '& .MuiInputBase-input': { fontSize: 11, fontFamily: 'monospace' } }} />
          <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
            <Button size="small" component="label" disabled={busy} sx={{ fontSize: 11, textTransform: 'none' }}>
              Choose .rvlic file
              <input hidden type="file" accept=".rvlic,.txt,text/plain" data-testid="offline-token-file" onChange={(event) => void chooseFile(event)} />
            </Button>
            <Button size="small" variant="contained" onClick={() => void importToken()} disabled={busy || !token.trim()}
              sx={{ fontSize: 11, textTransform: 'none' }}>{busy ? 'Importing...' : 'Import licence'}</Button>
          </Box>
        </Box>

        <Box aria-live="polite">{result && <Alert severity={result.severity} sx={{ '& .MuiAlert-message': { fontSize: 11 } }}>{result.message}</Alert>}</Box>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Typography sx={{ fontSize: 10, color: 'text.secondary', ml: 1 }}>
          By activating you agree to the{' '}<Link href={LICENSE_TERMS_URL} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 10 }}>realvirtual license terms</Link>
        </Typography>
        <Button onClick={onClose} disabled={busy} sx={{ fontSize: 11, textTransform: 'none' }}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

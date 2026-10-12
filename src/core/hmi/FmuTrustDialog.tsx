// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FmuTrustDialog — the consent gate before an FMU runs in CONNECT
 * (plan-498 Phase 3, decision log "Trust-Granularität").
 *
 * Modal and blocking: no backdrop click, no Escape — the only ways out are
 * "Trust & start" and "Cancel". Several FMUs that need consent at the
 * same time are ONE list with a checkbox each; only the checked packages are
 * trusted. There is deliberately no "always trust": the decision is per
 * package SHA and CONNECT installation, and it is CONNECT that records it
 * (`POST /fmu/{sha}/trust`, which demands the browser's Origin).
 *
 * Mounted once in the `overlay` slot by the provisioning plugin; the open
 * questions live in `fmu-trust-store`.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { ContentCopy, WarningAmber } from '@mui/icons-material';
import {
  decideFmuTrust,
  getFmuTrustRequests,
  subscribeFmuTrust,
  type FmuTrustRequest,
} from './fmu-trust-store';
import { formatDecimal } from './rv-number-format';
import { FIELD_BG, FS, ICON_SIZE, INK_LOW, INK_MID, MONO, WARN } from './shared-sx';

/** The sentence the dialog must say, word for word (plan-498 §2.4 / decision log; English since plan-510). */
export const FMU_TRUST_WARNING = 'An FMU is native code and runs inside the CONNECT process. Only approve trusted sources.';
export const FMU_TRUST_CONFIRM_LABEL = 'Trust & start';
export const FMU_TRUST_CANCEL_LABEL = 'Cancel';
export const FMU_TRUST_COPY_SHA_LABEL = 'Copy SHA-256';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${formatDecimal(n / (1024 * 1024), 1)} MB`;
  if (n >= 1024) return `${formatDecimal(n / 1024, 1)} kB`;
  return `${n} B`;
}

/** `<first 8>…<last 4>` of a SHA-256. */
export function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 8)}…${sha.slice(-4)}` : sha;
}

/** The document part of an instance key (`<documentId>#…`). */
function documentOf(instanceKey: string): string {
  const i = instanceKey.indexOf('#');
  return i > 0 ? instanceKey.slice(0, i) : instanceKey;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
      <Typography sx={{ fontSize: FS.label, color: INK_LOW, minWidth: 64, flexShrink: 0 }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: FS.body, color: INK_MID, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Typography>
    </Box>
  );
}

function RequestRow({ req, checked, onToggle }: { req: FmuTrustRequest; checked: boolean; onToggle: () => void }) {
  const copy = (): void => {
    try { void navigator.clipboard?.writeText(req.sha256); } catch { /* clipboard unavailable */ }
  };
  return (
    <Box
      data-testid="fmu-trust-row"
      data-sha={req.sha256}
      sx={{ display: 'flex', gap: 1, p: 1, borderRadius: 1, bgcolor: FIELD_BG }}
    >
      <Checkbox
        size="small"
        checked={checked}
        onChange={onToggle}
        inputProps={{ 'aria-label': `Trust ${req.modelName || req.fileName}` }}
        sx={{ p: 0.25, alignSelf: 'flex-start' }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: FS.body, fontWeight: 600 }}>{req.modelName || req.fileName}</Typography>
        <Field label="GUID"><span style={{ fontFamily: MONO }}>{req.guid || '—'}</span></Field>
        <Field label="Tool">{req.generationTool || '—'}</Field>
        <Field label="File">{`${req.fileName || '—'} · ${formatBytes(req.byteLength)}`}</Field>
        <Field label="SHA-256">
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip title={req.sha256}>
              <span data-testid="fmu-trust-sha" style={{ fontFamily: MONO }}>{shortSha(req.sha256)}</span>
            </Tooltip>
            <Tooltip title={FMU_TRUST_COPY_SHA_LABEL}>
              <IconButton size="small" aria-label={FMU_TRUST_COPY_SHA_LABEL} onClick={copy} sx={{ p: 0.25 }}>
                <ContentCopy sx={{ fontSize: ICON_SIZE.xs }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Field>
        <Field label="Source">
          {req.sources.map((s) => (
            <div key={s.instanceKey} data-testid="fmu-trust-source">
              {`${documentOf(s.instanceKey)} · ${s.nodePath}`}
            </div>
          ))}
        </Field>
      </Box>
    </Box>
  );
}

/** The consent dialog — renders nothing while no FMU waits for a decision. */
export function FmuTrustDialog() {
  const requests = useSyncExternalStore(subscribeFmuTrust, getFmuTrustRequests, getFmuTrustRequests);
  // Unchecked = explicitly excluded; new rows start checked (the button is the decision).
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (requests.length === 0 && excluded.size > 0) setExcluded(new Set());
  }, [requests, excluded]);

  if (requests.length === 0) return null;

  const approved = new Set(requests.map((r) => r.sha256).filter((sha) => !excluded.has(sha)));
  const toggle = (sha: string): void => {
    const next = new Set(excluded);
    if (next.has(sha)) next.delete(sha); else next.add(sha);
    setExcluded(next);
  };
  const plural = requests.length > 1;

  return (
    <Dialog
      open
      data-testid="fmu-trust-dialog"
      // Blocking: a click beside it or Escape must not count as an answer.
      onClose={() => { /* only the two buttons decide */ }}
      disableEscapeKeyDown
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle sx={{ fontSize: FS.title, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarningAmber sx={{ fontSize: ICON_SIZE.lg, color: WARN }} />
        {plural ? `Run ${requests.length} FMUs in CONNECT?` : 'Run FMU in CONNECT?'}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <DialogContentText data-testid="fmu-trust-warning" sx={{ fontSize: FS.body }}>
          {FMU_TRUST_WARNING}
        </DialogContentText>
        {requests.map((r) => (
          <RequestRow key={r.sha256} req={r} checked={!excluded.has(r.sha256)} onToggle={() => toggle(r.sha256)} />
        ))}
      </DialogContent>
      <DialogActions>
        <Button size="small" sx={{ textTransform: 'none' }} onClick={() => decideFmuTrust(new Set())}>
          {FMU_TRUST_CANCEL_LABEL}
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={approved.size === 0}
          sx={{ textTransform: 'none' }}
          onClick={() => decideFmuTrust(approved)}
        >
          {FMU_TRUST_CONFIRM_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

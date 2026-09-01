// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UnifiedImportDialog.tsx — the one Import dialog for all providers
 * (plan-238 §3.1). Tabs are rendered DYNAMICALLY from the provider registry;
 * unavailable providers show a setup hint instead of the import form.
 *
 * The dialog CONFIGURES an import; the job itself runs in the import-job
 * store. While the job runs the dialog STAYS OPEN as a blocking modal —
 * importing mutates the asset being edited, so the user must not keep
 * editing mid-import. Esc behaves like the Cancel button (abort, stay open);
 * backdrop clicks are ignored while busy. The component stays mounted
 * (`keepMounted`) so the provider tabs keep their state.
 *
 * There is no additive-vs-replace choice: the sink follows the workspace mode,
 * because the two modes mean different things.
 *
 *   - **editor**  → `AssetEditorPlugin.importItems()`. Editor mode edits ONE
 *     library object and has no scene, so an import is always an addition to the
 *     current asset (an undoable `importCad` op).
 *   - **planner** → `importObject()` (op log, undo/redo, autosave), which also
 *     offers the floor auto-align that only makes sense for a scene placement.
 *
 * "Open an arbitrary GLB as the scene" is not an import — it is the model
 * picker's job (`hmi/settings/ModelTab`, `hmi/scene/SceneWindow`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, IconButton, LinearProgress, Tab, Tabs,
  Tooltip, Typography,
} from '@mui/material';
import { Close, UploadFile } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import {
  importProviderRegistry,
  type CadImportProvider,
  type ImportFilePicker,
  type ImportProviderInput,
} from '../../core/import/rv-import-provider';
import {
  abortImportJob, dismissImportOutcome, startImportJob, useImportJob,
} from './import-job-store';

/**
 * Map known failure signatures to an actionable next step. Raw engine errors
 * ("memory access out of bounds") name the problem but not the fix — the
 * remediation line restores the user's agency after a failed import.
 */
export function remediationFor(message: string): string | null {
  const m = message.toLowerCase();
  if (/memory access out of bounds|out of memory|allocation fail|wasm memory|heap limit/.test(m)) {
    return 'The in-browser CAD engine ran out of memory — try a lower tessellation quality '
      + 'or convert via realvirtual CONNECT.';
  }
  if (/unreachable|failed to fetch|networkerror|load failed|timed? ?out/.test(m)) {
    return 'The server could not be reached — check that realvirtual CONNECT is running '
      + 'and reachable, then try again.';
  }
  if (/unsupported|not supported|unknown format|failed to parse|unexpected token|invalid glb|corrupt/.test(m)) {
    return 'The file could not be read — check that it is a valid, uncorrupted file in a '
      + 'supported format.';
  }
  return null;
}

interface UnifiedImportDialogProps {
  viewer: RVViewer;
  open: boolean;
  onClose: () => void;
}

/** Subscribe to registry + per-provider availability changes. */
function useProviders(open: boolean): CadImportProvider[] {
  const [, bump] = useState(0);
  const [providers, setProviders] = useState<CadImportProvider[]>(() => importProviderRegistry.list());

  useEffect(() => {
    if (!open) return;
    setProviders(importProviderRegistry.list());
    const offRegistry = importProviderRegistry.onChange(() => {
      setProviders(importProviderRegistry.list());
    });
    return offRegistry;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const offs = providers.map(p => {
      try { return p.onAvailabilityChange(() => bump(n => n + 1)); } catch { return () => undefined; }
    });
    return () => { for (const off of offs) off(); };
  }, [open, providers]);

  return providers;
}

/** Remember the last-used provider across dialog opens (localStorage). */
const LAST_PROVIDER_KEY = 'rv.import.lastProvider';

function loadLastProviderId(): string | null {
  try { return localStorage.getItem(LAST_PROVIDER_KEY); } catch { return null; }
}

export function UnifiedImportDialog({ viewer, open, onClose }: UnifiedImportDialogProps) {
  const providers = useProviders(open);
  const [activeId, setActiveId] = useState<string | null>(loadLastProviderId);
  const isEditor = viewer.modes.activeMode === 'editor';
  const [alignToFloor, setAlignToFloor] = useState(true);
  const inputsRef = useRef(new Map<string, ImportProviderInput | null>());
  const [hasInput, setHasInput] = useState(false);
  // The active tab's local file picker — rendered as the footer's
  // "Choose files…" button (registered via useRegisterFilePicker).
  const [filePicker, setFilePicker] = useState<ImportFilePicker | null>(null);

  // The job lives in the store, not here — the dialog is one of its two views.
  const job = useImportJob();
  const busy = job.status === 'running';
  const outcome = job.outcome;
  const cancelled = outcome?.kind === 'cancelled';
  const errors = outcome && outcome.kind !== 'cancelled' ? outcome.errors : [];
  const warnings = outcome?.warnings ?? [];
  const progress = busy ? job.progress : null;

  // Keep a valid active tab as providers come and go.
  const active = useMemo(
    () => providers.find(p => p.id === activeId) ?? providers[0] ?? null,
    [providers, activeId],
  );

  // A pure success needs no dialog: close it and let the tile confirm briefly.
  useEffect(() => {
    if (open && outcome?.kind === 'success') onClose();
  }, [open, outcome, onClose]);

  const ctx = useMemo(() => ({
    viewer,
    close: onClose,
    setInput: (input: ImportProviderInput | null) => {
      if (active) {
        inputsRef.current.set(active.id, input);
        setHasInput(input !== null);
      }
    },
    registerFilePicker: (picker: ImportFilePicker | null) => setFilePicker(picker),
  }), [viewer, onClose, active]);

  const selectTab = useCallback((id: string) => {
    setActiveId(id);
    try { localStorage.setItem(LAST_PROVIDER_KEY, id); } catch { /* private mode */ }
    dismissImportOutcome();
    setHasInput((inputsRef.current.get(id) ?? null) !== null);
  }, []);

  const doImport = useCallback(() => {
    if (!active) return;
    const input = inputsRef.current.get(active.id);
    if (!input) return;
    dismissImportOutcome();
    // The dialog stays open and blocks the workspace while the job runs —
    // progress renders below, Cancel aborts.
    startImportJob(viewer, active, input, { isEditor, alignToFloor });
  }, [active, isEditor, alignToFloor, viewer]);

  // Cancel a running import (keeps the dialog open WITH the selection and
  // settings — whoever cancels a slow import to lower the quality must not
  // redo the setup); otherwise consume the outcome and close.
  const cancelOrClose = useCallback(() => {
    if (busy) {
      abortImportJob();
      return;
    }
    if (outcome) dismissImportOutcome();
    onClose();
  }, [busy, outcome, onClose]);

  const availability = active?.availability() ?? 'needs-setup';
  const canImport = !!active && availability === 'ready' && hasInput && !busy;

  return (
    <Dialog
      open={open}
      // Stays mounted while a job runs so the provider tabs keep their state
      // across collapse-to-tile and reopen (the button unmounts us when idle).
      keepMounted
      onClose={(_, reason) => {
        if (busy) {
          // The running import blocks the workspace: Esc behaves like the
          // Cancel button (abort, stay open), backdrop clicks are ignored.
          if (reason === 'escapeKeyDown') cancelOrClose();
          return;
        }
        onClose();
      }}
      // Sized to the tab strip, not the generic sm dialog — the widest row
      // (six 12px tabs / the 150px+field setting rows) needs ~420px.
      maxWidth={false}
      slotProps={{ paper: { sx: { width: 420, maxWidth: 'calc(100vw - 32px)' } } }}
      data-testid="unified-import-dialog"
    >
      <DialogTitle
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 14, fontWeight: 600, px: 2, pt: 1.5, pb: 0.75 }}
      >
        Import
        <IconButton
          size="small"
          aria-label="Close"
          onClick={cancelOrClose}
          disabled={busy}
          sx={{ p: 0.5, mr: -0.5 }}
        >
          <Close sx={{ fontSize: 16 }} />
        </IconButton>
      </DialogTitle>
      <DialogContent
        sx={{
          px: 2,
          pt: 0,
          pb: 1.5,
          // ONE alert styling for the whole dialog, provider tabs included:
          // compact tinted glass instead of MUI's heavy dark slabs. Info stays
          // neutral (blue is action/selection, not information); warning /
          // error / success carry their state tint — always with icon + text.
          // bgcolor needs !important: the theme's MuiPaper override forces the
          // glass tier with !important, and Alert is a Paper.
          '& .MuiAlert-root': {
            py: 0.25,
            px: 1.25,
            fontSize: 12,
            fontWeight: 400,
            lineHeight: 1.5,
            alignItems: 'center',
            borderRadius: 1,
            border: '1px solid rgba(255,255,255,0.08)',
            bgcolor: 'rgba(255,255,255,0.04) !important',
            color: 'text.primary',
          },
          '& .MuiAlert-icon': { mr: 1, py: 0.5, '& svg': { fontSize: 16 } },
          '& .MuiAlert-message': { py: 0.5 },
          '& .MuiAlert-action': { pt: 0, mr: -0.5 },
          '& .MuiAlert-standardSuccess': { bgcolor: 'rgba(102,187,106,0.08) !important', borderColor: 'rgba(102,187,106,0.3)', color: 'text.primary' },
          '& .MuiAlert-standardWarning': { bgcolor: 'rgba(255,167,38,0.08) !important', borderColor: 'rgba(255,167,38,0.3)', color: 'text.primary' },
          '& .MuiAlert-standardError': { bgcolor: 'rgba(239,83,80,0.08) !important', borderColor: 'rgba(239,83,80,0.3)', color: 'text.primary' },
          '& .MuiAlert-standardInfo': { color: 'text.primary' },
        }}
      >
        {/* All providers stay visible at once — a source hidden behind a
            scroll chevron is a source that doesn't exist for most users.
            Compact tab padding fits six tabs into the sm dialog; the hairline
            underneath gives the active indicator a track to sit on. */}
        <Tabs
          value={active?.id ?? false}
          onChange={(_, v) => selectTab(v)}
          sx={{
            minHeight: 30,
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            '& .MuiTab-root': {
              minHeight: 30,
              minWidth: 0,
              px: 1.25,
              textTransform: 'none',
              fontSize: 12,
              fontWeight: 500,
            },
          }}
        >
          {providers.map(p => <Tab key={p.id} value={p.id} label={p.label} />)}
        </Tabs>

        {providers.length === 0 && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            No import providers registered.
          </Typography>
        )}

        {/* Fixed minimum height so switching between a one-button tab and a
            form-heavy tab doesn't bounce the dialog. The config tab renders in
            EVERY availability state — providers with an in-tab login flow
            (Onshape, plan-237) need their tab visible while still
            'needs-setup'. The Import button stays gated on 'ready'. */}
        <Box sx={{ minHeight: 148 }}>
          {active && active.renderConfigTab(ctx)}

          {active && availability !== 'ready' && (
            <Alert severity="info" sx={{ mt: 1.25 }}>
              {availability === 'connecting'
                ? `Connecting to ${active.label}…`
                : active.setupHint ?? `${active.label} needs to be set up before importing.`}
            </Alert>
          )}
        </Box>

        {busy && (
          <Box sx={{ mt: 1.5 }}>
            {/* Determinate as soon as the provider can report a fraction. STEP
                tessellation has no measurable progress (occt exposes no callback)
                — the percentage there is a calibrated estimate and the detail
                line says so ("~1 min 20 s remaining" / "taking longer than
                expected…"). */}
            <LinearProgress
              variant={progress?.percent != null ? 'determinate' : 'indeterminate'}
              value={progress?.percent != null ? progress.percent * 100 : undefined}
            />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1, mt: 0.5 }}>
              <Typography sx={{ fontSize: 12, color: 'text.primary' }} noWrap>
                {progress?.label ?? 'Importing…'}
              </Typography>
              {progress?.percent != null && (
                <Typography sx={{ fontFamily: 'monospace', fontSize: 11, color: 'text.primary', flexShrink: 0 }}>
                  {Math.round(progress.percent * 100)}%
                </Typography>
              )}
            </Box>
            {progress?.detail && (
              <Typography
                sx={{ display: 'block', fontFamily: 'monospace', fontSize: 11, color: 'text.secondary' }}
                noWrap
              >
                {progress.detail}
              </Typography>
            )}
          </Box>
        )}

        {cancelled && !busy && (
          <Alert severity="info" sx={{ mt: 1.25 }}>
            Import cancelled — your file selection and settings are kept.
          </Alert>
        )}

        {/* A warnings-only import DID place the model — say so explicitly
            instead of leaving success implicit behind a warning. */}
        {outcome?.kind === 'warning' && outcome.importedNames.length > 0 && (
          <Alert severity="success" sx={{ mt: 1.25 }}>
            Import complete — {outcome.importedNames.join(', ')}.
          </Alert>
        )}

        {errors.map((e, i) => {
          const hint = remediationFor(e);
          return (
            <Alert key={`e${i}`} severity="error" sx={{ mt: 1.25 }}>
              {e}
              {hint && (
                <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
                  {hint}
                </Typography>
              )}
            </Alert>
          );
        })}
        {warnings.map((w, i) => (
          <Alert key={`w${i}`} severity="warning" sx={{ mt: 1.25 }}>{w}</Alert>
        ))}
      </DialogContent>

      {/* One footer row: the planner's floor toggle on the left (editor mode
          needs no sink note — the sink follows the mode), actions right. */}
      <DialogActions
        sx={{ px: 2, py: 1.25, gap: 1, justifyContent: isEditor ? 'flex-end' : 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)' }}
      >
        {!isEditor && (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Tooltip title="Turn off for multi-part CAD assemblies that must keep their original positions.">
              <FormControlLabel
                control={<Checkbox size="small" checked={alignToFloor} onChange={(_, v) => setAlignToFloor(v)} sx={{ py: 0.25 }} />}
                label="Auto-align to floor"
                sx={{ mr: 0, ml: -0.75, '& .MuiFormControlLabel-label': { fontSize: 12, color: 'text.secondary' } }}
              />
            </Tooltip>
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {filePicker && (
            <Button
              size="small"
              variant="outlined"
              startIcon={<UploadFile sx={{ fontSize: 16 }} />}
              onClick={filePicker.openPicker}
              disabled={busy}
              sx={{ textTransform: 'none' }}
            >
              {filePicker.label}
            </Button>
          )}
          <Button size="small" onClick={cancelOrClose} sx={{ textTransform: 'none' }}>
            {busy ? 'Cancel import' : errors.length > 0 || warnings.length > 0 || cancelled ? 'Close' : 'Cancel'}
          </Button>
          <Button size="small" onClick={doImport} disabled={!canImport} variant="contained" sx={{ textTransform: 'none', px: 2 }}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}

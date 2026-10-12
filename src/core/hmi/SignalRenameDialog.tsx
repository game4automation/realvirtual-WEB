// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalRenameDialog — rename a PLC signal with every reference (plan-590 F9).
 *
 * The dialog is a VIEW of the command `editor.signalRename`: typing a name runs its dry run
 * (`dryRun: true`) and shows the preview; Rename runs it for real. It owns no rule of its own —
 * blockers, wire effects and warnings all come from the planner (`planSignalRename`) through the
 * command, so the inspector, the MCP tool and this dialog can never disagree about what a rename
 * may do.
 *
 * Layout (plan §3), top to bottom:
 *
 *  - current name and the new-name field;
 *  - one row per step kind with its count (model name, fields, operator panels, metadata, PLC
 *    programs, signal links, planner, historian, CONNECT, path references) — every single change
 *    behind a "All changes" disclosure;
 *  - blockers in red; any blocker locks the Rename button;
 *  - wire name changes (a name that travels on the wire: MQTT JSON key, name fallback, mirror) with
 *    a mandatory "I understand" checkbox;
 *  - warnings (historian series, inactive CONNECT profiles, CONNECT not connected …);
 *  - the completeness scope — what was searched and what was not.
 *
 * Built from the inspector building blocks and `shared-sx` only (plan-510); English UI text.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import { InspectorRow } from './rv-inspector-row';
import { DetailsDisclosure, InspectorSubheader } from './rv-inspector-blocks';
import {
  ERROR,
  FS,
  INK_HIGH,
  INK_LOW,
  INK_MID,
  MONO,
  WARN,
  inspectorInputSx,
} from './shared-sx';
import { commandRegistry } from './rv-command-registry';
import { SIGNAL_RENAME_COMMAND } from './problems-store';
import type { SignalRenamePreview, SignalRenamePreviewStep } from './signal-rename-wiring';
import { SIGNAL_RENAME_STEP_KINDS, type SignalRenameStepKind } from '../engine/rv-signal-rename';

/** Display label of each step kind (preview groups). */
export const SIGNAL_RENAME_KIND_LABELS: Readonly<Record<SignalRenameStepKind, string>> = {
  'signal-name': 'Signal name',
  'string-field': 'Model fields',
  'operator-panel': 'Operator panels',
  'metadata': 'Metadata',
  'plc-program': 'PLC programs',
  'signal-link': 'Signal links',
  'placed-mapping': 'Planner',
  'historian': 'Historian',
  'connect': 'CONNECT',
  'path-reference': 'Path references',
};

/** Human label of a wire effect kind. */
const WIRE_KIND_LABELS: Readonly<Record<string, string>> = {
  'json-key': 'JSON key',
  'name-fallback': 'name as address',
  'mirror-topic': 'mirror topic',
  'mirror-membership': 'mirror membership',
};

/** Debounce of the dry run while typing (ms). */
const PREVIEW_DEBOUNCE_MS = 250;

/** Answer of a dry run: the preview, or why there is none. */
export type SignalRenamePreviewOutcome = { preview: SignalRenamePreview } | { error: string };
/** Answer of an apply. */
export type SignalRenameApplyOutcome = { ok: true; journalId?: string } | { ok: false; reason: string };

export interface SignalRenameDialogProps {
  open: boolean;
  onClose: () => void;
  viewer: RVViewer | null;
  /** Registry path of the signal node. */
  nodePath: string;
  /** The signal's current (runtime) name — the field's start value. */
  currentName: string;
  /** Called after a committed rename with the new name. */
  onRenamed?: (newName: string, journalId?: string) => void;
  /** Dry run — default: `editor.signalRename` with `dryRun: true`. */
  runPreview?: (newName: string) => Promise<SignalRenamePreviewOutcome>;
  /** Apply — default: `editor.signalRename`. */
  runApply?: (newName: string, confirmWireChange: boolean) => Promise<SignalRenameApplyOutcome>;
}

/** Group the preview steps by kind, in the planner's display order. */
export function groupSignalRenameSteps(
  steps: readonly SignalRenamePreviewStep[],
): Array<{ kind: SignalRenameStepKind; steps: SignalRenamePreviewStep[]; count: number }> {
  const out: Array<{ kind: SignalRenameStepKind; steps: SignalRenamePreviewStep[]; count: number }> = [];
  for (const kind of SIGNAL_RENAME_STEP_KINDS) {
    const of = steps.filter((s) => s.kind === kind);
    if (of.length === 0) continue;
    const count = of.reduce((n, s) => n + (s.kind === 'path-reference' ? (s.count ?? 1) : 1), 0);
    out.push({ kind, steps: of, count });
  }
  return out;
}

/** True when the Rename button may be pressed. */
export function canSubmitSignalRename(
  preview: SignalRenamePreview | null, name: string, wireConfirmed: boolean, busy: boolean,
): boolean {
  if (busy || !preview) return false;
  if (preview.newName !== name) return false;
  if (!preview.ok) return false;
  if (preview.requiresWireConfirmation && !wireConfirmed) return false;
  return true;
}

function defaultPreview(viewer: RVViewer | null, nodePath: string) {
  return async (newName: string): Promise<SignalRenamePreviewOutcome> => {
    const r = await commandRegistry.execute<{ dryRun: true; preview: SignalRenamePreview }>(
      SIGNAL_RENAME_COMMAND, { path: nodePath, newName, dryRun: true },
      { origin: 'ui', ...(viewer ? { viewer } : {}) });
    return r.ok ? { preview: r.value.preview } : { error: r.reason };
  };
}

function defaultApply(viewer: RVViewer | null, nodePath: string) {
  return async (newName: string, confirmWireChange: boolean): Promise<SignalRenameApplyOutcome> => {
    const r = await commandRegistry.execute<{ journalId?: string }>(
      SIGNAL_RENAME_COMMAND, { path: nodePath, newName, dryRun: false, confirmWireChange },
      { origin: 'ui', ...(viewer ? { viewer } : {}) });
    return r.ok ? { ok: true, journalId: r.value.journalId } : { ok: false, reason: r.reason };
  };
}

/** A plain text line in the value column (wraps instead of truncating). */
function ValueText({ children, color = INK_MID, mono = false, testId }: {
  children: string; color?: string; mono?: boolean; testId?: string;
}) {
  return (
    <Typography
      data-testid={testId}
      sx={{
        fontSize: FS.label, color, fontFamily: mono ? MONO : undefined,
        minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'normal',
      }}
    >
      {children}
    </Typography>
  );
}

export function SignalRenameDialog({
  open, onClose, viewer, nodePath, currentName, onRenamed, runPreview, runApply,
}: SignalRenameDialogProps) {
  const [name, setName] = useState(currentName);
  const [preview, setPreview] = useState<SignalRenamePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [wireConfirmed, setWireConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const seq = useRef(0);

  const previewFn = useMemo(() => runPreview ?? defaultPreview(viewer, nodePath), [runPreview, viewer, nodePath]);
  const applyFn = useMemo(() => runApply ?? defaultApply(viewer, nodePath), [runApply, viewer, nodePath]);

  // Reset on (re)open.
  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setPreview(null);
    setPreviewError(null);
    setWireConfirmed(false);
    setApplyError(null);
  }, [open, currentName]);

  // Dry run, debounced; a stale answer (older keystroke) is dropped.
  useEffect(() => {
    if (!open) return undefined;
    setWireConfirmed(false);
    setApplyError(null);
    if (name === currentName || name.length === 0) {
      seq.current++;
      setPreview(null);
      setPreviewError(null);
      setChecking(false);
      return undefined;
    }
    const mine = ++seq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      void previewFn(name).then((outcome) => {
        if (mine !== seq.current) return;
        if ('preview' in outcome) { setPreview(outcome.preview); setPreviewError(null); }
        else { setPreview(null); setPreviewError(outcome.error); }
      }).catch((e: unknown) => {
        if (mine !== seq.current) return;
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : String(e));
      }).finally(() => {
        if (mine === seq.current) setChecking(false);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, name, currentName, previewFn]);

  const shown = preview && preview.newName === name ? preview : null;
  const groups = useMemo(() => (shown ? groupSignalRenameSteps(shown.steps) : []), [shown]);
  const canSubmit = canSubmitSignalRename(shown, name, wireConfirmed, applying || checking);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setApplying(true);
    setApplyError(null);
    try {
      const out = await applyFn(name, wireConfirmed);
      if (out.ok) {
        onRenamed?.(name, out.journalId);
        onClose();
      } else {
        setApplyError(out.reason);
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [canSubmit, applyFn, name, wireConfirmed, onRenamed, onClose]);

  return (
    <Dialog open={open} onClose={applying ? undefined : onClose} maxWidth="sm" fullWidth data-testid="rv-signal-rename-dialog">
      <DialogTitle sx={{ fontSize: FS.title, fontWeight: 600 }}>Rename signal</DialogTitle>
      <DialogContent sx={{ px: 1 }}>
        <InspectorRow label="Current name">
          <ValueText mono testId="rv-signal-rename-current">{currentName || '—'}</ValueText>
        </InspectorRow>
        <InspectorRow label="New name">
          <TextField
            size="small"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            slotProps={{
              htmlInput: { 'data-testid': 'rv-signal-rename-input', 'aria-label': 'New signal name', spellCheck: false },
              input: { sx: { fontSize: FS.label, fontFamily: MONO } },
            }}
            sx={{ width: '100%', '& .MuiOutlinedInput-root': inspectorInputSx }}
          />
        </InspectorRow>

        {checking && (
          <InspectorRow label="">
            <ValueText color={INK_LOW} testId="rv-signal-rename-checking">Checking references…</ValueText>
          </InspectorRow>
        )}

        {previewError && (
          <InspectorRow label="" dataAttrs={{ 'data-testid': 'rv-signal-rename-blocker' }}>
            <ValueText color={ERROR}>{previewError}</ValueText>
          </InspectorRow>
        )}

        {shown && (
          <>
            <InspectorSubheader data-testid="rv-signal-rename-changes">Changes</InspectorSubheader>
            {groups.length === 0 && (
              <InspectorRow label="">
                <ValueText color={INK_LOW}>Nothing references this signal by name.</ValueText>
              </InspectorRow>
            )}
            {groups.map((g) => (
              <InspectorRow
                key={g.kind}
                label={SIGNAL_RENAME_KIND_LABELS[g.kind]}
                dataAttrs={{ 'data-testid': `rv-signal-rename-group-${g.kind}`, 'data-count': String(g.count) }}
                trailing={<Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: INK_HIGH }}>{String(g.count)}</Typography>}
              >
                <Typography sx={{ fontSize: FS.label, color: INK_MID, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.steps.map((s) => (s.detail ? `${s.label} (${s.detail})` : s.label)).join(' · ')}
                </Typography>
              </InspectorRow>
            ))}
            {shown.steps.length > 0 && (
              <DetailsDisclosure title="All changes" summary={`${shown.steps.length} step${shown.steps.length === 1 ? '' : 's'}`} data-testid="rv-signal-rename-all">
                {shown.steps.map((s, i) => (
                  <InspectorRow key={`${s.kind}:${s.nodePath ?? s.label}:${i}`} label={s.label} labelTitle={s.nodePath ?? s.label} dense>
                    <ValueText color={INK_LOW}>{`${SIGNAL_RENAME_KIND_LABELS[s.kind]}${s.detail ? ` · ${s.detail}` : ''}`}</ValueText>
                  </InspectorRow>
                ))}
              </DetailsDisclosure>
            )}

            {shown.blockers.length > 0 && (
              <>
                <InspectorSubheader accent={ERROR}>Blocked</InspectorSubheader>
                {shown.blockers.map((b) => (
                  <InspectorRow key={b} label="" dataAttrs={{ 'data-testid': 'rv-signal-rename-blocker' }}>
                    <ValueText color={ERROR}>{b}</ValueText>
                  </InspectorRow>
                ))}
              </>
            )}

            {shown.wireChanges.length > 0 && (
              <>
                <InspectorSubheader accent={WARN}>Wire name changes</InspectorSubheader>
                {shown.wireChanges.map((w, i) => (
                  <InspectorRow
                    key={`${w.interfaceId}:${w.topic ?? ''}:${i}`}
                    label={w.topic ? `${w.interfaceId} · ${w.topic}` : w.interfaceId}
                    labelTitle={w.topic ? `${w.interfaceId} · ${w.topic}` : w.interfaceId}
                    dataAttrs={{ 'data-testid': 'rv-signal-rename-wire' }}
                  >
                    <ValueText color={WARN}>{`${WIRE_KIND_LABELS[w.kind] ?? w.kind}: ${w.detail}`}</ValueText>
                  </InspectorRow>
                ))}
                <InspectorRow label="Confirm">
                  <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer' }}>
                    <Checkbox
                      size="small"
                      checked={wireConfirmed}
                      onChange={(e) => setWireConfirmed(e.target.checked)}
                      slotProps={{ input: { 'data-testid': 'rv-signal-rename-confirm' } as Record<string, string> }}
                      sx={{ p: 0.25 }}
                    />
                    <Typography sx={{ fontSize: FS.label, color: INK_MID }}>
                      I understand that devices reading the old name on the wire stop receiving it
                    </Typography>
                  </Box>
                </InspectorRow>
              </>
            )}

            {shown.warnings.length > 0 && (
              <>
                <InspectorSubheader>Notes</InspectorSubheader>
                {shown.warnings.map((w) => (
                  <InspectorRow key={w} label="" dataAttrs={{ 'data-testid': 'rv-signal-rename-warning' }}>
                    <ValueText>{w}</ValueText>
                  </InspectorRow>
                ))}
              </>
            )}

            <InspectorRow label="Searched" dataAttrs={{ 'data-testid': 'rv-signal-rename-scope' }}>
              <ValueText color={INK_LOW}>{shown.scope}</ValueText>
            </InspectorRow>
          </>
        )}

        {applyError && (
          <InspectorRow label="" dataAttrs={{ 'data-testid': 'rv-signal-rename-error' }}>
            <ValueText color={ERROR}>{applyError}</ValueText>
          </InspectorRow>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" sx={{ textTransform: 'none' }} onClick={onClose} disabled={applying}>Cancel</Button>
        <Button
          size="small"
          variant="contained"
          sx={{ textTransform: 'none' }}
          onClick={() => { void submit(); }}
          disabled={!canSubmit}
          data-testid="rv-signal-rename-submit"
        >
          {applying ? 'Renaming…' : 'Rename'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

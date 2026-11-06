// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectAddressSourceDialogs — the two address SOURCES of an interface card (plan-2025 F11 / F12).
 *
 *  - **Fill addresses from controller** — browses the controller, couples every model signal whose
 *    name is EXACTLY a controller symbol and fills in the controller's address. Offered only where the
 *    gateway says the worker can browse (`supportsDiscovery`).
 *  - **Import address table** — a CSV / TSV `name;address[;dataType[;topic]]` for any interface.
 *
 * Both are preview-first: nothing is written until the user confirms the table of row verdicts, and
 * then exactly ONE batch goes to CONNECT's write core (`POST /config/ops`) on the revision the user
 * saw. Addresses are written into CONNECT only — never into the model, never into a comment
 * (plan-589). The pure logic lives in `rv-fill-addresses.ts` / `rv-address-table-import.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import {
  applyAddressTableImport,
  applyFillAddresses,
  ConnectConfigConflictError,
  ConnectConfigOutcomeUnknownError,
  ConnectConfigPlanStaleError,
  getConnectConfigPlanBase,
  holdConnectConfigEditing,
  isConnectConfigPlanCurrent,
  planAddressTableImportFor,
  planFillAddressesFromController,
  reconcileInterfaces,
  subscribeConnectStore,
  type ConnectInterface,
} from './connect-store';
import { collectModelPlcSignals } from '../import/rv-plc-automap';
import {
  FILL_WRITE_STATUSES,
  type FillAddressPlan,
  type FillRowStatus,
} from '../import/rv-fill-addresses';
import {
  ADDRESS_IMPORT_WRITE_STATUSES,
  parseAddressTable,
  type AddressImportContainer,
  type AddressImportExisting,
  type AddressImportPlan,
  type AddressImportStatus,
  type AddressTableColumns,
  type AddressTableDelimiterChoice,
} from '../import/rv-address-table-import';
import { ISA_AMBER, ISA_GREEN, ISA_RED } from './isa-colors';

/** Preview rows rendered at most (the batch always covers every row). */
const MAX_PREVIEW_ROWS = 500;

/**
 * Re-render on every change of the shown configuration or gateway, so a preview computed on an older
 * revision is seen as outdated at once (plan-2025 P7 review fix 3).
 */
function useConfigPlanBaseKey(): string {
  return useSyncExternalStore(subscribeConnectStore, () => {
    const b = getConnectConfigPlanBase();
    return `${b.baseUrl}\u0001${b.epoch}\u0001${b.revision?.instance ?? ''}\u0001${b.revision?.revision ?? ''}`;
  });
}

/** Did an apply fail in a way that makes its preview worthless (conflict, stale base, unknown result)? */
function invalidatesPreview(err: unknown): boolean {
  return err instanceof ConnectConfigConflictError
    || err instanceof ConnectConfigPlanStaleError
    || err instanceof ConnectConfigOutcomeUnknownError;
}

const STALE_PREVIEW_TEXT = 'The CONNECT configuration changed since this preview was computed — compute it again before writing.';

const cellSx = { fontSize: 11, fontFamily: 'monospace', px: 0.75, py: 0.25, whiteSpace: 'nowrap' as const };
const headSx = { ...cellSx, fontFamily: 'inherit', fontWeight: 600, color: 'rgba(255,255,255,0.7)' };

// ── Fill addresses from controller ─────────────────────────────────────

const FILL_LABEL: Record<FillRowStatus, string> = {
  fill: 'Fill',
  create: 'Create',
  retype: 'Retype to model',
  already: 'Already set',
  kept: 'Kept (different address)',
  'name-variant': 'Name variant (not coupled)',
  'not-found': 'Not on controller',
  'no-address': 'No address',
  'direction-conflict': 'Direction conflict',
  ambiguous: 'Ambiguous',
  'bound-elsewhere': 'On another interface',
};

function fillColor(status: FillRowStatus): string {
  if (FILL_WRITE_STATUSES.has(status)) return ISA_GREEN;
  if (status === 'already' || status === 'not-found') return 'rgba(255,255,255,0.55)';
  if (status === 'direction-conflict' || status === 'ambiguous') return ISA_RED;
  return ISA_AMBER;
}

/** Preview + apply of "Fill addresses from controller" for one interface. */
export function FillAddressesDialog({ open, onClose, iface }: { open: boolean; onClose: () => void; iface: ConnectInterface }) {
  const viewer = useViewer();
  const [plan, setPlan] = useState<FillAddressPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useConfigPlanBaseKey();
  const planCurrent = !!plan && isConnectConfigPlanCurrent(plan.base);

  useEffect(() => (open ? holdConnectConfigEditing() : undefined), [open]);

  const browse = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPlan(await planFillAddressesFromController(iface.id, collectModelPlcSignals(viewer)));
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [iface.id, viewer]);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setShowAll(false);
    void browse();
  }, [open, browse]);

  const writes = plan ? plan.rows.filter(r => FILL_WRITE_STATUSES.has(r.status)).length : 0;
  const visible = plan
    ? plan.rows.filter(r => showAll || (r.status !== 'not-found' && r.status !== 'already'))
    : [];

  const apply = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const commit = await applyFillAddresses(plan);
      const kept = commit.results.filter(r => r.addressKept).length;
      setDone(`${writes} address(es) written in one batch${kept > 0 ? `; ${kept} kept because the signal got an address meanwhile` : ''}.`);
      reconcileInterfaces(collectModelPlcSignals(viewer), [iface.id]);
      setPlan(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (invalidatesPreview(err)) {
        // The preview no longer describes the configuration: it must be computed again.
        setPlan(null);
        setError(`${message} Press "Browse again" to compute a new preview.`);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }, [plan, writes, viewer, iface.id]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth data-testid="fill-addresses-dialog">
      <DialogTitle sx={{ fontSize: 14 }}>Fill addresses from controller — {iface.id}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', mb: 1, lineHeight: 1.5 }}>
          Couples each model signal to the controller symbol of EXACTLY the same name and writes the
          controller's address into CONNECT. Existing addresses are never overwritten; a different
          spelling is only suggested. Nothing changes until you confirm.
        </Typography>
        {busy && !plan && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
            <CircularProgress size={14} />
            <Typography sx={{ fontSize: 12 }}>Browsing the controller…</Typography>
          </Box>
        )}
        {error && <Alert severity="error" sx={{ fontSize: 11, py: 0, mb: 1 }}>{error}</Alert>}
        {done && <Alert severity="success" sx={{ fontSize: 11, py: 0, mb: 1 }} data-testid="fill-addresses-done">{done}</Alert>}
        {plan && !planCurrent && (
          <Alert severity="warning" sx={{ fontSize: 11, py: 0, mb: 1 }} data-testid="fill-addresses-stale">{STALE_PREVIEW_TEXT}</Alert>
        )}
        {plan?.limitError && (
          <Alert severity="error" sx={{ fontSize: 11, py: 0, mb: 1 }} data-testid="fill-addresses-limit">{plan.limitError}</Alert>
        )}
        {plan && (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 1 }} data-testid="fill-addresses-counts">
              {(Object.keys(FILL_LABEL) as FillRowStatus[]).filter(s => plan.counts[s] > 0).map(s => (
                <Typography key={s} sx={{ fontSize: 11, color: fillColor(s) }}>{FILL_LABEL[s]}: {plan.counts[s]}</Typography>
              ))}
              <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                Controller only: {plan.controllerOnly} of {plan.discovered}
              </Typography>
            </Box>
            <TextField
              select size="small" label="Show" value={showAll ? 'all' : 'relevant'}
              onChange={(e) => setShowAll(e.target.value === 'all')} sx={{ mb: 1, minWidth: 220 }}
            >
              <MenuItem value="relevant" sx={{ fontSize: 12 }}>Changes and problems</MenuItem>
              <MenuItem value="all" sx={{ fontSize: 12 }}>All model signals</MenuItem>
            </TextField>
            <Box sx={{ maxHeight: 360, overflow: 'auto', border: '1px solid rgba(255,255,255,0.1)' }}>
              <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <Box component="th" sx={headSx}>Signal</Box>
                    <Box component="th" sx={headSx}>Result</Box>
                    <Box component="th" sx={headSx}>Controller address</Box>
                    <Box component="th" sx={headSx}>Note</Box>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, MAX_PREVIEW_ROWS).map(r => (
                    <tr key={r.name} data-testid="fill-row" data-status={r.status}>
                      <Box component="td" sx={cellSx}>{r.name}{r.topic ? ` @${r.topic}` : ''}</Box>
                      <Box component="td" sx={{ ...cellSx, fontFamily: 'inherit', color: fillColor(r.status) }}>{FILL_LABEL[r.status]}</Box>
                      <Box component="td" sx={cellSx}>{r.protocolAddress ?? ''}</Box>
                      <Box component="td" sx={{ ...cellSx, fontFamily: 'inherit', whiteSpace: 'normal' }}>
                        {r.status === 'kept' ? `configured: ${r.existingAddress}` : r.suggestion ? `controller: ${r.suggestion}` : r.reason ?? ''}
                      </Box>
                    </tr>
                  ))}
                </tbody>
              </Box>
              {visible.length > MAX_PREVIEW_ROWS && (
                <Typography sx={{ fontSize: 10, color: 'text.disabled', p: 0.5 }}>
                  +{visible.length - MAX_PREVIEW_ROWS} more rows (all of them are part of the batch)
                </Typography>
              )}
              {visible.length === 0 && (
                <Typography sx={{ fontSize: 11, color: 'text.disabled', p: 1 }}>Nothing to show.</Typography>
              )}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void browse()} disabled={busy} sx={{ textTransform: 'none' }}>Browse again</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>{done ? 'Close' : 'Cancel'}</Button>
        <Button
          variant="contained" onClick={() => void apply()}
          disabled={busy || writes === 0 || !planCurrent || !!plan?.limitError}
          sx={{ textTransform: 'none' }} data-testid="fill-addresses-apply"
        >
          {busy && plan ? 'Writing…' : `Fill ${writes} address${writes === 1 ? '' : 'es'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Import address table ───────────────────────────────────────────────

const IMPORT_LABEL: Record<AddressImportStatus, string> = {
  create: 'Create',
  update: 'Update',
  unchanged: 'Unchanged',
  kept: 'Kept (has an address)',
  rejected: 'Rejected',
};

function importColor(status: AddressImportStatus): string {
  if (ADDRESS_IMPORT_WRITE_STATUSES.has(status)) return ISA_GREEN;
  if (status === 'rejected') return ISA_RED;
  if (status === 'kept') return ISA_AMBER;
  return 'rgba(255,255,255,0.55)';
}

type ColumnField = keyof AddressTableColumns;
const COLUMN_FIELDS: Array<{ field: ColumnField; label: string; optional: boolean }> = [
  { field: 'name', label: 'Name column', optional: false },
  { field: 'address', label: 'Address column', optional: false },
  { field: 'dataType', label: 'Data type column', optional: true },
  { field: 'topic', label: 'Topic column', optional: true },
];

/** Container choice encoded for a select: `per-row`, `flat` or `topic:<name>`. */
function containerValue(c: AddressImportContainer): string {
  return c.kind === 'topic' ? `topic:${c.topic}` : c.kind;
}
function containerOf(value: string): AddressImportContainer {
  if (value.startsWith('topic:')) return { kind: 'topic', topic: value.slice('topic:'.length) };
  return value === 'per-row' ? { kind: 'per-row' } : { kind: 'flat' };
}

/** Paste / open a CSV or TSV address table, check it row by row, import it as one batch. */
export function AddressTableImportDialog({ open, onClose, iface }: { open: boolean; onClose: () => void; iface: ConnectInterface }) {
  const viewer = useViewer();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [columns, setColumns] = useState<AddressTableColumns | null>(null);
  const topics = useMemo(() => (iface.topics ?? []).map(t => t.topic), [iface.topics]);
  const [container, setContainer] = useState<AddressImportContainer>({ kind: 'flat' });
  const [existing, setExisting] = useState<AddressImportExisting>('fillEmpty');
  const [direction, setDirection] = useState<'input' | 'output' | 'none'>('none');
  const [delimiter, setDelimiter] = useState<AddressTableDelimiterChoice>('auto');
  /** The preview and the input version it was computed for (plan-2025 P7 review fix 4). */
  const [planState, setPlanState] = useState<{ plan: AddressImportPlan; key: string } | null>(null);
  /** Bumped to recompute the preview on an unchanged input (after a conflict). */
  const [recheck, setRecheck] = useState(0);
  const [checking, setChecking] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useConfigPlanBaseKey();

  useEffect(() => (open ? holdConnectConfigEditing() : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    setText(''); setColumns(null); setPlanState(null); setError(null); setDone(null);
    setContainer({ kind: 'flat' }); setExisting('fillEmpty'); setDirection('none'); setDelimiter('auto');
  }, [open]);

  const table = useMemo(() => (text.trim() ? parseAddressTable(text, delimiter) : null), [text, delimiter]);
  // A table of a new SHAPE (width, header) brings its own column mapping (header names or positional)
  // and, with a topic column, per-row containers as the default. Typing inside the rows keeps the
  // user's choices.
  const shape = table ? `${table.columnCount}\u0001${table.header?.join('\u0001') ?? ''}` : '';
  useEffect(() => {
    setColumns(table ? table.columns : null);
    if (table?.columns.topic != null) setContainer({ kind: 'per-row' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // The version of everything a preview depends on. A preview is valid ONLY for the version it was
  // computed for: any edit of the text, the separator, a column, the container, the mode or the
  // direction makes the shown preview void at once — also during the debounce below.
  const inputKey = JSON.stringify([text, delimiter, columns, container, existing, direction, recheck]);
  const inputKeyRef = useRef(inputKey);
  inputKeyRef.current = inputKey;

  // Re-check whenever the input or a choice changes (debounced: the gateway parses every address).
  useEffect(() => {
    setPlanState(null);
    if (!open || !table || !columns || table.rows.length === 0) { setChecking(false); return undefined; }
    let cancelled = false;
    const key = inputKey;
    setChecking(true);
    const timer = window.setTimeout(() => {
      setError(null);
      void planAddressTableImportFor(iface.id, table, {
        container, existing, columns,
        defaultDirection: direction === 'none' ? null : direction,
      }, collectModelPlcSignals(viewer))
        .then(p => { if (!cancelled && inputKeyRef.current === key) setPlanState({ plan: p, key }); })
        .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputKey covers text/delimiter/recheck
  }, [open, table, columns, container, existing, direction, recheck, iface.id, viewer]);

  // The preview shown and applied: only the one computed for THIS input, on the shown configuration.
  const plan = planState && planState.key === inputKey ? planState.plan : null;
  const planCurrent = !!plan && isConnectConfigPlanCurrent(plan.base);
  const busy = checking || writing;

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
  }, []);

  const writes = plan ? plan.counts.create + plan.counts.update : 0;
  const apply = useCallback(async () => {
    // Only the preview of the CURRENT input version is ever written.
    if (!planState || planState.key !== inputKeyRef.current) return;
    const target = planState.plan;
    setWriting(true);
    setError(null);
    try {
      await applyAddressTableImport(target);
      setDone(`${target.counts.create + target.counts.update} signal(s) written in one batch; ${target.counts.rejected} row(s) rejected.`);
      reconcileInterfaces(collectModelPlcSignals(viewer), [iface.id]);
      setText('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (invalidatesPreview(err)) {
        // The preview no longer describes the configuration: recompute it on the reloaded one.
        setPlanState(null);
        setRecheck(n => n + 1);
        setError(`${message} The preview is computed again on the current configuration — check it before importing.`);
      } else {
        setError(message);
      }
    } finally {
      setWriting(false);
    }
  }, [planState, viewer, iface.id]);

  const columnOptions = table ? Array.from({ length: Math.max(table.columnCount, 2) }, (_, i) => i) : [];
  const columnLabel = (i: number) => (table?.header?.[i] ? `${i + 1}: ${table.header[i]}` : `Column ${i + 1}`);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth data-testid="address-table-import-dialog">
      <DialogTitle sx={{ fontSize: 14 }}>Import address table — {iface.id}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', mb: 1, lineHeight: 1.5 }}>
          One row per signal: <Box component="span" sx={{ fontFamily: 'monospace' }}>name;address[;dataType[;topic]]</Box> —
          separated by semicolon, comma or tab, an optional header row names the columns. The name is
          the signal name exactly as the model uses it. Every row is checked; only valid rows are
          written, in one batch.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1 }}>
          <Button size="small" variant="outlined" onClick={() => fileRef.current?.click()} sx={{ textTransform: 'none' }}>
            Open CSV / TSV…
          </Button>
          <input
            ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" hidden
            data-testid="address-table-file"
            onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <TextField
            select size="small" label="Separator" sx={{ minWidth: 130 }}
            value={delimiter === '\t' ? 'tab' : delimiter}
            onChange={(e) => setDelimiter(e.target.value === 'tab' ? '\t' : e.target.value as AddressTableDelimiterChoice)}
            SelectProps={{ SelectDisplayProps: { 'data-testid': 'address-table-delimiter' } as React.HTMLAttributes<HTMLDivElement> }}
          >
            <MenuItem value="auto" sx={{ fontSize: 12 }}>Auto</MenuItem>
            <MenuItem value=";" sx={{ fontSize: 12 }}>Semicolon ;</MenuItem>
            <MenuItem value="," sx={{ fontSize: 12 }}>Comma ,</MenuItem>
            <MenuItem value="tab" sx={{ fontSize: 12 }}>Tab</MenuItem>
          </TextField>
          {table && (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
              {table.rows.length} row(s), separator {table.delimiter === '\t' ? 'tab' : `'${table.delimiter}'`}
              {table.header ? ', with header' : ''}
            </Typography>
          )}
        </Box>
        <TextField
          fullWidth multiline minRows={4} maxRows={8} size="small" label="…or paste the table here"
          value={text} onChange={(e) => setText(e.target.value)}
          inputProps={{ 'data-testid': 'address-table-text', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 11 } }}
          sx={{ mb: 1 }}
        />
        {table && columns && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
            {COLUMN_FIELDS.map(({ field, label, optional }) => (
              <TextField
                key={field} select size="small" label={label} sx={{ minWidth: 150 }}
                value={columns[field] === null ? 'none' : String(columns[field])}
                onChange={(e) => {
                  const v = e.target.value === 'none' ? null : Number(e.target.value);
                  setColumns(prev => (prev ? { ...prev, [field]: v } as AddressTableColumns : prev));
                }}
              >
                {optional && <MenuItem value="none" sx={{ fontSize: 12 }}>none</MenuItem>}
                {columnOptions.map(i => <MenuItem key={i} value={String(i)} sx={{ fontSize: 12 }}>{columnLabel(i)}</MenuItem>)}
              </TextField>
            ))}
            <TextField
              select size="small" label="Container" sx={{ minWidth: 200 }}
              value={containerValue(container)} onChange={(e) => setContainer(containerOf(e.target.value))}
            >
              <MenuItem value="flat" sx={{ fontSize: 12 }}>Interface signals</MenuItem>
              {columns.topic !== null && <MenuItem value="per-row" sx={{ fontSize: 12 }}>Per row (topic column)</MenuItem>}
              {topics.map(t => <MenuItem key={t} value={`topic:${t}`} sx={{ fontSize: 12 }}>Topic {t}</MenuItem>)}
            </TextField>
            <TextField
              select size="small" label="Existing addresses" sx={{ minWidth: 190 }}
              value={existing} onChange={(e) => setExisting(e.target.value as AddressImportExisting)}
            >
              <MenuItem value="fillEmpty" sx={{ fontSize: 12 }}>Keep (fill empty only)</MenuItem>
              <MenuItem value="overwrite" sx={{ fontSize: 12 }}>Overwrite</MenuItem>
            </TextField>
            <TextField
              select size="small" label="Direction of new signals" sx={{ minWidth: 210 }}
              value={direction} onChange={(e) => setDirection(e.target.value as 'input' | 'output' | 'none')}
            >
              <MenuItem value="none" sx={{ fontSize: 12 }}>From model / address only</MenuItem>
              <MenuItem value="output" sx={{ fontSize: 12 }}>Read from PLC (output)</MenuItem>
              <MenuItem value="input" sx={{ fontSize: 12 }}>Write to PLC (input)</MenuItem>
            </TextField>
          </Box>
        )}
        {busy && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}><CircularProgress size={12} /><Typography sx={{ fontSize: 11 }}>Checking rows…</Typography></Box>}
        {error && <Alert severity="error" sx={{ fontSize: 11, py: 0, mb: 1 }}>{error}</Alert>}
        {done && <Alert severity="success" sx={{ fontSize: 11, py: 0, mb: 1 }} data-testid="address-table-done">{done}</Alert>}
        {plan && !planCurrent && (
          <Alert severity="warning" sx={{ fontSize: 11, py: 0, mb: 1 }} data-testid="address-table-stale">{STALE_PREVIEW_TEXT}</Alert>
        )}
        {plan?.limitError && (
          <Alert severity="error" sx={{ fontSize: 11, py: 0, mb: 1 }} data-testid="address-table-limit">{plan.limitError}</Alert>
        )}
        {plan && (
          <>
            <Box sx={{ display: 'flex', gap: 1.5, mb: 0.5 }} data-testid="address-table-counts">
              {(Object.keys(IMPORT_LABEL) as AddressImportStatus[]).filter(s => plan.counts[s] > 0).map(s => (
                <Typography key={s} sx={{ fontSize: 11, color: importColor(s) }}>{IMPORT_LABEL[s]}: {plan.counts[s]}</Typography>
              ))}
            </Box>
            <Box sx={{ maxHeight: 300, overflow: 'auto', border: '1px solid rgba(255,255,255,0.1)' }}>
              <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <Box component="th" sx={headSx}>Line</Box>
                    <Box component="th" sx={headSx}>Signal</Box>
                    <Box component="th" sx={headSx}>Address</Box>
                    <Box component="th" sx={headSx}>Container</Box>
                    <Box component="th" sx={headSx}>Result</Box>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.slice(0, MAX_PREVIEW_ROWS).map(r => (
                    <tr key={r.line} data-testid="address-table-row" data-status={r.status}>
                      <Box component="td" sx={cellSx}>{r.line}</Box>
                      <Box component="td" sx={cellSx}>{r.name}</Box>
                      <Box component="td" sx={cellSx}>{r.address}</Box>
                      <Box component="td" sx={cellSx}>{r.topic ?? 'signals'}</Box>
                      <Box component="td" sx={{ ...cellSx, fontFamily: 'inherit', whiteSpace: 'normal', color: importColor(r.status) }}>
                        {IMPORT_LABEL[r.status]}{r.reason ? ` — ${r.reason}` : ''}
                      </Box>
                    </tr>
                  ))}
                </tbody>
              </Box>
              {plan.rows.length > MAX_PREVIEW_ROWS && (
                <Typography sx={{ fontSize: 10, color: 'text.disabled', p: 0.5 }}>
                  +{plan.rows.length - MAX_PREVIEW_ROWS} more rows
                </Typography>
              )}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>{done ? 'Close' : 'Cancel'}</Button>
        <Button
          variant="contained" onClick={() => void apply()}
          disabled={busy || !plan || writes === 0 || !planCurrent || !!plan.limitError}
          sx={{ textTransform: 'none' }} data-testid="address-table-apply"
        >
          {`Import ${writes} row${writes === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

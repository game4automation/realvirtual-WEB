// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Typography } from '@mui/material';
import { Upload } from '@mui/icons-material';
import { buildUdpSignalsFromSewRows, detectFormat, parseSewSymbolTable } from '../import/sew-symbol-table';
import { holdConnectConfigEditing, importSewUdpSymbolTable, type ConnectInterface } from './connect-store';
import { InspectorRow } from './rv-inspector-row';
import { DetailsDisclosure } from './rv-inspector-blocks';
import { ERROR, FS, INK_MID, WARN } from './shared-sx';

type Preview = ReturnType<typeof buildUdpSignalsFromSewRows>;

/** Browser-side SEW CSV import; a null target creates a disabled SEW-UDP interface. */
export function SewUdpImportDialog({ open, interfaces, targetInterfaceId, onClose }: {
  open: boolean;
  interfaces: ConnectInterface[];
  targetInterfaceId: string | null;
  onClose: () => void;
}) {
  const existing = interfaces.find(i => i.id === targetInterfaceId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fileName, setFileName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [allowWrites, setAllowWrites] = useState(true);
  const [reading, setReading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);

  useEffect(() => {
    if (open) return holdConnectConfigEditing();
  }, [open]);

  useEffect(() => {
    setPreview(null);
    setFileName('');
    setConfirmed(false);
    setAllowWrites(true);
    setError(null);
    setImported(false);
    setReading(false);
    return () => { readVersion.current++; };
  }, [open, targetInterfaceId]);

  useEffect(() => { setConfirmed(false); }, [existing?.signals]);

  const processFile = async (file: File, version = ++readVersion.current) => {
    if (version !== readVersion.current) return;
    setReading(true);
    setPreview(null);
    setConfirmed(false);
    setFileName(file.name);
    setError(null);
    try {
      const text = await file.text();
      if (version !== readVersion.current) return;
      if (detectFormat(text) !== 'sew') throw new Error('not a SEW symbol table (Name;Type;Direction)');
      const parsed = parseSewSymbolTable(text);
      const built = buildUdpSignalsFromSewRows(parsed);
      // Reserved rows appear in both parser errors and builder skips. Show each once.
      const skippedLines = new Set(built.skipped.map(row => row.line));
      const skipped = [
        ...built.skipped,
        ...parsed.errors.filter(row => !skippedLines.has(row.line)).map(row => ({ ...row, name: '' })),
      ].sort((a, b) => a.line - b.line);
      setPreview({ signals: built.signals, skipped });
    } catch (err) {
      if (version === readVersion.current) setError(err instanceof Error ? err.message : 'Could not read the CSV file.');
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  };

  const pickFile = async () => {
    if (!window.showOpenFilePicker) { inputRef.current?.click(); return; }
    // The picker and getFile() belong to the dialog generation that opened them.
    const version = ++readVersion.current;
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'SEW symbol table', accept: { 'text/csv': ['.csv'] } }],
        multiple: false,
      });
      if (version !== readVersion.current || !handle) return;
      const file = await handle.getFile();
      if (version !== readVersion.current) return;
      await processFile(file, version);
    } catch (err) {
      if (version !== readVersion.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Could not open the CSV file.');
    }
  };

  const existingCount = existing?.signals.length ?? 0;
  const targetValid = targetInterfaceId === null || existing?.type === 'Udp';
  const canImport = !!preview?.signals.length && targetValid && !reading && !pushing && !imported
    && (existingCount === 0 || confirmed);
  const sent = preview?.signals.filter(signal => signal.type.startsWith('PLCInput')).length ?? 0;
  const received = (preview?.signals.length ?? 0) - sent;
  const writesAllowed = targetInterfaceId === null ? allowWrites : existing?.allowWebToPlc === true;

  const handleImport = async () => {
    if (!canImport || !preview) return;
    setPushing(true);
    setError(null);
    try {
      await importSewUdpSymbolTable({ signals: preview.signals, targetInterfaceId, allowWebToPlc: writesAllowed });
      if (targetInterfaceId === null || existing?.enabled === false) setImported(true);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import to CONNECT failed.');
    } finally {
      setPushing(false);
    }
  };

  return (
    <Dialog open={open} onClose={pushing ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="sew-udp-import-title">
      <DialogTitle id="sew-udp-import-title" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: FS.title }}>
        <Upload sx={{ color: 'primary.main' }} />
        Import SEW symbol table — {targetInterfaceId ?? 'New SEW-UDP interface'}
      </DialogTitle>
      <DialogContent>
        {imported ? (
          <InspectorRow label="">
            <Typography role="status" sx={{ fontSize: FS.body, color: INK_MID }}>
              Import complete. The interface starts disabled. Enable it from its card to start exchanging signals.
            </Typography>
          </InspectorRow>
        ) : (
          <>
            <InspectorRow label="File" fullWidthField>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                <Button size="small" variant="outlined" onClick={() => void pickFile()} disabled={reading || pushing} sx={{ fontSize: FS.label, textTransform: 'none' }}>
                  Choose file…
                </Button>
                <Typography sx={{ fontSize: FS.body, color: INK_MID, overflowWrap: 'anywhere' }}>{fileName}</Typography>
              </Box>
              <input ref={inputRef} type="file" accept=".csv,text/csv" hidden aria-label="SEW symbol table CSV" onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void processFile(file);
              }} />
            </InspectorRow>
            {preview && (
              <>
                <InspectorRow label="Preview">
                  <Typography sx={{ fontSize: FS.body, color: INK_MID }}>
                    {preview.signals.length} signals ({sent} sent, {received} received) · {preview.skipped.length} skipped
                  </Typography>
                </InspectorRow>
                {preview.skipped.length > 0 && (
                  <DetailsDisclosure title="Skipped rows" summary={`${preview.skipped.length} skipped`} defaultOpen>
                    {preview.skipped.map(row => (
                      <InspectorRow key={row.line} label={`Line ${row.line}`}>
                        <Typography sx={{ fontSize: FS.body, color: INK_MID, overflowWrap: 'anywhere' }}>
                          {row.name ? `"${row.name}" — ` : ''}{row.reason}
                        </Typography>
                      </InspectorRow>
                    ))}
                  </DetailsDisclosure>
                )}
                {preview.signals.length > 0 && (sent === 0 || received === 0) && (
                  <InspectorRow label="">
                    <Typography sx={{ fontSize: FS.body, color: INK_MID }}>
                      {sent === 0 ? 'Receive-only table — nothing is sent.' : 'Send-only table — nothing is received.'}
                    </Typography>
                  </InspectorRow>
                )}
              </>
            )}
            {existingCount > 0 && (
              <InspectorRow label="">
                <FormControlLabel sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: FS.body, color: WARN } }} control={
                  <Checkbox size="small" checked={confirmed} disabled={pushing || reading} onChange={event => setConfirmed(event.target.checked)} />
                } label={`This import replaces ${existingCount} existing signals on this interface. I confirm replacement.`} />
              </InspectorRow>
            )}
            {targetInterfaceId === null && (
              <InspectorRow label="">
                <FormControlLabel sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: FS.body } }} control={
                  <Checkbox size="small" checked={allowWrites} disabled={pushing} onChange={event => setAllowWrites(event.target.checked)} />
                } label="Allow writing to the partner" />
              </InspectorRow>
            )}
            {!writesAllowed && (
              <InspectorRow label="">
                <Typography sx={{ fontSize: FS.body, color: WARN }}>Writing to the partner is off — the send telegram stays zero.</Typography>
              </InspectorRow>
            )}
            {error && (
              <InspectorRow label="">
                <Typography role="alert" sx={{ fontSize: FS.body, color: ERROR, overflowWrap: 'anywhere' }}>{error}</Typography>
              </InspectorRow>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pushing} sx={{ fontSize: FS.body }}>{imported ? 'Close' : 'Cancel'}</Button>
        {!imported && <Button variant="contained" disabled={!canImport} onClick={() => void handleImport()} sx={{ fontSize: FS.body }}>{pushing ? 'Importing…' : 'Import'}</Button>}
      </DialogActions>
    </Dialog>
  );
}

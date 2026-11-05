// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { ActiveDocumentFileExport } from '../../editor/active-document-view';
import type { ApplyPreview } from '../../export/rv-export-provider';
import { DocumentApplyDialog } from './DocumentFileExportDialogs';
import { FS } from '../shared-sx';

export interface DocumentApplyFlowProps {
  exp: ActiveDocumentFileExport;
  onClose: () => void;
  onMessage: (message: string) => void;
}

/** One file-selection → preview → commit flow for the document card and USD menu. Loaded on demand. */
export function DocumentApplyFlow({ exp, onClose, onMessage }: DocumentApplyFlowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const active = useRef(true);
  const reading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const readFile = async (file: File | undefined) => {
    if (!file || !exp.apply || reading.current) return;
    reading.current = true;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!active.current) return;
      const next = await exp.apply.preview({ name: file.name, bytes });
      if (active.current) setPreview(next);
    } catch (e) {
      if (active.current) {
        onClose();
        onMessage(e instanceof Error ? e.message : String(e));
      }
    } finally {
      reading.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".usdz,.usda,.usd"
        style={{ display: 'none' }}
        data-testid="document-card-apply-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void readFile(file);
        }}
      />
      {preview ? (
        <DocumentApplyDialog exp={exp} preview={preview} onClose={onClose} onMessage={onMessage} />
      ) : (
        <Dialog open onClose={() => { if (!busy) onClose(); }} maxWidth="sm" fullWidth>
          <DialogTitle sx={{ fontSize: FS.title, fontWeight: 600 }}>Apply realvirtual data from USD</DialogTitle>
          <DialogContent>
            <Typography sx={{ fontSize: FS.body }}>
              Choose a USD file to replace this document's realvirtual data. Geometry stays unchanged. You will review matched nodes and any data that would be removed before applying.
            </Typography>
            {busy && <Typography role="status" sx={{ fontSize: FS.body, mt: 1 }}>Reading realvirtual data…</Typography>}
          </DialogContent>
          <DialogActions>
            <Button size="small" disabled={busy} onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
            <Button size="small" variant="contained" disabled={busy} onClick={() => inputRef.current?.click()} sx={{ textTransform: 'none' }}>
              Choose USD file…
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, ToggleButton, ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  exportDiagnostics, previewDiagnostics, type DiagnosticsPreview,
} from '../diagnostics/rv-diagnostics-export';
import { DIVIDER, FIELD_BG, INK_LOW, INK_MID } from './shared-sx';

const SUPPORT_ADDRESS = 'professional@realvirtual.io';
const MAIL_TEXT = 'Please find the attached realvirtual diagnostics bundle. It contains runtime logs and environment information, but no geometry.';

export interface DiagnosticsDialogProps {
  open: boolean;
  onClose: () => void;
  preview?: typeof previewDiagnostics;
  save?: typeof exportDiagnostics;
}

function line(entry: DiagnosticsPreview['first'][number]): string {
  return `${new Date(entry.t).toLocaleTimeString()} ${entry.src} ${entry.lvl} ${entry.cat} ${entry.msg}`;
}

export function DiagnosticsDialog({
  open, onClose, preview = previewDiagnostics, save = exportDiagnostics,
}: DiagnosticsDialogProps) {
  const [minutes, setMinutes] = useState(15);
  const [data, setData] = useState<DiagnosticsPreview | null>(null);
  useEffect(() => {
    let live = true;
    void preview(minutes).then(value => { if (live) setData(value); });
    return () => { live = false; };
  }, [minutes, preview]);

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ elevation: 0 }}>
      <DialogTitle sx={{ fontSize: 14 }}>Save diagnostics</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box>
          <Typography sx={{ fontSize: 11, color: INK_MID, mb: 0.5 }}>Time window (minutes)</Typography>
          <ToggleButtonGroup exclusive size="small" value={minutes} onChange={(_, value) => value && setMinutes(value)}>
            {[5, 15, 30, 60].map(value => <ToggleButton key={value} value={value}>{value}</ToggleButton>)}
          </ToggleButtonGroup>
        </Box>
        <Typography data-testid="diagnostics-counts" sx={{ fontSize: 13, fontFamily: 'monospace' }}>
          {data ? `${data.lines} lines · ${data.errors} errors · ${data.warnings} warnings` : 'Preparing preview…'}
        </Typography>
        <Typography sx={{ fontSize: 12, color: INK_MID }}>
          Sources: Browser ✓ · CONNECT {data?.sources.connect ? '✓ included' : 'not available'}
        </Typography>
        <Box sx={{ bgcolor: FIELD_BG, border: `1px solid ${DIVIDER}`, borderRadius: 1, p: 1, maxHeight: 160, overflow: 'auto' }}>
          {[...(data?.first ?? []), ...(data?.last ?? [])].map((entry, index) => (
            <Typography key={`${entry.t}-${index}`} sx={{ fontSize: 11, fontFamily: 'monospace', color: INK_MID, whiteSpace: 'pre-wrap' }}>
              {line(entry)}
            </Typography>
          ))}
        </Box>
        <Typography sx={{ fontSize: 11, color: INK_LOW }}>Contains node and signal names, no geometry.</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: 12, color: INK_MID }}>To: {SUPPORT_ADDRESS}</Typography>
          <Button size="small" onClick={() => copy(SUPPORT_ADDRESS)}>Copy</Button>
        </Box>
        <Button size="small" onClick={() => copy(MAIL_TEXT)} sx={{ alignSelf: 'flex-start' }}>Copy mail text</Button>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => { void save({ minutes }); }}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

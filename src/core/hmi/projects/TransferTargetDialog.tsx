// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TransferTargetDialog — "Copy to…" / "Move to…" (plan-413 §3.1, phase 5).
 *
 * ## Only writable targets are listed, and an empty list says why
 *
 * The verb is offered on documents the project can give away; the *targets* are
 * the projects that can take one. A read-only project has no place in the list,
 * so it is not shown greyed out — a disabled row invites a click that can never
 * work. When nothing is writable the dialog says what to do instead of showing
 * an empty box (§3.6: telling the user the way forward beats disabling).
 *
 * ## Drag and drop is deliberately not here
 *
 * §3.3 draws the scope line: the verbs live in the context menu and the detail
 * pane. Dragging a card between two panels of two different projects is a
 * separate interaction with its own drop-target and cancel semantics, and this
 * plan does not build it.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Radio,
} from '@mui/material';
import { useState } from 'react';

/** One project a document can be sent to. */
export interface TransferTargetOption {
  /** Stable key — the project id. */
  id: string;
  label: string;
  /** Secondary line: folder name, backend kind, whatever identifies it. */
  hint?: string;
}

export interface TransferRequest {
  mode: 'copy' | 'move';
  /** What is being transferred, for the title. */
  documentName: string;
  /** Opaque handle the host uses to find the document again on confirm. */
  documentPath: string;
}

export interface TransferTargetDialogProps {
  request: TransferRequest | null;
  targets: TransferTargetOption[];
  onClose: () => void;
  onConfirm: (request: TransferRequest, targetId: string) => void;
}

export function TransferTargetDialog({
  request,
  targets,
  onClose,
  onConfirm,
}: TransferTargetDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // The selection is per-opening: a target picked for the last document must
  // not be pre-armed for the next one, which could be a move.
  const chosen = selected !== null && targets.some(t => t.id === selected) ? selected : null;
  const isMove = request?.mode === 'move';

  const close = () => { setSelected(null); onClose(); };

  return (
    <Dialog open={request !== null} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        {isMove ? 'Move to…' : 'Copy to…'}
      </DialogTitle>
      <DialogContent sx={{ pt: 0 }}>
        <DialogContentText sx={{ fontSize: 12 }}>
          {targets.length === 0
            ? 'No other writable project is open. Add a workspace folder, or open a project '
              + 'folder, to have somewhere to send this to.'
            : isMove
              ? `"${request?.documentName}" moves into the target's library; the original goes `
                + 'to the source project’s trash.'
              : `"${request?.documentName}" is copied into the target's library as a new document.`}
        </DialogContentText>
        {targets.length > 0 && (
          <List dense sx={{ mt: 1 }} aria-label="Transfer targets">
            {targets.map(t => (
              <ListItemButton
                key={t.id}
                selected={chosen === t.id}
                onClick={() => setSelected(t.id)}
                data-testid={`transfer-target-${t.id}`}
                sx={{ borderRadius: 1 }}
              >
                <Radio size="small" checked={chosen === t.id} tabIndex={-1} sx={{ mr: 1, p: 0.5 }} />
                <ListItemText
                  primary={t.label}
                  secondary={t.hint}
                  slotProps={{
                    primary: { sx: { fontSize: 13 } },
                    secondary: { sx: { fontSize: 11 } },
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={close} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button
          size="small"
          variant="contained"
          disabled={chosen === null || request === null}
          data-testid="transfer-confirm"
          onClick={() => {
            if (!request || chosen === null) return;
            setSelected(null);
            onConfirm(request, chosen);
          }}
          sx={{ textTransform: 'none' }}
        >
          {isMove ? 'Move' : 'Copy'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AlarmHistoryDialog — Operator-note history for one alarm.
 *
 * Shows the seeded notes (pinned) plus any user-added notes and lets the visitor
 * append their own. On locked (kiosk) deployments the input is disabled with a
 * "not saved" hint. Notes added here feed the next "Ask AI" answer.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, TextField, Button, IconButton, Stack, Divider,
} from '@mui/material';
import { Close, PushPin, Add, History } from '@mui/icons-material';
import type { AlarmScenario, AlarmNote } from './alarm-seed-data';
import { loadNotes, addNote, notesArePersistable } from './alarm-notes-store';

/** localStorage key remembering the operator name across sessions (plan-253). */
export const OPERATOR_NAME_KEY = 'rv-operator-name';

/** Read the remembered operator name. Never throws (private mode etc.). */
export function loadOperatorName(): string {
  try {
    return localStorage.getItem(OPERATOR_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Remember the operator name for the next note. Never throws. */
export function saveOperatorName(name: string): void {
  try {
    localStorage.setItem(OPERATOR_NAME_KEY, name);
  } catch { /* storage unavailable — name simply not remembered */ }
}

export interface AlarmHistoryDialogProps {
  alarm: AlarmScenario;
  open: boolean;
  onClose: () => void;
  /** Called after a note is added so the parent can refresh its note count. */
  onNotesChanged?: () => void;
}

function NoteRow({ note }: { note: AlarmNote }) {
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <PushPin sx={{ fontSize: 16, color: note.seed ? '#ffa726' : '#4fc3f7', mt: 0.25, transform: 'rotate(40deg)' }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {note.author} · {note.dateLabel} · {note.shift}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>
          {note.text}
        </Typography>
      </Box>
    </Box>
  );
}

export function AlarmHistoryDialog({ alarm, open, onClose, onNotesChanged }: AlarmHistoryDialogProps) {
  const [notes, setNotes] = useState<AlarmNote[]>([]);
  const [draft, setDraft] = useState('');
  const [author, setAuthor] = useState(() => loadOperatorName());
  const [saving, setSaving] = useState(false);
  const persistable = notesArePersistable();

  // Load notes whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadNotes(alarm.id).then((n) => { if (!cancelled) setNotes(n); });
    return () => { cancelled = true; };
  }, [open, alarm.id]);

  const handleAdd = useCallback(async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    const authorName = author.trim() || 'You';
    saveOperatorName(author.trim());
    const note: AlarmNote = {
      author: authorName,
      dateLabel: new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
      shift: 'This shift',
      text,
      seed: false,
    };
    await addNote(alarm.id, note);
    const refreshed = await loadNotes(alarm.id);
    setNotes(refreshed);
    setDraft('');
    setSaving(false);
    onNotesChanged?.();
  }, [draft, author, saving, alarm.id, onNotesChanged]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <History sx={{ color: '#4fc3f7' }} />
        <span>History — {alarm.code} ({notes.length} {notes.length === 1 ? 'note' : 'notes'})</span>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }} aria-label="Close">
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {notes.map((n, i) => <NoteRow key={`${n.author}-${i}`} note={n} />)}
        </Stack>
        <Divider sx={{ my: 2 }} />
        <TextField
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Your name"
          size="small"
          disabled={!persistable || saving}
          sx={{ mb: 1, maxWidth: 220 }}
        />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <TextField
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={persistable ? 'Add your own note…' : 'Kiosk mode — not saved'}
            multiline
            minRows={1}
            maxRows={4}
            fullWidth
            size="small"
            disabled={!persistable || saving}
            helperText={persistable ? undefined : 'Kiosk mode — notes are not saved.'}
          />
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={handleAdd}
            disabled={!persistable || saving || draft.trim().length === 0}
            sx={{ mt: 0.25, whiteSpace: 'nowrap' }}
          >
            Add
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

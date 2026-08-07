// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneNameDialog — the one-field prompt behind Rename and Save-as
 * (plan-372 Phase 13 prerequisite).
 *
 * The Scene window carried this inline. It is lifted out so the dashboard can
 * use it before that window is deleted, and so both spell the two operations
 * the same way — a rename that says "Save as" is the kind of small wrongness
 * that makes a user distrust the rest of the screen.
 *
 * Submit is blocked on an empty name rather than silently coercing one: an
 * auto-generated "Untitled" would be indistinguishable from the user's own.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';

export interface SceneNameDialogState {
  kind: 'rename' | 'saveAs';
  /** Scene id — required for `rename`, unused for `saveAs`. */
  id?: string;
  name: string;
}

export interface SceneNameDialogProps {
  state: SceneNameDialogState | null;
  onChange: (next: SceneNameDialogState | null) => void;
  onSubmit: () => void;
}

export function SceneNameDialog({ state, onChange, onSubmit }: SceneNameDialogProps) {
  const isRename = state?.kind === 'rename';
  const canSubmit = (state?.name.trim().length ?? 0) > 0;

  return (
    <Dialog open={state !== null} onClose={() => onChange(null)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        {isRename ? 'Rename scene' : 'Save scene as'}
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Scene name"
          value={state?.name ?? ''}
          onChange={(e) => onChange(state ? { ...state, name: e.target.value } : state)}
          // Enter is the expected way out of a single-field dialog.
          onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) onSubmit(); }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={() => onChange(null)} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!canSubmit}
          onClick={onSubmit}
          data-testid="scene-name-confirm"
          sx={{ textTransform: 'none' }}
        >
          {isRename ? 'Rename' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

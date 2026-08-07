// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetPromptDialog — the single-field prompt behind "Rename" and
 * "Collections…" for a library asset (plan-372 Phase 9).
 *
 * Kept separate from {@link SceneNameDialog} even though both are one text
 * field: the two operate on different objects with different validity rules,
 * and a shared "generic text dialog" would immediately need a flag for every
 * difference. This one accepts an empty value for `collections` — clearing an
 * asset's collections is a legitimate thing to want — but not for a rename,
 * where an empty name has no meaning.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material';

export interface AssetPromptState {
  kind: 'renameAsset' | 'collections';
  /** Asset path relative to `library/`. */
  relPath: string;
  value: string;
}

export interface AssetPromptDialogProps {
  state: AssetPromptState | null;
  onChange: (next: AssetPromptState | null) => void;
  onSubmit: () => void;
}

export function AssetPromptDialog({ state, onChange, onSubmit }: AssetPromptDialogProps) {
  const isRename = state?.kind === 'renameAsset';
  // Clearing collections is meaningful; clearing a file name is not.
  const canSubmit = !isRename || (state?.value.trim().length ?? 0) > 0;

  return (
    <Dialog open={state !== null} onClose={() => onChange(null)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        {isRename ? 'Rename asset' : 'Collections'}
      </DialogTitle>
      <DialogContent>
        {!isRename && (
          <DialogContentText sx={{ fontSize: 12 }}>
            Comma-separated. Leave empty to remove this asset from all collections.
          </DialogContentText>
        )}
        <TextField
          autoFocus
          fullWidth
          size="small"
          label={isRename ? 'File name' : 'Collections'}
          value={state?.value ?? ''}
          onChange={(e) => onChange(state ? { ...state, value: e.target.value } : state)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) onSubmit(); }}
          sx={{ mt: isRename ? 1 : 2 }}
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
          data-testid="asset-prompt-confirm"
          sx={{ textTransform: 'none' }}
        >
          {isRename ? 'Rename' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

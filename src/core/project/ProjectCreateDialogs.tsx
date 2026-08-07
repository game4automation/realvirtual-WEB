// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectCreateDialogs — the two project-creation dialogs, lifted out of
 * `rv-project-switcher.tsx` (plan-372 §3.3, Phase 8).
 *
 * They are extracted *before* the switcher is deleted in Phase 13 and reused
 * **unchanged** in behaviour and copy, including the `data-testid` hooks the
 * existing tests drive. The extraction is deliberately a move, not a rewrite:
 * the wording of both dialogs was chosen carefully (a folder without a
 * manifest is a question, never an error; "from current scenes" states plainly
 * that nothing is removed) and rewording it here would quietly change what the
 * user is agreeing to.
 *
 * Both are controlled: the caller owns the request object and the confirm
 * handler, so the same dialogs serve the old switcher and the new dashboard
 * without either owning the other's state.
 */

import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

/** Pending "this folder has no project.json — create one?" request. */
export interface CreateHereRequest {
  dir: { name: string };
  name: string;
}

/** Pending "new project from the scenes already cached" request. */
export interface FromScenesRequest {
  name: string;
  selected: string[];
  error?: string | null | undefined;
}

/**
 * Generic over the caller's own request type. The switcher carries a real
 * `FileSystemDirectoryHandle` on `dir` while the dialog only ever reads
 * `dir.name`; widening here lets both callers keep their own richer type
 * instead of casting at every call site.
 */
export interface CreateHereDialogProps<T extends CreateHereRequest> {
  request: T | null;
  onChange: (next: T | null) => void;
  onConfirm: () => void;
}

/**
 * Offered when the user picks a folder that carries no manifest.
 *
 * The copy promises that existing folder contents are left untouched — that
 * promise is why this is a question rather than a silent write.
 */
export function CreateHereDialog<T extends CreateHereRequest>(
  { request, onChange, onConfirm }: CreateHereDialogProps<T>,
) {
  return (
    <Dialog open={request !== null} onClose={() => onChange(null)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>Create a project here?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          <b>"{request?.dir.name}"</b> has no <code>project.json</code>. A new project can be
          created in it — anything already in the folder is left untouched.
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Project name"
          value={request?.name ?? ''}
          onChange={e => onChange(request ? { ...request, name: e.target.value } : request)}
          sx={{ mt: 2 }}
        />
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={() => onChange(null)} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          data-testid="project-create-here-confirm"
          onClick={onConfirm}
          sx={{ textTransform: 'none' }}
        >
          Create project
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface NewProjectDialogProps {
  open: boolean;
  name: string;
  onChange: (next: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * The plain "new project" prompt: one name, one empty project.
 *
 * Deliberately asks nothing else. The folder is created inside the open
 * workspace under the slug of this name, so there is no picker to answer, and
 * an empty project is the whole point — scenes are added afterwards from the
 * project screen. Migrating existing cached scenes stays the separate,
 * explicitly-worded {@link FromScenesDialog}.
 */
export function NewProjectDialog(
  { open, name, onChange, onClose, onConfirm }: NewProjectDialogProps,
) {
  const canSubmit = name.trim().length > 0;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>New project</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          An empty project is created as a folder in your workspace.
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Project name"
          value={name}
          onChange={e => onChange(e.target.value)}
          // Enter is the expected way out of a single-field dialog.
          onKeyDown={e => { if (e.key === 'Enter' && canSubmit) onConfirm(); }}
          sx={{ mt: 2 }}
        />
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          data-testid="project-new-confirm"
          disabled={!canSubmit}
          onClick={onConfirm}
          sx={{ textTransform: 'none' }}
        >
          Create project
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface FromScenesDialogProps<T extends FromScenesRequest> {
  request: T | null;
  onChange: (next: T | null) => void;
  onConfirm: () => void;
  /** Scenes offered for selection — the browser cache's current contents. */
  scenes: { id: string; name: string }[];
}

/**
 * Copies chosen cached scenes into a folder the user picks.
 *
 * The confirm button is disabled with an empty selection: a project with no
 * scenes is not what anyone means by "from current scenes", and creating one
 * silently would leave the user staring at an empty project wondering what
 * happened.
 */
export function FromScenesDialog<T extends FromScenesRequest>(
  { request, onChange, onConfirm, scenes }: FromScenesDialogProps<T>,
) {
  return (
    <Dialog open={request !== null} onClose={() => onChange(null)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>New project from current scenes</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          The selected scenes are written into a folder you choose. They stay in the browser as
          well — nothing is removed here.
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Project name"
          value={request?.name ?? ''}
          onChange={e => onChange(request ? { ...request, name: e.target.value } : request)}
          sx={{ mt: 2, mb: 1 }}
        />
        <Stack sx={{ maxHeight: 240, overflow: 'auto' }}>
          {scenes.map(m => (
            <FormControlLabel
              key={m.id}
              control={
                <Checkbox
                  size="small"
                  data-testid={`project-scene-pick-${m.id}`}
                  checked={request?.selected.includes(m.id) ?? false}
                  onChange={e => {
                    if (!request) return;
                    const selected = e.target.checked
                      ? [...request.selected, m.id]
                      : request.selected.filter(id => id !== m.id);
                    onChange({ ...request, selected });
                  }}
                />
              }
              label={<Typography sx={{ fontSize: 12 }}>{m.name}</Typography>}
            />
          ))}
        </Stack>
        {request?.error && (
          <Alert severity="warning" sx={{ mt: 1, fontSize: 12 }}>{request.error}</Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={() => onChange(null)} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          data-testid="project-from-scenes-confirm"
          disabled={(request?.selected.length ?? 0) === 0}
          onClick={onConfirm}
          sx={{ textTransform: 'none' }}
        >
          Choose folder…
        </Button>
      </DialogActions>
    </Dialog>
  );
}

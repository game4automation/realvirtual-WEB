// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * NewProjectDialog — name a project and say where it goes (plan-743 F4).
 *
 * ## Two fields, because a project needs two facts
 *
 * The dialog it replaces asked only for a name and put the folder "in your
 * workspace". With the workspace gone there is no implied location, so the
 * location is asked for — once. The picked PARENT is remembered under
 * `HANDLE_KEY_NEW_PROJECT_PARENT`, so the second project costs one field again.
 *
 * ## The folder name is shown before it is created
 *
 * `canonicalNameOf` slugifies aggressively — it collapses every non-ASCII name
 * to `project` — and a user who types "Anlage Köln" and gets a folder called
 * `anlage-k-ln` deserves to have seen that first. It is rendered live under the
 * name field, and it is the same string the existence check and the creation
 * use, so what is previewed is what appears on disk.
 *
 * ## "Folder exists" blocks, it does not warn
 *
 * `createProjectFromScenes` refuses a folder that already holds a manifest, but
 * a folder that exists WITHOUT one would be silently adopted and filled. The
 * inline check turns both into the same answer before Enter is armed.
 *
 * Structure follows `SceneNameDialog`: Enter submits when the form is complete,
 * Escape closes, and nothing else is bound.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography,
} from '@mui/material';
import { FolderOpen } from '@mui/icons-material';
import {
  HANDLE_KEY_NEW_PROJECT_PARENT,
  getFolderHandle,
  selectFolderForKey,
} from '../../engine/rv-local-filesystem';
import { canonicalNameOf } from '../../project/rv-project-types';

/** Picker id — its own slot, so the OS remembers this location separately. */
const PICKER_ID = 'rv-new-project-parent';

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  /** Create `<parent>/<canonical>` and open it. The host owns the writes. */
  onCreate: (parent: FileSystemDirectoryHandle, name: string) => void;
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  // Deliberately empty rather than "New Project": a pre-filled name is a name
  // the user has to delete before typing their own, and it is the one field
  // that decides what the folder is called.
  const [name, setName] = useState('');
  const [parent, setParent] = useState<FileSystemDirectoryHandle | null>(null);
  const [exists, setExists] = useState(false);
  const [checking, setChecking] = useState(false);

  const canonical = canonicalNameOf(name);
  const hasName = name.trim().length > 0;

  // The remembered parent, restored without a prompt: the grant may well still
  // be alive, and asking for it before the user has typed anything would spend
  // a dialog on a project they may not create.
  useEffect(() => {
    if (!open) return;
    setName('');
    setExists(false);
    let alive = true;
    void getFolderHandle(HANDLE_KEY_NEW_PROJECT_PARENT, { prompt: false })
      .then(dir => { if (alive) setParent(dir); })
      .catch(() => { if (alive) setParent(null); });
    return () => { alive = false; };
  }, [open]);

  // Existence is re-checked on every keystroke against the CANONICAL name,
  // because that — not what was typed — is what would collide on disk.
  useEffect(() => {
    if (!open || !parent || !hasName) { setExists(false); return; }
    let alive = true;
    setChecking(true);
    void parent.getDirectoryHandle(canonical)
      .then(() => { if (alive) setExists(true); })
      .catch(() => { if (alive) setExists(false); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [open, parent, canonical, hasName]);

  const pickLocation = useCallback(() => {
    void selectFolderForKey(HANDLE_KEY_NEW_PROJECT_PARENT, PICKER_ID)
      .then(dir => { if (dir) setParent(dir); });
  }, []);

  const canSubmit = hasName && parent !== null && !exists && !checking;

  const submit = useCallback(() => {
    if (!canSubmit || !parent) return;
    onCreate(parent, name.trim());
  }, [canSubmit, parent, name, onCreate]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>New project</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Name"
          value={name}
          inputProps={{ 'data-testid': 'new-project-name' }}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit(); }}
          sx={{ mt: 1 }}
        />
        {hasName && (
          <Typography
            data-testid="new-project-canonical"
            sx={{ fontSize: 11, color: 'text.disabled', fontFamily: 'monospace', mt: 0.75 }}
          >
            folder: {canonical}
          </Typography>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
          <Button
            size="small"
            startIcon={<FolderOpen sx={{ fontSize: 16 }} />}
            onClick={pickLocation}
            data-testid="new-project-location"
            sx={{ textTransform: 'none' }}
          >
            Location
          </Button>
          <Typography
            sx={{
              fontSize: 11, fontFamily: 'monospace', minWidth: 0,
              color: parent ? 'text.secondary' : 'text.disabled',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {parent?.name ?? 'Choose a folder to create the project in'}
          </Typography>
        </Box>

        {exists && (
          <Typography
            data-testid="new-project-exists"
            sx={{ fontSize: 11, color: 'warning.main', mt: 1.25 }}
          >
            Folder exists — pick another name or another location.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          data-testid="new-project-create"
          disabled={!canSubmit}
          onClick={submit}
          sx={{ textTransform: 'none' }}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

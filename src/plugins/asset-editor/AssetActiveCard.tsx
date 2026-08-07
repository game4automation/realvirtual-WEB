// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetActiveCard — top-of-hierarchy card for the asset document in editor
 * mode (registered via the hierarchy-header registry). Shows the asset name
 * (or "Untitled") with a dirty dot, Save button, undo/redo, and an overflow
 * menu (Save as…, Download .glb, Discard changes). Modeled on SceneActiveCard.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Delete,
  DriveFileRenameOutline,
  FileDownload,
  MoreVert,
  Redo,
  SaveAlt,
  Undo,
} from '@mui/icons-material';
import {
  getActiveAssetContext,
  subscribeActiveAsset,
  getActiveAssetVersion,
} from './active-asset-store';
import { runSaveFlow } from './save-flow';
import { downloadAssetGlb } from '../../core/editor/rv-asset-library-save';
import { clearAssetDraft } from '../../core/editor/rv-asset-draft-storage';
import { askAssetName } from './editor-dialog-store';

export function AssetActiveCard() {
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const ctx = getActiveAssetContext();
  // Re-render on document changes (dirty / undo / redo / name).
  const docSnap = useSyncExternalStore(
    ctx?.doc.subscribe ?? (() => () => {}),
    ctx?.doc.getSnapshot ?? (() => null),
  );

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  if (!ctx || !docSnap) return null;
  const { doc } = ctx;

  const onSave = () => { void runSaveFlow(ctx); };
  const onSaveAs = () => { closeMenu(); void runSaveFlow(ctx, { forceNamePrompt: true }); };
  const onRename = async () => {
    closeMenu();
    const name = await askAssetName(docSnap.name === 'Untitled' ? '' : docSnap.name, 'Rename asset');
    if (name && name.trim()) doc.renameDocument(name.trim());
  };
  const onDownload = () => { closeMenu(); void downloadAssetGlb(ctx.viewer, doc, docSnap.name); };
  const onDiscard = async () => {
    closeMenu();
    // Drop all edits: undo everything, clear the draft. The document stays
    // open (empty/base state) — matching "Discard changes", not "Close".
    while (doc.getSnapshot().canUndo) await doc.undo();
    await clearAssetDraft();
  };

  return (
    <Box
      sx={{
        px: 1.25, py: 0.75,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        bgcolor: 'rgba(255,255,255,0.03)',
        flexShrink: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 600, fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={docSnap.name}
          >
            {docSnap.name}
            {docSnap.dirty && (
              <Box
                component="span"
                sx={{
                  display: 'inline-block', ml: 0.75, width: 7, height: 7,
                  borderRadius: '50%', bgcolor: 'warning.main', verticalAlign: 'middle',
                }}
                title="Unsaved changes"
              />
            )}
          </Typography>
          <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
            Asset · Custom library
          </Typography>
        </Box>

        <Tooltip title={docSnap.undoLabel ? `Undo: ${docSnap.undoLabel}` : 'Undo'}>
          <span>
            <IconButton size="small" disabled={!docSnap.canUndo} onClick={() => void doc.undo()}>
              <Undo sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={docSnap.redoLabel ? `Redo: ${docSnap.redoLabel}` : 'Redo'}>
          <span>
            <IconButton size="small" disabled={!docSnap.canRedo} onClick={() => void doc.redo()}>
              <Redo sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>

        <Button
          size="small"
          variant="contained"
          startIcon={<SaveAlt sx={{ fontSize: 14 }} />}
          disabled={docSnap.busy || !docSnap.dirty}
          onClick={onSave}
          sx={{ fontSize: '0.7rem', px: 1, py: 0.25, minWidth: 0 }}
        >
          Save
        </Button>

        <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <MoreVert sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={closeMenu}>
        <MenuItem onClick={onSaveAs}>
          <ListItemIcon><SaveAlt fontSize="small" /></ListItemIcon>
          <ListItemText>Save as…</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => void onRename()}>
          <ListItemIcon><DriveFileRenameOutline fontSize="small" /></ListItemIcon>
          <ListItemText>Rename…</ListItemText>
        </MenuItem>
        <MenuItem onClick={onDownload}>
          <ListItemIcon><FileDownload fontSize="small" /></ListItemIcon>
          <ListItemText>Download .glb</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => void onDiscard()} disabled={!docSnap.dirty}>
          <ListItemIcon><Delete fontSize="small" /></ListItemIcon>
          <ListItemText>Discard changes</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}

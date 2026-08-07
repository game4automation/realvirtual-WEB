// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetEditorDialogs — renders the imperative editor dialogs (unsaved-changes
 * Save/Discard/Cancel, asset-name prompt, save-fallback). Mounted in the
 * 'overlay' UI slot while the editor mode is active; the promise plumbing
 * lives in editor-dialog-store.
 */

import { useState, useSyncExternalStore, useEffect } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material';
import {
  getPendingDialog,
  subscribeEditorDialogs,
  getEditorDialogsVersion,
} from './editor-dialog-store';

const FALLBACK_TEXT: Record<string, string> = {
  unsupported:
    'This browser cannot write to a folder project (no File System Access API). ' +
    'You can download the asset as a .glb file instead.',
  // plan-372 §2.9: the save target is the active project, not a work folder.
  // The concrete reason (no project open / bundled / read-only) is supplied by
  // the call site; this is the fallback when none was given.
  'no-writable-project':
    'There is no project that can be written to. Open or create your own project to save assets ' +
    'into its Custom library, or download the asset as a .glb file.',
  'write-denied':
    'Write permission for the project folder was not granted. Grant it when prompted, or download ' +
    'the asset as a .glb file instead.',
  error: 'Saving failed.',
};

/** From this many parts on, the split gets an explicit render-cost warning.
 *  Editor mode does not bake, so every part stays its own draw call. */
const DRAW_CALL_CAUTION = 200;

export function AssetEditorDialogs() {
  useSyncExternalStore(subscribeEditorDialogs, getEditorDialogsVersion);
  const pending = getPendingDialog();

  const [nameValue, setNameValue] = useState('');
  useEffect(() => {
    if (pending?.kind === 'name') setNameValue(pending.initial);
  }, [pending]);

  if (!pending) return null;

  if (pending.kind === 'unsaved') {
    return (
      <Dialog open onClose={() => pending.resolve('cancel')} maxWidth="xs" fullWidth>
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            “{pending.assetName}” has unsaved changes. Save it to the Custom library before leaving the editor?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => pending.resolve('cancel')}>Cancel</Button>
          <Button color="warning" onClick={() => pending.resolve('discard')}>Discard</Button>
          <Button variant="contained" onClick={() => pending.resolve('save')}>Save</Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'name') {
    const submit = () => { if (nameValue.trim()) pending.resolve(nameValue.trim()); };
    return (
      <Dialog open onClose={() => pending.resolve(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{pending.title}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            margin="dense"
            label="Asset name"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => pending.resolve(null)}>Cancel</Button>
          <Button variant="contained" disabled={!nameValue.trim()} onClick={submit}>OK</Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'reimport-report') {
    const { report } = pending;
    return (
      <Dialog open onClose={() => pending.resolve()} maxWidth="sm" fullWidth>
        <DialogTitle>CAD re-import — {report.fileName}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            Components preserved on {report.matched} matched node{report.matched !== 1 ? 's' : ''}.
            {report.newUnmapped.length > 0 && (
              <> {report.newUnmapped.length} new node{report.newUnmapped.length !== 1 ? 's' : ''} had no prior counterpart.</>
            )}
            {report.unmatched.length > 0 && (
              <>
                <strong style={{ display: 'block', marginTop: 12 }}>
                  ⚠ {report.unmatched.length} node{report.unmatched.length !== 1 ? 's' : ''} with components
                  no longer exist in the new CAD revision:
                </strong>
                <ul style={{ margin: '8px 0', paddingLeft: 20, maxHeight: 180, overflow: 'auto' }}>
                  {report.unmatched.map((u) => (
                    <li key={u.relPath} style={{ fontSize: 13 }}>
                      <code>{u.relPath}</code> — {Object.keys(u.components).join(', ')}
                    </li>
                  ))}
                </ul>
                These components were NOT carried over. Undo restores the previous geometry
                with everything intact.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          {report.unmatched.length > 0 && (
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(JSON.stringify(report.unmatched, null, 2));
              }}
            >
              Copy as JSON
            </Button>
          )}
          <Button variant="contained" onClick={() => pending.resolve()}>OK</Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'separate-preview') {
    const { nodeName, mode, status, partCount, reason } = pending;
    const busy = status === 'busy';
    const modeLabel = mode === 'groups' ? 'by material group' : 'into parts';
    return (
      <Dialog
        open
        // Escape / backdrop must behave like Cancel in every state, including
        // while the analysis is still running.
        onClose={() => pending.resolve(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Separate mesh</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {busy && <>Analyzing “{nodeName}” {modeLabel}…</>}
            {status === 'ready' && (
              <>
                “{nodeName}” splits {modeLabel} into <strong>{partCount}</strong> parts.
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                  This creates {partCount} meshes, i.e. {partCount} draw calls.
                  {partCount >= DRAW_CALL_CAUTION && ' That is a lot — expect a noticeable render cost.'}
                </div>
              </>
            )}
            {status === 'ineligible' && <>“{nodeName}” cannot be separated: {reason}.</>}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          {status === 'ineligible' ? (
            <Button variant="contained" onClick={() => pending.resolve(false)}>Close</Button>
          ) : (
            <>
              <Button onClick={() => pending.resolve(false)}>Cancel</Button>
              <Button variant="contained" disabled={busy} onClick={() => pending.resolve(true)}>
                Separate
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'merge-preview') {
    const { nodeName, status, sourceCount, outputCount, keptCount, keptSummary, reason } = pending;
    const busy = status === 'busy';
    return (
      <Dialog
        open
        // Escape / backdrop behaves like Cancel in every state, the busy one included.
        onClose={() => pending.resolve(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Merge mesh</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {busy && <>Analyzing “{nodeName}”…</>}
            {status === 'ready' && (
              <>
                “{nodeName}”: <strong>{sourceCount}</strong> part{sourceCount === 1 ? '' : 's'} →{' '}
                <strong>{outputCount}</strong> mesh{outputCount === 1 ? '' : 'es'}.
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                  {keptCount > 0
                    ? <>{keptCount} node{keptCount === 1 ? '' : 's'} kept ({keptSummary}).</>
                    : <>No nodes need to be kept.</>}
                </div>
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                  One mesh per material and Group. Picking and culling become coarser —
                  Separate is the inverse operation.
                </div>
              </>
            )}
            {status === 'ineligible' && <>“{nodeName}” cannot be merged: {reason}.</>}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          {status === 'ineligible' ? (
            <Button variant="contained" onClick={() => pending.resolve(false)}>Close</Button>
          ) : (
            <>
              <Button onClick={() => pending.resolve(false)}>Cancel</Button>
              <Button variant="contained" disabled={busy} onClick={() => pending.resolve(true)}>
                Merge
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'merge-unapplied') {
    const { reasons } = pending;
    return (
      <Dialog open onClose={() => pending.resolve()} maxWidth="sm" fullWidth>
        <DialogTitle>A recorded merge could not be reproduced</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {reasons.length === 1 ? 'One merge' : `${reasons.length} merges`} in this draft
            could not be applied to the restored tree:
            <ul style={{ margin: '8px 0', paddingLeft: 20, maxHeight: 180, overflow: 'auto' }}>
              {reasons.map((r) => <li key={r} style={{ fontSize: 13 }}>{r}</li>)}
            </ul>
            The affected subtrees are still unmerged. Re-run the merge, or undo back past it.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => pending.resolve()}>OK</Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'cad-missing') {
    const { fileNames } = pending;
    const n = fileNames.length;
    return (
      <Dialog open onClose={() => pending.resolve()} maxWidth="xs" fullWidth>
        <DialogTitle>CAD geometry could not be restored</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {n === 1 ? 'This file was' : `These ${n} files were`} imported into this asset, but the
            cached geometry is no longer available:
            <ul style={{ margin: '8px 0', paddingLeft: 20, maxHeight: 180, overflow: 'auto' }}>
              {fileNames.map((f) => <li key={f} style={{ fontSize: 13 }}><code>{f}</code></li>)}
            </ul>
            Re-import {n === 1 ? 'it' : 'them'} to restore the geometry. Configuring a local work
            folder (Settings → Local Folder) keeps CAD imports across reloads.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => pending.resolve()}>OK</Button>
        </DialogActions>
      </Dialog>
    );
  }

  // save-fallback
  return (
    <Dialog open onClose={() => pending.resolve('cancel')} maxWidth="xs" fullWidth>
      <DialogTitle>Cannot save to Custom library</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {FALLBACK_TEXT[pending.reason]}
          {pending.message ? ` (${pending.message})` : ''}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => pending.resolve('cancel')}>Cancel</Button>
        <Button variant="contained" onClick={() => pending.resolve('download')}>Download .glb</Button>
      </DialogActions>
    </Dialog>
  );
}

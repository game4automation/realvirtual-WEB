// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AddLibraryDialog — subscribe to a library (plan-372 Phase 8).
 *
 * Lifted out of the Layout Planner panel so the Projects dashboard can offer
 * the same four routes without the planner plugin being loaded. It talks to the
 * **core** `LibraryStore` singleton rather than the planner's store, which is
 * exactly what makes it usable from both surfaces — the planner delegates to
 * that same store since Phase 4, so the two can never disagree about which
 * libraries exist.
 *
 * ## The Asset Manager tab is injected, not imported
 *
 * Unity Asset Manager support is a private, commercial extension. A public
 * build must not import it, so the caller passes a connect callback and the tab
 * simply does not appear when nobody supplies one. That is the same
 * escape-hatch shape the planner extension already uses, minus the React
 * component hand-off.
 *
 * ## Where an added library LANDS is the caller's choice
 *
 * By default the dialog subscribes globally with origin `'user'` — everything
 * typed here was typed by a human, which is the one origin §2.6.3 persists
 * globally. Config and URL-param subscriptions arrive through other paths and
 * must not be recorded as if the user had asked for them.
 *
 * The Projects dashboard passes `onAttach` and lands the library in the OPEN
 * PROJECT instead: into `project.json.libraries[]`, so it travels with the
 * project to whoever opens it next rather than living in one browser's
 * localStorage. Nothing about the dialog changes but the destination, which is
 * why this is one prop and not a second component.
 */

import { useCallback, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { Cloud, GitHub } from '@mui/icons-material';
import { getLibraryStore } from './library-store-singleton';

/** Credentials the private Asset-Manager extension needs to open a connection. */
export interface AssetManagerConnectRequest {
  label: string;
  projectId: string;
  keyId: string;
  secretKey: string;
}

export interface AddLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new library's URL/id once it has been added. */
  onAdded?: (idOrUrl: string) => void;
  /**
   * Where a typed URL is attached, when it is NOT the global subscription list.
   *
   * The Projects dashboard attaches to the open project instead: the URL goes
   * into `project.json.libraries[]` and travels with the project. Return an
   * error message to show (the dialog stays open), or `null` on success.
   * Without this prop the dialog subscribes globally, as before.
   */
  onAttach?: (url: string) => Promise<string | null>;
  /** Caption under the tabs — says where an added library will land. */
  attachHint?: string;
  /**
   * Supplied only when the private Asset-Manager extension is present. Its
   * absence hides the tab — a public build offers no route it cannot honour.
   */
  onConnectAssetManager?: (request: AssetManagerConnectRequest) => string | undefined;
}

type TabId = 'url' | 'github' | 'assetManager';

const CODE_SX = {
  fontFamily: 'monospace',
  px: 0.5,
  py: 0.125,
  bgcolor: 'rgba(255,255,255,0.06)',
  borderRadius: 0.5,
} as const;

export function AddLibraryDialog({
  open,
  onClose,
  onAdded,
  onAttach,
  attachHint,
  onConnectAssetManager,
}: AddLibraryDialogProps) {
  const store = getLibraryStore();

  const tabs: TabId[] = [
    'url',
    'github',
    ...(onConnectAssetManager ? (['assetManager'] as TabId[]) : []),
  ];

  const [tab, setTab] = useState<TabId>('url');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [ghUrl, setGhUrl] = useState('');
  const [amLabel, setAmLabel] = useState('');
  const [amProjId, setAmProjId] = useState('');
  const [amKeyId, setAmKeyId] = useState('');
  const [amSecret, setAmSecret] = useState('');

  // Explicit string values, not indices: the Asset-Manager and Local-Folder
  // tabs are conditional, so positional indices shift depending on the build
  // and would silently select the wrong panel.
  const active: TabId = tabs.includes(tab) ? tab : 'url';

  const finish = useCallback((idOrUrl: string) => {
    setUrl(''); setGhUrl('');
    setAmLabel(''); setAmProjId(''); setAmKeyId(''); setAmSecret('');
    setError(null);
    onClose();
    onAdded?.(idOrUrl);
  }, [onClose, onAdded]);

  /** URL and GitHub share a path: addCatalog auto-detects a repo/folder URL. */
  const addByUrl = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    // Whether the subscription already existed decides whether a failure may
    // roll it back below: re-adding a catalog that is already attached must not
    // detach it just because this attempt could not reach the network.
    const wasAttached = store.catalogUrls.includes(value);
    try {
      if (onAttach) {
        const failure = await onAttach(value);
        if (failure) { setError(failure); return; }
        finish(value);
        return;
      }
      await store.addCatalog(value, 'user');
      // `addCatalog` RESOLVES on a failed fetch — the store records the reason
      // in `catalogErrors` rather than throwing, so that one unreachable
      // catalog cannot abort a boot restore looping over many. The catch below
      // therefore never fires for the cases a user actually hits (a 404, a
      // rate-limited GitHub API, a repo without .glb files) and the dialog
      // closed as if the add had worked. Read the recorded reason instead.
      const failure = store.catalogErrors.get(value);
      if (failure) {
        // Surfaced, never swallowed: a library that silently fails to appear is
        // indistinguishable from one the user mistyped.
        setError(failure);
        // Leave no phantom root behind: a subscription that never loaded shows
        // in the tree as an empty library with nothing saying why.
        if (!wasAttached) store.removeCatalog(value);
        return;
      }
      finish(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [store, finish, onAttach]);

  const connectAssetManager = useCallback(() => {
    if (!onConnectAssetManager) return;
    const id = onConnectAssetManager({
      label: amLabel.trim() || `Asset Manager (${amProjId.trim().slice(0, 8)}…)`,
      projectId: amProjId.trim(),
      keyId: amKeyId.trim(),
      secretKey: amSecret.trim(),
    });
    finish(id ?? 'asset-manager');
  }, [onConnectAssetManager, amLabel, amProjId, amKeyId, amSecret, finish]);

  const amComplete = !!amProjId.trim() && !!amKeyId.trim() && !!amSecret.trim();

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 14, pb: 0 }}>Add Library</DialogTitle>
      <DialogContent sx={{ pt: 0 }}>
        <Tabs
          value={active}
          onChange={(_, v: TabId) => { setTab(v); setError(null); }}
          sx={{ mb: 1, minHeight: 32, '& .MuiTab-root': { minHeight: 32, textTransform: 'none', fontSize: 12 } }}
        >
          <Tab value="url" label="URL" />
          <Tab value="github" label="GitHub" icon={<GitHub sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
          {onConnectAssetManager && (
            <Tab value="assetManager" label="Asset Manager" icon={<Cloud sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
          )}
        </Tabs>

        {active === 'url' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Load a component library from a public <Box component="code" sx={CODE_SX}>catalog.json</Box> URL.
            </Typography>
            <TextField
              autoFocus
              size="small"
              fullWidth
              label="Catalog URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addByUrl(url); }}
            />
          </Box>
        )}

        {active === 'github' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Point at a GitHub repository or folder; it is scanned for <Box component="code" sx={CODE_SX}>.glb</Box> files.
              A direct <Box component="code" sx={CODE_SX}>catalog.json</Box> link works too.
            </Typography>
            <TextField
              autoFocus
              size="small"
              fullWidth
              label="GitHub URL"
              value={ghUrl}
              onChange={(e) => setGhUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addByUrl(ghUrl); }}
            />
          </Box>
        )}

        {active === 'assetManager' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
            <TextField size="small" fullWidth label="Name (optional)" placeholder="My Asset Library"
              value={amLabel} onChange={(e) => setAmLabel(e.target.value)} />
            <TextField size="small" fullWidth label="Project ID" required
              value={amProjId} onChange={(e) => setAmProjId(e.target.value)} />
            <TextField size="small" fullWidth label="Service Account Key ID" required
              value={amKeyId} onChange={(e) => setAmKeyId(e.target.value)} />
            <TextField size="small" fullWidth label="Secret Key" type="password" required
              value={amSecret} onChange={(e) => setAmSecret(e.target.value)} />
          </Box>
        )}

        {attachHint && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1.5, color: 'text.secondary' }}>
            {attachHint}
          </Typography>
        )}

        {error && (
          <Typography sx={{ mt: 1.5, fontSize: 12, color: 'error.main' }}>{error}</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        {active === 'url' && (
          <Button variant="contained" disabled={busy || !url.trim()} onClick={() => void addByUrl(url)} sx={{ textTransform: 'none' }}>
            {busy ? <CircularProgress size={16} /> : 'Add'}
          </Button>
        )}
        {active === 'github' && (
          <Button variant="contained" disabled={busy || !ghUrl.trim()} onClick={() => void addByUrl(ghUrl)} sx={{ textTransform: 'none' }}>
            {busy ? <CircularProgress size={16} /> : 'Scan & Add'}
          </Button>
        )}
        {active === 'assetManager' && (
          <Button variant="contained" disabled={busy || !amComplete} onClick={connectAssetManager} sx={{ textTransform: 'none' }}>
            Connect
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

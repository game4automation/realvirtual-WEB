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
 * ## Origin is always `'user'` here
 *
 * Everything added through this dialog was typed by a human, which is the one
 * origin §2.6.3 persists globally. Config, URL-param and project-manifest
 * subscriptions arrive through other paths and must not be recorded as if the
 * user had asked for them.
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
import { Cloud, FolderOpen, GitHub } from '@mui/icons-material';
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
   * Supplied only when the private Asset-Manager extension is present. Its
   * absence hides the tab — a public build offers no route it cannot honour.
   */
  onConnectAssetManager?: (request: AssetManagerConnectRequest) => string | undefined;
}

type TabId = 'url' | 'github' | 'assetManager' | 'localFolder';

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
  onConnectAssetManager,
}: AddLibraryDialogProps) {
  const store = getLibraryStore();
  const localFolderSupported = store.isLocalFolderSupported;

  const tabs: TabId[] = [
    'url',
    'github',
    ...(onConnectAssetManager ? (['assetManager'] as TabId[]) : []),
    ...(localFolderSupported ? (['localFolder'] as TabId[]) : []),
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
    try {
      await store.addCatalog(value, 'user');
      finish(value);
    } catch (e) {
      // Surfaced, never swallowed: a library that silently fails to appear is
      // indistinguishable from one the user mistyped.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [store, finish]);

  const addLocalFolder = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await store.addLocalFolder();
      finish('local');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [store, finish]);

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
          {localFolderSupported && (
            <Tab value="localFolder" label="Local Folder" icon={<FolderOpen sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
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

        {active === 'localFolder' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Pick a folder on this computer. Its <Box component="code" sx={CODE_SX}>library/</Box> subfolders
              become collections. The permission is remembered between sessions.
            </Typography>
          </Box>
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
        {active === 'localFolder' && (
          <Button variant="contained" disabled={busy} onClick={() => void addLocalFolder()} sx={{ textTransform: 'none' }}>
            {busy ? <CircularProgress size={16} /> : 'Choose folder…'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

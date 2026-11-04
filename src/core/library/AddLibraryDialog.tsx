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

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Cloud, GitHub, Inventory2 } from '@mui/icons-material';
import { getLibraryStore } from './library-store-singleton';
import {
  linkLibraryFolder,
  listLibraryProjectCandidates,
  readHostedLibraryProject,
  type LibraryProjectCandidate,
  type ReadLibraryProjectResult,
} from './library-project-candidates';

/**
 * plan-778 Phase 2 (F10, Decision 8): the **Projects** tab — attach another
 * PROJECT as a library of the open project, by its id. Present only when the
 * caller targets a project (the dashboard); the global subscription route has
 * no project to attach to.
 */
export interface AddLibraryProjectsOptions {
  /** The open project — never offered as its own library. */
  openProjectId: string | null;
  /** Project ids already in `libraries[]` — listed greyed. */
  attachedIds: readonly string[];
  /** Attach by id (`library.attach {projectId,label,hint}`); the reason on failure, null on success. */
  attach(ref: { projectId: string; label: string; hint?: string }): Promise<string | null>;
  /** Known projects (default: realvirtual library + linked folders + browser projects). */
  listCandidates?(): Promise<LibraryProjectCandidate[]>;
  /** From URL… (default: read the hosted `project.json`). */
  readUrl?(url: string): Promise<ReadLibraryProjectResult>;
  /** Link folder… after the pick (default: read + link the folder). */
  linkFolder?(dir: FileSystemDirectoryHandle): Promise<ReadLibraryProjectResult>;
  /**
   * The folder picker. Default: `window.showDirectoryPicker({mode:'read'})`
   * when the browser has it; null hides **Link folder…** (Stab 13).
   */
  directoryPicker?: (() => Promise<FileSystemDirectoryHandle>) | null;
}

function defaultDirectoryPicker(): (() => Promise<FileSystemDirectoryHandle>) | null {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') return null;
  return () => window.showDirectoryPicker!({ id: 'rv-library-link', mode: 'read' });
}

const LOCATION_WORD: Record<LibraryProjectCandidate['location'], string> = {
  bundled: 'built in',
  folder: 'folder',
  browser: 'browser',
  hosted: 'hosted',
};

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
  /** plan-778: the Projects tab (first, default) — present only when supplied. */
  projects?: AddLibraryProjectsOptions;
}

type TabId = 'projects' | 'url' | 'github' | 'assetManager';

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
  projects,
}: AddLibraryDialogProps) {
  const store = getLibraryStore();

  const tabs: TabId[] = [
    ...(projects ? (['projects'] as TabId[]) : []),
    'url',
    'github',
    ...(onConnectAssetManager ? (['assetManager'] as TabId[]) : []),
  ];

  const [tab, setTab] = useState<TabId>(projects ? 'projects' : 'url');
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
  const active: TabId = tabs.includes(tab) ? tab : tabs[0];

  // ── Projects tab (plan-778) ─────────────────────────────────────────────
  const [candidates, setCandidates] = useState<LibraryProjectCandidate[] | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [fromUrlOpen, setFromUrlOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState('');
  // Held in a ref (plan-778 review U7): a caller passing a fresh function per
  // render would otherwise re-run the effect on every render — and every run
  // sets state, i.e. renders again.
  const listCandidatesRef = useRef(projects?.listCandidates ?? listLibraryProjectCandidates);
  listCandidatesRef.current = projects?.listCandidates ?? listLibraryProjectCandidates;
  const hasProjects = !!projects;
  useEffect(() => {
    if (!open || !hasProjects) return;
    let alive = true;
    void listCandidatesRef.current().then(
      (rows) => { if (alive) setCandidates(rows); },
      () => { if (alive) setCandidates([]); },
    );
    return () => { alive = false; };
  }, [open, hasProjects]);
  const offered = (candidates ?? []).filter((c) => c.id !== projects?.openProjectId);
  const isAttached = (id: string): boolean => !!projects?.attachedIds.includes(id);
  const picker = projects
    ? (projects.directoryPicker === undefined ? defaultDirectoryPicker() : projects.directoryPicker)
    : null;

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

  /** Attach one project by id (Projects list, Link folder…, From URL…). */
  const attachProject = useCallback(async (ref: { projectId: string; label: string; hint?: string }) => {
    if (!projects) return;
    if (ref.projectId === projects.openProjectId) {
      setError('A project cannot be a library of itself.');
      return;
    }
    const failure = await projects.attach(ref);
    if (failure) { setError(failure); return; }
    setSelectedProject(null); setProjectUrl(''); setFromUrlOpen(false);
    finish(ref.projectId);
  }, [projects, finish]);

  const addSelectedProject = useCallback(async () => {
    const c = offered.find((x) => x.id === selectedProject);
    if (!c) return;
    setBusy(true); setError(null);
    try {
      await attachProject({ projectId: c.id, label: c.name, ...(c.hint ? { hint: c.hint } : {}) });
    } finally {
      setBusy(false);
    }
  }, [offered, selectedProject, attachProject]);

  /**
   * **Link folder…** — the picker is the FIRST statement of the click
   * (user activation); read-only, a library is never written (Decision 3).
   */
  const linkFolder = useCallback(() => {
    if (!picker || !projects) return;
    let picking: Promise<FileSystemDirectoryHandle>;
    try { picking = picker(); } catch (e) { picking = Promise.reject(e); }
    setBusy(true); setError(null);
    void picking.then(
      async (dir) => {
        const r = projects.linkFolder
          ? await projects.linkFolder(dir)
          : await linkLibraryFolder(dir, projects.openProjectId);
        if (!r.ok) { setError(r.reason); return; }
        await attachProject({ projectId: r.id, label: r.name, hint: r.hint });
      },
      (e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return;   // dismissed
        setError(e instanceof Error ? e.message : String(e));
      },
    ).finally(() => setBusy(false));
  }, [picker, projects, attachProject]);

  /** **From URL…** — read the hosted project.json for its id, attach by id with the URL as hint. */
  const addFromUrl = useCallback(async () => {
    if (!projects) return;
    const value = projectUrl.trim();
    if (!value) return;
    setBusy(true); setError(null);
    try {
      const r = await (projects.readUrl ?? readHostedLibraryProject)(value);
      if (!r.ok) { setError(r.reason); return; }
      await attachProject({ projectId: r.id, label: r.name, hint: r.hint });
    } finally {
      setBusy(false);
    }
  }, [projects, projectUrl, attachProject]);

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
          {projects && (
            <Tab value="projects" label="Projects" icon={<Inventory2 sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
          )}
          <Tab value="url" label="URL" />
          <Tab value="github" label="GitHub" icon={<GitHub sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
          {onConnectAssetManager && (
            <Tab value="assetManager" label="Asset Manager" icon={<Cloud sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
          )}
        </Tabs>

        {active === 'projects' && projects && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Use another project&apos;s documents here. The library stays read-only and is referenced by its project id.
            </Typography>
            <Box role="listbox" aria-label="Known projects" data-testid="library-project-list"
              sx={{ display: 'flex', flexDirection: 'column', maxHeight: 220, overflowY: 'auto' }}>
              {candidates === null && (
                <Typography variant="caption" sx={{ color: 'text.secondary', py: 1 }}>Loading…</Typography>
              )}
              {candidates !== null && offered.length === 0 && (
                <Typography variant="caption" sx={{ color: 'text.secondary', py: 1 }}>
                  No other project is known in this browser yet.
                </Typography>
              )}
              {offered.map((c) => {
                const attached = isAttached(c.id);
                const selected = selectedProject === c.id;
                return (
                  <Box
                    key={c.id}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={attached}
                    data-project-id={c.id}
                    onClick={() => { if (!attached) { setSelectedProject(c.id); setError(null); } }}
                    sx={{
                      display: 'flex', alignItems: 'baseline', gap: 1, px: 1, py: 0.5, borderRadius: 0.5,
                      cursor: attached ? 'default' : 'pointer',
                      opacity: attached ? 0.45 : 1,
                      bgcolor: selected ? 'action.selected' : 'transparent',
                      '&:hover': attached ? undefined : { bgcolor: 'action.hover' },
                    }}
                  >
                    <Typography sx={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </Typography>
                    <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{LOCATION_WORD[c.location]}</Typography>
                    <Typography sx={{ fontSize: 10, color: 'text.disabled', fontFamily: 'monospace' }}>{c.id}</Typography>
                    {attached && <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>(attached)</Typography>}
                  </Box>
                );
              })}
            </Box>
            <Box sx={{ display: 'flex', gap: 1 }}>
              {/* Stab 13: no picker in this browser (Firefox, Safari) → no folder action. */}
              {picker && (
                <Button size="small" variant="outlined" disabled={busy} onClick={linkFolder} sx={{ textTransform: 'none' }}>
                  Link folder…
                </Button>
              )}
              <Button size="small" variant="outlined" disabled={busy}
                onClick={() => { setFromUrlOpen((v) => !v); setError(null); }} sx={{ textTransform: 'none' }}>
                From URL…
              </Button>
            </Box>
            {fromUrlOpen && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <TextField
                  autoFocus
                  size="small"
                  fullWidth
                  label="Project URL"
                  placeholder="https://…/project.json"
                  value={projectUrl}
                  onChange={(e) => setProjectUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addFromUrl(); }}
                />
                <Button size="small" variant="contained" disabled={busy || !projectUrl.trim()}
                  onClick={() => void addFromUrl()} sx={{ textTransform: 'none', flexShrink: 0 }}>
                  Add from URL
                </Button>
              </Box>
            )}
          </Box>
        )}

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
        {active === 'projects' && (
          <Button variant="contained" disabled={busy || !selectedProject} onClick={() => void addSelectedProject()} sx={{ textTransform: 'none' }}>
            {busy ? <CircularProgress size={16} /> : 'Add'}
          </Button>
        )}
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

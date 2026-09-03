// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsDashboardHost — binds live stores to the presentational shell
 * (plan-372 Phase 7).
 *
 * The shell, the rail and the detail pane are deliberately dumb so they can be
 * tested without a viewer. This file is the one place that knows about the
 * project store, the library source registry and the scene store, which keeps
 * the store wiring reviewable in a single screenful instead of smeared across
 * three components.
 *
 * ## Everything reads through `useSyncExternalStore`
 *
 * All three stores expose a *stable* snapshot object; none of the selectors
 * below build a new object per read. That is not stylistic — a fresh identity
 * on every read is an infinite render loop under `useSyncExternalStore`, the
 * failure §2.6.4 calls out explicitly.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Box, Button, Chip, Divider, IconButton, InputAdornment, ListItemText, Menu, MenuItem, Snackbar, TextField, Tooltip, Typography } from '@mui/material';
import { SectionHeader } from '../shared-components';
import {
  Add, ChevronRight, CreateNewFolderOutlined, DeleteOutline,
  MoreVert, NoteAddOutlined, Refresh, Search, SettingsEthernet,
} from '@mui/icons-material';
import type { LibraryCatalogEntry } from '../../library/library-types';
import { debug } from '../../engine/rv-debug'; // TEMP open-perf instrumentation
import {
  getLibrarySourcesSnapshot,
  listLibrarySources,
  subscribeLibrarySources,
} from '../../library/library-source-registry';
import { getProjectStore } from '../../project/project-store';
import { projectAssetUrl } from '../../project/rv-project-asset-source';
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME } from '../../project/backends/bundled-backend';
import { readRecentProjects, forgetRecentProject } from '../../project/rv-project-recent';
import { CreateHereDialog, FromScenesDialog, NewProjectDialog, ProjectRenameDialog, type CreateHereRequest, type FromScenesRequest, type ProjectRenameRequest } from '../../project/ProjectCreateDialogs';
import { createProjectFromScenes } from '../../project/rv-project-create';
import { writeManifest } from '../../project/rv-project-storage';
import {
  canonicalNameOf,
  normaliseFolderPath,
  readProjectFolders,
  withProjectFolders,
} from '../../project/rv-project-types';
import {
  adoptWorkspace,
  getWorkspaceHandle,
  getWorkspaceMeta,
  probeOpenFolder,
  scanStoredWorkspace,
} from '../../project/rv-project-workspace';
import { detectOpenTarget, projectStartDocument, resolveResumeTarget } from '../../project/rv-project-open';
import { findStartDocument } from '../../project/rv-project-documents';
import { readRememberedSession, rememberSession } from '../../project/rv-project-resume-store';
import { pickFolderForKey, type FolderPick } from '../../engine/rv-local-filesystem';
import { exportProject, importProject, RVPROJECT_EXTENSION } from '../../project/rv-project-transport';
import type { WorkspaceProjectEntry } from '../../project/rv-project-workspace';
import { useMode } from '../../../hooks/use-mode';
import { getAppConfig } from '../rv-app-config';
import { useStartupModalRegistration } from '../startup-modal-coordinator';
import { shouldAutoOpenProjects } from './projects-auto-open';
// The blob-only create/rename/duplicate/delete verbs are deliberately NOT
// imported any more (plan-717 F1/F6/F7, F9's removal guard): every one of them
// writes bytes past the manifest row, which is the split this plan closes. What
// is left here is the collections write (a row write) and the two cross-source
// verbs (already row-based since plan-413 §2.7).
import {
  setAssetCollections,
  copyDocumentAcrossSources, moveDocumentAcrossSources,
  LIBRARY_FOLDER,
} from '../../library/library-asset-ops';
import { createDocument, duplicateDocument, retireDocument } from '../../project/rv-document-ops';
import { withTransferSession } from '../../project/rv-document-transfer';
import { FolderBackend } from '../../project/backends/folder-backend';
import { TransferTargetDialog, type TransferRequest, type TransferTargetOption } from './TransferTargetDialog';
import { PROJECT_LIBRARY_PROVIDER_ID } from '../../library/project-library-provider';
import { GLOBAL_LIBRARY_PROVIDER_ID } from '../../library/global-library-provider';
import {
  documentBase,
  getOpenDocumentBase,
  projectDocumentBase,
  sameDocumentBase,
  sceneDocumentBase,
  setOpenDocumentBase,
} from '../../editor/active-asset-store';
import { NO_PROJECT } from '../../thumbnails';
import type { ThumbnailKeyParts } from '../../thumbnails/thumbnail-key';
import { AddLibraryDialog } from '../../library/AddLibraryDialog';
import { getLibraryStore } from '../../library/library-store-singleton';
import {
  readProjectLibraries,
  withProjectLibraries,
} from '../../library/project-libraries';
import { setPendingAssetOpen } from '@rv-private/plugins/asset-editor/pending-open-store';
import { useViewer } from '../../../hooks/use-viewer';
import { getSceneStore } from '../scene/scene-store-singleton';
import { SceneConfirmDialog } from '../scene/rv-scene-confirm-dialog';
import { SceneNameDialog } from './SceneNameDialog';
import { AssetPromptDialog } from './AssetPromptDialog';
import { ProjectsDashboard } from './ProjectsDashboard';
import { ProjectsList, type ProjectListRow } from './ProjectsList';
import { ProjectTree } from './ProjectTree';
import {
  buildDashboardTree,
  catalogRootId,
  type CatalogRootInput,
  type TreeCatalogEntryInput,
} from '../../project/rv-project-tree-sources';
import {
  buildProjectTree,
  canRenameInTree,
  findTreeNode,
  folderContents,
  folderSubfolders,
  isRenamableInTree,
  nearestFolderPath,
  planTreeMove,
  type ProjectTreeNode,
} from '../../project/rv-project-tree';
import { listProjectFiles } from '../../project/backends/project-backend';
import {
} from '../../project/backends/bundled-backend';
import {
  ProjectFolderContents, type FolderCardModel, type FolderTileModel,
} from './ProjectFolderContents';
import { applyTreeMove, DOCS_INDEX_FILE, type TreeMoveIO } from '../../project/rv-project-tree-move';
import { docsIndexPaths, parseDocsIndex, type DocsIndex } from '../../project/rv-docs-index';
import { findLocalIdCollisions } from '../../project/rv-asset-identity';
import {
  isConnectConfigPath, isKnowledgeFilePath, readDocumentRef,
  stripConnectConfigSuffix, stripKnowledgeFileSuffix,
} from '../../project/rv-project-refs';
import { CONNECT_CONFIG_DRAG_TYPE, KNOWLEDGE_FILE_DRAG_TYPE } from './connect-config-dnd';
import { setDragChip } from './drag-chip';
import { reportDocumentIdCollisions } from '../problems-store';
import { selectionPointsIntoGroup, type SelectedAssetRef } from './assets-library-groups';
import type { ProjectCardMenuAction } from './ProjectCard';
import { ProjectsDetailPane, type DetailAction, type DetailField } from './ProjectsDetailPane';
import { DestructiveConfirmDialog, type DestructiveConfirmRequest } from './DestructiveConfirmDialog';
import {
  closeProjectsDashboard,
  getProjectsDashboardSnapshot,
  openProjectsDashboard,
  setProjectsChip,
  setProjectsSearch,
  setProjectsSelection,
  setProjectsTag,
  setProjectsView,
  subscribeProjectsDashboard,
} from './projects-dashboard-store';
import {
  documentChipOptions,
  documentTagOptions,
  matchesDocumentFilter,
  matchesSearchTerm,
  type ClassifiedRow,
  type DocumentFilterState,
} from './document-filter';
import { DocumentFilterBar } from './DocumentFilterBar';
import { DocumentHeroSection } from './DocumentHeroSection';
import { ClassificationEditor } from './ClassificationEditor';
// plan-716 §2.7 / F8 — the dashboard's readers of THE one list. They live in
// their own module because this file cannot be rendered by a test.
import {
  documentById,
  documentPickOptions,
  documentRoleBadge,
  documentsUsingRef,
  documentTypeBadge,
  newDocumentFolderFor,
  newDocumentNameFor,
  type RefUsage,
} from './dashboard-documents';
// plan-446: the two CONNECT bridges of the project browser — "Show in Explorer"
// (a host action the gateway performs, gated to a local page) and "Open in
// CONNECT" (the one place a configuration is written).
import {
  canRevealInExplorerNow,
  getConnectSnapshot,
  revealInExplorer,
  subscribeConnectStore,
} from '../connect-store';
import { ConnectOptionsWindow } from '../ConnectOptionsWindow';
import type { DocumentClassification } from '../../project/rv-document-classification';
import type { TieredDocumentEntry } from '../../project/rv-project-tiers';

/** Display name for a manifest asset that carries no explicit `label`. */
function baseNameOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.glb$/i, '');
}

/**
 * The "Used by" block of a reference file's detail pane (plan-446 F4).
 *
 * Chips rather than the comma-joined sentence this used to be: the answer to
 * "who uses this configuration" is almost always followed by "show me that
 * one", and a click that selects the document in the dashboard is that step.
 * The empty case keeps its sentence — a row of nothing would read as a loading
 * state.
 */
function usedByChips(usedBy: readonly RefUsage[]) {
  return (
    <>
      <Divider sx={{ my: 1.25, borderColor: 'rgba(255,255,255,0.06)' }} />
      <SectionHeader>Used by</SectionHeader>
      {usedBy.length === 0 ? (
        <Typography
          data-testid="usedby-empty"
          sx={{ fontSize: 11, color: 'text.disabled', mt: 0.5 }}
        >
          Not referenced by any document
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
          {usedBy.map(doc => (
            <Chip
              key={doc.id}
              data-testid={`usedby-chip-${doc.id}`}
              label={doc.name}
              size="small"
              onClick={() => setProjectsSelection({ kind: 'document', documentId: doc.id })}
              sx={{ fontSize: 10, height: 20, maxWidth: '100%' }}
            />
          ))}
        </Box>
      )}
    </>
  );
}

// `readRememberedSession` / `rememberSession` used to live here as private
// helpers. They now come from `rv-project-resume-store`, because the boot path
// in `main.ts` needs the SAME read: a reload restores a project rather than
// opening it, so the resume effect below never fires for it and the pair has to
// be readable outside this component.

/**
 * Path of a project-library asset relative to `library/`, or null.
 *
 * The asset ops (`renameAsset`, `deleteAsset`, …) prefix `library/` themselves,
 * while a catalog entry's `localPath` already carries it — passing the entry id
 * or the localPath straight through is how "Delete" used to look for
 * `library/project:library/….glb` and always failed.
 */
function libraryRelPathOf(entry: LibraryCatalogEntry): string | null {
  const p = entry.localPath;
  if (!p) return null;
  return p.startsWith(`${LIBRARY_FOLDER}/`) ? p.slice(LIBRARY_FOLDER.length + 1) : p;
}

/**
 * One document of the open project, as the filter and the detail pane see it.
 *
 * It used to carry the grid card too, and since Lauf 13 there are cards again —
 * but they are built per *tree row* of the selected folder, not per document of
 * the whole project, so the two lists stayed separate. What this one carries is
 * what the rest of the screen needs: the classification (chips, tags, the
 * editor), the manifest row to write an edit back to, and a stable key the
 * detail pane looks the row up by.
 */
interface DocumentRow extends ClassifiedRow {
  /** `scene:<id>` or `model:<path>`. */
  key: string;
  /** The manifest document, when this row has one. Absent for a bare example. */
  doc?: TieredDocumentEntry;
}

/** What {@link openDocumentAsWorkingScene} needs of the viewer — the mode manager. */
export interface WorkingSceneOpenModes {
  activeMode: string | null;
  list(): readonly { id: string }[];
  setMode(id: string): void;
  requestMode(id: string): unknown;
}

/**
 * Open a document row as the working scene — including the EDITOR handoff.
 *
 * Exported (and separated from the host's `openScene` callback) so the handoff
 * contract is testable; the host wraps it in its dirty guard and dashboard
 * dismissal, which stay UI concerns.
 *
 * A double-click with the EDITOR active must put the clicked document INTO the
 * editor. The editor resolves what it shows only on mode activation
 * (`_resolveOpenPlan`), so with the mode already active the load would swap
 * the viewport model while the editor kept its old document — header, op log
 * and edits all pointing at the previous asset. Leave before the load
 * (releases the old binding) and re-enter after the identity is published, so
 * the open plan binds the document this click names — the same
 * leave-and-re-enter `web_editor_open` uses. The re-entry carries the identity
 * as an EXPLICIT pending open (same as `openAssetInEditor`): a plain re-entry
 * lets a recoverable crash draft of ANOTHER document silently open instead of
 * the document this click names; with the pending set, a conflicting draft is
 * asked about instead of winning by default.
 *
 * After the load the identity is published exactly as `openModel` does
 * (plan-711 F1): `SceneStore._loadIntoWorkspace` already recorded the same
 * identity on the way through — this is the call site the plan names, written
 * through the SAME constructor so the two can only agree. The name comes from
 * the row the user clicked, read off THE one list since plan-716 Phase 5 (F8);
 * without a row the funnel's write stands rather than being overwritten with a
 * guess. The resume pair is NOT written here (plan-702 Phase 3): the
 * `SceneStore.openDocument` funnel writes it itself, with alias tolerance this
 * call site never had.
 */
export async function openDocumentAsWorkingScene(
  viewer: { modes: WorkingSceneOpenModes },
  sceneStore: { openScene(id: string): Promise<void> },
  documents: readonly TieredDocumentEntry[],
  id: string,
): Promise<void> {
  const modes = viewer.modes;
  const wasEditor = modes.activeMode === 'editor';
  if (wasEditor) {
    const ids = modes.list().map((m) => m.id);
    modes.setMode(ids.find((mid) => mid !== 'editor') ?? 'hmi');
  }
  await sceneStore.openScene(id);
  const sceneRow = documentById(documents, id);
  if (sceneRow) setOpenDocumentBase(sceneDocumentBase(id, sceneRow.name));
  if (wasEditor) {
    if (sceneRow) {
      setPendingAssetOpen(documentBase(id, sceneRow.name, sceneRow.path));
    }
    void modes.requestMode('editor');
  }
}

export function ProjectsDashboardHost() {
  const dash = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);
  const store = getProjectStore();
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The registry publishes a version counter, never an object — see §2.6.4.
  // The value is BOUND, not discarded: `sources` is memoised below, so the
  // counter is the only thing that can tell the memo a provider republished
  // (plan-702 §2.9). Dropping it here brings back the pre-702 behaviour where
  // a new file in a local folder never appeared.
  const registryVersion = useSyncExternalStore(subscribeLibrarySources, getLibrarySourcesSnapshot);
  // plan-446 F3. Read here rather than probed per menu open: the flag already
  // travels on the `/health` this screen's gateway connection made, so the verb
  // costs no request — and it re-appears by itself when a reconnect answers
  // `revealSupported` again after a refusal cleared it.
  const connectSnap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);

  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProjectEntry[]>([]);
  const [recent, setRecent] = useState(() => readRecentProjects());
  // The display record, not the handle: it is written synchronously by
  // `pickWorkspace` and is all the empty state needs to decide which screen to
  // be. Probing the real handle would mean an async permission check before the
  // first paint, and a flash of "no workspace" for a user who has one.
  const [workspaceMeta, setWorkspaceMeta] = useState(() => getWorkspaceMeta());

  // Workspace discovery touches the disk, so it runs when the OVERVIEW is
  // actually on screen, not on every dashboard open: the two screens are two
  // windows onto two listings (workspace → projects, project → its documents),
  // and each scan belongs to the screen that shows its result. Going back to
  // the overview re-runs the scan, which is also what keeps the list fresh
  // after a stay inside a project. The one exception is the FIRST open of a
  // session: it scans whichever screen it lands on, because the project screen
  // keeps one piece of workspace knowledge — the "Copy to… / Move to…"
  // transfer targets — and those entries hide entirely when the list is empty.
  const workspaceScannedRef = useRef(false);
  useEffect(() => {
    if (!dash.open) return;
    if (dash.view !== 'projects' && workspaceScannedRef.current) return;
    workspaceScannedRef.current = true;
    let alive = true;
    void scanStoredWorkspace()
      .then(result => { if (alive) setWorkspaceProjects(result?.projects ?? []); })
      .catch(() => { if (alive) setWorkspaceProjects([]); });
    setRecent(readRecentProjects());
    setWorkspaceMeta(getWorkspaceMeta());
    return () => { alive = false; };
  }, [dash.open, dash.view]);

  const sources = useMemo(() => listLibrarySources(), [registryVersion]);
  // Kiosk gate (§2.13): a locked mode means the user may browse the project
  // they were given but must not open a different one. Only the PROJECTS group
  // is hidden - hiding the whole rail would leave an empty shell.
  const { locked: modeLocked } = useMode();

  // Auto-open exactly once per session, and only when the session did not
  // already say what to show (§2.12). Registered with the startup-modal
  // coordinator so it cannot stack on top of the welcome screen.
  useStartupModalRegistration('projects', dash.open);
  const autoOpenedRef = useRef(false);
  /**
   * "The next project that opens was opened deliberately — resume into it."
   *
   * Set BEFORE the open, not after: the store publishes synchronously, so a flag
   * set afterwards would arrive one render too late and the resume would never
   * fire. It is a ref rather than state because flipping it must not itself
   * cause a render.
   */
  const pendingResumeRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    const cfg = getAppConfig();
    // Boot-restore failure (plan-702 Punkt 3): the last session's project did
    // not come back — say so and open the list so one click re-grants it. Read
    // once, here: the effect runs exactly once per session by design.
    const failure = store.getSnapshot().restoreFailure;
    if (failure) {
      const name = failure.projectName ?? failure.projectId;
      setMessage(failure.reason === 'permission'
        ? `The project "${name}" could not be restored — the folder permission has expired. Open it again to re-grant access.`
        : `The project "${name}" could not be restored — its folder is missing or unreadable. Open it again from its current location.`);
    }
    if (shouldAutoOpenProjects({
      search: window.location.search,
      defaultModel: cfg.defaultModel,
      // Read from the store rather than from `project` (the hook's snapshot):
      // this effect runs exactly once, and it must see the project the boot
      // resolved, not whatever the first render happened to hold (plan-726 F3).
      projectStartDocument: projectStartDocument(store.getSnapshot().project),
      modeLocked,
      suppress: cfg.projects?.suppress,
      force: cfg.projects?.force,
      restoreFailed: failure !== null,
    })) {
      openProjectsDashboard();
    }
  }, [modeLocked, store]);

  // A recent entry that is also a workspace subfolder would appear twice; the
  // workspace listing wins because it is the live, on-disk truth.
  const workspaceNames = useMemo(
    () => new Set(workspaceProjects.map(p => p.name)),
    [workspaceProjects],
  );
  const recentOutside = useMemo(
    () => recent.filter(r => !workspaceNames.has(r.name)),
    [recent, workspaceNames],
  );

  /**
   * The rows of the list screen: the open project, then workspace entries,
   * then recents from elsewhere. All are projects to the user, so they share
   * one list rather than headed groups — the origin only decides whether the
   * row can be forgotten.
   *
   * The open project leads the list even when it belongs to neither source.
   *
   * `DemoRealvirtual` — the shipped demo project — is listed with the workspace
   * entries whether or not it is open, because a deploy serves it over HTTP and
   * `discoverWorkspaceProjects()` can never find it there.
   *
   * Unless the workspace *is* the folder it lives in: whoever points the picker
   * at `projects/` gets `demo-realvirtual` discovered like any other folder, and
   * then the synthetic row is the same project a second time. On-disk truth
   * wins, same rule the recents list follows above.
   */
  const projectRows = useMemo<ProjectListRow[]>(() => {
    const term = dash.search.trim().toLowerCase();
    const match = (name: string) => !term || name.toLowerCase().includes(term);
    const onDisk = [...workspaceProjects, ...recentOutside]
      .some(p => p.id === DEMO_PROJECT_ID || p.name === DEMO_PROJECT_NAME);
    const rows: ProjectListRow[] = [
      ...(!onDisk && match(DEMO_PROJECT_NAME)
        ? [{
            id: DEMO_PROJECT_ID,
            name: DEMO_PROJECT_NAME,
            caption: 'realvirtual demo scenes & library',
            origin: 'workspace' as const,
          }]
        : []),
      ...workspaceProjects
        .filter(p => match(p.name))
        .map(p => ({
          id: p.id,
          name: p.name,
          caption: p.folderName,
          origin: 'workspace' as const,
          canManage: true,
        })),
      ...recentOutside
        .filter(r => match(r.name))
        .map(r => ({
          id: r.id,
          name: r.name,
          caption: r.folderName,
          origin: 'recent' as const,
        })),
    ];

    const open = project.project;
    if (open && match(open.name) && !rows.some(r => r.id === open.id)) {
      rows.unshift({
        id: open.id,
        name: open.name,
        caption: project.folderName ?? `${project.backendKind ?? 'open'} project`,
        // Not 'recent': there is no recents entry to forget, so the row must
        // not offer a remove button that would do nothing.
        origin: 'workspace',
      });
    }
    return rows;
  }, [workspaceProjects, recentOutside, dash.search,
      project.project, project.folderName, project.backendKind]);

  const projectLibraries = useMemo(
    () => sources.filter(s => s.source.kind === 'project')
      .map(s => ({ id: s.source.id, label: s.source.label, error: s.source.error })),
    [sources],
  );
  const globalLibraries = useMemo(
    () => sources.filter(s => s.source.kind !== 'project')
      .map(s => ({ id: s.source.id, label: s.source.label, error: s.source.error })),
    [sources],
  );

  // ── Project verbs (§3.3) ──────────────────────────────────────────────
  // Every switch goes through the store's own open path, which is where the
  // plan-370 dirty guard lives (§3.4). Calling it here rather than
  // reimplementing a guard is the whole point: one prompt, one rule.
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // One confirm for every destructive verb — see DestructiveConfirmDialog.
  const [confirmReq, setConfirmReq] = useState<DestructiveConfirmRequest | null>(null);
  const [createHere, setCreateHere] = useState<(CreateHereRequest & { dir: FileSystemDirectoryHandle }) | null>(null);
  const [fromScenes, setFromScenes] = useState<FromScenesRequest | null>(null);
  const [newProjectName, setNewProjectName] = useState<string | null>(null);

  /**
   * Show the folder picker and, when no folder comes back, say why.
   *
   * Only `cancelled` is silent — the user dismissed a dialog they opened, and
   * narrating that is noise. Every other empty outcome used to look exactly
   * like a cancel, which is how a browser without the File System Access API
   * turned "Open workspace…" into a button that visibly did nothing.
   */
  const pickFolder = useCallback(async (
    key: string,
  ): Promise<FileSystemDirectoryHandle | null> => {
    const pick: FolderPick = await pickFolderForKey(key);
    if (pick.kind === 'picked') return pick.dir;
    if (pick.kind === 'unsupported') {
      setMessage('This browser cannot open local folders. '
        + 'Folder projects need the File System Access API — use Chrome or Edge.');
    } else if (pick.kind === 'blocked') {
      setMessage(pick.reason);
    }
    return null;
  }, []);

  /** Run a verb, surfacing failures instead of swallowing them. */
  const runVerb = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : `${label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Open a project and drill into it.
   *
   * Note the departure from §3.4: picking a *project* no longer dismisses the
   * dashboard. Under the rail it had to, because there was nowhere else to go;
   * with a second screen, dismissing would throw the user back at the viewport
   * one click before the scenes they came for. Opening a scene or a model still
   * closes — those are the actions that actually change what is on screen.
   */
  const handleOpenProject = useCallback((id: string) => {
    if (busy) return;
    const ws = workspaceProjects.find(p => p.id === id);
    // "Already open" is only true when it is the same THING, not merely the
    // same id. DemoRealvirtual exists twice under one id — as the read-only
    // HTTP fallback and as a folder in the workspace — so while the HTTP one
    // is open, clicking the folder row must still open the folder. Treating
    // it as navigation is what left the project permanently read-only.
    if (id === project.project?.id && (!ws || project.backendKind === 'folder')) {
      setProjectsView('project');      // genuinely already open — pure navigation
      return;
    }
    void runVerb('Open project', async () => {
      pendingResumeRef.current = true;
      try {
        // The folder wins whenever there is one: it is writable, and the HTTP
        // project is the fallback for a deploy that has no folder at all.
        const ok = ws
          ? await store.openProjectFolder(ws.dir)
          : id === DEMO_PROJECT_ID
            ? await store.openDemoProject()
            : await store.openRecentProject(id);
        if (!ok) setMessage('That project could not be opened.');
        else setProjectsView('project');
      } finally {
        // A failed open must not leave the flag armed for the next one.
        if (!store.getProject()) pendingResumeRef.current = false;
      }
    });
  }, [busy, project.project?.id, project.backendKind, workspaceProjects, runVerb, store]);

  /**
   * **One "Open…"** (plan-703 §2.6.3, decision 1).
   *
   * There used to be two buttons — "Open folder…" and "Switch workspace" — and
   * the user had to know which of our two internal concepts their folder was.
   * Now there is one picker and one directory listing, and the listing answers
   * the question: a folder with its own `project.json` is a project (even when
   * it also holds child projects — decision 2), a folder holding child projects
   * is a workspace, and a folder that is neither is an offer to create one.
   *
   * The detection is `detectOpenTarget`, the listing is `probeOpenFolder`, and
   * neither of them is here — this function is only the dispatch.
   */
  const handleOpen = useCallback(() => {
    void runVerb('Open', async () => {
      // Picked under the project key rather than the workspace one: a folder we
      // have not classified yet must not become "the workspace" just by being
      // looked at. `adoptWorkspace` below is what promotes it, once we know.
      const dir = await pickFolder('rv-project-pick');
      if (!dir) return;                // cancelled, or already explained by pickFolder
      const target = detectOpenTarget(await probeOpenFolder(dir));

      if (target.kind === 'project') {
        pendingResumeRef.current = true;
        const ok = await store.openProjectFolder(dir);
        if (!ok) {
          pendingResumeRef.current = false;
          setMessage('That project could not be opened.');
          return;
        }
        setProjectsView('project');
        if (target.childProjects.length > 0) {
          // Decision 2: the children are a HINT, never a second interpretation.
          setMessage(`Opened "${dir.name}". It also contains `
            + `${target.childProjects.length} project folder(s).`);
        }
        return;
      }

      if (target.kind === 'workspace') {
        await adoptWorkspace(dir);
        const result = await scanStoredWorkspace();
        setWorkspaceProjects(result?.projects ?? []);
        setWorkspaceMeta(getWorkspaceMeta());
        setProjectsView('projects');
        return;
      }

      // Neither: offer to make one here rather than reporting an error for a
      // folder the user deliberately chose.
      setCreateHere({ dir, name: dir.name || 'New Project' });
    });
  }, [runVerb, store, pickFolder]);

  /** Create a project in the folder the single "Open…" found empty. */
  const submitCreateHere = useCallback(() => {
    const request = createHere;
    setCreateHere(null);
    if (!request) return;
    const name = request.name.trim();
    if (!name) return;
    void runVerb('New project', async () => {
      const result = await createProjectFromScenes(request.dir, name, []);
      if (!result.ok) throw new Error(result.message);
      const ok = await store.openProjectFolder(request.dir);
      if (!ok) throw new Error('The project was created but could not be opened.');
      setProjectsView('project');
    });
  }, [createHere, runVerb, store]);

  /**
   * Export the open folder project as a single .rvproject (Phase 16).
   *
   * Only a folder project has bytes on disk to zip; the action is offered
   * nowhere else rather than failing after the click.
   */
  const handleExportProject = useCallback(() => {
    void runVerb('Export project', async () => {
      const dir = store.getProjectDir();
      if (!dir) throw new Error('Only a project folder can be exported.');
      const result = await exportProject(dir, project.project?.name ?? 'project');
      if (result.kind !== 'exported') throw new Error(result.message);
      const url = URL.createObjectURL(result.blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = result.fileName;
        a.click();
      } finally {
        // Revoked late: revoking synchronously can cancel the download in
        // some browsers before it has read the blob.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      if (result.skipped.length > 0) {
        setMessage(`Exported ${result.entryCount} files. Caches and secrets were excluded.`);
      }
    });
  }, [runVerb, store, project.project?.name]);

  /** Unpack a .rvproject into a folder the user picks. */
  const handleImportProject = useCallback(() => {
    void runVerb('Import project', async () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = RVPROJECT_EXTENSION;
      const file = await new Promise<File | null>((resolve) => {
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
      });
      if (!file) return;                 // cancelled — not an error
      // Unpacked into a folder the user picks now — and that folder becomes the
      // workspace, which is where the import will be listed again next time.
      const dir = await pickFolder('rv-project-pick');
      if (!dir) return;
      await adoptWorkspace(dir);
      const result = await importProject(file, dir);
      if (result.kind !== 'imported') throw new Error(
        'message' in result ? result.message : 'Import failed.');
      setMessage(`Imported "${result.project.name}" (${result.entryCount} files).`);
    });
  }, [runVerb, pickFolder]);

  /**
   * Every document of the open project by path — the lookup the asset verbs need.
   *
   * Declared before the asset ops since plan-717 Phase 3: those verbs address
   * documents by ROW now (delete retires a row, duplicate copies one), and the
   * path is how a library-relative gesture finds its row.
   */
  const documentByPath = useMemo(
    () => new Map(project.documents.map(d => [d.path, d])),
    [project.documents],
  );

  // ── Asset ops (§2.6.5 / Phase 9) ──────────────────────────────────────
  // They all write through the active backend, so one implementation serves a
  // folder project and a browser project alike.
  const viewer = useViewer();
  const [assetDialog, setAssetDialog] = useState<
    // `renameNode` is Lauf 13's card rename: `relPath` is a TREE path, not a
    // library-relative one, and it goes through the tree's move/rename write
    // path rather than through the library asset ops.
    { kind: 'renameAsset' | 'collections' | 'renameNode'; relPath: string; value: string } | null
  >(null);

  /** Run an asset op, surfacing its typed failure rather than swallowing it. */
  const runAssetOp = useCallback((
    label: string,
    fn: (backend: NonNullable<ReturnType<typeof store.getBackend>>) => Promise<{ kind: string; message?: string }>,
  ) => {
    return runVerb(label, async () => {
      const backend = store.getBackend();
      if (!backend?.writable) throw new Error('This project is read-only.');
      const result = await fn(backend);
      if (result.kind !== 'ok') throw new Error(result.message ?? `${label} failed.`);
      // BOTH listings re-read after every successful mutation: the document
      // scan feeds the tree rows, the folder cards and the detail pane; the
      // provider catalog feeds thumbnails and drag-into-scene. Skipping either
      // leaves an old name (or a deleted card) standing until the next open.
      await store.rescanDocuments();
      await listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
    });
  }, [runVerb, store]);

  /**
   * Open an asset in the asset editor.
   *
   * The identity handoff (`providerAsset`) rather than a URL: the editor
   * re-resolves through the source registry, which works for the project's own
   * `library/` and a remote catalog alike, and survives a reload.
   *
   * Except when the asset has a document ROW in this project: a `providerAsset`
   * base routes Save through `save-into-project` with `copies: true`
   * (`decideSaveVerb`), which is the "make it mine" semantics a FOREIGN catalog
   * needs — applied to the project's own asset it wrote a second file
   * (`Name_1.glb`) on every save instead of the one that was opened. Since
   * plan-719 F2 that route also PROMPTS ("Save into project as…") rather than
   * copying silently, which makes getting this wrong louder but no less wrong:
   * the user would be asked to place a file they already own. Ownership
   * is the row, never the folder (plan-716/717: the section is a place, not a
   * type) — so the test is `documentByPath`, and the identity handed over is
   * the row itself: its id, its name, its path, wherever the file sits.
   */
  const openAssetInEditor = useCallback((ref: SelectedAssetRef, label: string) => {
    const localPath = ref.providerId === PROJECT_LIBRARY_PROVIDER_ID
      ? listLibrarySources()
        .find(s => s.providerId === ref.providerId && s.source.id === ref.sourceId)
        ?.source.getEntry(ref.assetId)?.localPath
      : null;
    // The provider has historically reported the path with and without the
    // `library/` prefix — the row decides, so both spellings are tried.
    const ownDoc = localPath
      ? documentByPath.get(localPath) ?? documentByPath.get(`${LIBRARY_FOLDER}/${localPath}`)
      : null;
    setPendingAssetOpen(ownDoc ? documentBase(ownDoc.id, ownDoc.name || label, ownDoc.path) : {
      kind: 'providerAsset',
      providerId: ref.providerId,
      sourceId: ref.sourceId,
      assetId: ref.assetId,
      label,
    });
    void viewer.modes.requestMode('editor');
    closeProjectsDashboard();
  }, [viewer, documentByPath]);

  /**
   * Delete a library asset after an explicit confirmation.
   *
   * ## Through the ROW since plan-717 §2.7
   *
   * `retireDocument`, the same verb the scene cards' Delete already used — bytes
   * into `.trash/`, row out of the manifest, both recoverable. `deleteAsset` did
   * the byte half and then cleared the asset's SIDECAR record, which was the
   * pre-717 way of saying "the metadata dies with the document"; now the
   * metadata IS the row, so dropping the row says it once and exactly.
   *
   * The bytes land in the project's root `.trash/` rather than `library/.trash/`.
   * That is the better of the two: `isExcludedFromExport` matches its prefixes at
   * the start of the path, so only the root folder is actually kept out of a
   * `.rvproject` — a library-local trash travelled with the archive.
   *
   * A mis-click must never delete, hence the confirmation; and a delete gesture
   * must never be terminal, hence `.trash/`.
   */
  const handleDeleteAsset = useCallback((doc: TieredDocumentEntry | undefined, name: string) => {
    setConfirmReq({
      title: 'Delete asset',
      message: `Delete "${name}"? It is moved to the project's trash folder.`,
      confirmLabel: 'Delete',
      onConfirm: () => {
        void runAssetOp('Delete asset', async () => {
          if (!doc) {
            return {
              kind: 'error',
              message: `"${name}" is not registered in this project — reopen the project and try again.`,
            };
          }
          await retireDocument(store, doc.id);
          setProjectsSelection({ kind: 'none' });
          return { kind: 'ok' };
        });
      },
    });
  }, [runAssetOp, store]);

  // ── Cross-source copy / move (plan-413 §2.7, phase 5) ─────────────────
  const [transferReq, setTransferReq] = useState<TransferRequest | null>(null);

  /**
   * Where a document can be sent.
   *
   * Workspace projects only, and never the one that is open: a target needs a
   * folder handle (its `project.json` is updated under compare-and-swap) and a
   * transfer into the source itself is Duplicate, which already exists. A
   * read-only project is absent rather than disabled — see the dialog.
   */
  const transferTargets = useMemo<TransferTargetOption[]>(
    () => workspaceProjects
      .filter(ws => ws.id !== project.project?.id)
      .map(ws => ({ id: ws.id, label: ws.name, hint: ws.folderName })),
    [workspaceProjects, project.project?.id],
  );

  /**
   * Run the copy or the move inside one exclusive transfer session.
   *
   * The session is what makes writing into a project that is NOT open legal at
   * all: the target backend is constructed writable, activated for the duration
   * and deactivated again in a `finally` (§2.7). It is built **without a writer
   * host** on purpose — a writer would subscribe to the global scene mutation
   * bus and mirror the open project's saves into this folder, which is the one
   * thing §2.2.1b forbids. Blob writes need no writer.
   */
  const runTransfer = useCallback((req: TransferRequest, targetId: string) => {
    setTransferReq(null);
    const ws = workspaceProjects.find(p => p.id === targetId);
    const doc = documentByPath.get(req.documentPath);
    const label = req.mode === 'move' ? 'Move document' : 'Copy document';
    void runVerb(label, async () => {
      if (!ws) throw new Error('That project is no longer in the workspace.');
      if (!doc) throw new Error('That document is no longer part of this project.');
      const backend = store.getBackend();
      if (!backend?.writable) throw new Error('This project is read-only.');

      const result = await withTransferSession(
        {
          source: {
            label: project.project?.name ?? 'this project',
            backend,
            dir: store.getProjectDir(),
            isActiveProject: true,
          },
          target: {
            label: ws.name,
            // A fresh backend rather than `ws.backend`: discovery constructs
            // those read-only and inert, and `setWritable` on a shared instance
            // would leave the workspace listing holding a writable handle long
            // after the transfer.
            backend: new FolderBackend(ws.dir, {
              writable: true,
              id: `transfer:${ws.id}`,
            }),
            dir: ws.dir,
          },
        },
        session => req.mode === 'move'
          ? moveDocumentAcrossSources(session, doc)
          : copyDocumentAcrossSources(session, doc),
      );

      if (result.kind !== 'ok') throw new Error(result.message);
      if (result.warning) {
        setMessage(result.warning);
      } else {
        setMessage(`"${doc.name}" ${req.mode === 'move' ? 'moved' : 'copied'} to "${ws.name}".`);
      }
      // A move took bytes out of THIS project's library, so the source listing
      // is stale until it is re-read — the same refresh every asset op does.
      if (req.mode === 'move') {
        await listLibrarySources()
          .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
        setProjectsSelection({ kind: 'none' });
      }
    });
  }, [workspaceProjects, documentByPath, runVerb, store, project.project?.name]);

  /**
   * "Copy to…" / "Move to…" for one document, or nothing.
   *
   * Nothing, rather than two disabled entries, in three cases: the document is
   * not one this project owns, the project cannot be written to, or there is
   * nowhere to send it. A menu entry that can never do anything is noise the
   * user has to re-read on every card (§3.6).
   */
  const transferActionsFor = useCallback((
    doc: TieredDocumentEntry | undefined,
  ): ProjectCardMenuAction[] => {
    if (!doc || doc.tier === 'bundled' || !project.writable) return [];
    if (transferTargets.length === 0) return [];
    const request = (mode: 'copy' | 'move'): TransferRequest =>
      ({ mode, documentName: doc.name, documentPath: doc.path });
    return [
      { key: 'copyTo', label: 'Copy to…', onClick: () => setTransferReq(request('copy')) },
      { key: 'moveTo', label: 'Move to…', onClick: () => setTransferReq(request('move')) },
    ];
  }, [project.writable, transferTargets.length]);

  /**
   * Actions for a library asset (§3.6).
   *
   * A read-only source gets "Edit a copy" instead of a disabled "Edit" — the
   * plan is explicit that telling the user the way forward beats greying out.
   * Mutating verbs appear only for assets that live in THIS project, because
   * those are the only ones the backend can actually write.
   */
  const buildAssetActions = useCallback((
    ref: SelectedAssetRef,
    entry: LibraryCatalogEntry,
    writable: boolean,
    isProjectAsset: boolean,
  ): DetailAction[] => {
    const actions: DetailAction[] = [
      {
        key: 'edit',
        // A read-only source gets "Edit a copy": the editor opens either way,
        // but saving lands in the user's own library, and the label says so.
        label: writable ? 'Edit' : 'Edit a copy',
        primary: true,
        onClick: () => openAssetInEditor(ref, entry.name),
      },
    ];
    if (!isProjectAsset || !writable) return actions;
    const relPath = libraryRelPathOf(entry);
    if (!relPath) return actions;
    // The row behind this card. Since plan-716 the provider lists EVERY document
    // and `localPath` is the row's full project-relative path — `models/X.glb`
    // as much as `library/X.glb`. Re-prefixing `library/` unconditionally (the
    // pre-716 spelling) made every non-library card's Delete/Duplicate resolve
    // to nothing and fail with "not registered"; try the row's own spelling
    // first, the historical library-relative one second.
    const doc = entry.localPath
      ? documentByPath.get(entry.localPath)
        ?? documentByPath.get(`${LIBRARY_FOLDER}/${entry.localPath}`)
      : documentByPath.get(`${LIBRARY_FOLDER}/${relPath}`);
    // No "Rename" entry in THIS list, and that is not the same as no Rename
    // verb: the pane synthesises one from `onRename` (plan-450 §2.2) and places
    // it after the last `primary` action. The commit is the `renameLibraryAsset`
    // below — the same one the pre-717 dialog reached, minus the dialog. Adding
    // it here would produce two buttons for one verb.
    actions.push({
      key: 'dup',
      label: 'Duplicate',
      // The ROW route (plan-717 §2.7): `duplicateDocument` copies the file AND
      // registers the copy with a NEW id, carrying the source's collections over
      // — the same inheritance `duplicateAsset` gave through the sidecar, now
      // from the one place the filing lives.
      onClick: () => {
        void runAssetOp('Duplicate asset', async () => {
          if (!doc) {
            return {
              kind: 'error',
              message: `"${entry.name}" is not registered in this project — reopen the project and try again.`,
            };
          }
          await duplicateDocument(store, doc.id);
          return { kind: 'ok' };
        });
      },
    });
    actions.push({
      key: 'collections',
      label: 'Collections…',
      // The ROW's collections, not the catalog entry's: since plan-717 §2.6 the
      // entry shows the union of the filing and the folder chips, and offering
      // "library/Conveyors" for editing would invite the user to delete a chip
      // that is derived from where the file lives and would come straight back.
      onClick: () => setAssetDialog({
        kind: 'collections',
        relPath,
        value: (doc?.collections ?? []).join(', '),
      }),
    });
    // The cross-source verbs (§2.7). The asset IS a document — wherever its
    // file sits — so the lookup is by its row, resolved above.
    actions.push(...transferActionsFor(doc));
    actions.push({
      key: 'delete',
      label: 'Delete',
      destructive: true,
      onClick: () => handleDeleteAsset(doc, entry.name),
    });
    return actions;
  }, [openAssetInEditor, runAssetOp, handleDeleteAsset, transferActionsFor, documentByPath, store]);

  const [addLibraryOpen, setAddLibraryOpen] = useState(false);
  // The planner plugin owns the private cloud store when it is loaded. Reading
  // it through the plugin registry keeps this file free of a private import.
  const cloudStore = (viewer.getPlugin('layout-planner') as
    { cloudStore?: { addConnection(label: string, cfg: { projectId: string; keyId: string; secretKey: string }): string } } | undefined)?.cloudStore ?? null;

  const handleCloseProject = useCallback(() => {
    // The carry-over identity is project-relative, so it must not outlive the
    // project: a later mode switch would otherwise try to open a path that no
    // longer resolves.
    setOpenDocumentBase(null);
    void runVerb('Close project', () => store.requestCloseProject());
  }, [runVerb, store]);

  // ── Project rename / delete (workspace rows only) ─────────────────────
  // Both act on the folder the workspace scan found. Recents and the bundled
  // demo have no workspace folder, so neither verb is offered for them.
  const [renameProjectReq, setRenameProjectReq] = useState<ProjectRenameRequest | null>(null);

  const handleRenameProject = useCallback((id: string) => {
    const ws = workspaceProjects.find(p => p.id === id);
    if (ws) setRenameProjectReq({ id, name: ws.name });
  }, [workspaceProjects]);

  const submitRenameProject = useCallback(() => {
    if (!renameProjectReq) return;
    const { id, name } = renameProjectReq;
    const trimmed = name.trim();
    setRenameProjectReq(null);
    if (!trimmed) return;
    const ws = workspaceProjects.find(p => p.id === id);
    if (!ws) return;
    void runVerb('Rename project', async () => {
      await writeManifest(ws.dir, { ...ws.manifest, name: trimmed });
      const scan = await scanStoredWorkspace({ prompt: false });
      setWorkspaceProjects(scan.projects);
      // The open project shows its name in the header; re-open it so the
      // rename is visible immediately. The store's own dirty guard applies.
      if (project.project?.id === id && project.backendKind === 'folder') {
        await store.openProjectFolder(ws.dir);
      }
    });
  }, [renameProjectReq, workspaceProjects, runVerb,
      project.project?.id, project.backendKind, store]);

  const handleDeleteProject = useCallback((id: string) => {
    const ws = workspaceProjects.find(p => p.id === id);
    if (!ws) return;
    // Deleting the folder under the open project would leave the store
    // writing into nowhere — closing first is the user's explicit step.
    if (project.project?.id === id) {
      setMessage('Close the project before deleting it.');
      return;
    }
    setConfirmReq({
      title: 'Delete project',
      message: `Delete the project "${ws.name}" and its folder "${ws.folderName}"? This cannot be undone.`,
      confirmLabel: 'Delete project',
      onConfirm: () => {
        void runVerb('Delete project', async () => {
          const root = await getWorkspaceHandle();
          if (!root) throw new Error('The workspace folder is not accessible.');
          await root.removeEntry(ws.folderName, { recursive: true });
          // A recents entry pointing at the deleted folder would be a row
          // that can only ever fail to open.
          forgetRecentProject(id);
          setRecent(readRecentProjects());
          const scan = await scanStoredWorkspace({ prompt: false });
          setWorkspaceProjects(scan.projects);
        });
      },
    });
  }, [workspaceProjects, project.project?.id, runVerb]);

  // ── Scene actions (§3.6) ──────────────────────────────────────────────
  // The dashboard is the only scene browser after Phase 13, so it must carry
  // the full set the Scene window had - and, crucially, the same unsaved-changes
  // guard. Switching scenes silently past a dirty draft is data loss.
  const sceneStore = getSceneStore();
  const sceneSnap = useSyncExternalStore(
    sceneStore?.subscribe ?? (() => () => {}),
    sceneStore?.getSnapshot ?? (() => null),
  );
  const [pendingSwitch, setPendingSwitch] = useState<(() => Promise<void>) | null>(null);
  const [nameDialog, setNameDialog] = useState<{ kind: 'rename' | 'saveAs'; id?: string; name: string } | null>(null);

  /** Run `action`, but stop at the confirm dialog while the draft is dirty. */
  const trySwitch = useCallback((action: () => Promise<void>) => {
    if (sceneSnap?.dirty) setPendingSwitch(() => action);
    else void action();
  }, [sceneSnap?.dirty]);

  const openScene = useCallback((id: string) => {
    if (!sceneStore) return;
    // Opening the document that is ALREADY open means one thing: the dashboard
    // is the only thing between the user and it. Close it and touch nothing —
    // no reload, no dirty guard, no editor leave/re-enter, unsaved edits
    // intact. `sameDocumentBase` compares by documentId alone (a rename is the
    // same document), and a false negative here merely reloads — the
    // conservative side of plan-711 risk 8.
    if (sameDocumentBase(getOpenDocumentBase(), documentBase(id, ''))) {
      closeProjectsDashboard();
      return;
    }
    trySwitch(async () => {
      // Close BEFORE the await, as `openAssetInEditor` does: the dashboard sits
      // at PROJECTS_DASHBOARD_ZINDEX (10500) above the info overlay (10000), so
      // closing it after the load means the "Loading…" overlay the SceneStore
      // shows is covered for its entire lifetime and the click appears dead.
      closeProjectsDashboard();
      await openDocumentAsWorkingScene(viewer, sceneStore, project.documents, id);
    });
  }, [sceneStore, trySwitch, project.documents, viewer]);

  /**
   * Create a project in the workspace, give it a scene, and open it.
   *
   * A brand-new project used to be a folder with a manifest and nothing else —
   * the user landed on an empty card with no obvious next click. It now carries
   * the default document (one empty GLB named "empty"), which is loaded as the
   * active scene right away, so there is something to build in from the start.
   *
   * The dashboard STAYS OPEN and drills into the new project. Creating a project
   * is not the same gesture as opening a document: the user asked for a project,
   * and dropping them into the viewport would hide the very screen they need to
   * add to it. This is why the scene load here does not go through `openScene` —
   * that verb closes the dashboard, which is exactly right for a click on a
   * document card and exactly wrong here.
   *
   * The document is created only after the project is OPEN: `createDocument`
   * writes through the project store, which needs the folder backend active.
   */
  const handleCreateProject = useCallback(() => {
    const name = (newProjectName ?? '').trim();
    if (!name) return;
    setNewProjectName(null);
    void runVerb('New project', async () => {
      const root = await getWorkspaceHandle();
      if (!root) throw new Error('No workspace folder is open — pick one first.');
      const dir = await root.getDirectoryHandle(canonicalNameOf(name), { create: true });
      const result = await createProjectFromScenes(dir, name, []);
      if (!result.ok) throw new Error(result.message);
      const scan = await scanStoredWorkspace({ prompt: false });
      setWorkspaceProjects(scan.projects);
      setWorkspaceMeta(getWorkspaceMeta());

      const opened = await store.openProjectFolder(dir);
      if (!opened) throw new Error('The project was created but could not be opened.');
      setProjectsView('project');

      // In the project ROOT ('' — a real target since the folder rule was
      // generalised), so the newborn project is one file, not a `scenes/` tree.
      const created = await createDocument(store, 'empty', { folder: '' });
      await store.rescanDocuments();
      await listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
      setProjectsSelection({ kind: 'document', documentId: created.documentId });
      await store.flush();

      // The load runs behind the dashboard. No dirty guard is needed and none is
      // wanted: the scene being replaced belongs to the project we just left, and
      // `openProjectFolder` above already ran its own guard over it.
      if (sceneStore) await sceneStore.openScene(created.documentId);
    });
  }, [newProjectName, runVerb, store, sceneStore]);

  /**
   * Open a base GLB.
   *
   * Goes through the same dirty guard as a scene: switching away from an edited
   * draft without asking is the same data loss whichever list the click came
   * from.
   *
   * It used to take a `published` flag and fork to `openPublishedExample()` for
   * the second identity space's rows. plan-731 2d removed both: an example is a
   * document, and a document opens the one way.
   */
  /**
   * Open a model card.
   *
   * `modelId` is a manifest **path**, not a URL, and it stays one: the base
   * handed to the SceneStore is `rvproject:<path>`, which that store re-resolves
   * on every load — into bytes for a self-contained GLB, or into a URL it then
   * owns (plan-709 §2.5). It used to resolve an object URL here and drop the
   * backend's `release()`, so every model opened from this list left its bytes
   * resident for the life of the tab.
   */
  /**
   * @param sourceUrl a URL the caller has already resolved, used INSTEAD of
   *   `rvproject:<path>`. The built-in demos (plan-445 F6) need it: their bytes
   *   come from the deploy root, not from the open project's backend, so the
   *   `rvproject:` sentinel would resolve them against the wrong folder. It is
   *   also why such an open records no document identity and no session
   *   memory — a demo is not a document of the project the user has open, and
   *   remembering it would send the next reload somewhere they never saved.
   */
  const openModel = useCallback((
    modelId: string,
    label: string,
    sourceUrl?: string,
  ) => {
    if (!sceneStore) return;
    // Same rule as `openScene`: the already-open model just closes the
    // dashboard. Compared through the path-derived id this verb itself records
    // below, so the two sides of the comparison can only agree or genuinely
    // differ.
    if (!sourceUrl
      && sameDocumentBase(getOpenDocumentBase(), projectDocumentBase(modelId, label))) {
      closeProjectsDashboard();
      return;
    }
    trySwitch(async () => {
      // Close first — same reason as `openScene` above: the load's own
      // "Loading…" overlay is invisible under the still-open dashboard.
      closeProjectsDashboard();
      await sceneStore.openBuiltin(sourceUrl ?? projectAssetUrl(modelId), label);
      // Say WHAT is now open, so a mode that takes over later opens the same
      // thing instead of starting from nothing.
      // This one STAYS, unlike `openScene`'s (plan-702 Phase 3). The funnel
      // covers only what reaches `openDocument`, and this verb reaches it for
      // exactly one of its outcomes: a manifest path that HAS a document row. A
      // model path without a row stays a `builtin` base and does not pass the
      // funnel, so it would not record that the session moved here. Removing
      // this call would leave the previous document's pair standing and send the
      // next reload back to a document the user had already navigated away from.
      setOpenDocumentBase(sourceUrl ? null : projectDocumentBase(modelId, label));
      if (!sourceUrl) rememberSession(project.project?.id, modelId, viewer.modes.activeMode);
    });
  }, [sceneStore, trySwitch, store, project.project?.id, viewer]);

  const deleteScene = useCallback((id: string, name: string) => {
    if (!sceneStore) return;
    // A destructive, irreversible action always asks first.
    setConfirmReq({
      title: 'Delete scene',
      message: `Delete the scene "${name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => {
        void runVerb('Delete scene', async () => {
          await sceneStore.delete(id);
          setProjectsSelection({ kind: 'none' });
          // Same two refreshes as `renameDocumentRow`, for the same field
          // finding: the tree and the cards render the document SCAN, not the
          // manifest — without the rescan the deleted card stands until the
          // next reload (2026-08-19 — "delete leaves the card").
          await store.rescanDocuments();
          await listLibrarySources()
            .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
        });
      },
    });
  }, [sceneStore, runVerb, store]);

  const duplicateScene = useCallback((id: string) => {
    if (!sceneStore) return;
    void runVerb('Duplicate scene', async () => {
      await sceneStore.duplicate(id);
      // The copy's card has the same scan dependency as the deleted card above.
      await store.rescanDocuments();
      await listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
    });
  }, [sceneStore, runVerb, store]);

  /**
   * Rename a document ROW — through `runVerb` and BOTH listing refreshes,
   * like every other asset verb.
   *
   * `SceneStore.rename` writes the file and the manifest row correctly, but it
   * cannot know about the dashboard's scans: without the rescan the tree, the
   * cards and the pane keep the old name until the next project open, and the
   * fire-and-forget call this replaces swallowed any failure into an unhandled
   * rejection (field finding 2026-08-14 — "rename does nothing").
   */
  const renameDocumentRow = useCallback((id: string, name: string) => {
    if (!sceneStore) return;
    void runVerb('Rename', async () => {
      await sceneStore.rename(id, name);
      await store.rescanDocuments();
      await listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
    });
  }, [sceneStore, runVerb, store]);

  const submitNameDialog = useCallback(async () => {
    if (!nameDialog || !sceneStore) return;
    const name = nameDialog.name.trim();
    if (!name) return;
    setNameDialog(null);
    if (nameDialog.kind === 'saveAs') {
      const next = pendingSwitch;
      setPendingSwitch(null);
      await sceneStore.saveAs(name);
      if (next) await next();
    } else if (nameDialog.id) {
      renameDocumentRow(nameDialog.id, name);
    }
  }, [nameDialog, sceneStore, pendingSwitch, renameDocumentRow]);

  // ── Catalogs (plan-703 §2.6, F11) ─────────────────────────────────────
  // Every attached library is a ROOT of the one tree now, not a card grid on a
  // second tab. `sources` is the memoised registry read, so `registryVersion`
  // already rides in through it — see the binding note at the top.
  //
  // **Every attached library, whatever attached it.**
  //
  // This list used to be filtered by origin: `config` (the catalogs
  // `_restorePlacements` wires up so a restored scene's placements resolve)
  // and `urlParam` (a `?library=` deep link) were hidden, on the reasoning
  // that neither is a library of *this project* and showing them made opening
  // a GLB in the planner grow a root that was not there before.
  //
  // The cost of that rule was worse than the problem it solved: the planner's
  // library window lists the store's catalogs unfiltered, so the two surfaces
  // disagreed about which libraries exist. A user who could see a library,
  // browse it and drag out of it in the planner found nothing under Libraries
  // here, with no error and nothing to act on — which reads as the dashboard
  // being broken, not as a policy. Provenance is worth showing; it is not
  // worth hiding a library over. One store, one list, both windows.
  //
  // The origin ladder still does its real job untouched — deciding what is
  // PERSISTED (`_persistUrls`) and what a project switch may swap out
  // (`applyProjectLibraries`). It just no longer decides what is VISIBLE.
  const catalogRoots = useMemo<CatalogRootInput[]>(() => sources.filter(({ providerId }) => {
    // The open project's OWN `library/` folder, published as a source so the
    // planner can browse it. Under the tabs it was a grid on the Assets tab;
    // as a tree root it is the project a second time — same name, same
    // contents, one row below the folder that already holds them. It is
    // dropped here rather than at the provider because the planner and the
    // asset picker still need the source.
    if (providerId === PROJECT_LIBRARY_PROVIDER_ID) return false;
    return true;
  }).map(({ providerId, source }) => {
    let entries: LibraryCatalogEntry[] = [];
    try {
      entries = source.listEntries();
    } catch {
      // One broken provider must not blank the whole tree (plan-702 §5.1 R4).
      entries = [];
    }
    return {
      providerId,
      sourceId: source.id,
      // A catalog that failed to load says so IN ITS ROW. `LibrarySource`
      // has carried `error` since plan-702, and the tree dropped it: a
      // rate-limited GitHub scan or a 404 arrived as a root with a name and
      // no children, indistinguishable from an empty library. The tree model
      // has no error channel of its own, so the reason rides in the label —
      // the one field that is guaranteed to reach the user's eye.
      label: source.error ? `${source.label} — ${source.error}` : source.label,
      // **Never writable, whatever the source says.** `writable` on a
      // `LibrarySource` means "assets can be written into it"; in the tree it
      // means "its folder structure can be rearranged", and no provider offers
      // that. Marking it false is what makes the refusal visible before the
      // drop rather than as an error afterwards.
      writable: false,
      remote: source.kind !== 'project' && source.kind !== 'local',
      sourceKind: source.kind,
      entries: entries.map(e => ({
        assetId: e.id,
        name: e.name,
        path: e.localPath || e.glbUrl || e.splatUrl || '',
      })),
    };
  }), [sources]);

  /** The registered source behind a catalog root id, or null. */
  const sourceOfRoot = useCallback((rootId: string) => sources.find(
    s => catalogRootId(s.providerId, s.source.id) === rootId) ?? null, [sources]);

  /**
   * Attach a library TO THE OPEN PROJECT — the dashboard's only destination.
   *
   * A library added here belongs to the project, not to this browser: the URL
   * goes into `project.json.libraries[]` and travels with the project to
   * whoever opens it next. The global `user` list still exists (the planner
   * subscribes into it), but nothing on this screen writes to it.
   *
   * Order matters. The catalog is loaded FIRST and the manifest is written
   * only once it resolved: a URL that 404s or is rate-limited must not be
   * committed to someone's project.json, where it would fail again for every
   * person who opens it. Returns the reason to show, or null on success.
   */
  const attachLibraryToProject = useCallback(async (url: string): Promise<string | null> => {
    const libStore = getLibraryStore();
    const wasAttached = libStore.catalogUrls.includes(url);
    await libStore.addCatalog(url, 'projectManifest');
    // `addCatalog` resolves on a failed fetch and records the reason instead.
    const failure = libStore.catalogErrors.get(url);
    if (failure) {
      if (!wasAttached) libStore.removeCatalog(url);
      return failure;
    }

    // `applyManifestDelta` returns null on a project it cannot write — a
    // read-only backend, or none at all. Roll the subscription back rather
    // than leave a library that is attached but not recorded anywhere.
    const next = await store.applyManifestDelta(current =>
      withProjectLibraries(current, [...readProjectLibraries(current), url]));
    if (!next) {
      if (!wasAttached) libStore.removeCatalog(url);
      return 'This project is read-only, so a library cannot be added to it.';
    }

    // Re-declare the project level from what was just written, so the store's
    // `_projectUrls` matches the manifest and the next project switch can swap
    // it out again.
    await libStore.applyProjectLibraries(readProjectLibraries(next));
    return null;
  }, [store]);

  /** Detach a library through whatever route its provider exposes. */
  const handleRemoveLibrary = useCallback((rootId: string, label: string) => {
    const registered = sourceOfRoot(rootId);
    const source = registered?.source;
    if (!registered || !source?.remove) return;
    setConfirmReq({
      title: 'Remove library',
      message: `Remove the library "${label}" from this viewer? Its files are not deleted.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        void runVerb('Remove library', async () => {
          await source.remove!();
          // A project library lives in `project.json`, so detaching it from
          // the store alone would bring it straight back on the next open.
          if (registered.providerId === GLOBAL_LIBRARY_PROVIDER_ID
            && readProjectLibraries(store.getProject()).includes(source.id)) {
            await store.applyManifestDelta(current => withProjectLibraries(
              current,
              readProjectLibraries(current).filter(u => u !== source.id),
            ));
          }
          // A selection pointing into the library that just went away would
          // leave the detail pane describing a dead source (plan-702 §2.7/R5).
          const group = { providerId: registered.providerId, sourceId: source.id };
          if (selectionPointsIntoGroup(dash.selection, group)
            || (dash.selection.kind === 'folder' && dash.selection.rootId === rootId)) {
            setProjectsSelection({ kind: 'none' });
          }
        });
      },
    });
  }, [sourceOfRoot, runVerb, dash.selection, store]);

  /** Re-scan a library that offers it. */
  const handleRefreshLibrary = useCallback((rootId: string) => {
    const source = sourceOfRoot(rootId)?.source;
    if (!source?.refresh) return;
    void runVerb('Refresh library', () => source.refresh!());
  }, [sourceOfRoot, runVerb]);

  // ── The document view (plan-413 §3.1) ─────────────────────────────────
  // What the search, the chips and the tag currently ask for. Three fields
  // rather than three closures so the memo below has one dependency for the
  // whole filter instead of one per control.
  const documentFilter = useMemo<DocumentFilterState>(
    () => ({ term: dash.search, chip: dash.chip, tag: dash.tag }),
    [dash.search, dash.chip, dash.tag],
  );

  /**
   * THE one list (§3.1) — every document of the open project, unfiltered.
   *
   * Unfiltered on purpose: the chips report counts, and a count computed from
   * the already-chipped list would change every time it was clicked. Since
   * Lauf 13 the chips are counted over the SELECTED FOLDER's contents instead
   * (`folderRows` below) — this list is what the detail pane and the
   * classification editor read.
   *
   * The rows come from `snapshot.documents`, the list phase 2 published. What
   * used to be two lists here — `project.models` and `project.scenes` — are two
   * sections of that one list, and the selection kinds stay `model` and `scene`
   * because they still name what the detail pane can DO with a row (a scene can
   * be renamed and deleted; a base model is opened and nothing else). The kinds
   * are internal identifiers; nothing the user reads says either word.
   *
   * Library documents ARE here since plan-703 Phase 6, unlike under the tabs:
   * the tree shows the project folder as it is, and `library/` is an ordinary
   * folder in it (decision 7). The project's own library is also a registered
   * catalog, but that catalog's root is a SIBLING of the project root, so the
   * two listings sit side by side instead of one hiding the other.
   */
  const documentRows = useMemo<DocumentRow[]>(() => {
    const rows: DocumentRow[] = [];

    for (const doc of project.documents) {
      rows.push({
        name: doc.name,
        classification: doc.classification,
        doc,
        // One key shape for every document — the row is addressed by its id,
        // wherever the file sits (placeless, plan-716/717). 'scene:' is the
        // historical prefix and is now the ONLY one: the 'published:' keys that
        // used to sit beside it were the second identity space plan-731 melted
        // into this very list.
        key: 'scene:' + doc.id,
      });
    }

    // ONE list, one identity (plan-731 2d). A second loop used to append the
    // published-example catalogue here whenever `backendKind === 'bundled'`, so
    // a row could arrive from either of two sources under either of two key
    // shapes. Both examples are `documents[]` rows now — including the dev-only
    // turntable fixture, which is why nothing disappeared from the dev
    // checkout's list when the loop went.

    return rows;
  }, [project.documents]);

  /**
   * Every tag anybody in this project used — the autocomplete source (F13).
   *
   * Deliberately project-wide and not folder-scoped, unlike the chips: this
   * feeds the classification editor's suggestions, and a folder-scoped list
   * would offer fewer tags the deeper you navigate, which is the opposite of
   * what an autocomplete is for.
   */
  const documentTags = useMemo(() => documentTagOptions(documentRows), [documentRows]);

  // ── The tree (plan-703 Phase 6, §2.6; folders-only since Lauf 13) ─────
  // The project folder is root 1, every attached catalog is a sibling root.
  //
  // The tree is built UNFILTERED. Phase 6 narrowed the listings so the tree
  // itself shrank under the search, which was right while the tree was also the
  // asset list. Now the assets are cards and the tree is the folder structure:
  // a structure that rearranges itself as you type is a structure you cannot
  // navigate, so the filter moved to the cards (see `folderCards`).

  /**
   * Paths `docs-index.json` points at.
   *
   * Read once per project, best-effort: a project without the file (most of
   * them) gets an empty list and no error. These are the rows whose move
   * rewrites the index instead of the manifest (§2.6.5, decision 23) — without
   * them the tree could not offer that move at all.
   */
  const [attachments, setAttachments] = useState<string[]>([]);
  useEffect(() => {
    const backend = store.getBackend();
    if (!dash.open || !backend) { setAttachments([]); return; }
    let alive = true;
    void (async () => {
      try {
        const resolved = await backend.readDocumentUrl(DOCS_INDEX_FILE);
        if (!resolved) { if (alive) setAttachments([]); return; }
        let text: string;
        try { text = await (await fetch(resolved.url)).text(); } finally { resolved.release(); }
        const paths = docsIndexPaths(parseDocsIndex(JSON.parse(text) as unknown));
        if (alive) setAttachments(paths);
      } catch {
        if (alive) setAttachments([]);
      }
    })();
    return () => { alive = false; };
  }, [dash.open, store, project.project?.id, project.documents]);

  /**
   * The project's CONNECT configuration files (`*.connect.json`), from the
   * backend's suffix walk. A config is a config by its file ENDING, never by
   * the folder it sits in (plan-718 reference model) — this listing is what
   * lets one show up as a card even though it is neither a manifest document
   * nor a docs-index target. Best-effort like the attachments above: a backend
   * without the walk (bundled, HTTP) simply reports none.
   */
  const [connectConfigs, setConnectConfigs] = useState<string[]>([]);
  /** The knowledge twin (`*.knowledge.md`) — same listing, same rules. */
  const [knowledgeFiles, setKnowledgeFiles] = useState<string[]>([]);
  /**
   * Everything else the project folder holds — the inert rows of the full view
   * (plan-445 F1/F2).
   */
  const [plainFiles, setPlainFiles] = useState<string[]>([]);
  /** Bumped by a write that changes the folder without changing a document. */
  const [listingBump, setListingBump] = useState(0);
  useEffect(() => {
    const backend = store.getBackend();
    if (!dash.open || !backend) {
      setConnectConfigs([]); setKnowledgeFiles([]); setPlainFiles([]);
      return;
    }
    let alive = true;
    // ONE walk for all three lists (plan-445 §5.1): the two per-ending walks
    // that used to stand here were two full traversals of the project folder
    // per dashboard open, and the full view would have made it three.
    void listProjectFiles(backend).then(listing => {
      if (!alive) return;
      setConnectConfigs(listing.configs);
      setKnowledgeFiles(listing.knowledge);
      setPlainFiles(listing.plainFiles);
    });
    return () => { alive = false; };
  }, [dash.open, store, project.project?.id, project.documents, listingBump]);

  /**
   * Per-document mtimes — the content VERSION of every card preview.
   *
   * The thumbnail cache is persistent and keyed by identity; without a
   * version segment the first render ever made was served forever, saves
   * included (defect 2026-08-19). The mtime is the honest version: it changes
   * exactly when the bytes do. Re-statted on every dashboard open and
   * whenever a save lands (`document-saved`), so the very next card render
   * misses the old cache entry and draws the new bytes.
   */
  const [docStats, setDocStats] = useState<ReadonlyMap<string, number>>(new Map());
  const [statsBump, setStatsBump] = useState(0);
  useEffect(
    () => viewer.on('document-saved', () => setStatsBump(t => t + 1)),
    [viewer],
  );
  useEffect(() => {
    const backend = store.getBackend();
    if (!dash.open || !backend) { setDocStats(new Map()); return; }
    let alive = true;
    void backend.statDocuments()
      .then(stats => {
        if (!alive) return;
        setDocStats(new Map(stats.flatMap(s =>
          typeof s.mtime === 'number' ? [[s.path, s.mtime] as const] : [])));
      })
      .catch(() => { if (alive) setDocStats(new Map()); });
    return () => { alive = false; };
  }, [dash.open, store, project.project?.id, project.documents, statsBump]);

  // ─── The "Built-in demos" root is GONE (plan-737 Phase 3) ──────────────
  //
  // plan-445 F6 added a read-only catalog root listing whatever
  // `BundledBackend.listModels()` returned. It was built for a world where the
  // demo could only ever be a deploy artefact, and it had two failure modes
  // that the demo-as-a-project move removes rather than mitigates:
  //
  //  - **In a customer delivery it lied.** The bundled backend there lists the
  //    CUSTOMER's models, so their own machines appeared under a heading that
  //    called them "Built-in demos".
  //  - **On the demo deploy it duplicated.** The rows were the open project's
  //    own rows, which is why it needed a `backendKind === 'bundled'` skip and
  //    a `dedupeBundledEntries()` pass to stay merely redundant.
  //
  // Since plan-737 the demo is an ordinary project — a writable
  // `projects/demo-realvirtual/` in a customer workspace, a normal row in the
  // project list, the open project itself on the hosted demo — so there is
  // nothing left for a synthetic read-only root to show that the project list
  // does not show better. Deleted outright by user decision (Grill Q6), with no
  // transition period; `bundledCatalogEntries`/`dedupeBundledEntries` and the
  // `bundledDocument` ref kind went with it.
  const treeCatalogs = catalogRoots;

  const tree = useMemo(() => buildDashboardTree({
    project: project.project
      ? {
          id: project.project.id,
          name: project.project.name,
          writable: project.writable,
          documents: project.documents,
          attachments,
          configs: connectConfigs,
          knowledge: knowledgeFiles,
          plainFiles,
          folders: readProjectFolders(project.project),
        }
      : null,
    catalogs: treeCatalogs,
  }), [project.project, project.writable, project.documents, attachments,
      connectConfigs, knowledgeFiles, plainFiles, treeCatalogs]);

  const treeRoots = useMemo(() => buildProjectTree(tree.roots), [tree.roots]);

  /**
   * The same roots, split into the two things the panel now names separately.
   *
   * One `buildProjectTree` call still produces them, so every rule that reads
   * the whole forest — the move verdicts, `findTreeNode`, `nearestFolderPath` —
   * keeps seeing one tree and cannot disagree with what is on screen. The split
   * is presentation: what the project holds, and what is merely attached to it,
   * stopped reading as one list once libraries got their own header.
   */
  const projectTreeRoots = useMemo(
    () => treeRoots.filter(r => r.rootKind !== 'catalog'), [treeRoots]);
  const libraryTreeRoots = useMemo(
    () => treeRoots.filter(r => r.rootKind === 'catalog'), [treeRoots]);

  /**
   * Which tree row the current selection is, or null.
   *
   * Derived from the selection rather than stored beside it: the selection is
   * also set from outside the tree (creating an asset selects it), and a second
   * field would be a copy that can disagree with the first.
   */
  const selectedTreePath = useMemo(() => {
    const sel = dash.selection;
    if (sel.kind === 'folder') {
      return sel.relPath === '' ? sel.rootId : `${sel.rootId}/${sel.relPath}`;
    }
    for (const [path, ref] of tree.refs) {
      if (sel.kind === 'asset' && ref.kind === 'catalogAsset'
        && ref.providerId === sel.providerId && ref.sourceId === sel.sourceId
        && ref.assetId === sel.assetId) return path;
      if (sel.kind === 'documentPath' && ref.kind === 'document' && ref.path === sel.path) return path;
      if (sel.kind === 'document' && ref.kind === 'document'
        && ref.documentId === sel.documentId) return path;
      // File selections (attachments, CONNECT configs) highlight their row
      // too — the hero chip's "reveal" ping needs the selected card to light
      // up, exactly like clicking an object field pings the asset in Unity.
      // Every non-document leaf answers to a `file` selection — the four
      // reference kinds and the inert plain files of the full view.
      if (sel.kind === 'file'
        && (ref.kind === 'attachment' || ref.kind === 'connectConfig'
          || ref.kind === 'knowledgeFile' || ref.kind === 'plainFile')
        && path === `${sel.rootId}/${sel.relPath}`) return path;
    }
    return null;
  }, [dash.selection, tree.refs]);

  /** Turn a tree row into the selection that describes it. */
  const handleTreeSelect = useCallback((node: ProjectTreeNode) => {
    const ref = tree.refs.get(node.path!);
    if (!ref) {
      setProjectsSelection({ kind: 'folder', rootId: node.rootId, relPath: node.relPath });
      return;
    }
    if (ref.kind === 'catalogAsset') {
      setProjectsSelection({
        kind: 'asset',
        providerId: ref.providerId,
        sourceId: ref.sourceId,
        assetId: ref.assetId,
      });
      return;
    }
    if (ref.kind === 'attachment' || ref.kind === 'connectConfig'
      || ref.kind === 'knowledgeFile' || ref.kind === 'plainFile') {
      setProjectsSelection({ kind: 'file', rootId: node.rootId, relPath: node.relPath });
      return;
    }
    // Selection follows the same placeless rule as opening: a row makes it a
    // document selection with the document verbs, wherever the file sits.
    const doc = documentByPath.get(ref.path);
    if (doc) {
      setProjectsSelection({ kind: 'document', documentId: doc.id });
    } else {
      setProjectsSelection({ kind: 'documentPath', path: ref.path });
    }
  }, [tree.refs, documentByPath]);

  /** Double-click: the row's primary verb, or nothing when it has none. */
  const handleTreeActivate = useCallback((node: ProjectTreeNode) => {
    const ref = tree.refs.get(node.path!);
    // TEMP open-perf instrumentation — stamp the click itself, so the gap to
    // the next phase timer is measurable.
    debug('perf', '[open-perf] card activate', {
      name: node.name, kind: ref?.kind ?? 'none', mode: viewer.modes.activeMode,
    });
    if (!ref) return;                                  // a folder just expands
    if (ref.kind === 'attachment') return;             // nothing opens a PDF here
    if (ref.kind === 'connectConfig') return;          // a config is inspected, not opened
    if (ref.kind === 'knowledgeFile') return;          // knowledge too — the pane describes it
    if (ref.kind === 'plainFile') return;              // inert (plan-445 F2) — no verb at all
    if (ref.kind === 'catalogAsset') {
      const source = sources.find(
        s => s.providerId === ref.providerId && s.source.id === ref.sourceId)?.source;
      const entry = source?.getEntry(ref.assetId) ?? null;
      if (!entry || entry.splatUrl || entry.virtual) return;
      openAssetInEditor(
        { providerId: ref.providerId, sourceId: ref.sourceId, assetId: ref.assetId },
        entry.name,
      );
      return;
    }
    // ANY document opens as the working scene — the section is a place, not a
    // type (plan-716/717), so where the file sits must not decide what a
    // double-click means. `openModel` is left for what has no row at all.
    const doc = documentByPath.get(ref.path);
    if (doc) openScene(doc.id);
    else openModel(ref.path, node.name);
  }, [tree.refs, sources, documentByPath, openAssetInEditor, openScene, openModel]);

  // ── The folder's contents, as cards (Lauf 13) ─────────────────────────
  /**
   * Which folder the cards are showing.
   *
   * Derived from the selection rather than stored beside it, for the same
   * reason `selectedTreePath` is: a second field would be a copy that can
   * disagree. Selecting a card therefore keeps the grid where it is — a card's
   * nearest folder IS the folder it is already in — and selecting nothing falls
   * back to the project root, so the screen is never blank on arrival.
   */
  const selectedFolderPath = useMemo(
    () => nearestFolderPath(treeRoots, selectedTreePath) ?? treeRoots[0]?.path ?? null,
    [treeRoots, selectedTreePath],
  );

  /**
   * Where the next new document lands, as a folder path.
   *
   * The SAME call the create verb makes, so the tooltip can never promise a
   * folder the click does not use — and since plan-717 Phase 3 it is literally
   * the same function rather than the same rule written twice.
   */
  const newDocumentFolder = useMemo(
    () => newDocumentFolderFor(project.project?.id, selectedFolderPath),
    [project.project?.id, selectedFolderPath],
  );

  /**
   * Create an empty document IN the folder the user is looking at, and reveal it.
   *
   * ONE creation verb (plan-716 §2.6) over ONE mechanism (plan-717 F7). Since
   * scene and asset are the same thing — a GLB document with a manifest row —
   * the user no longer picks a TYPE, and as of Phase 3 the code no longer picks
   * a create path either: `createDocument` writes the file and the row in one
   * go, wherever the folder in view happens to be. The blob-only create branch
   * that used to serve `library/` wrote bytes with no row and relied on a
   * following rescan to invent one — the single offender F1 names, and the
   * reason a library asset's identity used to move under a rename.
   *
   * The newborn is selected by its ROW id, which is what the tree indexes and
   * what survives the rename the user very often does next.
   */
  const handleNewDocument = useCallback(() => {
    const folder = newDocumentFolderFor(project.project?.id, selectedFolderPath);
    void runVerb('New document', async () => {
      const created = await createDocument(store, newDocumentNameFor(folder), { folder });
      // Two listings have to learn about the newborn before it can be shown:
      // the document scan (tree rows + folder cards) and the project-library
      // catalog (thumbnails, drag-into-scene). The row itself is already in the
      // manifest — this is the display catching up, not the registration.
      await store.rescanDocuments();
      await listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
      setProjectsSelection({ kind: 'document', documentId: created.documentId });
      // The manifest write is queued by the folder writer; wait for it so a
      // reload right after the click cannot lose the row.
      await store.flush();
    });
  }, [runVerb, store, project.project?.id, selectedFolderPath]);

  /** The folder's direct document/attachment rows, with what each one is. */
  const folderRows = useMemo(() => folderContents(treeRoots, selectedFolderPath).map(node => {
    const ref = tree.refs.get(node.path!);
    const doc = ref?.kind === 'document' ? documentByPath.get(ref.path) : undefined;
    return { node, ref, doc, name: node.name, classification: doc?.classification };
  }), [treeRoots, selectedFolderPath, tree.refs, documentByPath]);

  /** The folder's direct subfolders — pre-search, so the empty state can tell
   *  "empty" from "your search hid the subfolders". */
  const subfoldersInView = useMemo(
    () => folderSubfolders(treeRoots, selectedFolderPath),
    [treeRoots, selectedFolderPath],
  );

  /**
   * Chips of the folder in view, counted over what the search left.
   *
   * Folder-scoped since Lauf 13, because the chips now cut the cards and a
   * count that described the whole project would name a number the grid never
   * shows. Counted after the search but before the chip and the tag: the search
   * is the coarser gesture the chips live inside, and a count that changed as
   * you clicked a chip would answer a different question every time.
   *
   * "Unclassified" over a folder therefore means "the rows in THIS folder whose
   * bytes carry no level" — an attachment and a catalog entry, which can carry
   * no classification at all, are counted there.
   */
  const folderChips = useMemo(
    () => documentChipOptions(
      folderRows.filter(r => matchesSearchTerm(r.name, dash.search)),
      dash.chip,
    ),
    [folderRows, dash.search, dash.chip],
  );

  /** Announce a card drag to the tree, which owns every drop. */
  const [cardDragPath, setCardDragPath] = useState<string | null>(null);

  const folderCards = useMemo<FolderCardModel[]>(
    () => folderRows
      .filter(row => matchesDocumentFilter(row, documentFilter))
      .map(({ node, ref, doc }) => {
        const path = node.path!;
        const catalogEntry = ref?.kind === 'catalogAsset'
          ? sources.find(s => s.providerId === ref.providerId && s.source.id === ref.sourceId)
            ?.source.getEntry(ref.assetId) ?? null
          : null;
        // A project document is not a catalog entry and never will be; the
        // card only ever reads `name`/`thumbnailUrl`/`category` off it, so the
        // honest thing is a minimal stand-in rather than a fake catalog row.
        const entry: LibraryCatalogEntry = catalogEntry ?? {
          id: path,
          name: node.name,
          category: 'custom',
          ...(doc?.thumbnail ? { thumbnailUrl: doc.thumbnail } : {}),
        };
        // A CONNECT config / knowledge file is what its ENDING says (plan-718):
        // it gets the stated glyph tile instead of a preview, and no Open verb
        // — the detail pane is where it is inspected, double-click opens
        // nothing.
        const isConnectConfig = ref?.kind === 'connectConfig';
        const isKnowledgeFile = ref?.kind === 'knowledgeFile';
        const isRefFile = isConnectConfig || isKnowledgeFile;
        // Defence line 1 of three (plan-445 §2.4): an inert row gets an EMPTY
        // verb set, so the card shows no menu at all rather than a menu whose
        // every entry refuses.
        const isInert = node.inert === true;
        const menuActions: ProjectCardMenuAction[] = isRefFile || isInert
          ? []
          : [{ key: 'open', label: 'Open', onClick: () => handleTreeActivate(node) }];
        // Rename left the tree with the row it belonged to; the card is where
        // it lives now. Folders keep F2 in the tree — the verb did not move,
        // only the thing it acts on did. Config cards rename too (their names
        // are minted at creation): the tree move repoints `connectRef`s, and
        // CONNECT recomputes a profile's internal `Ref` from the path it
        // discovered the file at.
        // Since plan-725 that discovery is a project-wide `*.connect.json` walk
        // and it happens again on notify, so a rename reaches a RUNNING gateway
        // — which is what makes "nothing goes stale" true. Before plan-725 the
        // discovery was a `connect/`-folder scan performed once at startup, and
        // the sentence quietly meant "nothing goes stale after the next
        // restart". The write path that carries this is `replaceManifest`
        // (§2.7, F7); without its notify the claim above is false again.
        // Offered exactly where the commit would be accepted — `isRenamableInTree`
        // is the name-independent half of `canRenameInTree` itself, so a card
        // can no longer offer a rename the write path then refuses (F4).
        if (isRenamableInTree(treeRoots, path) && node.rootId === project.project?.id) {
          menuActions.push({
            key: 'rename',
            label: 'Rename…',
            onClick: () => setAssetDialog({ kind: 'renameNode', relPath: path, value: node.name }),
          });
        }
        // A card shows a picture only when one already exists — a catalog that
        // ships thumbnails, or a document with a saved `thumbnail`. Everything
        // else stayed blank because the generator `ProjectCard` already owns
        // was never armed: it needs an identity to cache under and a way to
        // fetch the bytes, and the grid passed neither. Both are cheap here.
        // A catalog asset resolves through its own source (the same call the
        // library grid used); a project document has no source, so it resolves
        // through the backend and is keyed in a namespace of its own — its
        // path is unique within the project, which is all the key needs.
        const backend = store.getBackend();
        const thumbnailKey: ThumbnailKeyParts | undefined = ref?.kind === 'catalogAsset'
          ? {
            projectId: project.project?.id ?? NO_PROJECT,
            providerId: ref.providerId,
            sourceId: ref.sourceId,
            assetId: ref.assetId,
          }
          : node.kind === 'document' && backend
            ? {
              projectId: project.project?.id ?? NO_PROJECT,
              providerId: 'project-document',
              sourceId: node.rootId,
              assetId: path,
              // The content version (file mtime): a saved document gets a NEW
              // key, so the persistent cache misses and re-renders instead of
              // serving the pre-save picture forever.
              ...(docStats.get(node.relPath) !== undefined
                ? { version: String(docStats.get(node.relPath)) }
                : {}),
            }
            : undefined;
        const resolveThumbnail = ref?.kind === 'catalogAsset'
          ? async () => {
            const source = sources.find(
              s => s.providerId === ref.providerId && s.source.id === ref.sourceId)?.source;
            if (!source) return null;
            const resolved = await source.resolveAsset(ref.assetId, 'thumbnail');
            return { url: resolved.url, release: resolved.revokeUrl };
          }
          : node.kind === 'document' && backend
            ? async () => backend.readDocumentUrl(node.relPath)
            : undefined;
        return {
          key: path,
          entry,
          thumbnailKey,
          resolveThumbnail,
          ...(isConnectConfig ? { glyph: 'connect' as const } : {}),
          ...(isKnowledgeFile ? { glyph: 'knowledge' as const } : {}),
          // The document's own tier is the whole answer since plan-737. The
          // `isBundled` half beside it described a built-in-demo ROW, and there
          // are no such rows any more.
          tier: doc?.tier === 'bundled' ? 'bundled' : 'user',
          selected: selectedTreePath === path,
          onSelect: () => handleTreeSelect(node),
          onOpen: () => handleTreeActivate(node),
          menuActions,
          // A config/knowledge card is draggable even when its FILE may not
          // move (a reserved-folder row): the drag then carries only the
          // reference payload for the hero card's Unity-style assignment,
          // never a tree move.
          // …but never an inert one: it has no move to offer, and a drag that
          // can only be refused is a broken promise.
          draggable: (node.writable || isRefFile) && !isInert,
          onDragStart: (e: React.DragEvent) => {
            // What travels under the cursor is the collapsed chip — type icon
            // + name — not a ghost of the whole card.
            setDragChip(e.dataTransfer, {
              label: node.name,
              kind: isConnectConfig ? 'connect' : isKnowledgeFile ? 'knowledge' : 'document',
            });
            if (isConnectConfig) {
              e.dataTransfer.setData(CONNECT_CONFIG_DRAG_TYPE, node.relPath);
            }
            if (isKnowledgeFile) {
              e.dataTransfer.setData(KNOWLEDGE_FILE_DRAG_TYPE, node.relPath);
            }
            if (node.writable) {
              setCardDragPath(path);
              e.dataTransfer.effectAllowed = isRefFile ? 'all' : 'move';
            } else {
              e.dataTransfer.effectAllowed = 'link';
            }
          },
          onDragEnd: () => setCardDragPath(null),
        };
      }),
    [folderRows, documentFilter, sources, selectedTreePath, project.project?.id,
      store, docStats, handleTreeSelect, handleTreeActivate, treeRoots],
  );

  /**
   * Navigation tiles for the subfolders, shown AHEAD of the asset cards. A
   * folder holding nothing but subfolders (the demo's `library/`) used to
   * read as "This folder is empty" — true of its direct documents, false of
   * the folder. Only the search cuts them: the chips and the classification
   * filter describe documents, and a folder carries neither. Click navigates
   * — the same thing clicking the folder's tree row does — so the grid and
   * the tree stay one navigation model, not two.
   */
  const subfolderTiles = useMemo<FolderTileModel[]>(
    () => subfoldersInView
      .filter(node => matchesSearchTerm(node.name, dash.search))
      .map(node => {
        const path = node.path!;
        const menuActions: ProjectCardMenuAction[] = node.inert === true
          ? []
          : [{ key: 'open', label: 'Open', onClick: () => handleTreeSelect(node) }];
        if (isRenamableInTree(treeRoots, path) && node.rootId === project.project?.id) {
          menuActions.push({
            key: 'rename',
            label: 'Rename…',
            onClick: () => setAssetDialog({ kind: 'renameNode', relPath: path, value: node.name }),
          });
        }
        return {
          key: path,
          name: node.name,
          holdsSomething: node.hasContent ?? node.children.length > 0,
          onOpen: () => handleTreeSelect(node),
          menuActions,
        };
      }),
    [subfoldersInView, dash.search, treeRoots, project.project?.id, handleTreeSelect],
  );

  // ── The move write path (plan-703 Phase 5 rest, F12/F13) ──────────────
  /**
   * The IO `applyTreeMove` writes through, or null when nothing can be written.
   *
   * Built per call rather than memoised: it closes over the backend and the
   * manifest as they are *now*, and a stale closure here would write a move
   * into a project that is no longer open.
   */
  const treeMoveIO = useCallback((): TreeMoveIO | null => {
    const backend = store.getBackend();
    if (!backend?.writable) return null;
    const readBytes = async (relPath: string): Promise<Blob | null> => {
      const resolved = await backend.readDocumentUrl(relPath);
      if (!resolved) return null;
      try { return await (await fetch(resolved.url)).blob(); } finally { resolved.release(); }
    };
    return {
      readBytes,
      writeBytes: async (relPath, blob) => {
        // Overwrite-by-design: the docs pane writes what the user just typed
        // over whatever is there, and the editor holds no revision to compare
        // against. The MCP twin of this seam DOES carry one (plan-736 Phase 1),
        // because an agent's blind overwrite is the case worth refusing.
        await backend.writeDocument(
          relPath, new Uint8Array(await blob.arrayBuffer()), { expectedRevision: 'any' });
      },
      deleteBytes: relPath => backend.deleteDocument(relPath),
      readManifest: async () => store.getProject(),
      writeManifest: next => store.replaceManifest(next),
      readDocsIndex: async () => {
        const blob = await readBytes(DOCS_INDEX_FILE);
        if (!blob) return null;
        try { return JSON.parse(await blob.text()) as unknown; } catch { return null; }
      },
      writeDocsIndex: async (index: DocsIndex) => {
        // The attachment index is machinery, rewritten wholesale from state the
        // caller already holds — there is nothing to merge and nothing to lose.
        await backend.writeDocument(
          DOCS_INDEX_FILE,
          new TextEncoder().encode(JSON.stringify(index, null, 2)),
          { expectedRevision: 'any' },
        );
      },
    };
  }, [store]);

  /**
   * Move or rename a tree row — the one write both verbs share.
   *
   * A rename IS a move: same node, destination in the same folder. So both
   * arrive here, `planTreeMove` turns the destination into the plan (manifest
   * row for a GLB, `docs-index.json` row for anything else) and `applyTreeMove`
   * performs it. The tree component has already run `canMoveInTree` /
   * `canRenameInTree`; the verdict is re-stated here rather than re-derived
   * because the plan only ever reads `from` and `to` off it.
   */
  const runTreeEdit = useCallback((
    label: string,
    node: ProjectTreeNode,
    to: string,
    /** Runs only on SUCCESS (runVerb swallows failures into the snackbar). */
    onDone?: (to: string) => void,
  ) => {
    void runVerb(label, async () => {
      const io = treeMoveIO();
      if (!io) throw new Error('This project is read-only.');
      if (node.rootId !== project.project?.id) {
        throw new Error('A catalog cannot be restructured from here.');
      }
      const plan = planTreeMove(treeRoots, node.path!, { ok: true, from: node.relPath, to });
      const outcome = await applyTreeMove(io, plan);
      // Declared folders travel with the move too. `applyTreeMove` rewrites
      // document paths, and an EMPTY folder has none — without this a renamed
      // empty folder snapped back to its old name on the next rebuild, and a
      // moved one reappeared at its old place.
      if (node.kind === 'folder') {
        const from = node.relPath;
        await store.applyManifestDelta((current) => {
          const remapped = readProjectFolders(current).map(p =>
            p === from ? to : (p.startsWith(`${from}/`) ? to + p.slice(from.length) : p));
          return withProjectFolders(current, remapped);
        });
      }
      // The document scan AND the provider listing both re-read, or the tree
      // row, the card and the pane keep the old name until the next open.
      await store.rescanDocuments();
      await listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
      // Those two refresh the LISTINGS. Whatever renders the LIVING document —
      // the hero card, the hierarchy card — reads the open document's own name,
      // which no rescan touches: renaming the open document from the tree left
      // both on the old title until the next reload. `SceneStore.rename` adopts
      // its own rename inline; this is the same adoption for the tree route.
      sceneStore?.adoptDocumentRename();
      onDone?.(to);
      if (outcome.docsIndexRows > 0) {
        setMessage(`Moved, and repointed ${outcome.docsIndexRows} document link(s).`);
      }
    });
  }, [runVerb, treeMoveIO, treeRoots, project.project?.id, store, sceneStore]);

  /**
   * Create a CONNECT configuration in the folder in view — the sibling of
   * `handleNewDocument`, with the same minted-name philosophy as folders:
   * `connect`, `connect-2`, … and rename-in-place afterwards. The file is a
   * minimal, valid profile in exactly the shape CONNECT's
   * `ProjectConnectStore.WriteProfile` produces, written create-only
   * (`expectedRevision: null`) so a race with an existing file refuses
   * instead of overwriting.
   */
  const handleNewConnectConfig = useCallback(() => {
    const folder = newDocumentFolderFor(project.project?.id, selectedFolderPath);
    void runVerb('New CONNECT configuration', async () => {
      const backend = store.getBackend();
      const rootId = project.project?.id;
      if (!backend?.writable || !rootId) throw new Error('This project is read-only.');
      const taken = new Set(connectConfigs.map(p => p.toLowerCase()));
      const relFor = (name: string) =>
        folder ? `${folder}/${name}.connect.json` : `${name}.connect.json`;
      let name = 'connect';
      for (let n = 2; taken.has(relFor(name).toLowerCase()); n++) name = `connect-${n}`;
      const rel = relFor(name);
      const payload = {
        $schema: 'rv-connect-config/1.0',
        Name: name,
        Interfaces: [],
        Mirrors: [],
        Mappings: [],
      };
      await backend.writeDocument(
        rel,
        new TextEncoder().encode(JSON.stringify(payload, null, 2)),
        { expectedRevision: 'create' },
      );
      // Show it NOW — the listing effect re-scans later and merely confirms.
      setConnectConfigs(prev => (prev.includes(rel) ? prev : [...prev, rel]));
      setProjectsSelection({ kind: 'file', rootId, relPath: rel });
      // plan-725 §2.7 — this is the ONE config-bearing write in the app that
      // never touches the manifest: a raw `writeDocument` and nothing else. No
      // notify site in the project store can see it, so it says so itself, or
      // the file a user just made stays invisible to a running gateway until
      // some unrelated write or a restart happens to reveal it.
      store.notifyProjectChanged();
    });
  }, [runVerb, store, project.project?.id, selectedFolderPath, connectConfigs]);

  /**
   * Create a folder inside `parent` — the right-click verb.
   *
   * The name is minted rather than asked for: a folder is cheap, F2 renames it
   * in place, and a modal between the click and the result would be the slowest
   * part of making one. `New Folder`, `New Folder 2`, … so a second click never
   * collides with the first — collisions matter here because two entries of the
   * same path are ONE folder, and the click would silently do nothing.
   */
  const handleNewFolder = useCallback((parent: ProjectTreeNode) => {
    void runVerb('New folder', async () => {
      if (!project.writable) throw new Error('This project is read-only.');
      if (parent.rootId !== project.project?.id) {
        throw new Error('A library cannot hold new folders.');
      }
      // The row's own folder: a folder holds its children, a document sits
      // beside its siblings — so a right-click on either means the same place.
      const base = parent.kind === 'document' || parent.kind === 'file'
        ? normaliseFolderPath(parent.relPath.split('/').slice(0, -1).join('/'))
        : normaliseFolderPath(parent.relPath);
      const taken = new Set(
        (findTreeNode(treeRoots, parent.kind === 'root' || parent.kind === 'folder'
          ? parent.path! : `${parent.rootId}/${base}`)?.children ?? [])
          .map(c => c.name.toLowerCase()),
      );
      let name = 'New Folder';
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New Folder ${n}`;
      const path = base ? `${base}/${name}` : name;

      await store.applyManifestDelta(current =>
        withProjectFolders(current, [...readProjectFolders(current), path]));
      setProjectsSelection({ kind: 'folder', rootId: parent.rootId, relPath: path });
    });
  }, [runVerb, project.writable, project.project?.id, treeRoots, store]);

  /** Right-clicked row + where to anchor the menu, or null when it is closed. */
  const [treeMenu, setTreeMenu] = useState<
    { node: ProjectTreeNode; x: number; y: number } | null>(null);

  const handleTreeContextMenu = useCallback((node: ProjectTreeNode, e: React.MouseEvent) => {
    setTreeMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  /**
   * Right-click on the empty part of the card grid (user request 2026-09-01).
   *
   * The tree has had a context menu since Lauf 13, the cards since Phase 6, and
   * the one surface in between — the folder's own blank space, which is exactly
   * where someone stands when they want to CREATE something — had none. It
   * carries the folder verbs, i.e. the same ones the toolbar offers, so the
   * menu teaches the toolbar rather than hiding an alternative.
   */
  const [gridMenu, setGridMenu] = useState<{ x: number; y: number } | null>(null);
  const handleGridContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setGridMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // ── "Show in Explorer" (plan-446 Phase 2) ────────────────────────────
  /**
   * Whether the verb exists AT ALL on this screen — capability plus local
   * origin. Not "may this row be revealed": a row of somebody else's catalog
   * root fails a second, per-node condition below.
   */
  const revealAvailable = useMemo(
    // The store-integrated helper, not a second copy of the rule: the memo's
    // dependencies are exactly the three snapshot fields it reads, so a
    // refusal that clears `revealSupported` retires the verb on the next
    // render without a reload.
    () => canRevealInExplorerNow(),
    [connectSnap.state, connectSnap.revealSupported, connectSnap.serverUrl],
  );

  /**
   * Reveal a row of the OPEN project. Failures are silent by design (§Phase 2):
   * the gateway's refusal clears the capability inside the store, so the entry
   * is simply gone the next time the menu opens — a dialog for a convenience
   * the user can retry by looking at the folder themselves would cost more than
   * it explains.
   */
  const handleRevealInExplorer = useCallback((node: ProjectTreeNode) => {
    void revealInExplorer(node.relPath ?? '');
  }, []);

  /**
   * The CONNECT settings window, opened from a `*.connect.json` row with that
   * file preselected (plan-446 Phase 3). A path, not a profile NAME: the
   * manifest binds documents to FILES, and the window resolves the file to
   * whichever profile the gateway loaded from it.
   */
  const [connectOptions, setConnectOptions] = useState<{ ref: string | null } | null>(null);

  /**
   * The verbs the right-clicked row can actually perform — and only those.
   *
   * Refused verbs are ABSENT, not disabled (plan-445 F4). A greyed-out entry is
   * a promise the row cannot keep, and on a read-only catalog or an inert
   * full-view file the entire menu would have consisted of them; the empty list
   * therefore also suppresses the menu itself, which is defence line 1 of the
   * inert rule (§2.4).
   *
   * Rename asks {@link isRenamableInTree} — the name-independent half of
   * `canRenameInTree` — so the verb appears exactly where the commit is
   * accepted, rather than restating the rule in a second place that can drift.
   *
   * "Show in Explorer" (plan-446 F3, merged into this list on 2026-08-24)
   * follows the same absence rule: it appears only when CONNECT can do it AND
   * this page is local — a viewer opened from another machine would otherwise
   * open a window on the plant PC nobody is standing at. Rows of a CATALOG
   * root are excluded (not inside the project CONNECT serves), and inert
   * full-view rows keep their no-verbs guarantee from plan-445.
   */
  const treeMenuVerbs = useMemo<Array<{ key: string; label: string; run: () => void }>>(() => {
    const node = treeMenu?.node;
    if (!node) return [];
    const verbs: Array<{ key: string; label: string; run: () => void }> = [];
    const ownProject = node.rootId === project.project?.id;
    if (ownProject && project.writable && node.writable
      && (node.kind === 'root' || node.kind === 'folder'
        || node.kind === 'document' || node.kind === 'file')
      && !node.inert) {
      verbs.push({ key: 'newFolder', label: 'New Folder', run: () => handleNewFolder(node) });
    }
    if (ownProject && isRenamableInTree(treeRoots, node.path)) {
      verbs.push({
        key: 'rename',
        label: 'Rename…',
        run: () => setAssetDialog({ kind: 'renameNode', relPath: node.path!, value: node.name }),
      });
    }
    if (revealAvailable && ownProject && !node.inert) {
      verbs.push({
        key: 'reveal',
        label: 'Show in Explorer',
        run: () => handleRevealInExplorer(node),
      });
    }
    return verbs;
  }, [treeMenu, treeRoots, project.project?.id, project.writable, handleNewFolder,
    revealAvailable, handleRevealInExplorer]);

  const handleTreeMove = useCallback(
    (node: ProjectTreeNode, to: string) => runTreeEdit('Move', node, to),
    [runTreeEdit],
  );
  const handleTreeRename = useCallback(
    (node: ProjectTreeNode, to: string) => runTreeEdit('Rename', node, to),
    [runTreeEdit],
  );

  /**
   * Rename a library asset — the one commit the dialog and the detail pane's
   * inline title edit share.
   *
   * ## One route, because the row is guaranteed (plan-717 F6)
   *
   * Always through the TREE machinery: `applyTreeMove` writes the manifest FIRST
   * (so every refusal aborts before a byte moves), repoints the row's `path`,
   * makes its `name` follow the new stem and leaves the `id` alone — and that
   * untouched id is the whole reason a rename no longer breaks a reference (F8).
   *
   * The blob-only fallback that used to stand here for "a file no scan has
   * listed yet" is gone with the state it served. Since Phase 1 every file in a
   * writable project is adopted into a row before it can be shown, so the
   * fallback could only ever fire for a row that does not exist — and when it
   * fired it renamed the bytes underneath the id, which is exactly the failure
   * this plan exists to end. A missing tree node is now reported, not routed
   * around.
   *
   * Collections need no carry-over any more either: they live on the row the
   * move repoints (§2.4), so the sidecar carry-over has nothing left to carry.
   */
  const renameLibraryAsset = useCallback((relPath: string, rawName: string) => {
    let fileName = rawName.trim();
    if (!fileName) return;
    // A name typed without an extension keeps the original one — renaming
    // "Belt.glb" to "Belt 2" must not produce a file no scan will list.
    const dot = relPath.lastIndexOf('.');
    const ext = dot > 0 ? relPath.slice(dot) : '';
    if (ext && !/\.[a-z0-9]+$/i.test(fileName)) fileName += ext;

    const projId = project.project?.id;
    const treePath = projId ? `${projId}/${LIBRARY_FOLDER}/${relPath}` : null;
    const node = treePath ? findTreeNode(treeRoots, treePath) : null;
    if (!node || !treePath) {
      setMessage(`Rename refused: "${relPath}" is not part of this project's tree.`);
      return;
    }
    const verdict = canRenameInTree(treeRoots, treePath, fileName);
    if (!verdict.ok) {
      if (verdict.reason !== 'unchanged') setMessage(`Rename refused: ${verdict.reason}.`);
      return;
    }
    runTreeEdit('Rename asset', node, verdict.to, (to) => {
      // Follow the selection to the new path, or the detail pane would
      // describe an asset that no longer exists.
      setProjectsSelection({
        kind: 'asset',
        providerId: PROJECT_LIBRARY_PROVIDER_ID,
        sourceId: projId ?? '',
        assetId: `project:${to}`,
      });
    });
  }, [runTreeEdit, treeRoots, project.project?.id]);

  /** Confirm handler of the one-field asset dialog (rename / collections). */
  const submitAssetDialog = useCallback(() => {
    if (!assetDialog) return;
    const { kind, relPath, value } = assetDialog;
    setAssetDialog(null);
    if (kind === 'collections') {
      // The store, not the backend: collections live on the manifest row now
      // (§2.4). `runAssetOp` still wraps it — the writable check and the two
      // listing refreshes afterwards are the same for every asset verb.
      void runAssetOp('Set collections', () => setAssetCollections(store, relPath, value.split(',')));
      return;
    }
    renameLibraryAsset(relPath, value);
  }, [assetDialog, runAssetOp, renameLibraryAsset, store]);

  /**
   * "Rename…" on a card — the tree's F2 for a row that is no longer in the tree.
   *
   * Runs the SAME `canRenameInTree` the inline editor runs and the same write
   * path afterwards. A refused name reports through the snackbar rather than
   * keeping an editor open, because a dialog that has already closed has no
   * editor to keep.
   */
  const submitNodeRename = useCallback(() => {
    const req = assetDialog;
    setAssetDialog(null);
    if (!req || req.kind !== 'renameNode') return;
    const node = findTreeNode(treeRoots, req.relPath);
    if (!node) return;
    const verdict = canRenameInTree(treeRoots, req.relPath, req.value);
    if (!verdict.ok) {
      if (verdict.reason !== 'unchanged') setMessage(`Rename refused: ${verdict.reason}.`);
      return;
    }
    handleTreeRename(node, verdict.to);
  }, [assetDialog, treeRoots, handleTreeRename]);

  // ── Duplicate ids (plan-703 §2.5, Phase 5 rest) ───────────────────────
  /**
   * Two documents claiming one id, reported once per open project.
   *
   * §2.5's rule is that a collision is an error WITH A MESSAGE, never a silent
   * alias — the Unity-GUID fall pattern of §8. `assertNoDocumentIdCollisions`
   * is the throwing form, for a caller that must not proceed; at project-open
   * there is nothing to abort, so the finding goes to the Problems panel, which
   * is where the user can see it and act on it.
   */
  useEffect(() => {
    reportDocumentIdCollisions(findLocalIdCollisions(project.project));
  }, [project.project]);

  // ── The resume rule (plan-703 §2.6.3, decisions 3 and 24; F15) ────────
  /**
   * What to show once a project the user just opened has loaded.
   *
   * The order is `resolveResumeTarget`'s, not this file's: URL beats the
   * remembered pair beats `defaultModel`, and a kiosk (`modeLocked`) takes
   * `defaultModel` whatever the other two say. All this effect adds is the two
   * things the rule cannot know — whether the named asset is actually in this
   * project, and how to open it.
   *
   * Armed only by an explicit open (`pendingResumeRef`). A project that becomes
   * open some other way — a restore on reload, a plugin — is left alone: the
   * resume is an answer to "the user just opened this", not to "a project
   * exists".
   */
  useEffect(() => {
    if (!pendingResumeRef.current) return;
    const projectId = project.project?.id;
    if (!projectId) return;
    pendingResumeRef.current = false;

    const target = resolveResumeTarget({
      search: window.location.search,
      remembered: readRememberedSession(projectId),
      // What the project itself last had open. Without it a switch into a
      // project this browser has never opened has nothing to resume and lands
      // on the deployer's `defaultModel` — a document out of another project.
      projectActive: project.project?.activeSceneId ?? null,
      // plan-721 §2.4: the PROJECT's own start document beats the global
      // `settings.json` one, and the rule is identical at BOTH call sites of
      // `resolveResumeTarget` — this one and the boot in `main.ts`. On an
      // appliance the dashboard is unreachable under the kiosk lock, but the
      // lock is a config flag a commissioning session can drop, and a rule
      // that held in only one of the two places would be a rule that depends
      // on how the project was opened.
      defaultModel: projectStartDocument(project.project) ?? getAppConfig().defaultModel,
      modeLocked,
      // Same rule at both call sites: a demo deployment always resumes into
      // its start document, never into the visitor's last session.
      demoProject: project.project?.kind === 'demo',
    });
    if (!target.asset) return;

    // Addressed by path or by id: a URL names a path, a remembered pair may
    // hold either, and refusing one of the two would make the rule depend on
    // which spelling happened to be stored. The rule itself lives in
    // `findStartDocument` (plan-726 F12) — this is one of THREE call sites that
    // had it inline, and three copies is how three answers start to differ.
    const doc = findStartDocument(project.documents, target.asset);
    if (!doc) return;

    // The mode is restored ONLY from the remembered pair — `resolveResumeTarget`
    // is what guarantees that; a URL and a `defaultModel` both come back with
    // `mode: null`, so this line cannot relocate anybody by accident.
    if (target.mode) void viewer.modes.requestMode(target.mode);
    // Same rule as the tree: a document is a document, wherever it sits.
    openScene(doc.id);
  }, [project.project?.id, project.project?.activeSceneId, project.documents,
      modeLocked, viewer, openScene, openModel]);

  // ── The hero band (plan-709 F3, project screen only) ──────────────────
  /**
   * Click on the hero card: reveal what is open, do not reopen it.
   *
   * Selecting the row is all it takes — the folder the cards show is derived
   * from the selection, so the grid follows to the asset's own folder without a
   * second piece of state to keep in step.
   *
   * Every base kind that HAS a row gets a branch: a library asset opened in
   * the editor is a `providerAsset`, a project-library GLB a `libraryGlb`
   * (whose `relPath` is the catalog's asset id), a planner document a
   * `projectDocument`. Only `builtinModel` and `empty` stay silent — a
   * published example and an unsaved scratch have no row to select.
   *
   * The band renders on the PROJECT screen only (user decision after
   * plan-709): the overview lists projects, not documents, so "what is open"
   * has no row to reveal there and the band would only push the list down.
   */
  const handleHeroReveal = useCallback(() => {
    const base = getOpenDocumentBase();
    if (!base) return;
    // Every owned document has a row of its own, and since plan-711 F1 it has
    // an identity to be recognised by — so it gets a branch rather than falling
    // silently out of the reveal. The three former kinds are one branch since
    // plan-716 §2.6, and the order inside it preserves what each of them did:
    // a slot-addressed document reveals by ID; a path-addressed one looks its
    // row up and reveals it as a scene or a model depending on the SECTION the
    // manifest puts it in; a library path with no row falls through to the
    // catalog search the former `libraryGlb` branch ended in.
    if (base.kind === 'document') {
      if (!base.path) {
        setProjectsSelection({ kind: 'document', documentId: base.documentId });
        return;
      }
      const doc = documentByPath.get(base.path);
      if (doc) {
        // Placeless like the tree: a row reveals as a document, wherever it sits.
        setProjectsSelection({ kind: 'document', documentId: doc.id });
        return;
      }
      const libraryRelative = base.path.startsWith('library/')
        ? base.path.slice('library/'.length)
        : null;
      if (libraryRelative !== null) {
        for (const ref of tree.refs.values()) {
          if (ref.kind === 'catalogAsset' && ref.assetId === libraryRelative) {
            setProjectsSelection({
              kind: 'asset',
              providerId: ref.providerId,
              sourceId: ref.sourceId,
              assetId: ref.assetId,
            });
            return;
          }
        }
        return;
      }
      setProjectsSelection({ kind: 'documentPath', path: base.path });
      return;
    }
    if (base.kind === 'providerAsset') {
      setProjectsSelection({
        kind: 'asset',
        providerId: base.providerId,
        sourceId: base.sourceId,
        assetId: base.assetId,
      });
    }
  }, [documentByPath, tree.refs]);

  // ── Classification (§2.5) ─────────────────────────────────────────────
  /**
   * Write a document's classification into its GLB, then into the cache.
   *
   * Goes through `runVerb` like every other write in this file, so a refused
   * write (read-only project, a body somebody else changed since it was read)
   * surfaces in the snackbar instead of vanishing. `busy` is what turns the
   * editor inert while the bytes are in flight.
   */
  const changeClassification = useCallback((
    doc: TieredDocumentEntry,
    next: DocumentClassification | null,
  ) => {
    void runVerb('Classify document', () => store.setDocumentClassification(doc.id, next));
  }, [runVerb, store]);

  /**
   * The classification block of the selected document, or null.
   *
   * Editable only for a document this project owns: a bundled example travels
   * with the deploy, so its classification is a fact about somebody else's
   * file. The read-only editor still SHOWS it — that is information worth
   * having, and §3.6 prefers showing to greying out.
   */
  const classificationFor = useCallback((row: DocumentRow | undefined) => {
    if (!row) return null;
    return (
      <ClassificationEditor
        classification={row.classification}
        knownTags={documentTags}
        busy={busy}
        onChange={row.doc && row.doc.tier !== 'bundled' && project.writable
          ? (next) => changeClassification(row.doc!, next)
          : undefined}
      />
    );
  }, [documentTags, busy, project.writable, changeClassification]);

  // ── Markdown preview + editor (plan-445 F7) ───────────────────────────
  /**
   * Which `.md` file the detail pane is showing, and its text.
   *
   * `text: null` means "still reading" — the pane says so rather than
   * flashing an empty document. Keyed by path so a stale read that lands after
   * the user moved on is dropped instead of overwriting the new selection.
   */
  const [mdFile, setMdFile] = useState<{ path: string; text: string | null } | null>(null);
  /** The selected file's path when it is Markdown, else null. */
  const selectedMdPath = useMemo(() => {
    const sel = dash.selection;
    if (sel.kind !== 'file' || sel.rootId !== project.project?.id) return null;
    return /\.md$/i.test(sel.relPath) ? sel.relPath : null;
  }, [dash.selection, project.project?.id]);

  useEffect(() => {
    if (!selectedMdPath) { setMdFile(null); return; }
    const backend = store.getBackend();
    if (!backend) { setMdFile(null); return; }
    let alive = true;
    setMdFile({ path: selectedMdPath, text: null });
    void backend.readDocument(selectedMdPath).then(r => r?.bytes ?? null)
      .then(bytes => {
        if (!alive) return;
        setMdFile({
          path: selectedMdPath,
          text: bytes ? new TextDecoder().decode(bytes) : '',
        });
      })
      .catch(() => { if (alive) setMdFile({ path: selectedMdPath, text: '' }); });
    return () => { alive = false; };
  }, [selectedMdPath, store, listingBump]);

  /**
   * Write an edited Markdown body back, through the SAME `writeDocument` seam every
   * other file write in this file uses — no second storage path for text.
   *
   * Unconditional (no `expectedRevision`): the alternative would be to hash the
   * bytes we read and refuse on a mismatch, and there is nothing on this screen
   * that could then resolve the conflict. The listing bump afterwards is what
   * makes the preview show what was actually stored.
   */
  const saveMarkdown = useCallback((relPath: string, next: string) => {
    void runVerb('Save file', async () => {
      const backend = store.getBackend();
      if (!backend?.writable) throw new Error('This project is read-only.');
      // Overwrite-by-design: this is the editor saving the text it is showing.
      await backend.writeDocument(
        relPath, new TextEncoder().encode(next), { expectedRevision: 'any' });
      setMdFile({ path: relPath, text: next });
      setListingBump(n => n + 1);
    });
  }, [runVerb, store]);

  /** The pane's Markdown block for the selected `.md` file, or undefined. */
  const markdownPane = useMemo(() => {
    if (!selectedMdPath || mdFile?.path !== selectedMdPath) return undefined;
    return {
      text: mdFile.text,
      editable: project.writable,
      onSave: (next: string) => saveMarkdown(selectedMdPath, next),
    };
  }, [selectedMdPath, mdFile, project.writable, saveMarkdown]);

  // ── Detail pane for the current selection (§3.6) ──────────────────────
  const detail = useMemo(() => {
    const sel = dash.selection;

    if (sel.kind === 'document') {
      // THE one list (plan-716 F8). `scenes` was the `scenes/`-section
      // projection of exactly this array, so the lookup is the same lookup
      // against a superset — a selection that names a `library/` document now
      // gets the pane it always should have had instead of an empty column.
      const scene = documentById(project.documents, sel.documentId);
      if (!scene) return { title: null };
      const bundled = scene.tier === 'bundled';
      const fields: DetailField[] = [];
      if (scene.modifiedAt) fields.push({ label: 'Modified', value: scene.modifiedAt });
      if (project.project?.name) fields.push({ label: 'Project', value: project.project.name });
      // The document's CONNECT binding (`documents[].connectRef`, plan-718 §3).
      // Shown whenever set — and marked when the file it names is not in the
      // config listing, because a dead reference is exactly what this row
      // exists to surface.
      const connectRef = readDocumentRef(scene, 'connectRef');
      if (connectRef) {
        const shown = stripConnectConfigSuffix(connectRef);
        fields.push({
          label: 'CONNECT',
          value: connectConfigs.includes(connectRef) ? shown : `${shown} — missing`,
        });
      }
      const knowledgeRef = readDocumentRef(scene, 'knowledgeRef');
      if (knowledgeRef) {
        const shown = stripKnowledgeFileSuffix(knowledgeRef);
        fields.push({
          label: 'Knowledge',
          value: knowledgeFiles.includes(knowledgeRef) ? shown : `${shown} — missing`,
        });
      }
      const actions: DetailAction[] = [
        { key: 'open', label: 'Open', primary: true, onClick: () => openScene(scene.id) },
      ];
      // A bundled scene is offered a duplicate rather than five greyed-out
      // buttons — telling the user the way forward beats disabling (§3.6).
      if (bundled) {
        actions.push({
          key: 'dup',
          label: 'Duplicate to this project',
          onClick: () => duplicateScene(scene.id),
        });
      } else {
        // No "Rename" entry here either: the pane derives it from `onRename`
        // below (plan-450 §2.2), so a writable scene gets the button without
        // this list restating the permission — and a bundled one, which never
        // supplies `onRename`, gets no button at all rather than a dead one.
        actions.push({ key: 'dup', label: 'Duplicate', onClick: () => duplicateScene(scene.id) });
        // `scene` IS the document row now — the second lookup that used to
        // stand here asked the same array for the same id.
        actions.push(...transferActionsFor(scene));
        actions.push({
          key: 'delete',
          label: 'Delete',
          destructive: true,
          onClick: () => deleteScene(scene.id, scene.name),
        });
      }
      const row = documentRows.find(r => r.key === 'scene:' + scene.id);
      return {
        title: scene.name,
        // The subtitle says only what nothing else shows: writability. The
        // word "Document" said nothing the row's presence did not already say
        // — what the file IS is the type badge, where it LIVES is the place
        // badge, and the root earns no place chip at all.
        ...(bundled ? { subtitle: 'Read-only' } : {}),
        badge: bundled ? 'Sample' : null,
        badges: [documentTypeBadge(scene), documentRoleBadge(scene)],
        thumbnailUrl: scene.thumbnail ?? null,
        fields,
        actions,
        extra: classificationFor(row),
        // The title edits in place — the same commit the Rename action makes.
        ...(bundled || !sceneStore ? {} : {
          onRename: (name: string) => { renameDocumentRow(scene.id, name); },
        }),
      };
    }

    if (sel.kind === 'documentPath') {
      // No `published:` shape reaches this branch any more (plan-731 2c). A
      // path selection is a path selection: an example is an ordinary document
      // row and answers through `documentByPath` like every other one.
      //
      // `models[]` paths can carry a leading slash (the bundled manifest
      // declares them URL-style, `/models/x.glb`) while the tree's document
      // paths never do — compare with it stripped, or a bundled project's
      // model row answers with an empty detail pane.
      const model = project.models.find(m => m.path.replace(/^\/+/, '') === sel.path);
      // `models[]` carries only the `models/` section — a document in
      // `library/` (or anywhere else) is still a selectable asset and answers
      // through the one document list instead of an empty pane.
      const doc = documentByPath.get(sel.path);
      const label = (model && (model.label ?? baseNameOf(model.path)))
        ?? doc?.name ?? baseNameOf(sel.path);
      if (!label) return { title: null };
      const row = documentRows.find(
        r => r.key === (doc ? 'scene:' + doc.id : 'model:' + sel.path),
      );
      const readOnly = (model?.tier ?? doc?.tier) === 'bundled';
      return {
        title: label,
        // Same rule as the branch above: the subtitle carries only what no
        // badge shows.
        ...(readOnly ? { subtitle: 'Read-only' } : {}),
        badges: !doc ? [] : [documentTypeBadge(doc), documentRoleBadge(doc)],
        fields: [
          { label: 'Source', value: sel.path },
          // Same reference rows as the id-selected branch — one fact, both routes.
          ...(() => {
            const rows: DetailField[] = [];
            const connectRef = readDocumentRef(doc, 'connectRef');
            if (connectRef) {
              const shown = stripConnectConfigSuffix(connectRef);
              rows.push({
                label: 'CONNECT',
                value: connectConfigs.includes(connectRef) ? shown : `${shown} — missing`,
              });
            }
            const knowledgeRef = readDocumentRef(doc, 'knowledgeRef');
            if (knowledgeRef) {
              const shown = stripKnowledgeFileSuffix(knowledgeRef);
              rows.push({
                label: 'Knowledge',
                value: knowledgeFiles.includes(knowledgeRef) ? shown : `${shown} — missing`,
              });
            }
            return rows;
          })(),
        ],
        actions: [
          {
            key: 'open',
            label: 'Open',
            primary: true,
            onClick: () => openModel(sel.path, label),
          },
          ...(readOnly ? [] : transferActionsFor(documentByPath.get(sel.path))),
        ] as DetailAction[],
        extra: classificationFor(row),
        // Inline title rename runs the SAME gate and write path as F2 on the
        // tree row — one rule, however the rename is reached. The selection
        // follows to the new path on success, so the pane keeps describing
        // the document it just renamed.
        ...(readOnly || !selectedTreePath ? {} : {
          onRename: (name: string) => {
            const node = findTreeNode(treeRoots, selectedTreePath);
            if (!node) return;
            const verdict = canRenameInTree(treeRoots, selectedTreePath, name);
            if (!verdict.ok) {
              if (verdict.reason !== 'unchanged') setMessage(`Rename refused: ${verdict.reason}.`);
              return;
            }
            runTreeEdit('Rename', node, verdict.to, (to) => {
              setProjectsSelection({ kind: 'documentPath', path: to });
            });
          },
        }),
      };
    }

    if (sel.kind === 'asset') {
      const src = sources.find(s => s.providerId === sel.providerId && s.source.id === sel.sourceId);
      const entry = src?.source.getEntry(sel.assetId) ?? null;
      if (!entry) return { title: null };
      const fields: DetailField[] = [{ label: 'Category', value: entry.category }];
      if (entry.collections?.length) fields.push({ label: 'Collections', value: entry.collections.join(', ') });
      if (entry.footprintMm) fields.push({ label: 'Footprint', value: `${entry.footprintMm[0]} × ${entry.footprintMm[1]} mm` });
      if (entry.tags?.length) fields.push({ label: 'Tags', value: entry.tags.join(', ') });
      const writable = src?.source.writable ?? false;
      return {
        title: entry.name,
        subtitle: src?.source.label ?? null,
        thumbnailUrl: entry.thumbnailUrl ?? null,
        fields,
        actions: buildAssetActions(
          { providerId: sel.providerId, sourceId: sel.sourceId, assetId: sel.assetId },
          entry,
          writable,
          sel.providerId === PROJECT_LIBRARY_PROVIDER_ID,
        ),
        // Inline title rename — the same commit as the Rename action, minus
        // the dialog. Writable project-library assets only, like the action.
        ...(() => {
          if (!writable || sel.providerId !== PROJECT_LIBRARY_PROVIDER_ID) return {};
          const relPath = libraryRelPathOf(entry);
          return relPath
            ? { onRename: (name: string) => renameLibraryAsset(relPath, name) }
            : {};
        })(),
      };
    }

    // ── A tree row that is not a document (plan-703 Phase 6) ──
    if (sel.kind === 'folder' || sel.kind === 'file') {
      // A CONNECT configuration / knowledge file DOES earn a pane: which
      // documents reference it is a fact nothing else on this screen states,
      // and the N:1 reverse direction is a scan of the manifest's ref fields
      // (plan-718) — computed here, never stored.
      const refFilePane = (
        field: 'connectRef' | 'knowledgeRef',
        subtitle: string,
        badge: string,
        strip: (path: string) => string,
        actions: DetailAction[] = [],
      ) => {
        // The reverse direction, computed — never a stored `usedBy` array.
        // `documentsUsingRef` carries the id as well as the label, which is
        // what turns the list from a sentence into navigation (plan-446 F4).
        const usedBy = documentsUsingRef(project.documents, field, sel.relPath);
        return {
          // The ending is the classifier, never part of the name — stripped
          // here like everywhere else (the badge already says what this is).
          title: baseNameOf(strip(sel.relPath)),
          subtitle,
          badges: [badge],
          fields: [
            { label: 'Path', value: strip(sel.relPath) },
          ],
          extra: usedByChips(usedBy),
          actions,
        };
      };
      // The "Built-in — read-only" pane went with the root it described
      // (plan-737 Phase 3). The demo's documents are ordinary project rows now
      // and get the ordinary project pane below — with a real path, a real
      // "used by", and the verbs of a project that can actually be written to.
      if (sel.kind === 'file' && sel.rootId === project.project?.id) {
        if (isConnectConfigPath(sel.relPath)) {
          return refFilePane(
            'connectRef', 'CONNECT configuration', 'Connect', stripConnectConfigSuffix,
            // Read-only in the browser by decision (LOP-120): the verb hands
            // the file over to CONNECT rather than opening a second editor
            // beside CONNECT's live working set.
            [{
              key: 'open-in-connect',
              label: 'Open in CONNECT',
              onClick: () => setConnectOptions({ ref: sel.relPath }),
            }],
          );
        }
        if (isKnowledgeFilePath(sel.relPath)) {
          return {
            ...refFilePane(
              'knowledgeRef', 'Knowledge file', 'Knowledge', stripKnowledgeFileSuffix),
            // Preview always, Edit only where the project can be written
            // (plan-445 F7) — the pane decides the chrome, this decides the offer.
            ...(markdownPane ? { markdown: markdownPane } : {}),
          };
        }
        // Any OTHER file of the full view (plan-445 F1/F2). It earns a pane
        // for exactly one reason: a `.md` is readable, and reading it is the
        // whole point of listing it. No verbs — the row is inert.
        if (markdownPane) {
          return {
            title: baseNameOf(sel.relPath),
            subtitle: 'Markdown',
            fields: [{ label: 'Path', value: sel.relPath }],
            markdown: markdownPane,
          };
        }
      }
      // A library root's verbs (Refresh, Remove) sit on its tree row now.
      // A plain folder or attachment earns no pane — the folder header's
      // breadcrumb already says where the user is, and a pane restating the
      // name would make navigation look like inspection. Only ASSETS have
      // details worth a column.
      return { title: null };
    }

    // Nothing picked yet — the project itself is what the pane describes.
    // Under the rail this slot said "Select an item to see its details"; on a
    // screen the user reached by choosing a project, the project's own verbs
    // are what they are most likely to want on arrival.
    // Nothing selected → nothing to describe. The project's own facts live in
    // the dashboard header and its verbs in the header menu; a pane that
    // repeated them here would make "no selection" look like a selection.
    return { title: null };
  }, [dash.selection, project, sources, store, runVerb, connectConfigs, knowledgeFiles,
      openScene, duplicateScene, deleteScene, buildAssetActions, openModel,
      project.models, documentRows, classificationFor,
      transferActionsFor, documentByPath, sourceOfRoot, treeRoots, catalogRoots,
      handleRefreshLibrary, handleRemoveLibrary,
      sceneStore, selectedTreePath, runTreeEdit, renameLibraryAsset, renameDocumentRow,
      tree.refs, markdownPane]);

  const handleForget = useCallback((id: string) => {
    forgetRecentProject(id);
    setRecent(readRecentProjects());
  }, []);

  /**
   * Refresh/Remove on a library ROOT row, right-hand (they replaced the
   * "remote · read-only" words — the cloud icon already says remote). The
   * verbs sit on the thing they act on; the detail pane no longer carries a
   * library fallback.
   */
  const renderLibraryRootActions = useCallback((node: ProjectTreeNode) => {
    const registered = sourceOfRoot(node.rootId);
    if (!registered) return null;
    const src = registered.source;
    return (
      <Box
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, ml: 0.5 }}
      >
        {src.refresh && (
          <Tooltip title="Refresh library">
            <IconButton
              size="small"
              sx={{ p: 0.25 }}
              aria-label={`Refresh ${src.label}`}
              onClick={() => handleRefreshLibrary(node.rootId)}
            >
              <Refresh sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        {src.remove && (
          <Tooltip title="Remove library">
            <IconButton
              size="small"
              sx={{ p: 0.25 }}
              aria-label={`Remove ${src.label}`}
              onClick={() => handleRemoveLibrary(node.rootId, src.label)}
            >
              <DeleteOutline sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    );
  }, [sourceOfRoot, handleRefreshLibrary, handleRemoveLibrary]);

  // ── Header menus (project verbs + folder create) ──────────────────────
  // The project's verbs moved from the detail pane's no-selection fallback
  // into the title row; the create verbs from the toolbar into the folder
  // header they act on. Plain anchor state, same as the card menus.
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<HTMLElement | null>(null);

  /**
   * Mounted once, then kept (hidden by `ProjectsDashboard` while closed).
   *
   * Unmounting on close is what made every reopen slow and forgetful: the
   * tree, the virtualized grid and every thumbnail were rebuilt from nothing,
   * and component-local state (folder expansion, scroll) died with them. A
   * session that never opens the dashboard still pays nothing — the gate
   * below keeps it unrendered until the first open.
   */
  const everOpenedRef = useRef(false);
  if (dash.open) everOpenedRef.current = true;
  if (!everOpenedRef.current) return null;

  const onProjectScreen = dash.view === 'project' && project.project !== null;

  // Dialogs and the snackbar ride along on both screens: a verb started on one
  // can surface its failure after the user has navigated to the other.
  const sharedChrome = (
    <>
      {/* The way OUT of unsaved work, on both screens.
          `Save as…` existed only inside the switch-confirmation dialog, which
          meant the offer appeared solely when the user was already leaving —
          and a TRANSIENT workspace (a shared link, an Example) could not be
          saved at all without first trying to navigate away from it. Someone
          who opens a shared demo, binds their signals and wants to keep the
          result had no verb to reach for. The dialog still calls the same
          `setNameDialog`; this is the missing free-standing entry point. */}
      {sceneSnap?.dirty && (
        <Tooltip title={sceneSnap.transient
          ? 'This scene came from a link and is not stored anywhere yet — saving keeps it under My scenes.'
          : 'Save the current edits under a new name.'}
        >
          <Button
            size="small"
            color="warning"
            variant={sceneSnap.transient ? 'contained' : 'outlined'}
            onClick={() => setNameDialog({ kind: 'saveAs', name: sceneSnap?.draft?.name ?? '' })}
            sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
          >
            {sceneSnap.transient ? 'Save to my scenes…' : 'Save as…'}
          </Button>
        </Tooltip>
      )}
      {/* Attaching a library is a viewer-level verb, so it rides in the shared
          chrome. The Asset-Manager tab inside it appears only when the private
          extension supplied a cloud store. */}
      <AddLibraryDialog
        open={addLibraryOpen}
        onClose={() => setAddLibraryOpen(false)}
        onAttach={attachLibraryToProject}
        attachHint={'Added to this project ' + '—' + ' the reference is stored in project.json and travels with the project.'}
        onConnectAssetManager={cloudStore
          ? (req) => cloudStore.addConnection(req.label, {
              projectId: req.projectId,
              keyId: req.keyId,
              secretKey: req.secretKey,
            })
          : undefined}
      />
      {/* The third answer of the single "Open…": the folder is neither a
          project nor a workspace, so it is offered as a place to make one. */}
      <CreateHereDialog
        request={createHere}
        onChange={setCreateHere}
        onConfirm={submitCreateHere}
      />
      <NewProjectDialog
        open={newProjectName !== null}
        name={newProjectName ?? ''}
        onChange={setNewProjectName}
        onClose={() => setNewProjectName(null)}
        onConfirm={handleCreateProject}
      />
      <FromScenesDialog
        request={fromScenes}
        onChange={setFromScenes}
        onConfirm={() => setFromScenes(null)}
        // THE one list (plan-716 F8): "new project from what I have" means
        // every document the project owns, not the `scenes/` third of them.
        scenes={documentPickOptions(project.documents)}
      />
      <ProjectRenameDialog
        request={renameProjectReq}
        onChange={setRenameProjectReq}
        onConfirm={submitRenameProject}
      />
      <DestructiveConfirmDialog
        request={confirmReq}
        onClose={() => setConfirmReq(null)}
      />
      {/* Right-click on a tree row. Anchored to the pointer rather than the
          row, so the menu opens where the click was — and carries only the
          verbs the clicked row can actually perform. */}
      <Menu
        open={treeMenuVerbs.length > 0}
        onClose={() => setTreeMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={treeMenu ? { top: treeMenu.y, left: treeMenu.x } : undefined}
      >
        {treeMenuVerbs.map(verb => (
          <MenuItem
            key={verb.key}
            data-testid={`tree-menu-${verb.key}`}
            onClick={() => { setTreeMenu(null); verb.run(); }}
            sx={{ fontSize: 13 }}
          >
            {verb.label}
          </MenuItem>
        ))}
      </Menu>
      {/* plan-446 F4. The CONNECT settings window, opened from a config row
          with that file preselected. Deliberately the SAME window the CONNECT
          panel mounts and not a second editor: CONNECT stays the one place a
          configuration is written (decision log 2026-08-23). */}
      <ConnectOptionsWindow
        open={connectOptions !== null}
        initialProfile={connectOptions?.ref ?? null}
        onClose={() => setConnectOptions(null)}
        onProfileSwitched={() => { /* no bridge list on this screen to reload */ }}
      />
      {/* These three were imported and their state managed since Phase 13,
          but never rendered — "Rename" set state into the void. */}
      <AssetPromptDialog
        state={assetDialog}
        onChange={setAssetDialog}
        onSubmit={assetDialog?.kind === 'renameNode' ? submitNodeRename : submitAssetDialog}
      />
      {/* Cross-source copy/move (plan-413 §3.1). Rides in the shared chrome
          like every other verb dialog: the transfer runs long enough that the
          user may well have navigated away before it reports. */}
      <TransferTargetDialog
        request={transferReq}
        targets={transferTargets}
        onClose={() => setTransferReq(null)}
        onConfirm={runTransfer}
      />
      <SceneNameDialog
        state={nameDialog}
        onChange={setNameDialog}
        onSubmit={() => { void submitNameDialog(); }}
      />
      <SceneConfirmDialog
        // Hidden (not cancelled) while the Save-as prompt is up: cancelling
        // the name dialog drops back to this choice instead of losing it.
        open={pendingSwitch !== null && nameDialog?.kind !== 'saveAs'}
        sceneName={sceneSnap?.draft?.name ?? sceneSnap?.saved?.name ?? 'Working scene'}
        canSave={sceneSnap?.saved !== null && sceneSnap?.saved !== undefined}
        onSave={() => {
          const next = pendingSwitch;
          setPendingSwitch(null);
          void (async () => {
            await sceneStore?.save();
            if (next) await next();
          })();
        }}
        onSaveAs={() => {
          // The switch stays pending: submitNameDialog runs it after Save-as.
          setNameDialog({ kind: 'saveAs', name: sceneSnap?.draft?.name ?? '' });
        }}
        onDiscard={() => {
          const next = pendingSwitch;
          setPendingSwitch(null);
          if (next) void next();
        }}
        onCancel={() => setPendingSwitch(null)}
      />
      <Snackbar
        open={message !== null}
        autoHideDuration={8000}
        onClose={() => setMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="warning" onClose={() => setMessage(null)} sx={{ fontSize: 12 }}>
          {message}
        </Alert>
      </Snackbar>
    </>
  );

  // ── Screen two: the open project ──────────────────────────────────────
  // ONE tree, no tabs (plan-703 Phase 6). The three header verbs are all
  // offered at once now, because there is no longer a tab to attach them to:
  // "Add library" is viewer-level and works on a read-only deploy, the other
  // two write into the project and say so when it cannot be written.
  if (onProjectScreen) {
    // The folder header names the whole way down from the root, and every
    // ancestor is a click target back up — the grid's own "up" navigation,
    // since the cards deliberately show no folders.
    const folderCrumbs = (selectedFolderPath ?? '').split('/').reduce<
      Array<{ path: string; name: string; rootId: string; relPath: string }>
    >((acc, _seg, i, segs) => {
      if (!selectedFolderPath) return acc;
      const path = segs.slice(0, i + 1).join('/');
      const node = findTreeNode(treeRoots, path);
      if (node) {
        acc.push({
          path,
          name: node.name,
          rootId: segs[0],
          relPath: segs.slice(1, i + 1).join('/'),
        });
      }
      return acc;
    }, []);
    // The folder the grid is showing, as a tree node — what "New folder" from
    // the grid's own menu needs as its parent.
    const folderNode = selectedFolderPath ? findTreeNode(treeRoots, selectedFolderPath) : null;
    return (
      <ProjectsDashboard
        title={project.project?.name ?? 'Project'}
        subtitle={[
          project.backendKind ? `${project.backendKind} project` : null,
          `${documentRows.length} document${documentRows.length === 1 ? '' : 's'}`,
          project.writable ? null : 'read-only',
        ].filter(Boolean).join(' · ')}
        onBack={() => setProjectsView('projects')}
        hero={<DocumentHeroSection onReveal={handleHeroReveal} />}
        // The tools moved down onto the grid's own toolbar, where the things
        // they filter are: a separate full-width bar carrying nothing but a
        // centred search field was a third horizontal rule between the user
        // and the documents.
        showSearch={false}
        titleActions={
          <>
            {sharedChrome}
            <Tooltip title="Project actions">
              <IconButton
                size="small"
                aria-label="Project actions"
                onClick={(e) => setProjectMenuAnchor(e.currentTarget)}
              >
                <MoreVert sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={projectMenuAnchor}
              open={Boolean(projectMenuAnchor)}
              onClose={() => setProjectMenuAnchor(null)}
            >
              <MenuItem
                onClick={() => { setProjectMenuAnchor(null); handleCloseProject(); }}
                sx={{ fontSize: 13 }}
              >
                Close Project
              </MenuItem>
              <MenuItem
                disabled={project.backendKind !== 'folder'}
                onClick={() => { setProjectMenuAnchor(null); handleExportProject(); }}
              >
                <ListItemText
                  primary="Export .rvproject"
                  secondary={project.backendKind !== 'folder'
                    ? 'Only a project folder can be exported.'
                    : undefined}
                  primaryTypographyProps={{ fontSize: 13 }}
                  secondaryTypographyProps={{ fontSize: 10 }}
                />
              </MenuItem>
              <MenuItem
                onClick={() => { setProjectMenuAnchor(null); handleImportProject(); }}
                sx={{ fontSize: 13 }}
              >
                Import .rvproject…
              </MenuItem>
            </Menu>
          </>
        }
      >
        {/* Folders left, contents right — the Unity project window (Lauf 13).
            The tree is a fixed column rather than a flex share: it holds names
            of a known length, while the grid is what should take the space a
            wider window offers. */}
        <Box
          sx={{
            width: 280,
            flexShrink: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {/* Two named sections rather than one list: what the project holds,
              and what is attached to it. Each verb sits under the header it
              belongs to — "add library" is a libraries verb, so it moved off
              the panel title and onto the Libraries header.

              The two used to differ only by the word in the header, which is
              why they read as one confusing list. Each section header sits on
              the DARKEST band in the column (user decision 2026-09-02) —
              darker than the tree's own root bands, so the two headers frame
              their sections the way the top/bottom toolbars frame the
              viewport — and the boundary between the sections is stated
              twice: clear space, then a hairline, then the next dark band. */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center',
              px: 1.25, minHeight: 30, flexShrink: 0,
              bgcolor: 'rgba(0,0,0,0.28)',
            }}
          >
            <Typography
              sx={{
                fontSize: 11, fontWeight: 600, flex: 1,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: 'rgba(255,255,255,0.55)',
              }}
            >
              Project
            </Typography>
          </Box>
          {/* The project takes only what it needs, so the Libraries header sits
              directly under the last project row instead of being pushed to the
              bottom of the panel by a tree that claimed all the space. Clamped
              so a big project still cannot squeeze the libraries out of view;
              past the clamp the tree scrolls inside itself. */}
          <Box sx={{ flex: '0 1 auto', minHeight: 0, maxHeight: '55%', display: 'flex', flexDirection: 'column' }}>
            <ProjectTree
              roots={projectTreeRoots}
              height="100%"
              selectedPath={selectedTreePath}
              containingFolderPath={selectedFolderPath}
              onSelect={handleTreeSelect}
              onActivate={handleTreeActivate}
              onContextMenu={handleTreeContextMenu}
              onMove={handleTreeMove}
              onRename={handleTreeRename}
              externalDragPath={cardDragPath}
            />
          </Box>
          {/* The ONE boundary in this column: clear space, the separator line
              floating in the middle of it, clear space again, then the next
              section's dark header band. The line gets air on BOTH sides —
              sitting directly on the dark band it read as the band's own edge
              rather than as a separator (user decision 2026-09-02). */}
          <Box
            sx={{
              flexShrink: 0, mx: 0, my: '12px',
              borderTop: '1px solid rgba(255,255,255,0.1)',
            }}
          />
          <Box
            sx={{
              display: 'flex', alignItems: 'center',
              px: 1.25, minHeight: 30, flexShrink: 0,
              bgcolor: 'rgba(0,0,0,0.28)',
            }}
          >
            <Tooltip title="Shared asset collections attached to this project — read-only unless you own them.">
              <Typography
                sx={{
                  fontSize: 11, fontWeight: 600, flex: 1,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  color: 'rgba(255,255,255,0.55)',
                }}
              >
                Libraries
              </Typography>
            </Tooltip>
            <Tooltip title="Attach a library to this project">
              <IconButton
                size="small"
                aria-label="Add library"
                onClick={() => setAddLibraryOpen(true)}
              >
                <Add sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
          {/* Takes the space the project left over, so the panel has no dead
              gap between the two sections. */}
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ProjectTree
              roots={libraryTreeRoots}
              height="100%"
              selectedPath={selectedTreePath}
              containingFolderPath={selectedFolderPath}
              onSelect={handleTreeSelect}
              onActivate={handleTreeActivate}
              onContextMenu={handleTreeContextMenu}
              onMove={handleTreeMove}
              onRename={handleTreeRename}
              externalDragPath={cardDragPath}
              renderRootActions={renderLibraryRootActions}
            />
          </Box>
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* ONE toolbar for the grid: where you are, what you are filtering
              it by, and what you can make in it — left to right in the order
              you would say them. The chips and the search used to live on a
              separate bar spanning the whole window, which put them nearer the
              tree they do NOT filter than the cards they do. */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.75,
              px: 1.5, minHeight: 40, flexShrink: 0,
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <Box
              data-testid="folder-header-name"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 1, minWidth: 0,
                overflow: 'hidden', whiteSpace: 'nowrap' }}
            >
              {folderCrumbs.map((crumb, i) => {
                const last = i === folderCrumbs.length - 1;
                return (
                  <Box key={crumb.path} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                    {i > 0 && (
                      <ChevronRight sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }} />
                    )}
                    <Typography
                      component={last ? 'span' : 'button'}
                      onClick={last
                        ? undefined
                        : () => setProjectsSelection({
                            kind: 'folder', rootId: crumb.rootId, relPath: crumb.relPath,
                          })}
                      sx={{
                        // One size for the whole trail — weight alone marks the
                        // current folder. (No `font` shorthand on the button:
                        // it resets font-size after the fact.)
                        fontSize: 12, lineHeight: 1.4, fontFamily: 'inherit',
                        fontWeight: last ? 600 : 400,
                        color: last ? 'text.primary' : 'text.secondary',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        ...(last ? {} : {
                          background: 'none', border: 'none', p: 0, cursor: 'pointer',
                          '&:hover': { color: 'text.primary', textDecoration: 'underline' },
                        }),
                      }}
                    >
                      {crumb.name}
                    </Typography>
                  </Box>
                );
              })}
            </Box>

            <Box sx={{ flex: 1, minWidth: 8 }} />

            {/* The classification filter sits right-aligned, directly beside
                the search: the two are the same gesture at different grains.
                Both narrow the CARDS of the folder in view (Lauf 13) — the
                folder tree beside them keeps its shape, because a structure
                that rearranges itself as you type is a structure you cannot
                navigate. */}
            <DocumentFilterBar
              chips={folderChips}
              chip={dash.chip}
              onChipChange={setProjectsChip}
              tags={documentTags}
              tag={dash.tag}
              onTagChange={setProjectsTag}
            />

            <TextField
              size="small"
              placeholder="Search this folder…"
              value={dash.search}
              onChange={(e) => setProjectsSearch(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start" sx={{ mr: 0.5 }}>
                      <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                    </InputAdornment>
                  ),
                  sx: { fontSize: 12, height: 28 },
                },
              }}
              sx={{ width: 200, flexShrink: 0 }}
            />
            {/*
              The PRIMARY way in (plan-445 F5). "New document" was a 16px plus
              among three other icon buttons — the single most-used verb on the
              screen, and the one nobody found. Contained and in the accent
              colour, it is now the one thing in this header that reads as an
              offer.

              One button, no type menu: the folder in view decides where the
              new document lands (plan-716 §2.6). The tooltip names the folder
              so the target is visible before the click, not after it.
            */}
            <Tooltip
              title={project.writable
                ? `New document in ${newDocumentFolder === '' ? 'the project root' : `${newDocumentFolder}/`}`
                : 'This project is read-only.'}
            >
              <span>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<Add sx={{ fontSize: 14 }} />}
                  disabled={!project.writable}
                  onClick={handleNewDocument}
                  sx={{
                    fontSize: 11,
                    textTransform: 'none',
                    whiteSpace: 'nowrap',
                    py: 0.25,
                    // Instrument Blue — the one working accent of DESIGN.md.
                    bgcolor: '#4fc3f7',
                    color: 'rgba(0,0,0,0.87)',
                    '&:hover': { bgcolor: '#81d4fa' },
                    // Read-only project: properly muted, not washed-out blue —
                    // the custom bgcolor otherwise bleeds through MUI's
                    // disabled state and reads as a broken primary button.
                    '&.Mui-disabled': {
                      bgcolor: 'rgba(255,255,255,0.06)',
                      color: 'rgba(255,255,255,0.3)',
                    },
                  }}
                >
                  New document
                </Button>
              </span>
            </Tooltip>
            {/* The one OTHER creatable thing (plan-718): a CONNECT
                configuration. Its own quiet button rather than a type menu —
                the document button keeps its no-menu decision
                (plan-716 §2.6), and the icon is the same glyph every config
                card and chip already carries. */}
            <Tooltip
              title={project.writable
                ? `New CONNECT configuration in ${newDocumentFolder === '' ? 'the project root' : `${newDocumentFolder}/`}`
                : 'This project is read-only.'}
            >
              <span>
                <IconButton
                  size="small"
                  aria-label="New CONNECT configuration"
                  disabled={!project.writable}
                  onClick={handleNewConnectConfig}
                >
                  <SettingsEthernet sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <ProjectFolderContents
            cards={folderCards}
            folders={subfolderTiles}
            onBackgroundContextMenu={handleGridContextMenu}
            emptyMessage={folderRows.length > 0 || subfoldersInView.length > 0
              ? 'Nothing in this folder matches the filter.'
              : project.writable
                ? 'This folder is empty. Create a document, or drag one in from a library.'
                : 'This folder is empty.'}
            emptyAction={folderRows.length === 0 && project.writable && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<Add sx={{ fontSize: 14 }} />}
                onClick={handleNewDocument}
                sx={{ fontSize: 11, textTransform: 'none', py: 0.25 }}
              >
                New document
              </Button>
            )}
          />
          {/* The folder's verbs where the folder is. Anchored to the pointer,
              same as the tree menu, and disabled entries stay VISIBLE so a
              read-only project still teaches what the screen can do. */}
          <Menu
            open={gridMenu !== null}
            onClose={() => setGridMenu(null)}
            anchorReference="anchorPosition"
            anchorPosition={gridMenu ? { top: gridMenu.y, left: gridMenu.x } : undefined}
          >
            <MenuItem
              data-testid="grid-menu-new-document"
              disabled={!project.writable}
              onClick={() => { setGridMenu(null); handleNewDocument(); }}
              sx={{ fontSize: 13, gap: 1 }}
            >
              <NoteAddOutlined sx={{ fontSize: 16 }} />
              New document
            </MenuItem>
            <MenuItem
              data-testid="grid-menu-new-folder"
              disabled={!project.writable || folderNode === null}
              onClick={() => {
                setGridMenu(null);
                if (folderNode) handleNewFolder(folderNode);
              }}
              sx={{ fontSize: 13, gap: 1 }}
            >
              <CreateNewFolderOutlined sx={{ fontSize: 16 }} />
              New folder
            </MenuItem>
            <MenuItem
              data-testid="grid-menu-new-connect"
              disabled={!project.writable}
              onClick={() => { setGridMenu(null); handleNewConnectConfig(); }}
              sx={{ fontSize: 13, gap: 1 }}
            >
              <SettingsEthernet sx={{ fontSize: 16 }} />
              New CONNECT configuration
            </MenuItem>
            <Divider sx={{ my: 0.5 }} />
            <MenuItem
              data-testid="grid-menu-refresh"
              onClick={() => {
                setGridMenu(null);
                void runVerb('Refresh', () => store.rescanDocuments());
              }}
              sx={{ fontSize: 13, gap: 1 }}
            >
              <Refresh sx={{ fontSize: 16 }} />
              Refresh
            </MenuItem>
          </Menu>
        </Box>
        {/* Always present, so the layout never jumps when a selection comes
            and goes; without one it says so ("Nothing selected"). */}
        <ProjectsDetailPane {...detail} />
      </ProjectsDashboard>
    );
  }

  // ── Screen one: which project ─────────────────────────────────────────
  // Search is offered only once there is a list worth filtering; on the empty
  // state it would be a control that can only ever return nothing.
  const hasWorkspace = workspaceMeta !== null || workspaceProjects.length > 0;
  // The kiosk gate is a statement about the DEPLOYMENT, not about the model
  // that happens to be open. A project plugin may lock the mode — Mauser and
  // Toray both do, to make their model a single-purpose 3D-HMI — while the very
  // same build sits in a dev workspace next to a dozen other projects. Reading
  // `modeLocked` alone told that developer "This deployment opens a single
  // fixed project" and took the list away. So the screen closes only when the
  // lock is backed by there being nothing else to offer: no workspace, and at
  // most the one project the box was given (plan-721 §2.13).
  const kioskSingleProject = modeLocked && !hasWorkspace && projectRows.length <= 1;
  return (
    <ProjectsDashboard
      title="Projects"
      showSearch={projectRows.length > 0}
      headerActions={
        <>
          {/* ONE "Open…" (decision 1). It used to be two — "Open folder…" and
              "Switch workspace" — which made the user classify their own
              folder before they were allowed to open it. */}
          {!kioskSingleProject && (
            <Button
              size="small"
              variant="outlined"
              onClick={handleOpen}
              sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              Open…
            </Button>
          )}
          {hasWorkspace && !kioskSingleProject && (
            <Button
              size="small"
              variant="contained"
              onClick={() => setNewProjectName('New Project')}
              sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              New project
            </Button>
          )}
          {sharedChrome}
        </>
      }
    >
      <ProjectsList
        hasWorkspace={hasWorkspace}
        workspaceName={workspaceMeta?.folderName ?? null}
        rows={projectRows}
        activeProjectId={project.project?.id ?? null}
        modeLocked={kioskSingleProject}
        onOpenProject={handleOpenProject}
        onOpenWorkspace={handleOpen}
        onOpenFolder={handleOpen}
        onForgetProject={handleForget}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
      />
    </ProjectsDashboard>
  );
}

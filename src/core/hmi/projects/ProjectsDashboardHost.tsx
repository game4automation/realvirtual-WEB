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
import { Alert, Button, Snackbar, Tab, Tabs, Tooltip } from '@mui/material';
import type { LibraryCatalogEntry } from '../../library/library-types';
import {
  getLibrarySourcesSnapshot,
  listLibrarySources,
  subscribeLibrarySources,
} from '../../library/library-source-registry';
import { getProjectStore } from '../../project/project-store';
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME } from '../../project/backends/bundled-backend';
import { NO_PROJECT } from '../../thumbnails/thumbnail-key';
import { readRecentProjects, forgetRecentProject } from '../../project/rv-project-recent';
import { CreateHereDialog, FromScenesDialog, NewProjectDialog, type CreateHereRequest, type FromScenesRequest } from '../../project/ProjectCreateDialogs';
import { createProjectFromScenes } from '../../project/rv-project-create';
import { canonicalNameOf } from '../../project/rv-project-types';
import { getWorkspaceHandle, getWorkspaceMeta, pickWorkspace, scanStoredWorkspace } from '../../project/rv-project-workspace';
import { exportProject, importProject, RVPROJECT_EXTENSION } from '../../project/rv-project-transport';
import type { WorkspaceProjectEntry } from '../../project/rv-project-workspace';
import { useMode } from '../../../hooks/use-mode';
import { getAppConfig } from '../rv-app-config';
import { useStartupModalRegistration } from '../startup-modal-coordinator';
import { shouldAutoOpenProjects } from './projects-auto-open';
import {
  createEmptyAsset, deleteAsset, duplicateAsset, renameAsset, setAssetCollections,
  LIBRARY_FOLDER,
} from '../../library/library-asset-ops';
import { PROJECT_LIBRARY_PROVIDER_ID } from '../../library/project-library-provider';
import { AddLibraryDialog } from '../../library/AddLibraryDialog';
import { getLibraryStore } from '../../library/library-store-singleton';
import { setPendingAssetOpen } from '../../../plugins/asset-editor/pending-open-store';
import { useViewer } from '../../../hooks/use-viewer';
import { getSceneStore } from '../scene/scene-store-singleton';
import { SceneConfirmDialog } from '../scene/rv-scene-confirm-dialog';
import { SceneNameDialog } from './SceneNameDialog';
import { AssetPromptDialog } from './AssetPromptDialog';
import { ProjectsDashboard } from './ProjectsDashboard';
import { ProjectsList, type ProjectListRow } from './ProjectsList';
import { ProjectSections, projectTabId, type ProjectSection } from './ProjectSections';
import { AssetLibrarySection } from './AssetLibrarySection';
import {
  buildAssetGroups,
  selectionPointsIntoGroup,
  type AssetLibraryGroup,
} from './assets-library-groups';
import {
  clearTransient,
  getAssetsSectionsSnapshot,
  isSectionCollapsedEffective,
  pruneSections,
  subscribeAssetsSections,
  toggleSection,
} from './assets-sections-store';
import { ProjectsDetailPane, type DetailAction, type DetailField } from './ProjectsDetailPane';
import {
  closeProjectsDashboard,
  getProjectsDashboardSnapshot,
  openProjectsDashboard,
  projectTabOf,
  setProjectsSelection,
  setProjectsTab,
  setProjectsView,
  subscribeProjectsDashboard,
  type ProjectTab,
} from './projects-dashboard-store';

/** Display name for a manifest asset that carries no explicit `label`. */
function baseNameOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.glb$/i, '');
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
  // Same contract for the Assets-tab collapse state.
  const sectionsVersion = useSyncExternalStore(
    subscribeAssetsSections, getAssetsSectionsSnapshot);

  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProjectEntry[]>([]);
  const [recent, setRecent] = useState(() => readRecentProjects());
  // The display record, not the handle: it is written synchronously by
  // `pickWorkspace` and is all the empty state needs to decide which screen to
  // be. Probing the real handle would mean an async permission check before the
  // first paint, and a flash of "no workspace" for a user who has one.
  const [workspaceMeta, setWorkspaceMeta] = useState(() => getWorkspaceMeta());

  // Workspace discovery touches the disk, so it runs on open rather than on
  // every render — and only while the dashboard is actually visible.
  useEffect(() => {
    if (!dash.open) return;
    let alive = true;
    void scanStoredWorkspace()
      .then(result => { if (alive) setWorkspaceProjects(result?.projects ?? []); })
      .catch(() => { if (alive) setWorkspaceProjects([]); });
    setRecent(readRecentProjects());
    setWorkspaceMeta(getWorkspaceMeta());
    return () => { alive = false; };
  }, [dash.open]);

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
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    const cfg = getAppConfig();
    if (shouldAutoOpenProjects({
      search: window.location.search,
      defaultModel: cfg.defaultModel,
      modeLocked,
      suppress: cfg.projects?.suppress,
      force: cfg.projects?.force,
    })) {
      openProjectsDashboard();
    }
  }, [modeLocked]);

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
  const [createHere, setCreateHere] = useState<(CreateHereRequest & { dir: FileSystemDirectoryHandle }) | null>(null);
  const [fromScenes, setFromScenes] = useState<FromScenesRequest | null>(null);
  const [newProjectName, setNewProjectName] = useState<string | null>(null);

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
      // The folder wins whenever there is one: it is writable, and the HTTP
      // project is the fallback for a deploy that has no folder at all.
      const ok = ws
        ? await store.openProjectFolder(ws.dir)
        : id === DEMO_PROJECT_ID
          ? await store.openDemoProject()
          : await store.openRecentProject(id);
      if (!ok) setMessage('That project could not be opened.');
      else setProjectsView('project');
    });
  }, [busy, project.project?.id, project.backendKind, workspaceProjects, runVerb, store]);

  const handleOpenWorkspace = useCallback(() => {
    void runVerb('Open workspace', async () => {
      const dir = await pickWorkspace();
      if (!dir) return;                // user cancelled the picker — not an error
      const result = await scanStoredWorkspace();
      setWorkspaceProjects(result?.projects ?? []);
      setWorkspaceMeta(getWorkspaceMeta());
    });
  }, [runVerb]);

  /**
   * Create an empty project in the workspace and show its card.
   *
   * No folder picker and no scene selection: the workspace grant already
   * covers the subfolder, so a new project is a name and nothing else. The
   * project is *not* opened — creating a card is not leaving the current one,
   * the same rule `handleNewScene` follows.
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
    });
  }, [newProjectName, runVerb]);

  const handleOpenFolder = useCallback(() => {
    void runVerb('Open project folder', async () => {
      const ok = await store.pickAndOpenProject();
      if (ok) setProjectsView('project');
    });
  }, [runVerb, store]);

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
      const dir = await pickWorkspace();
      if (!dir) return;
      const result = await importProject(file, dir);
      if (result.kind !== 'imported') throw new Error(
        'message' in result ? result.message : 'Import failed.');
      setMessage(`Imported "${result.project.name}" (${result.entryCount} files).`);
    });
  }, [runVerb]);

  // ── Asset ops (§2.6.5 / Phase 9) ──────────────────────────────────────
  // They all write through the active backend, so one implementation serves a
  // folder project and a browser project alike.
  const viewer = useViewer();
  const [assetDialog, setAssetDialog] = useState<
    { kind: 'renameAsset' | 'collections'; relPath: string; value: string } | null
  >(null);

  /** Run an asset op, surfacing its typed failure rather than swallowing it. */
  const runAssetOp = useCallback((
    label: string,
    fn: (backend: NonNullable<ReturnType<typeof store.getBackend>>) => Promise<{ kind: string; message?: string }>,
  ) => {
    void runVerb(label, async () => {
      const backend = store.getBackend();
      if (!backend?.writable) throw new Error('This project is read-only.');
      const result = await fn(backend);
      if (result.kind !== 'ok') throw new Error(result.message ?? `${label} failed.`);
    });
  }, [runVerb, store]);

  /**
   * Create an empty asset in the project library and stay put.
   *
   * It used to jump into the editor, which left the project with nothing until
   * the user saved — abandon the editor and no asset had ever existed. Writing
   * it first makes the row real: rename it here, open it when ready.
   */
  const handleNewAsset = useCallback(() => {
    void runVerb('New asset', async () => {
      const backend = store.getBackend();
      if (!backend?.writable) throw new Error('This project is read-only.');
      const result = await createEmptyAsset(backend);
      if (result.kind !== 'ok' || !result.newPath) {
        throw new Error('message' in result ? result.message : 'New asset failed.');
      }
      // The provider lists the folder, so the new file needs a re-read before
      // its card exists to be selected.
      const source = listLibrarySources()
        .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID);
      await source?.source.refresh?.();
      setProjectsSelection({
        kind: 'asset',
        providerId: PROJECT_LIBRARY_PROVIDER_ID,
        sourceId: source?.source.id ?? project.project?.id ?? '',
        assetId: `project:${LIBRARY_FOLDER}/${result.newPath}`,
      });
    });
  }, [runVerb, store, project.project?.id]);

  /**
   * Actions for a library asset (§3.6).
   *
   * A read-only source gets "Edit a copy" instead of a disabled "Edit" — the
   * plan is explicit that telling the user the way forward beats greying out.
   * Mutating verbs appear only for assets that live in THIS project, because
   * those are the only ones the backend can actually write.
   */
  const buildAssetActions = useCallback((
    assetId: string,
    assetName: string,
    writable: boolean,
    isProjectAsset: boolean,
  ): DetailAction[] => {
    const actions: DetailAction[] = [
      writable
        ? { key: 'edit', label: 'Edit', primary: true, onClick: () => handleNewAsset() }
        : { key: 'editcopy', label: 'Edit a copy', primary: true, onClick: () => handleNewAsset() },
    ];
    if (!isProjectAsset || !writable) return actions;

    actions.push({
      key: 'rename',
      label: 'Rename',
      onClick: () => setAssetDialog({ kind: 'renameAsset', relPath: assetId, value: assetName }),
    });
    actions.push({
      key: 'dup',
      label: 'Duplicate',
      onClick: () => runAssetOp('Duplicate asset', b => duplicateAsset(b, assetId)),
    });
    actions.push({
      key: 'collections',
      label: 'Collections…',
      onClick: () => setAssetDialog({ kind: 'collections', relPath: assetId, value: '' }),
    });
    actions.push({
      key: 'delete',
      label: 'Delete',
      destructive: true,
      onClick: () => runAssetOp('Delete asset', b => deleteAsset(b, assetId)),
    });
    return actions;
  }, [handleNewAsset, runAssetOp]);

  const [addLibraryOpen, setAddLibraryOpen] = useState(false);
  // The planner plugin owns the private cloud store when it is loaded. Reading
  // it through the plugin registry keeps this file free of a private import.
  const cloudStore = (viewer.getPlugin('layout-planner') as
    { cloudStore?: { addConnection(label: string, cfg: { projectId: string; keyId: string; secretKey: string }): string } } | undefined)?.cloudStore ?? null;

  const handleCloseProject = useCallback(() => {
    void runVerb('Close project', () => store.requestCloseProject());
  }, [runVerb, store]);

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
    trySwitch(async () => { await sceneStore.openScene(id); closeProjectsDashboard(); });
  }, [sceneStore, trySwitch]);

  /**
   * Create an empty scene and stay put.
   *
   * Deliberately NOT a switch: the dashboard stays open, the new row appears
   * selected, and the user renames it or opens it from there. Nothing about
   * the current workspace changes, so there is no unsaved work to guard and no
   * prompt to show — creating a row is not leaving one.
   */
  const handleNewScene = useCallback(() => {
    if (!sceneStore) return;
    void runVerb('New scene', async () => {
      const id = sceneStore.createEmpty();
      setProjectsSelection({ kind: 'scene', sceneId: id });
      // The manifest write is queued by the folder writer; wait for it so a
      // reload right after the click cannot lose the row.
      await store.flush();
    });
  }, [sceneStore, runVerb, store]);

  /**
   * Open a base GLB or a published example.
   *
   * Both go through the same dirty guard as a scene: switching away from an
   * edited draft without asking is the same data loss whichever list the click
   * came from.
   */
  /**
   * Open a model card.
   *
   * `modelId` is a manifest **path**, not a URL — the backend turns it into
   * something loadable (a deploy URL as it stands, a blob URL for a file in a
   * project folder). Resolving through the backend rather than assuming a URL
   * is what lets a folder project's own GLBs open at all.
   */
  const openModel = useCallback((modelId: string, label: string, published: boolean) => {
    if (!sceneStore) return;
    trySwitch(async () => {
      if (published) {
        const entry = sceneSnap?.published.find(e => 'published:' + e.urlName === modelId);
        if (entry) await sceneStore.openPublishedExample(entry);
      } else {
        const url = await store.resolveAssetUrl(modelId);
        if (!url) throw new Error(`"${label}" could not be read from this project.`);
        await sceneStore.openBuiltin(url, label);
      }
      closeProjectsDashboard();
    });
  }, [sceneStore, trySwitch, sceneSnap?.published, store]);

  const exportScene = useCallback((id: string) => {
    if (!sceneStore) return;
    void runVerb('Export scene', async () => {
      // Hydration first: a project-folder scene may not be in memory yet, and
      // exporting an unhydrated scene would silently write an empty file.
      if (!(await sceneStore.ensureSceneHydrated(id))) {
        throw new Error('This scene could not be loaded from the project folder — export cancelled.');
      }
      sceneStore.exportSceneJSON(id);
    });
  }, [sceneStore, runVerb]);

  const deleteScene = useCallback((id: string, name: string) => {
    if (!sceneStore) return;
    // A destructive, irreversible action always asks first.
    if (!window.confirm(`Delete the scene "${name}"? This cannot be undone.`)) return;
    void runVerb('Delete scene', async () => {
      await sceneStore.delete(id);
      setProjectsSelection({ kind: 'none' });
    });
  }, [sceneStore, runVerb]);

  const duplicateScene = useCallback((id: string) => {
    if (!sceneStore) return;
    void runVerb('Duplicate scene', async () => { sceneStore.duplicate(id); });
  }, [sceneStore, runVerb]);

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
      sceneStore.rename(nameDialog.id, name);
    }
  }, [nameDialog, sceneStore, pendingSwitch]);

  // ── Assets, grouped by the library they came from (plan-702 F1) ───────
  // `sources` is the memoised registry read, so `registryVersion` already
  // rides in through it — see the binding note at the top of this component.
  const assetGroups = useMemo<AssetLibraryGroup[]>(() => buildAssetGroups({
    sources,
    searchTerm: dash.search,
    projectId: project.project?.id,
    selectedAsset: dash.selection.kind === 'asset'
      ? {
          providerId: dash.selection.providerId,
          sourceId: dash.selection.sourceId,
          assetId: dash.selection.assetId,
        }
      : null,
    onSelect: (ref) => setProjectsSelection({ kind: 'asset', ...ref }),
  }), [sources, dash.search, dash.selection, project.project?.id]);

  // Collapse state for libraries that no longer exist is dropped as soon as
  // the group list changes — a URL re-added later must not come back closed.
  useEffect(() => {
    pruneSections(assetGroups.map(g => g.groupKey));
  }, [assetGroups]);

  // Leaving search mode discards the search-scoped collapse overrides, which
  // is what restores exactly the state the user had before they typed.
  const searchActive = dash.search.trim() !== '';
  useEffect(() => {
    if (!searchActive) clearTransient();
  }, [searchActive]);

  /** Detach a library through whatever route its provider exposes. */
  const handleRemoveLibrary = useCallback((group: AssetLibraryGroup) => {
    const source = sources.find(
      s => s.providerId === group.providerId && s.source.id === group.sourceId)?.source;
    if (!source?.remove) return;
    if (!window.confirm(`Remove the library "${group.label}" from this viewer?`)) return;
    void runVerb('Remove library', async () => {
      await source.remove!();
      // A selection pointing into the library that just went away would leave
      // the detail pane describing a dead source (plan-702 §2.7 / R5).
      if (selectionPointsIntoGroup(dash.selection, group)) {
        setProjectsSelection({ kind: 'none' });
      }
    });
  }, [sources, runVerb, dash.selection]);

  /** Re-scan a library that offers it (local folders do). */
  const handleRefreshLibrary = useCallback((group: AssetLibraryGroup) => {
    const source = sources.find(
      s => s.providerId === group.providerId && s.source.id === group.sourceId)?.source;
    if (!source?.refresh) return;
    void runVerb('Refresh library', () => source.refresh!());
  }, [sources, runVerb]);

  /**
   * Re-request the browser's read permission for a local folder.
   *
   * `requestPermission()` is only allowed inside a user gesture, which is why
   * this hangs off a click and never off an effect.
   */
  const handleGrantLibraryPermission = useCallback(() => {
    void runVerb('Grant folder access', () => getLibraryStore().activateLocalFolder());
  }, [runVerb]);

  // ── The three sections of the project screen (§3.5) ────────────────────
  // One memo, three lists — the rail's mutually exclusive groups are gone, so
  // the search term now filters all of them at once and each section reports
  // its own count.
  const sections = useMemo<ProjectSection[]>(() => {
    const term = dash.search.trim().toLowerCase();
    const match = (name: string) => !term || name.toLowerCase().includes(term);

    // "Models" carries what the Scene window called base GLBs and Examples:
    // the models a scene can be built on, plus the read-only published
    // examples. Both open through the same dirty-guarded switch as a scene.
    //
    // The models come from the PROJECT MANIFEST (`project.models`), never from
    // the deploy-wide `builtins`. That list is every GLB the build can reach —
    // in dev that is every private customer project's models — so rendering it
    // here put Toray's and Mauser's geometry into the demo project, all falsely
    // labelled "bundled". Manifest-driven means a folder project shows what it
    // actually holds, tagged `user`; only the read-only HTTP project is
    // `bundled`, which is what that tier honestly means.
    const demoTier = project.backendKind === 'bundled';
    const modelCards = [
      ...project.models
        .filter(m => match(m.label ?? m.path))
        .map(m => ({
          key: 'model:' + m.path,
          entry: {
            id: m.path,
            name: m.label ?? baseNameOf(m.path),
            category: 'custom',
            thumbnailUrl: m.thumbnail,
          } as LibraryCatalogEntry,
          tier: m.tier,
          onSelect: () => setProjectsSelection({ kind: 'model', modelId: m.path }),
          selected: dash.selection.kind === 'model' && dash.selection.modelId === m.path,
          // A base model has no source registry entry, so it borrows the
          // project's own id as the source: the pair still identifies it
          // uniquely, which is all the cache key needs.
          thumbnailKey: {
            projectId: project.project?.id ?? NO_PROJECT,
            providerId: 'project-models',
            sourceId: project.project?.id ?? NO_PROJECT,
            assetId: m.path,
          },
          resolveThumbnail: async () => {
            const url = await store.resolveAssetUrl(m.path);
            return url ? { url } : null;
          },
        })),
      ...(demoTier ? sceneSnap?.published ?? [] : [])
        .filter(e => match(e.label))
        .map(e => ({
          key: 'published:' + e.urlName,
          entry: { id: 'published:' + e.urlName, name: e.label, category: 'custom' } as LibraryCatalogEntry,
          tier: 'bundled' as const,
          onSelect: () => setProjectsSelection({ kind: 'model', modelId: 'published:' + e.urlName }),
          selected: dash.selection.kind === 'model'
            && dash.selection.modelId === 'published:' + e.urlName,
        })),
    ];

    const sceneCards = project.scenes
      .filter(s => match(s.name))
      .map(s => ({
        key: 'scene:' + s.id,
        entry: {
          id: s.id,
          name: s.name,
          category: 'custom',
          thumbnailUrl: s.thumbnail,
        } as LibraryCatalogEntry,
        tier: s.tier === 'bundled' ? ('bundled' as const) : ('user' as const),
        onSelect: () => setProjectsSelection({ kind: 'scene', sceneId: s.id }),
        selected: dash.selection.kind === 'scene' && dash.selection.sceneId === s.id,
      }));

    // The Assets tab is grouped per library since plan-702, so its cards are
    // built by `buildAssetGroups` above and only flattened here for the tab's
    // own count badge.
    const assetCards = assetGroups.flatMap(g => g.cards);

    return [
      {
        key: 'models' as ProjectTab,
        label: 'Models',
        cards: modelCards,
        emptyHint: demoTier
          ? 'This deploy ships no base models or examples.'
          : 'No models in this project yet — add one to its models/ folder and list it in project.json.',
      },
      {
        key: 'scenes' as ProjectTab,
        label: 'Scenes',
        cards: sceneCards,
        emptyHint: 'No scenes yet — open a model and save it as a scene.',
      },
      {
        key: 'assets' as ProjectTab,
        label: 'Assets',
        cards: assetCards,
        emptyHint: 'No asset libraries attached to this project.',
      },
    ];
  }, [dash.search, dash.selection, project.scenes, assetGroups,
      sceneSnap?.published, project.backendKind, project.models, store]);

  // ── Detail pane for the current selection (§3.6) ──────────────────────
  const detail = useMemo(() => {
    const sel = dash.selection;

    if (sel.kind === 'scene') {
      const scene = project.scenes.find(s => s.id === sel.sceneId);
      if (!scene) return { title: null };
      const bundled = scene.tier === 'bundled';
      const fields: DetailField[] = [];
      if (scene.modifiedAt) fields.push({ label: 'Modified', value: scene.modifiedAt });
      if (project.project?.name) fields.push({ label: 'Project', value: project.project.name });
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
        actions.push({
          key: 'rename',
          label: 'Rename',
          onClick: () => setNameDialog({ kind: 'rename', id: scene.id, name: scene.name }),
        });
        actions.push({ key: 'dup', label: 'Duplicate', onClick: () => duplicateScene(scene.id) });
        actions.push({ key: 'export', label: 'Export JSON', onClick: () => exportScene(scene.id) });
        actions.push({
          key: 'delete',
          label: 'Delete',
          destructive: true,
          onClick: () => deleteScene(scene.id, scene.name),
        });
      }
      return {
        title: scene.name,
        subtitle: bundled ? 'Bundled scene' : 'Scene',
        badge: bundled ? 'Sample' : null,
        thumbnailUrl: scene.thumbnail ?? null,
        fields,
        actions,
      };
    }

    if (sel.kind === 'model') {
      const published = sel.modelId.startsWith('published:');
      const model = published
        ? null
        : project.models.find(m => m.path === sel.modelId);
      const label = published
        ? sceneSnap?.published.find(e => 'published:' + e.urlName === sel.modelId)?.label
        : model && (model.label ?? baseNameOf(model.path));
      if (!label) return { title: null };
      return {
        title: label,
        subtitle: published
          ? 'Example scene (read-only)'
          : model?.tier === 'bundled' ? 'Base model (read-only)' : 'Base model',
        fields: published ? [] : [{ label: 'Source', value: sel.modelId }],
        actions: [{
          key: 'open',
          label: 'Open',
          primary: true,
          onClick: () => openModel(sel.modelId, label, published),
        }] as DetailAction[],
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
        actions: buildAssetActions(entry.id, entry.name, writable, sel.providerId === 'project'),
      };
    }

    // Nothing picked yet — the project itself is what the pane describes.
    // Under the rail this slot said "Select an item to see its details"; on a
    // screen the user reached by choosing a project, the project's own verbs
    // are what they are most likely to want on arrival.
    if (sel.kind === 'project' || sel.kind === 'none') {
      const p = project.project;
      if (!p) return { title: null };
      return {
        title: p.name,
        subtitle: project.backendKind ? `${project.backendKind} project` : null,
        fields: [
          { label: 'Backend', value: project.backendKind ?? 'none' },
          { label: 'Scenes', value: String(project.scenes.length) },
          { label: 'Writable', value: project.writable ? 'yes' : 'no' },
          ...(project.folderName ? [{ label: 'Folder', value: project.folderName }] : []),
        ],
        actions: [
          { key: 'close', label: 'Close Project', onClick: handleCloseProject },
          {
            key: 'export',
            label: 'Export .rvproject',
            onClick: handleExportProject,
            disabled: project.backendKind !== 'folder',
            disabledReason: 'Only a project folder can be exported.',
          },
          { key: 'import', label: 'Import .rvproject…', onClick: handleImportProject },
        ] as DetailAction[],
      };
    }

    return { title: null };
  }, [dash.selection, project, sources, store, runVerb,
      openScene, duplicateScene, exportScene, deleteScene, handleCloseProject,
      handleExportProject, handleImportProject, buildAssetActions, openModel,
      sceneSnap?.published, project.models]);

  const handleForget = useCallback((id: string) => {
    forgetRecentProject(id);
    setRecent(readRecentProjects());
  }, []);

  if (!dash.open) return null;

  const onProjectScreen = dash.view === 'project' && project.project !== null;

  // Dialogs and the snackbar ride along on both screens: a verb started on one
  // can surface its failure after the user has navigated to the other.
  const sharedChrome = (
    <>
      {/* Imported since Phase 8 but never rendered until plan-702 — the Assets
          tab is now the single place a library is attached. The Asset-Manager
          tab appears only when the private extension supplied a cloud store. */}
      <AddLibraryDialog
        open={addLibraryOpen}
        onClose={() => setAddLibraryOpen(false)}
        onConnectAssetManager={cloudStore
          ? (req) => cloudStore.addConnection(req.label, {
              projectId: req.projectId,
              keyId: req.keyId,
              secretKey: req.secretKey,
            })
          : undefined}
      />
      <CreateHereDialog
        request={createHere}
        onChange={setCreateHere}
        onConfirm={() => setCreateHere(null)}
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
        scenes={project.scenes.map(s => ({ id: s.id, name: s.name }))}
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
  if (onProjectScreen) {
    const activeTab = projectTabOf(dash.group);
    const newAction = activeTab === 'scenes'
      ? { label: 'New scene', onClick: handleNewScene }
      : activeTab === 'assets'
        ? { label: 'New asset', onClick: handleNewAsset }
        : null;
    return (
      <ProjectsDashboard
        title={project.project?.name ?? 'Project'}
        onBack={() => setProjectsView('projects')}
        headerTabs={
          <Tabs
            value={activeTab}
            onChange={(_e, v: ProjectTab) => setProjectsTab(v)}
            aria-label="Project contents"
            slotProps={{ indicator: { sx: { height: 2 } } }}
            sx={{ ml: 2, minHeight: 32 }}
          >
            {sections.map(s => (
              <Tab
                key={s.key}
                id={projectTabId(s.key)}
                aria-controls={`rv-project-panel-${s.key}`}
                value={s.key}
                // The count rides on the label so an inactive tab already
                // answers "is there anything in there?".
                label={`${s.label} ${s.cards.length}`}
                sx={{ fontSize: 12, textTransform: 'none', minHeight: 32, py: 0, px: 1.5 }}
              />
            ))}
          </Tabs>
        }
        headerActions={
          <>
            {/* The verb belongs to the tab it acts on. One "New asset" button
                across all three read as the only thing a project can be given,
                and on the Scenes tab it was simply the wrong verb. Models have
                no create gesture — a base model is imported or exported from
                CAD, never authored here — so that tab offers none. */}
            {/* Attaching a library is a VIEWER-level action, not a project
                one: it works on a read-only deploy too, which is why it sits
                outside the writable-gated "New asset" button (plan-702 F3). */}
            {activeTab === 'assets' && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => setAddLibraryOpen(true)}
                sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
              >
                Add library
              </Button>
            )}
            {newAction && (
              // Creating writes to the project, so a read-only one says so up
              // front instead of failing on the click — a deploy served over
              // HTTP has no folder to write into at all.
              <Tooltip title={project.writable ? '' : 'This project is read-only.'}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={!project.writable}
                    onClick={newAction.onClick}
                    sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
                  >
                    {newAction.label}
                  </Button>
                </span>
              </Tooltip>
            )}
            {sharedChrome}
          </>
        }
      >
        <ProjectSections
          sections={sections}
          activeTab={activeTab}
          filtered={searchActive}
          assetGroups={assetGroups.length === 0 ? null : assetGroups.map((g, i) => (
            <AssetLibrarySection
              key={g.groupKey}
              group={g}
              first={i === 0}
              // `sectionsVersion` is read here so the collapse store's version
              // counter is a real dependency of this render, not a subscription
              // whose value is thrown away.
              collapsed={sectionsVersion >= 0
                && isSectionCollapsedEffective(g.groupKey, searchActive)}
              searchActive={searchActive}
              onToggle={() => toggleSection(g.groupKey, searchActive)}
              onRefresh={g.refreshable ? () => handleRefreshLibrary(g) : undefined}
              onGrantPermission={g.needsPermission ? handleGrantLibraryPermission : undefined}
              onRemove={g.removable ? () => handleRemoveLibrary(g) : undefined}
            />
          ))}
        />
        <ProjectsDetailPane {...detail} />
      </ProjectsDashboard>
    );
  }

  // ── Screen one: which project ─────────────────────────────────────────
  // Search is offered only once there is a list worth filtering; on the empty
  // state it would be a control that can only ever return nothing.
  const hasWorkspace = workspaceMeta !== null || workspaceProjects.length > 0;
  return (
    <ProjectsDashboard
      title="Projects"
      showSearch={projectRows.length > 0}
      headerActions={
        <>
          {hasWorkspace && !modeLocked && (
            <>
              <Button
                size="small"
                variant="outlined"
                onClick={handleOpenWorkspace}
                sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
              >
                Switch workspace
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => setNewProjectName('New Project')}
                sx={{ fontSize: 11, textTransform: 'none', whiteSpace: 'nowrap' }}
              >
                New project
              </Button>
            </>
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
        modeLocked={modeLocked}
        onOpenProject={handleOpenProject}
        onOpenWorkspace={handleOpenWorkspace}
        onOpenFolder={handleOpenFolder}
        onForgetProject={handleForget}
      />
    </ProjectsDashboard>
  );
}

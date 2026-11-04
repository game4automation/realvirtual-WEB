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
import { Alert, Badge, Box, Button, Chip, Collapse, Dialog, DialogContent, DialogTitle, Divider, IconButton, InputAdornment, LinearProgress, ListItemText, Menu, MenuItem, Snackbar, TextField, Tooltip, Typography } from '@mui/material';
import { SectionHeader } from '../shared-components';
import {
  Add, ChevronRight, CreateNewFolderOutlined, DeleteOutline, FilterList,
  MoreHoriz, MoreVert, NoteAddOutlined, Refresh, Search, SettingsEthernet,
} from '@mui/icons-material';
import type { LibraryCatalogEntry } from '../../library/library-types';
import { fileGlyphOf } from '../../library/AssetCard';
import { debug } from '../../engine/rv-debug'; // TEMP open-perf instrumentation
import {
  getLibrarySourcesSnapshot,
  listBrowsableLibrarySources,
  listLibrarySources,
  subscribeLibrarySources,
} from '../../library/library-source-registry';
import { getProjectStore } from '../../project/project-store';
import { projectAssetUrl } from '../../project/rv-project-asset-source';
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME } from '../../project/backends/bundled-backend';
import { WORKSPACE_DEFAULT_PROJECT_HINT } from '../../project/rv-workspace-default';
import {
  isSameLinkedFolder,
  listLinkedProjects,
  recordLinkedProject,
  relinkProject,
  unlinkProject,
  type LinkedProjectEntry,
} from '../../project/rv-project-linked';
import { FromScenesDialog, ProjectRenameDialog, type FromScenesRequest, type ProjectRenameRequest } from '../../project/ProjectCreateDialogs';
import { NewProjectDialog } from './NewProjectDialog';
import { createProjectFromScenes } from '../../project/rv-project-create';
import { writeManifest } from '../../project/rv-project-storage';
import {
  canonicalNameOf,
  normaliseFolderPath,
  readProjectFolders,
  withProjectFolders,
  type RvDocumentEntry,
} from '../../project/rv-project-types';
import { probeAddTarget } from '../../project/rv-project-add';
import { locateProjectFolder } from '../../project/rv-project-locate';
// The rules of Add / Open / Locate / Drop live in their own module for the same
// reason `dashboard-documents` does: this file cannot be rendered by a test, so
// a rule kept inside it is a rule with no test.
import {
  collectDropHandles,
  firstDirectoryHandle,
  isInternalDrag,
  linkChildProjects,
  resolveLinkedOpen,
  summariseParentAdd,
  verdictForAdd,
} from './linked-project-verbs';
import { seedProjectFromScan } from '../../project/rv-project-scan';
import { getAddJobSnapshot, startAddScan } from '../../project/rv-project-add-job';
import { readManifest } from '../../project/rv-project-storage';
import { detectOpenTarget, projectStartDocument } from '../../project/rv-project-open';
import { rememberSession } from '../../project/rv-project-resume-store';
import {
  clearRecents,
  forgetRecent,
  withOpenIntentMode,
} from '../../project/rv-project-recents-store';
import type { RecentDocumentEntry } from '../../project/rv-project-recents';
import { useRecentDocuments } from '../../../hooks/use-recent-documents';
import { isRecentDocumentsShortcut } from '../recent-documents-shortcut';
import { documentForSelectedPath, getRecentDocumentsHoverOpened, getRecentDocumentsOpen, subscribeRecentDocumentsOpen, setRecentDocumentsOpen, toggleRecentDocumentsOpen } from './projects-dashboard-store';
import { RecentDocumentsPopover } from './RecentDocumentsPopover';
import { ProjectOperationDialog } from './ProjectOperationDialog';
import { RegenerateThumbnailsDialog } from './RegenerateThumbnailsDialog';
import { resetProjectOpProgress, startProjectOp } from '../../project/project-op-progress';
import {
  isOpeningRecent, openProjectDocument, openRecentEntry,
  type OpenChainBaseDeps, type OpenRecentResult,
} from './open-recent-entry';
import { allowedModesOf, documentModeKey, effectiveOpenMode, handoffParkMode, isModeAllowedForRow, type DocumentModeRecord } from '../../project/rv-document-mode';
import {
  loadDocumentModes, readDocumentMode, subscribeDocumentModes,
} from '../../project/rv-document-mode-store';
import { forgetProjectTraces } from './forget-project-traces';
import {
  forgetModelIndexEntry, loadModelIndex, subscribeModelIndex,
} from '../../project/rv-model-index-store';
import { indexBundledProject } from '../../project/rv-model-index-writer';
import { modelIndexKey, type ModelIndexSnapshot } from '../../project/rv-model-index';
import {
  MAX_SEARCH_RESULTS as MAX_MODEL_SEARCH_RESULTS,
  buildModelSearchIndex, capModelSearch, searchModelIndex, unindexedLinkedCount, visibleSnapshots,
  type ModelSearchGroup, type ModelSearchHit, type ModelSearchProject,
} from '../../project/rv-model-search';
import { ModelSearchResults } from './ModelSearchResults';
import { openProjectById } from './open-project-by-id';
import {
  getFolderHandle,
  getHandle,
  pickFolderForKey,
  projectHandleKey,
  putHandle,
  type FolderPick,
} from '../../engine/rv-local-filesystem';
import { exportProject, importProject, RVPROJECT_EXTENSION } from '../../project/rv-project-transport';
import type { LinkedRowState } from './ProjectsList';
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
import { useThumbnailUrl } from '../../thumbnails/rv-thumbnail-url-store';
import { AddLibraryDialog, type AddLibraryProjectsOptions } from '../../library/AddLibraryDialog';
import { readProjectLibraries } from '../../library/project-libraries';
import { countOpenLibraryPlacements, ensureLibraryCommandsRegistered } from '../../library/library-commands';
import { LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID } from '../../library/library-origin';
import { getLibraryProjectLoader } from '../../library/library-project-loader';
import { isLibraryProjectSource } from '../../library/library-projects-provider';
import { libraryStateBadge, runLibraryRepair } from '../../library/library-project-ui';
import { attachedLibraryProjectIdsOf, detachConfirmationMessage, libraryRemovalKeepsAvailable } from '../../library/project-library-attach';
// plan-776 #20: registered and dispatched BY ID — the loop, the writer and the
// renderer stay out of the dashboard (guard 9.5); the descriptor is light.
import {
  dispatchRegenerateThumbnails,
  ensureThumbnailCommandsRegistered,
  regenerateThumbnailsMenuState,
} from '../../thumbnails/rv-thumbnail-regenerate-commands';
// At import, not while a menu renders: a first registration notifies the
// registry's subscribers, which must not happen inside a render.
ensureThumbnailCommandsRegistered();
import { commandRegistry } from '../rv-command-registry';
import { setPendingAssetOpen } from '@rv-private/plugins/asset-editor/shared/pending-open-store';
import { useViewer } from '../../../hooks/use-viewer';
import { getSceneStore } from '../scene/scene-store-singleton';
import { SceneConfirmDialog } from '../scene/rv-scene-confirm-dialog';
import { SceneNameDialog } from './SceneNameDialog';
import { AssetPromptDialog } from './AssetPromptDialog';
import { ProjectsDashboard } from './ProjectsDashboard';
import { ProjectsList, type ProjectListRow } from './ProjectsList';
import { ProjectTree, PROJECT_TREE_DRAG_TYPE } from './ProjectTree';
import {
  buildDashboardTree,
  catalogRootId,
  isFileRef,
  type CatalogRootInput,
  type TreeCatalogEntryInput,
} from '../../project/rv-project-tree-sources';
import {
  buildProjectTree,
  canMoveInTree,
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
import {
  CONNECT_CONFIG_DRAG_TYPE,
  KNOWLEDGE_FILE_DRAG_TYPE,
  SCRIPT_FILE_DRAG_TYPE,
} from './connect-config-dnd';
import { setDragChip } from './drag-chip';
import { reportDocumentIdCollisions } from '../problems-store';
import { selectionPointsIntoGroup, type SelectedAssetRef } from './assets-library-groups';
import type { ProjectCardMenuAction } from './ProjectCard';
import { ProjectsDetailPane, type DetailAction, type DetailField } from './ProjectsDetailPane';
import { ProjectsDetailSheet } from './ProjectsDetailSheet';
import {
  collapseCrumbs, isCollapsedCrumbs, mobileLibraryTiles,
} from './mobile-folder-view';
import { useMobileLayout, useTouchDevice } from '../../../hooks/use-mobile-layout';
import { DestructiveConfirmDialog, type DestructiveConfirmRequest } from './DestructiveConfirmDialog';
import {
  beginProjectsOpening,
  closeProjectsDashboard,
  endProjectsOpening,
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
  matchesDocumentChip,
  matchesDocumentFilter,
  matchesDocumentTag,
  matchesSearchTerm,
  type ClassifiedRow,
  type DocumentFilterState,
} from './document-filter';
import {
  buildProjectSearchIndex, capSearchResult, filterSearchGroups, isDocumentHit,
  searchDocumentRows, searchProjectIndex,
} from '../../project/rv-project-tree-search';
import { ProjectSearchResults } from './ProjectSearchResults';
import { projectsScreenActive, useDashboardSearchShortcut } from './dashboard-search-shortcut';
import { DocumentFilterBar } from './DocumentFilterBar';
import { DocumentHeroSection } from './DocumentHeroSection';
import { ClassificationEditor } from './ClassificationEditor';
import { DocumentInfoEditor } from './DocumentInfoEditor';
// plan-716 §2.7 / F8 — the dashboard's readers of THE one list. They live in
// their own module because this file cannot be rendered by a test.
import {
  documentById,
  documentCardPicture,
  documentPickOptions,
  documentRoleBadge,
  documentsUsingRef,
  documentTypeBadge,
  formatDocumentSize,
  newDocumentFolderFor,
  newDocumentNameFor,
  type DocumentStatEntry,
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
import type { DocumentInfo } from '../../project/rv-document-info';
import type { TieredDocumentEntry } from '../../project/rv-project-tiers';
import { sceneUrlToDocumentUrl } from '../../project/rv-doc-alias';

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
/**
 * The CONNECT and Knowledge reference rows of one document — one fact, both routes.
 *
 * The detail pane reaches a document by ID (a tree row) or by PATH (a card), and
 * both branches used to write these two rows out by hand (plan-461 V13). A
 * reference whose file is not in the listing is marked "— missing": a dead
 * reference is exactly what these rows exist to surface.
 */
function refFields(
  doc: RvDocumentEntry | null | undefined,
  connectConfigs: readonly string[],
  knowledgeFiles: readonly string[],
): DetailField[] {
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
}

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
  /** `document:<id>` — one key shape for every row (plan-777 F8). */
  key: string;
  /** The manifest document, when this row has one. Absent for a bare example. */
  doc?: TieredDocumentEntry;
}

/** What {@link openDocumentAsWorkingScene} needs of the viewer — the mode manager. */
export interface WorkingSceneOpenModes {
  activeMode: string | null;
  list(): readonly { id: string }[];
  /** The modes the open document allows (`ModeManager.available`). Optional for test doubles. */
  available?(): readonly { id: string }[];
  /**
   * Lift the LEAVING document's mode restriction (`documents[].modes`) before a
   * switch made on the way to another document - see case (a) of
   * `runDecidedHandoff`. The load installs the new document's own restriction.
   */
  setRestriction?(restriction: null): void;
  setMode(id: string): void;
  /**
   * The awaited switch (plan-652): resolves once the mode is committed, after its
   * on-demand feature loaded. Optional so test doubles without it keep working.
   */
  setModeAsync?(id: string): Promise<boolean>;
  /** Sync when nothing has to load, a promise otherwise (plan-652 Phase 4). Optional like setModeAsync. */
  switchMode?(id: string): boolean | Promise<boolean>;
  /**
   * `token` is the workspace switch lock of the caller that owns this open
   * (plan-478 R3-2). Absent for an ordinary double-click, which owns nothing;
   * present when the recents chain holds the lock and this handoff is the
   * re-entry it is allowed to make.
   */
  requestMode(id: string, token?: symbol): unknown;
}

/**
 * `setMode` that WAITS for the switch (plan-652 section 2.4.4). The handoff's next step -
 * `openScene`, or the pending asset the editor's activation reads - assumes the
 * mode has changed; a lazy target (the Editor) would otherwise switch later, outside
 * the `withOpenIntentMode` scope (plan-478 F1b).
 */
function setModeAwaited(modes: WorkingSceneOpenModes, id: string): Promise<unknown> | undefined {
  // An ordinary switch (no feature to load) stays SYNCHRONOUS - no promise, so the caller
  // adds no turn between leaving the editor and `openScene` (plan-478 ordering,
  // recent-documents-open-chain R3-3/4). Only a lazy target hands back a promise.
  if (typeof modes.switchMode === 'function') {
    const result = modes.switchMode(id);
    return typeof result === 'boolean' ? undefined : result;
  }
  if (typeof modes.setModeAsync === 'function') return modes.setModeAsync(id);
  modes.setMode(id);
  return undefined;
}

/**
 * Open a document row as the working scene — including the EDITOR handoff.
 *
 * Exported (and separated from the host's `openDocumentRow` callback) so the handoff
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
/**
 * Which mode the handoff parks in while the load runs.
 *
 * Exported because a caller that must clear the exit guards BEFORE the handoff
 * runs (the recents chain, plan-478) has to name the mode the handoff will
 * depart to — and two spellings of "the first non-editor mode" is how the
 * guard check and the actual departure start to disagree.
 */
export function handoffExitTarget(modes: {
  list(): readonly { id: string }[];
  available?: () => readonly { id: string }[];
}): string {
  // The one spelling lives beside the chain's guard rule (plan-513).
  return handoffParkMode(modes);
}

/** What the handoff needs of the scene store. */
export interface WorkingSceneStore {
  openScene(id: string, opts?: { modeDecidedByCaller?: boolean }): Promise<void>;
}

/**
 * Handoffs run ONE AT A TIME (plan-478 R3-2).
 *
 * Two overlapping handoffs interleave three shared things — the mode manager,
 * the scene store's single workspace, and the recents ring's intent scope — and
 * the second one to START is routinely the first to FINISH (a small document
 * loads while a large one is still decoding). Serialising them is cheaper than
 * making each of those three safe against interleaving, and it is what the
 * user already believes is happening: a double-click means "open this instead",
 * never "open both".
 *
 * A failed handoff must not poison the queue, so the tail is the SETTLED
 * promise; the caller still gets the rejection through `run`.
 */
let handoffQueue: Promise<unknown> = Promise.resolve();

/**
 * `targetMode` (plan-513) is the mode the open chain has DECIDED this open ends
 * in, with its exit guards already asked. Absent, the handoff behaves exactly
 * as it always has. Resolves `false` only when the editor refused its re-entry
 * at the end of an editor → editor open; every other outcome is `true`.
 */
export function openDocumentAsWorkingScene(
  viewer: { modes: WorkingSceneOpenModes },
  sceneStore: WorkingSceneStore,
  documents: readonly TieredDocumentEntry[],
  id: string,
  switchToken?: symbol,
  targetMode?: string,
): Promise<boolean> {
  const run = handoffQueue.then(
    () => runHandoff(viewer, sceneStore, documents, id, switchToken, targetMode),
    () => runHandoff(viewer, sceneStore, documents, id, switchToken, targetMode),
  );
  handoffQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function runHandoff(
  viewer: { modes: WorkingSceneOpenModes },
  sceneStore: WorkingSceneStore,
  documents: readonly TieredDocumentEntry[],
  id: string,
  switchToken?: symbol,
  targetMode?: string,
): Promise<boolean> {
  if (targetMode !== undefined) {
    return runDecidedHandoff(viewer.modes, sceneStore, documents, id, targetMode, switchToken);
  }
  const modes = viewer.modes;
  const wasEditor = modes.activeMode === 'editor';
  // The whole leave/load/re-enter dance is ONE open with ONE intended mode
  // (plan-478 F1b). Inside the scope the recents ring records the mode this
  // open ends in rather than the transitional one it passes through, and the
  // `mode-changed` retagging is inert — without that, the `setMode` two lines
  // down would stamp the transitional mode onto the document being LEFT, which
  // is still the ring's head until the new one is recorded (SOL R2 F4).
  await withOpenIntentMode(wasEditor ? 'editor' : null, async () => {
    if (wasEditor) { const pending = setModeAwaited(modes, handoffExitTarget(modes)); if (pending) await pending; }
    await sceneStore.openScene(id);
    const sceneRow = documentById(documents, id);
    if (sceneRow) setOpenDocumentBase(sceneDocumentBase(id, sceneRow.name));
    if (wasEditor) {
      if (sceneRow) {
        setPendingAssetOpen(documentBase(id, sceneRow.name, sceneRow.path));
      }
      // AWAITED, not fired and forgotten (plan-478 R3-3). The re-entry runs the
      // editor's own activation — `_resolveOpenPlan`, which may raise the
      // conflicting-draft dialog — and a caller that continued past it would
      // set its target mode while this switch was still deciding, letting the
      // later-landing `requestMode` win and leaving the workspace in `editor`
      // when the recent asked for something else. It stays INSIDE the intent
      // scope, so the resulting `mode-changed` retags nothing: the ring's head
      // is already this document with `editor` recorded from the intent.
      await modes.requestMode('editor', switchToken);
    }
  });
  return true;
}

/**
 * The handoff with a DECIDED target (plan-513 F7): the chain asked the exit
 * guards for exactly this transition, so nothing here asks again — except the
 * editor's own re-entry in case c, which is the editor's activation, not a
 * guard question.
 *
 * All four cases run inside `withOpenIntentMode(target)`: the recording takes
 * the target, and the `mode-changed` trackers stay inert while the workspace
 * passes through anything else. The load is `modeDecidedByCaller`, so the row's
 * declared mode is not applied a second time.
 *
 *  a. editor → X: leave straight INTO X, then load. No park mode.
 *  b. X → editor: load, publish the identity, set the pending asset, THEN
 *     activate the editor — its activation resolves what it shows from the
 *     pending open, so the order is the contract (plan-513 risk "Editor ohne
 *     geladenes Asset").
 *  c. editor → editor: the path as it always was — park, load, pending,
 *     `requestMode('editor')` with the chain's token. Its `false` travels back
 *     so the chain can answer `vetoed-after-open`.
 *  d. X → Y (neither the editor): load, then switch if Y differs.
 */
async function runDecidedHandoff(
  modes: WorkingSceneOpenModes,
  sceneStore: WorkingSceneStore,
  documents: readonly TieredDocumentEntry[],
  id: string,
  target: string,
  switchToken?: symbol,
): Promise<boolean> {
  const wasEditor = modes.activeMode === 'editor';
  const sceneRow = documentById(documents, id);
  const publishIdentity = () => {
    if (sceneRow) setOpenDocumentBase(sceneDocumentBase(id, sceneRow.name));
  };
  const pendAsset = () => {
    if (sceneRow) setPendingAssetOpen(documentBase(id, sceneRow.name, sceneRow.path));
  };
  return withOpenIntentMode(target, async () => {
    if (wasEditor && target === 'editor') {                       // (c)
      { const pending = setModeAwaited(modes, handoffExitTarget(modes)); if (pending) await pending; }
      await sceneStore.openScene(id, { modeDecidedByCaller: true });
      publishIdentity();
      pendAsset();
      return (await modes.requestMode('editor', switchToken)) !== false;
    }
    if (wasEditor) {                                              // (a)
      // The switch happens BEFORE the load, i.e. while the document being LEFT
      // still restricts the modes: its restriction must not refuse the mode the
      // NEXT document opens in (the chain already checked `target` against that
      // document's own `modes`). The load installs the new restriction.
      modes.setRestriction?.(null);
      { const pending = setModeAwaited(modes, target); if (pending) await pending; }
      await sceneStore.openScene(id, { modeDecidedByCaller: true });
      publishIdentity();
      // A store notification during a deferred departure can reinstall the old
      // restriction and refuse it; the new document's restriction is in place
      // now and `target` was checked against it, so settle it here.
      if (modes.activeMode !== target) {
        const pending = setModeAwaited(modes, target); if (pending) await pending;
      }
      return true;
    }
    await sceneStore.openScene(id, { modeDecidedByCaller: true });
    publishIdentity();
    if (target === 'editor') {                                    // (b)
      pendAsset();
      { const pending = setModeAwaited(modes, 'editor'); if (pending) await pending; }
    } else if (modes.activeMode !== target) {                     // (d)
      { const pending = setModeAwaited(modes, target); if (pending) await pending; }
    }
    return true;
  });
}

export function ProjectsDashboardHost() {
  const dash = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);
  /**
   * Two independent questions, asked once here and handed down as booleans
   * (plan-458 §2.1).
   *
   * `compactLayout` is about WIDTH: below 900px the three columns do not fit,
   * so the grid becomes the screen, the tree goes and the detail pane becomes
   * a sheet. `touchInput` is about the POINTER: a long-press replaces the
   * right-click and inputs grow to 16px so iOS does not zoom on focus.
   *
   * They are deliberately not one flag. A narrow desktop window is compact but
   * still has a mouse; a wide touch tablet keeps the three columns but has no
   * right-click. Merging them would give each of those the wrong half.
   */
  const compactLayout = useMobileLayout();
  const touchInput = useTouchDevice();
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

  /**
   * The linked projects — this browser's whole project list (plan-743 F1).
   *
   * Held as state rather than derived, because reading it is async (the
   * localStorage rows are intersected with the IndexedDB handle keys) and every
   * verb that changes it — Add, New, Locate, Remove, and an ordinary open —
   * has to publish the new list itself.
   */
  const [linked, setLinked] = useState<LinkedProjectEntry[]>([]);
  /**
   * Per-row openability, collected AFTER the first paint.
   *
   * ONE `setState` for the whole map, never one per row: the probe is N async
   * round-trips, and a `setState` inside each would repaint the list N times
   * while the user is trying to read it.
   */
  const [rowStates, setRowStates] = useState<Map<string, LinkedRowState>>(() => new Map());

  /** Correct ONE row's state after a click told us more than the probe could. */
  const setRowState = useCallback((id: string, state: LinkedRowState) => {
    setRowStates(prev => {
      if (prev.get(id) === state) return prev;   // identity is the render signal
      const next = new Map(prev);
      next.set(id, state);
      return next;
    });
  }, []);

  const refreshLinked = useCallback(async (): Promise<LinkedProjectEntry[]> => {
    let rows: LinkedProjectEntry[] = [];
    try {
      rows = await listLinkedProjects();
    } catch {
      rows = [];
    }
    setLinked(rows);
    return rows;
  }, []);

  // Listing is cheap and asks for nothing: no disk read, no permission. It can
  // therefore run on every dashboard open rather than on a "scanned once"
  // latch, which is what kept the old workspace list stale after a change made
  // in another tab.
  useEffect(() => {
    if (!dash.open) return;
    let alive = true;
    void (async () => {
      const rows = await listLinkedProjects().catch(() => [] as LinkedProjectEntry[]);
      if (!alive) return;
      setLinked(rows);

      // The permission probe comes second, and only `queryPermission` — the
      // list must be readable before any of this resolves, and a `prompt` here
      // would raise a browser dialog the user never asked for.
      const states = new Map<string, LinkedRowState>();
      // plan-778 (review Stab 9): a linked project that is a LIBRARY of the open
      // project is only ever read (Decision 3) — probing it for readwrite would
      // show "needs grant" for a folder the library loader reads just fine.
      const libraryIds = new Set(attachedLibraryProjectIdsOf(store.getProject()));
      await Promise.all(rows.map(async (row) => {
        try {
          const handle = await getHandle(projectHandleKey(row.id));
          if (!handle) { states.set(row.id, 'missing'); return; }
          const perm = await handle.queryPermission({ mode: libraryIds.has(row.id) ? 'read' : 'readwrite' });
          states.set(row.id, perm === 'granted' ? 'ready' : 'needs-grant');
        } catch {
          // A stale handle throws here; the click will tell the two apart.
          states.set(row.id, 'needs-grant');
        }
      }));
      if (alive) setRowStates(states);
    })();
    return () => { alive = false; };
  }, [dash.open, dash.view]);

  // `hidden` sources are resolver-only (service unreachable) — not browsable.
  // plan-778: plus the TRANSITIVE library projects (hidden — not placeable), so
  // the tree can show them as "needed by <B>" roots with their state and repair.
  const sources = useMemo(() => [
    ...listBrowsableLibrarySources(),
    ...listLibrarySources().filter(({ providerId, source }) => providerId === LIBRARY_PROJECTS_PROVIDER_ID
      && source.hidden === true && isLibraryProjectSource(source) && source.neededBy.length > 0),
  ], [registryVersion]);
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

  /**
   * The rows of the list screen: the bundled demo, then the linked projects in
   * their own order, then the open project if it is neither.
   *
   * The linked list is ALREADY sorted (last opened first, then last linked), so
   * this memo does not re-sort it: the ordering is a property of the list, and
   * deriving it a second time here is how the two would eventually disagree.
   * The ordering is deliberately SILENT (user decision 2026-09-07): no badge,
   * no timestamp, no "Recent" heading, only position.
   *
   * `DemoRealvirtual` — the shipped demo project — is listed whether or not it
   * is open, because a deploy serves it over HTTP and no folder listing could
   * ever find it there. Unless the user has LINKED the demo folder itself: then
   * the same project would be two rows, and the bundled one wins (plan-743 F12,
   * the same rule the store's collision guard applies).
   */
  const projectRows = useMemo<ProjectListRow[]>(() => {
    // Unfiltered (plan-509 SOL R2 F3): a term typed on this screen searches
    // MODELS, the cards give way to the hit list while it is there, and this
    // list is also where the hit groups take their order and names from.
    const bundledIds = new Set<string>([DEMO_PROJECT_ID]);
    const bundledRows: ProjectListRow[] = [{
      id: DEMO_PROJECT_ID,
      name: DEMO_PROJECT_NAME,
      caption: 'realvirtual demo scenes & library',
      hint: 'bundled' as const,
    }];

    const linkedRows: ProjectListRow[] = linked
      .filter(l => !bundledIds.has(l.id) && l.name !== DEMO_PROJECT_NAME)
      .map(l => ({
        id: l.id,
        name: l.name,
        caption: l.folderName,
        hint: 'local' as const,
        state: rowStates.get(l.id) ?? 'ready',
        canManage: true,
        canUnlink: true,
      }));

    const rows: ProjectListRow[] = [...bundledRows, ...linkedRows];

    const open = project.project;
    if (open && !rows.some(r => r.id === open.id)) {
      // The browser project has no folder and no link, so it can neither be
      // removed nor renamed — it goes LAST (user decision: it is a fallback,
      // not a recent).
      rows.push({
        id: open.id,
        name: open.name,
        caption: project.backendKind === 'browser'
          ? WORKSPACE_DEFAULT_PROJECT_HINT
          : project.folderName ?? `${project.backendKind ?? 'open'} project`,
        // The open project is the one row whose backend is known exactly, so
        // its hint is read rather than assumed. 'browser' is the implicit
        // project and says so: it lives in this browser's storage.
        hint: project.backendKind === 'bundled' ? 'bundled'
          : project.backendKind === 'browser' ? 'browser'
          : 'local',
      });
    }
    return rows;
  }, [linked, rowStates,
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
  const operationRef = useRef(false);
  const [operationLabel, setOperationLabel] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // One confirm for every destructive verb — see DestructiveConfirmDialog.
  const [confirmReq, setConfirmReq] = useState<DestructiveConfirmRequest | null>(null);
  const [fromScenes, setFromScenes] = useState<FromScenesRequest | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

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
    if (operationRef.current) return;
    operationRef.current = true;
    setSuccessMessage(null);
    setMessage(null);
    setOperationLabel(label.replace(/^Rename/, 'Renaming').replace(/^Delete/, 'Deleting'));
    setBusy(true);
    startProjectOp();
    try {
      await fn();
      if (/^(Rename|Delete)/.test(label)) setSuccessMessage(`${label} completed.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : `${label} failed: ${String(e)}`);
    } finally {
      resetProjectOpProgress();
      setBusy(false);
      setOperationLabel(null);
      operationRef.current = false;
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
  const openProject = useCallback(async (id: string) => {
    const isLinked = linked.some(l => l.id === id);
    // "Already open" is only true when it is the same THING, not merely the
    // same id. DemoRealvirtual exists twice under one id — as the read-only
    // HTTP fallback and as a linked folder — so while the HTTP one is open,
    // clicking the folder row must still open the folder. Treating it as
    // navigation is what left the project permanently read-only.
    if (id === project.project?.id && (!isLinked || project.backendKind === 'folder')) {
      setProjectsView('project');      // genuinely already open — pure navigation
      return;
    }

    // The verb itself lives in `open-project-by-id.ts` since plan-478 Phase 3:
    // the recents chain must be able to AWAIT an open and to know WHY one did
    // not happen, and two spellings of "open this project" is how the two
    // would start to differ. What stays here is the host's reaction to the
    // answer — the view, the row state, the message.
    //
    // The "already open" question is answered ABOVE, with this file's own rule
    // (the id is not enough — DemoRealvirtual exists twice), so the verb is
    // told there is nothing open and simply performs the open.
    //
    // Opening a project shows the PROJECT — its folders and documents — and
    // nothing else. Until 2026-09-25 this click also armed a "resume" effect
    // that resolved a document (URL `?scene=`, the remembered pair, the
    // manifest's `activeSceneId`, `defaultModel`) and loaded it, closing the
    // dashboard behind the user's back whenever one of those happened to name
    // a document of the clicked project. Resuming into a document is the
    // BOOT's job (`main.ts`, reload and kiosk); a click on a folder is a
    // request to look inside it. A document opens when a document is clicked.
    const r = await openProjectById(
      { projectId: id, backend: !isLinked && id === DEMO_PROJECT_ID ? 'bundled' : 'folder' },
      {
        currentProject: () => null,
        isLinked: () => isLinked,
        resolveLinkedOpen,
        store,
        afterLinkedOpen: refreshLinked,
        onRowState: setRowState,
      },
    );
    if (r === 'opened' || r === 'already-open') {
      setProjectsView('project');
      return;
    }
    // `denied` / `missing` already said what they are, as a row state.
    if (r !== 'denied' && r !== 'missing') {
      setMessage('That project could not be opened.');
    }
  }, [project.project?.id, project.backendKind, linked, store,
      setRowState, refreshLinked]);

  const handleOpenProject = useCallback((id: string) => {
    void runVerb('Open project', () => openProject(id));
  }, [runVerb, openProject]);

  /**
   * **Add** — link a folder the user already has (plan-743 F2).
   *
   * One picker, one directory listing, and the listing answers which of three
   * shapes it is. The user is never asked to classify their own folder:
   *
   *  - **project** — link it and open it;
   *  - **parent** — link every child project and write NOTHING to the folder
   *    itself (the replacement for migrating an old workspace root);
   *  - **plain** — offer to make it a project by scanning it for GLBs.
   *
   * Shared by the Add button, the drop handler and Locate, because all three
   * arrive at the same place: a directory handle of unknown shape.
   */
  const addProjectFolder = useCallback(async (dir: FileSystemDirectoryHandle) => {
    // Reentrancy guard: a second Add while a scan runs would either queue
    // invisibly or replace the job the user is watching. Neither is honest.
    if (getAddJobSnapshot().status === 'running') {
      setMessage('A folder is still being scanned — cancel it or wait for it to finish.');
      return;
    }
    const verdict = await verdictForAdd(dir, linked);

    if (verdict.kind === 'project') {
      const manifest = verdict.manifest;
      if (verdict.probe.manifestBroken || !manifest) {
        setMessage(`"${dir.name}" holds a project.json that could not be read.`);
        return;
      }
      if (verdict.duplicateOfOtherFolder) {
        const keep = window.confirm(
          `This folder is a copy of project "${manifest.name}", which is already linked. `
          + 'Replace the link?');
        if (!keep) return;
      }
      const ok = await store.openProjectFolder(dir);
      if (!ok) {
        setMessage('That project could not be opened.');
        return;
      }
      await refreshLinked();
      setRowState(manifest.id, 'ready');
      setProjectsView('project');
      return;
    }

    if (verdict.kind === 'parent') {
      const added = await linkChildProjects(dir, verdict.childProjects, linked);
      await refreshLinked();
      setProjectsView('projects');
      setMessage(summariseParentAdd(added));
      return;
    }

    // Plain: the folder may be full of GLBs, it just holds no manifest. The
    // scan runs in the module-level job store, so closing the dashboard does
    // not cancel it.
    startAddScan(dir, (outcome) => {
      if (outcome.kind !== 'success' || !outcome.result) {
        if (outcome.kind === 'error' && outcome.error) setMessage(outcome.error);
        return;                          // cancelled: nothing written, nothing said
      }
      const result = outcome.result;
      void runVerb('Add project', async () => {
        await seedProjectFromScan(dir, dir.name || 'New project', result);
        // Nested projects become their own rows — the same thing the `parent`
        // branch does, reached from the other direction.
        const added = await linkChildProjects(
          dir, result.nestedProjectDirs.map(n => n.relPath), linked,
          result.nestedProjectDirs.map(n => n.dir));
        const ok = await store.openProjectFolder(dir);
        await refreshLinked();
        if (!ok) {
          setMessage('The project was created but could not be opened.');
          return;
        }
        setProjectsView('project');
        if (added.linked > 0) setMessage(summariseParentAdd(added));
      });
    });
  }, [runVerb, store, linked, refreshLinked, setRowState]);

  // Only entry points acquire the operation guard. Composed steps are awaited
  // inside the same operation so Add and Locate cannot suppress their own work.
  const handleAdd = useCallback((dir: FileSystemDirectoryHandle) => {
    void runVerb('Add project', () => addProjectFolder(dir));
  }, [runVerb, addProjectFolder]);

  /** Add via the button: pick a folder first, then classify it. */
  const handleAddPick = useCallback(() => {
    void runVerb('Add project', async () => {
      const dir = await pickFolder('rv-project-pick');
      if (!dir) return;                // cancelled, or already explained by pickFolder
      await addProjectFolder(dir);
    });
  }, [runVerb, pickFolder, addProjectFolder]);

  /**
   * **Locate…** — the row's folder moved, point it at the new place (F6).
   *
   * The one place a handle is replaced WITHOUT a confirm — but only when the
   * folder found still carries the same project id. The old folder is gone by
   * definition (that is why the row said "Folder not found"), so there is no
   * other folder for the row to lose. A different id is a different project and
   * goes through the ordinary Add, after the user has said so.
   */
  const handleLocate = useCallback((id: string) => {
    const entry = linked.find(l => l.id === id);
    void runVerb('Locate project', async () => {
      const dir = await pickFolder('rv-project-pick');
      if (!dir) return;
      // The pre-778 refusal stays first (review U6): a folder whose project.json
      // is missing or broken is refused here, exactly as before — whatever a
      // lenient manifest read might still make of it.
      const probe = await probeAddTarget(dir);
      if (!probe.hasManifest || probe.manifestBroken) {
        setMessage(`"${dir.name}" does not hold a readable project.json.`);
        return;
      }
      // plan-778: the verdict is shared with the library Locate (Problems panel).
      const verdict = await locateProjectFolder(id, dir, entry?.name);
      if (verdict.kind === 'unreadable') {
        setMessage(verdict.message);
        return;
      }
      if (verdict.kind === 'ok') {
        await relinkProject(id, dir);
        await refreshLinked();
        setRowState(id, 'ready');
        await openProject(id);
        return;
      }
      const replace = window.confirm(
        `This folder holds project "${verdict.found.name}". `
        + `Replace the list entry for "${entry?.name ?? id}"?`);
      if (!replace) return;
      await unlinkProject(id);
      // The replaced entry's traces go with it, like Remove's (plan-509 F7):
      // its recents and its folder model-index snapshot describe a project
      // that is no longer on the list.
      await forgetProjectTraces(id);
      await refreshLinked();
      await addProjectFolder(dir);
    });
  }, [linked, runVerb, pickFolder, refreshLinked, setRowState, openProject, addProjectFolder]);

  /**
   * **Remove from list** — forget the row and the handle, touch no file (F7).
   *
   * Both halves, or the orphan fallback in `listLinkedProjects` would put the
   * project straight back under "Untitled project" and the verb would look
   * broken.
   */
  const handleRemove = useCallback((id: string) => {
    void runVerb('Remove project', async () => {
      await unlinkProject(id);
      // Its recents go with it (plan-478 F10). A row pointing at a project the
      // user just unlinked can only ever answer "that project could not be
      // opened", and a list that keeps offering it reads as the verb not
      // having worked. The same holds for its model-index snapshot (plan-509
      // F7) — `forgetProjectTraces` is the one list of what goes.
      await forgetProjectTraces(id);
      await refreshLinked();
      setRowStates(prev => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    });
  }, [runVerb, refreshLinked]);

  /**
   * Drop an OS folder on the dashboard — the same thing as Add (F10).
   *
   * `getAsFileSystemHandle()` is called for every item SYNCHRONOUSLY inside the
   * drop handler and awaited only afterwards: the DataTransfer items are
   * neutered once the event tick ends, and an `await` before the calls makes
   * every one of them answer `null`.
   */
  const handleDashboardDrop = useCallback((e: React.DragEvent) => {
    // The dashboard already carries internal drags (CONNECT configs, knowledge
    // files). They own the drop; only an OS drag reaches Add.
    const types = Array.from(e.dataTransfer?.types ?? []);
    if (isInternalDrag(types, [
      CONNECT_CONFIG_DRAG_TYPE, KNOWLEDGE_FILE_DRAG_TYPE, SCRIPT_FILE_DRAG_TYPE,
    ])) return;

    const pending = collectDropHandles(Array.from(e.dataTransfer?.items ?? []));
    if (pending.length === 0) return;
    e.preventDefault();
    void (async () => {
      const dir = await firstDirectoryHandle(pending);
      if (dir) handleAdd(dir);
    })();
  }, [handleAdd]);

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

  /**
   * Pack with libraries (plan-778 F15, Decision 5): the open folder project plus
   * TRIMMED copies of the library projects it uses (`libraries/<id>/`) into a
   * folder the user picks — the browser half of what every delivery does, same
   * algorithm (`rv-library-trim-core.mjs`). The picker is the FIRST statement of
   * the click (user activation); the pack module loads lazily afterwards.
   */
  const handlePackWithLibraries = useCallback(() => {
    const picker = (window as Window & {
      showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) return;
    // Review U5: a running verb would make `runVerb` return without awaiting the
    // pick — ask BEFORE opening a picker whose result nobody would use.
    if (operationRef.current) {
      setMessage('Another project operation is still running — try again when it has finished.');
      return;
    }
    const picked = picker({ mode: 'readwrite' }).catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return null;   // cancelled — not an error
      throw e;
    });
    // Terminal handler: the verb below reports a failed pick; this only keeps a
    // rejection that no verb awaited from becoming an unhandled one.
    picked.catch(() => {});
    void runVerb('Pack with libraries', async () => {
      const target = await picked;
      if (!target) return;
      const dir = store.getProjectDir();
      if (!dir) throw new Error('Only a project folder can be packed.');
      const { packProjectWithLibraries, packLibrariesFromNodes } = await import('../../project/rv-library-pack');
      const nodes = getLibraryProjectLoader()?.getNodes() ?? [];
      const builtin = nodes.find((n) => n.projectId === REALVIRTUAL_LIBRARY_PROJECT_ID);
      const result = await packProjectWithLibraries({
        projectDir: dir,
        target,
        openLibrary: packLibrariesFromNodes(nodes),
        realvirtualLibrary: builtin?.state.kind === 'ready' && builtin.state.project
          ? (builtin.state.project as unknown as Record<string, unknown>)
          : null,
      });
      if (result.kind !== 'packed') throw new Error(result.message);
      const libs = result.libraries.map((l) => `${l.projectId} (${l.documentIds.length})`).join(', ');
      setSuccessMessage(`Packed ${result.files.length} files into "${target.name}"`
        + (libs ? ` with libraries ${libs}.` : ' (no libraries needed).'));
    });
  }, [runVerb, store]);

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
      // Unpacked into a folder the user picks now, and LINKED straight after:
      // an import that did not appear in the list would have to be found with
      // Add on the very next visit.
      const dir = await pickFolder('rv-project-pick');
      if (!dir) return;
      const result = await importProject(file, dir);
      if (result.kind !== 'imported') throw new Error(
        'message' in result ? result.message : 'Import failed.');
      await putHandle(dir, projectHandleKey(result.project.id));
      recordLinkedProject({
        id: result.project.id,
        name: result.project.name,
        slug: result.project.canonicalName || canonicalNameOf(result.project.name),
        folderName: dir.name,
        opened: false,
      });
      await refreshLinked();
      setMessage(`Imported "${result.project.name}" (${result.entryCount} files).`);
    });
  }, [runVerb, pickFolder, refreshLinked]);

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
    { kind: 'renameAsset' | 'collections' | 'renameNode' | 'newDocument'; relPath: string; value: string } | null
  >(null);

  /**
   * Re-read BOTH listings after a mutation (plan-461 V13).
   *
   * The document scan feeds the tree rows, the folder cards and the detail
   * pane; the provider catalog feeds thumbnails and drag-into-scene. Skipping
   * either leaves an old name — or a deleted card — standing until the next
   * open, which is the finding this pair exists for. Seven call sites wrote it
   * out identically; they now share this one so a third listing can only be
   * forgotten once.
   *
   * It refreshes the LISTINGS only. Whatever renders the LIVING document — the
   * hero card, the hierarchy card — reads the open document's own name, which
   * no rescan touches.
   */
  const refreshListings = useCallback(async () => {
    await store.rescanDocuments();
    await listLibrarySources()
      .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
  }, [store]);

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
      await refreshListings();
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
   * Linked projects only, and never the one that is open: a target needs a
   * folder handle (its `project.json` is updated under compare-and-swap) and a
   * transfer into the source itself is Duplicate, which already exists. A
   * read-only project is absent rather than disabled — see the dialog.
   */
  const transferTargets = useMemo<TransferTargetOption[]>(
    () => linked
      .filter(l => l.id !== project.project?.id)
      .map(l => ({ id: l.id, label: l.name, hint: l.folderName })),
    [linked, project.project?.id],
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
    const target = linked.find(l => l.id === targetId);
    const doc = documentByPath.get(req.documentPath);
    const label = req.mode === 'move' ? 'Move document' : 'Copy document';
    void runVerb(label, async () => {
      if (!target) throw new Error('That project is no longer in the list.');
      if (!doc) throw new Error('That document is no longer part of this project.');
      const backend = store.getBackend();
      if (!backend?.writable) throw new Error('This project is read-only.');
      // The target's own handle, prompted if the grant lapsed: writing into a
      // project that is not open is exactly the case a stale grant breaks, and
      // this call still sits inside the user's menu gesture.
      const targetDir = await getFolderHandle(projectHandleKey(targetId), { prompt: true });
      if (!targetDir) throw new Error(`"${target.name}" is not accessible — open it once first.`);

      const result = await withTransferSession(
        {
          source: {
            label: project.project?.name ?? 'this project',
            backend,
            dir: store.getProjectDir(),
            isActiveProject: true,
          },
          target: {
            label: target.name,
            // A backend built for THIS transfer and discarded with it: nothing
            // else holds a writable handle on the target, so the session cannot
            // leak write access past its own `finally`.
            backend: new FolderBackend(targetDir, {
              writable: true,
              id: `transfer:${target.id}`,
            }),
            dir: targetDir,
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
        setMessage(`"${doc.name}" ${req.mode === 'move' ? 'moved' : 'copied'} to "${target.name}".`);
      }
      // A move took bytes out of THIS project's library, so the source listing
      // is stale until it is re-read — the same refresh every asset op does.
      if (req.mode === 'move') {
        await listLibrarySources()
          .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source.refresh?.();
        setProjectsSelection({ kind: 'none' });
      }
    });
  }, [linked, documentByPath, runVerb, store, project.project?.name]);

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
  // plan-655 F2: "Manage libraries…" in the planner asks for the dialog itself
  // (`openAddLibraryDialog`), not just for the dashboard behind it.
  const addLibraryRequest = dash.addLibraryRequest;
  useEffect(() => {
    if (addLibraryRequest > 0) setAddLibraryOpen(true);
  }, [addLibraryRequest]);
  /**
   * Is the compact layout's detail sheet up? (plan-458 §2.3)
   *
   * Driven by the KIND of the selection, not by the click that made it: a
   * folder or a project is navigation and stays in the grid, while a document,
   * a file or a library asset is a thing with facts and verbs and is what the
   * sheet exists for. Closing it leaves the selection standing — the user
   * dismissed a panel, not a choice.
   */
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  /** The folded breadcrumb levels behind the ellipsis, and what anchors them. */
  const [crumbMenu, setCrumbMenu] = useState<
    { anchor: HTMLElement; hidden: { path: string; name: string; rootId: string; relPath: string }[] }
    | null>(null);
  useEffect(() => {
    const kind = dash.selection.kind;
    setDetailSheetOpen(kind === 'document' || kind === 'documentPath'
      || kind === 'file' || kind === 'asset');
  }, [dash.selection]);
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

  // ── Project rename / delete (linked rows only) ────────────────────────
  // Rename writes the linked folder's own manifest. The bundled demo and the
  // browser project have no folder, so neither verb is offered for them.
  const [renameProjectReq, setRenameProjectReq] = useState<ProjectRenameRequest | null>(null);

  const handleRenameProject = useCallback((id: string) => {
    const row = linked.find(l => l.id === id);
    if (row) setRenameProjectReq({ id, name: row.name });
  }, [linked]);

  const submitRenameProject = useCallback(() => {
    if (!renameProjectReq) return;
    const { id, name } = renameProjectReq;
    const trimmed = name.trim();
    setRenameProjectReq(null);
    if (!trimmed) return;
    void runVerb('Rename project', async () => {
      // No prompt: the user is renaming a row they are looking at, and the
      // grant is normally alive. When it is not, saying so beats a dialog
      // raised from inside a submit handler that no longer counts as a gesture.
      const dir = await getFolderHandle(projectHandleKey(id), { prompt: false });
      if (!dir) throw new Error('That project folder is not accessible — open it once first.');
      const manifest = (await readManifest(dir))?.project;
      if (!manifest) throw new Error('That project folder has no readable project.json.');
      await writeManifest(dir, { ...manifest, name: trimmed });
      recordLinkedProject({
        id,
        name: trimmed,
        slug: manifest.canonicalName || canonicalNameOf(trimmed),
        folderName: dir.name,
        opened: false,
      });
      await refreshLinked();
      // The open project shows its name in the header; re-open it so the
      // rename is visible immediately. The store's own dirty guard applies.
      if (project.project?.id === id && project.backendKind === 'folder') {
        await store.openProjectFolder(dir);
      }
    });
  }, [renameProjectReq, runVerb, refreshLinked,
      project.project?.id, project.backendKind, store]);

  const handleDeleteProject = useCallback((id: string) => {
    const row = linked.find(l => l.id === id);
    if (!row) return;
    // Deleting the folder under the open project would leave the store
    // writing into nowhere — closing first is the user's explicit step.
    if (project.project?.id === id) {
      setMessage('Close the project before deleting it.');
      return;
    }
    setConfirmReq({
      title: 'Delete project',
      message: `Delete the project "${row.name}" and its folder "${row.folderName}"? This cannot be undone.`,
      confirmLabel: 'Delete project',
      onConfirm: () => {
        void runVerb('Delete project', async () => {
          // Deleting a project needs its PARENT, which a per-project handle
          // does not give us — the linked model deliberately knows a project's
          // folder and nothing above it. So the folder's own contents go, the
          // manifest included, and the row is unlinked; the (now empty) folder
          // is the user's to remove.
          const dir = await getFolderHandle(projectHandleKey(id), { prompt: true });
          if (!dir) throw new Error('That project folder is not accessible.');
          for await (const name of dir.keys()) {
            await dir.removeEntry(name, { recursive: true });
          }
          await unlinkProject(id);
          // Same rule as Remove (F10), and more absolute: the folder itself is
          // gone, so every recent of it — and every model the index still
          // lists for it — is unopenable by construction.
          await forgetProjectTraces(id);
          await refreshLinked();
        });
      },
    });
  }, [linked, project.project?.id, runVerb, refreshLinked]);

  // ── Regenerate thumbnails (plan-776 #20) ──────────────────────────────
  // ONE registry command; this host only asks its rule (the menu item's
  // disabled state + tooltip) and dispatches it by id. Progress, Cancel and the
  // result are the command's progress store, shown by RegenerateThumbnailsDialog.
  const regenerateThumbnailsState = useCallback(
    (id: string) => regenerateThumbnailsMenuState(id, viewer),
    [viewer],
  );

  const handleRegenerateThumbnails = useCallback((id: string) => {
    // Dispatched in the click's tick: a linked folder may ask for access again,
    // and that prompt needs the user activation of this click.
    void dispatchRegenerateThumbnails(id, viewer)
      .then(async (r) => {
        // A refusal before the run started (the rule changed between menu and
        // click) has no dialog to say it; a failed run already shows its error.
        if (!r.ok && r.kind !== 'threw') setMessage(r.reason);
        // A linked project may have been opened on the way.
        await refreshLinked();
      });
  }, [viewer, refreshLinked]);

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

  /**
   * Which open-in-place run is the CURRENT one. A second double-click aborts
   * the first load (the newer load owns the scene); the first run's cleanup
   * must then leave the dashboard alone — it belongs to the newer open now.
   */
  const openSeqRef = useRef(0);

  // ── Recent documents (plan-478) ───────────────────────────────────────
  //
  // The activity-bar flyout and keyboard Quick Open share the same store and
  // opening chain, owned here alongside the project and scene dependencies.
  //
  // Under a kiosk lock none of it exists: no section, no listener, no popover
  // (F5). The recording side is gated separately, in the store itself, so a
  // locked deployment writes nothing even when its documents are opened by
  // `?doc=` or MCP.
  const recents = useRecentDocuments();
  const quickOpen = useSyncExternalStore(subscribeRecentDocumentsOpen, getRecentDocumentsOpen);
  /**
   * Mirrors `isOpeningRecent()` into React.
   *
   * The chain's in-flight flag is module-level on purpose (it must outlive this
   * host's unmount when the target mode is `viewer`), and a module variable
   * cannot make React repaint. This is the one-way mirror that disables the
   * rows while it runs — never the source of truth, which stays the module.
   */
  const [recentBusy, setRecentBusy] = useState(false);

  /**
   * The dirty-scene question, as an awaitable (plan-478 R3-1).
   *
   * The same dialog `trySwitch` raises, reached through the same
   * `pendingSwitch` slot so there can never be two unsaved-changes prompts with
   * two different answers. The difference is only in the shape: `trySwitch`
   * takes a continuation, a chain needs a boolean — so Discard/Save resolve
   * `true` through the pending action, and Cancel resolves `false` through this
   * ref, which the dialog's `onCancel` settles.
   */
  const dirtyGuardRef = useRef<((ok: boolean) => void) | null>(null);
  const confirmDiscardDirtyScene = useCallback((): Promise<boolean> => {
    if (!sceneSnap?.dirty) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      dirtyGuardRef.current = resolve;
      setPendingSwitch(() => async () => {
        dirtyGuardRef.current = null;
        resolve(true);
      });
    });
  }, [sceneSnap?.dirty]);

  /**
   * The chain's dependencies, built in ONE place for both of its callers — a
   * recent and a model-search hit (plan-509) — so the two can never drift
   * apart. Only how a gone document is forgotten differs, and that is the
   * caller's to add.
   */
  const openChainDeps = useCallback((): OpenChainBaseDeps => ({
    modes: viewer.modes,
    currentProject: () => {
      const p = store.getSnapshot();
      return p.project ? { id: p.project.id, backend: p.backendKind } : null;
    },
    isLinked: (id) => linked.some(l => l.id === id),
    resolveLinkedOpen,
    store: {
      openDemoProject: () => store.openDemoProject(),
      openWorkspaceProject: () => store.openWorkspaceProject(),
      openRecentProject: (id) => store.openRecentProject(id),
      openProjectFolder: (dir) => store.openProjectFolder(dir),
    },
    afterLinkedOpen: refreshLinked,
    onRowState: setRowState,
    isDemoProject: () => store.getSnapshot().project?.kind === 'demo',
    // The STORE's list, not the React snapshot: after step 2 the snapshot
    // is a frame behind and still describes the previous project.
    documents: () => store.getSnapshot().documents,
    openDocument: (id, token, targetMode) =>
      openDocumentAsWorkingScene(viewer, sceneStore!, store.getSnapshot().documents, id, token, targetMode),
    confirmDiscardDirtyScene,
    notify: setMessage,
  }), [viewer, store, linked, refreshLinked, setRowState, sceneStore,
      confirmDiscardDirtyScene]);

  /**
   * Run one chain open with the busy mirror and the shared result reporting.
   *
   * Not `runVerb`: its `busy` ends with the callback, which says nothing
   * about whether the document has finished loading, and this chain is
   * awaited to the end on purpose. Errors still surface — the chain answers
   * rather than throwing, and a throw would be a bug, not a user outcome.
   */
  const runOpenChain = useCallback((run: () => Promise<OpenRecentResult>) => {
    if (isOpeningRecent()) return;
    setRecentBusy(true);
    void (async () => {
      try {
        const result = await run();
        if (result === 'opened') {
          closeProjectsDashboard();
        } else if (result === 'project-denied') {
          setMessage('Access to that project folder was not granted.');
        } else if (result === 'project-missing') {
          setMessage('That project folder could not be found.');
        }
        // `busy`, `vetoed`, `vetoed-after-open`, `dirty-cancelled`,
        // `project-cancelled` and `document-missing` are silent here: each is
        // either the user's own answer to a prompt they just saw, or already
        // reported by the chain.
      } finally {
        setRecentBusy(false);
      }
    })();
  }, []);

  const openRecent = useCallback((entry: RecentDocumentEntry) => {
    // The mode comes from `rv-document-modes`, not from the ring (plan-513):
    // the entry's own `mode` is history, and it drifts across tabs.
    runOpenChain(async () => {
      const lastMode = await readDocumentMode(entry.backend, entry.projectId, entry.documentId);
      return openRecentEntry(entry, { ...openChainDeps(), forgetRecent }, { lastMode });
    });
  }, [runOpenChain, openChainDeps]);

  /**
   * Enter / double-click on a model-search hit (plan-509 F6): the project
   * through the normal open path — a folder-access prompt included — then the
   * model. A model the project no longer has is reported by the chain and
   * dropped from the index; the project stays open.
   */
  const openModelHit = useCallback((hit: ModelSearchHit) => {
    const { entry } = hit;
    runOpenChain(async () => {
      const lastMode = await readDocumentMode(entry.backend, entry.projectId, entry.doc.id);
      return openProjectDocument({
        projectId: entry.projectId,
        backend: entry.backend,
        documentId: entry.doc.id,
        projectName: entry.projectName,
        ...(lastMode ? { lastMode } : {}),
        // Display only — the chain decides on the LIVE row (plan-513 SOL R2 F2).
        ...(entry.doc.mode ? { indexedDeclaredMode: entry.doc.mode } : {}),
      }, {
        ...openChainDeps(),
        forget: (pid, did) => { void forgetModelIndexEntry(entry.backend, pid, did); },
      });
    });
  }, [runOpenChain, openChainDeps]);

  /** `viewer.modes.descriptor(id)?.label`, for the mode chip. */
  const recentModeLabel = useCallback(
    (mode: string) => viewer.modes.descriptor(mode)?.label,
    [viewer],
  );

  // ── The documents' last modes (plan-513) ──────────────────────────────
  //
  // ONE map for every chip on this screen, loaded once and again on every
  // change in this tab or another — never an IndexedDB read per row. A click
  // reads its own entry fresh (`readDocumentMode`); the chip and the click
  // then agree through `effectiveOpenMode`, the one rule both use.
  const [documentModes, setDocumentModes] = useState<Map<string, DocumentModeRecord>>(() => new Map());
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void loadDocumentModes().then((m) => { if (alive) setDocumentModes(m); });
    };
    const off = subscribeDocumentModes(reload);
    reload();
    return () => { alive = false; off(); };
  }, []);
  /** The mode a click on this document row opens it in, or null (no chip). */
  const openModeOf = useCallback((
    backend: RecentDocumentEntry['backend'],
    projectId: string,
    documentId: string,
    declaredMode: string | null | undefined,
    isDemo: boolean,
    /** The row's `modes` restriction - the chip must not name a mode the click would refuse. */
    allowedModes: string[] | null = null,
  ): string | null => effectiveOpenMode({
    lastMode: documentModes.get(documentModeKey(backend, projectId, documentId))?.mode ?? null,
    declaredMode,
    isDemo,
    has: (m) => viewer.modes.has(m),
    isAllowed: (m) => isModeAllowedForRow(allowedModes, m, (id) => viewer.modes.descriptor(id)?.runtime),
  }), [documentModes, viewer]);

  /**
   * Open a document of the OPEN project as the working scene — a card, the
   * detail pane's Open, a row of the project search (plan-513: through the
   * chain, below it because it uses the chain's deps).
   */
  const openDocumentRow = useCallback((id: string) => {
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
    // plan-513 F8 — a card (or a tree / search row of the open project) is the
    // same deliberate open as a recent: through the chain, same-project
    // branch, so the target mode is decided once and the chain's own dirty
    // guard is the ONE unsaved-changes dialog (not `trySwitch` as well).
    const snap = store.getSnapshot();
    if (snap.project && snap.backendKind) {
      const projectId = snap.project.id;
      const backend = snap.backendKind;
      const name = snap.documents.find(d => d.id === id)?.name ?? '…';
      runOpenChain(async () => {
        const lastMode = await readDocumentMode(backend, projectId, id);
        const base = openChainDeps();
        return openProjectDocument({
          projectId, backend, documentId: id,
          projectName: snap.project?.name ?? projectId,
          ...(lastMode ? { lastMode } : {}),
        }, {
          ...base,
          // Open IN PLACE, as before: the hero band announces the target and
          // shows the load's progress from the moment the LOAD starts — after
          // the chain's questions, so a cancelled dialog never flashes it.
          openDocument: async (docId, token, targetMode) => {
            const seq = ++openSeqRef.current;
            beginProjectsOpening(name);
            try {
              return await base.openDocument(docId, token, targetMode);
            } finally {
              if (openSeqRef.current === seq) {
                endProjectsOpening();
                closeProjectsDashboard();
              }
            }
          },
          // A card has no list of its own to forget from; the chain's notice
          // is the whole answer.
          forget: () => {},
        });
      });
      return;
    }
    trySwitch(async () => {
      // Open IN PLACE: the dashboard stays up while the load runs behind it,
      // the hero band announces the target and shows the load's progress
      // (model-load-progress-store mirrors the splash), and only a finished
      // load closes the dashboard — with its exit slide. On failure it closes
      // too: the splash error card with its Retry (z 1000) is the one error
      // surface, and it sits behind the dashboard until then.
      const seq = ++openSeqRef.current;
      beginProjectsOpening(project.documents.find(d => d.id === id)?.name ?? '…');
      try {
        await openDocumentAsWorkingScene(viewer, sceneStore, project.documents, id);
      } finally {
        if (openSeqRef.current === seq) {
          endProjectsOpening();
          closeProjectsDashboard();
        }
      }
    });
  }, [sceneStore, trySwitch, project.documents, viewer, store, runOpenChain, openChainDeps]);

  // The Quick-Open key. Registered on the window, capture phase OFF: a plain
  // bubble listener is enough because the predicate refuses every editable
  // target itself. Not mounted under a kiosk lock, and not under `mode:viewer`
  // — this whole host is unmounted there (`HMIShell.tsx`), which is the
  // cheapest possible way to honour "not reachable in the viewer".
  useEffect(() => {
    if (modeLocked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isRecentDocumentsShortcut(e)) return;
      // Chrome maps Ctrl+Shift+F to nothing, but a page-level default (and
      // Firefox's quick-find on some builds) is cheaper to prevent than to
      // debug in the field.
      e.preventDefault();
      toggleRecentDocumentsOpen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modeLocked]);

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
   * add to it. This is why the scene load here does not go through `openDocumentRow` —
   * that verb closes the dashboard, which is exactly right for a click on a
   * document card and exactly wrong here.
   *
   * The document is created only after the project is OPEN: `createDocument`
   * writes through the project store, which needs the folder backend active.
   */
  const handleCreateProject = useCallback((parent: FileSystemDirectoryHandle, name: string) => {
    setNewProjectOpen(false);
    if (!name) return;
    void runVerb('New project', async () => {
      const dir = await parent.getDirectoryHandle(canonicalNameOf(name), { create: true });
      const result = await createProjectFromScenes(dir, name, []);
      if (!result.ok) throw new Error(result.message);

      const opened = await store.openProjectFolder(dir);
      if (!opened) throw new Error('The project was created but could not be opened.');
      await refreshLinked();
      setProjectsView('project');

      // In the project ROOT ('' — a real target since the folder rule was
      // generalised), so the newborn project is one file, not a `scenes/` tree.
      const created = await createDocument(store, 'empty', { folder: '' });
      await refreshListings();
      setProjectsSelection({ kind: 'document', documentId: created.documentId });
      await store.flush();

      // The load runs behind the dashboard. No dirty guard is needed and none is
      // wanted: the scene being replaced belongs to the project we just left, and
      // `openProjectFolder` above already ran its own guard over it.
      if (sceneStore) await sceneStore.openScene(created.documentId);
    });
  }, [runVerb, store, sceneStore, refreshLinked]);

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
    // Same rule as `openDocumentRow`: the already-open model just closes the
    // dashboard. Compared through the path-derived id this verb itself records
    // below, so the two sides of the comparison can only agree or genuinely
    // differ.
    if (!sourceUrl
      && sameDocumentBase(getOpenDocumentBase(), projectDocumentBase(modelId, label))) {
      closeProjectsDashboard();
      return;
    }
    trySwitch(async () => {
      // Open IN PLACE — same choreography as `openDocumentRow` above.
      const seq = ++openSeqRef.current;
      beginProjectsOpening(label);
      try {
        await sceneStore.openBuiltin(sourceUrl ?? projectAssetUrl(modelId), label);
      } finally {
        if (openSeqRef.current === seq) {
          endProjectsOpening();
          closeProjectsDashboard();
        }
      }
      // Say WHAT is now open, so a mode that takes over later opens the same
      // thing instead of starting from nothing.
      // This one STAYS, unlike `openDocumentRow`'s (plan-702 Phase 3). The funnel
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

  const deleteDocumentRow = useCallback((id: string, name: string) => {
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
          await refreshListings();
        });
      },
    });
  }, [sceneStore, runVerb, store]);

  const duplicateDocumentRow = useCallback((id: string) => {
    if (!sceneStore) return;
    void runVerb('Duplicate scene', async () => {
      await sceneStore.duplicate(id);
      // The copy's card has the same scan dependency as the deleted card above.
      await refreshListings();
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
      await refreshListings();
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
    // plan-778 provider-filter decision: ONLY the open project is dropped —
    // a library project (`library-projects`) is another project and gets its
    // own root, with its state in the label and its repair on the row.
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
    // plan-778: a library project's root says its state ("Access needed", "Not
    // found", …) and, when transitive, which library needs it.
    let label = source.error ? `${source.label} — ${source.error}` : source.label;
    if (isLibraryProjectSource(source)) {
      const badge = libraryStateBadge(source.state, source.id);
      const neededByLabels = source.neededBy
        .map(id => sources.find(s => s.providerId === LIBRARY_PROJECTS_PROVIDER_ID && s.source.id === id)?.source.label ?? id);
      label = source.label
        + (source.direct ? '' : ` — needed by ${neededByLabels.join(', ')}`)
        + (badge.attention ? ` — ${badge.text}` : '');
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
      label,
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
    // plan-655 F1: the UI view of `library.attach` — the one sequence in
    // `project-library-attach.ts` (catalog first, project identity re-check,
    // manifest write, rollback on any failure) that `web_library_attach` runs.
    ensureLibraryCommandsRegistered();
    const r = await commandRegistry.execute('library.attach', { url, label: null }, { origin: 'ui', viewer });
    return r.ok ? null : r.reason;
  }, [viewer]);

  /**
   * plan-778: the Add library… **Projects** tab — attach another project BY ID
   * through `library.attach {projectId,label,hint}` (the same command MCP runs).
   * Memoised: the dialog reads its candidate list once per open.
   */
  const libraryProjectsOptions = useMemo<AddLibraryProjectsOptions>(() => ({
    openProjectId: project.project?.id ?? null,
    attachedIds: attachedLibraryProjectIdsOf(project.project),
    attach: async (ref) => {
      ensureLibraryCommandsRegistered();
      const r = await commandRegistry.execute('library.attach', ref, { origin: 'ui', viewer });
      return r.ok ? null : r.reason;
    },
  }), [project.project, viewer]);

  /** Detach a library through whatever route its provider exposes. */
  const handleRemoveLibrary = useCallback((rootId: string, label: string) => {
    const registered = sourceOfRoot(rootId);
    const source = registered?.source;
    // plan-778 Decision D: a DIRECT library project is removed from
    // `libraries[]` through `library.detach {projectId}` after a confirmation
    // that names how many placements will show as missing. Nothing is deleted.
    if (registered && source && registered.providerId === LIBRARY_PROJECTS_PROVIDER_ID
      && isLibraryProjectSource(source) && source.direct) {
      const projectId = source.id;
      const placements = countOpenLibraryPlacements(viewer, projectId);
      setConfirmReq({
        title: `Remove library '${source.label}'?`,
        // Review U1: the realvirtual library and a library another one still
        // needs stay resolvable — their placements do not go missing.
        message: detachConfirmationMessage(source.label, placements,
          libraryRemovalKeepsAvailable(getLibraryProjectLoader(), projectId)),
        confirmLabel: 'Remove',
        onConfirm: () => {
          void runVerb('Remove library', async () => {
            ensureLibraryCommandsRegistered();
            const r = await commandRegistry.execute('library.detach', { projectId }, { origin: 'ui', viewer });
            if (!r.ok) throw new Error(r.reason);
            const group = { providerId: registered.providerId, sourceId: projectId };
            if (selectionPointsIntoGroup(dash.selection, group)
              || (dash.selection.kind === 'folder' && dash.selection.rootId === rootId)) {
              setProjectsSelection({ kind: 'none' });
            }
          });
        },
      });
      return;
    }
    if (!registered || !source?.remove) return;
    setConfirmReq({
      title: 'Remove library',
      message: `Remove the library "${label}" from this viewer? Its files are not deleted.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        void runVerb('Remove library', async () => {
          // A project library lives in `project.json`: detach it MANIFEST FIRST
          // through `library.detach` (plan-655 F1), so a failed write leaves
          // it attached instead of gone-now-but-back-on-reopen.
          if (registered.providerId === GLOBAL_LIBRARY_PROVIDER_ID
            && readProjectLibraries(store.getProject()).includes(source.id)) {
            ensureLibraryCommandsRegistered();
            const r = await commandRegistry.execute('library.detach', { url: source.id }, { origin: 'ui', viewer });
            if (!r.ok) throw new Error(r.reason);
          }
          await source.remove!();
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
  }, [sourceOfRoot, runVerb, dash.selection, store, viewer]);

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
   * The rows come from `snapshot.documents`, the only list the snapshot carries.
   * What used to be two lists here — a `models` view and a `scenes` view — are
   * gone (plan-716 Phase 6, plan-777 P3). The selection kinds were renamed to
   * `document` (by id) and `documentPath` (by path) in plan-720: they name
   * which key a selection holds, never a kind of document. The rail-group kinds
   * `'scenes'`/`'models'` survive only as persisted deep-link values that fold
   * back to the one list (see `ProjectsRailGroup`).
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
        // wherever the file sits (placeless, plan-716/717). It was 'scene:' until
        // plan-777 — the historical prefix of the scene list — and the only one
        // left: the 'published:' keys that used to sit beside it were the second
        // identity space plan-731 melted into this very list.
        key: 'document:' + doc.id,
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
   * The project's own scripts (`plugins/**​/*.ts|tsx`) — the third bindable
   * listing (plan-479 Phase 1). Same walk, classified by folder AND ending.
   */
  const [projectScripts, setProjectScripts] = useState<string[]>([]);
  /**
   * Everything else the project folder holds — the inert rows of the full view
   * (plan-445 F1/F2).
   */
  const [plainFiles, setPlainFiles] = useState<string[]>([]);
  const [diskFolders, setDiskFolders] = useState<string[]>([]);
  /** Bumped by a write that changes the folder without changing a document. */
  const [listingBump, setListingBump] = useState(0);
  useEffect(() => {
    const backend = store.getBackend();
    if (!dash.open || !backend) {
      setConnectConfigs([]); setKnowledgeFiles([]); setProjectScripts([]); setPlainFiles([]);
      setDiskFolders([]);
      return;
    }
    let alive = true;
    // ONE walk for all three lists (plan-445 §5.1): the two per-ending walks
    // that used to stand here were two full traversals of the project folder
    // per dashboard open, and the full view would have made it three.
    void Promise.all([
      listProjectFiles(backend),
      backend.listFolders?.().catch(() => []) ?? Promise.resolve([]),
    ]).then(([listing, folders]) => {
      if (!alive) return;
      setConnectConfigs(listing.configs);
      setKnowledgeFiles(listing.knowledge);
      setProjectScripts(listing.scripts);
      setPlainFiles(listing.plainFiles);
      setDiskFolders(folders);
    });
    return () => { alive = false; };
  }, [dash.open, store, project.project?.id, project.documents, listingBump]);

  /**
   * Per-document stats — the on-disk size the detail pane shows.
   *
   * Re-statted on every dashboard open and whenever a save lands
   * (`document-saved`). Card pictures no longer depend on it (plan-776): a
   * save writes a new hashed sidecar and a new row pointer, which is the
   * version. A backend that cannot size a body reports 0, which is kept OUT
   * of the map so the pane omits the row rather than printing a GLB as empty.
   */
  const [docStats, setDocStats] = useState<ReadonlyMap<string, DocumentStatEntry>>(new Map());
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
        setDocStats(new Map(stats.map(s => [s.path, {
          ...(typeof s.mtime === 'number' ? { mtime: s.mtime } : {}),
          ...(typeof s.size === 'number' && s.size > 0 ? { size: s.size } : {}),
        }] as const)));
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
          scripts: projectScripts,
          plainFiles,
          folders: [...new Set([...readProjectFolders(project.project), ...diskFolders])],
        }
      : null,
    catalogs: treeCatalogs,
  }), [project.project, project.writable, project.documents, attachments,
      connectConfigs, knowledgeFiles, projectScripts, plainFiles, diskFolders, treeCatalogs]);

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
      if (sel.kind === 'file' && isFileRef(ref)
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
    if (isFileRef(ref)) {
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
    if (ref.kind === 'scriptFile') return;             // a script is bound, not opened
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
    if (doc) openDocumentRow(doc.id);
    else openModel(ref.path, node.name);
  }, [tree.refs, sources, documentByPath, openAssetInEditor, openDocumentRow, openModel]);

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
    // Ask for the name FIRST (user report 2026-10-20): the document is born
    // under the name the user means, instead of as "Untitled" plus a rename.
    // The folder is decided NOW, at the click, so navigating while the dialog
    // is up cannot move the create somewhere the user did not click in.
    const folder = newDocumentFolderFor(project.project?.id, selectedFolderPath);
    setAssetDialog({ kind: 'newDocument', relPath: folder, value: newDocumentNameFor(folder) });
  }, [project.project?.id, selectedFolderPath]);

  /** Confirm handler of the new-document name prompt — the create itself. */
  const createNamedDocument = useCallback((folder: string, name: string) => {
    void runVerb('New document', async () => {
      const created = await createDocument(store, name, { folder });
      // Two listings have to learn about the newborn before it can be shown:
      // the document scan (tree rows + folder cards) and the project-library
      // catalog (thumbnails, drag-into-scene). The row itself is already in the
      // manifest — this is the display catching up, not the registration.
      await refreshListings();
      setProjectsSelection({ kind: 'document', documentId: created.documentId });
      // The manifest write is queued by the folder writer; wait for it so a
      // reload right after the click cannot lose the row.
      await store.flush();
    });
  }, [runVerb, store]);

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

  // ── The project search (plan-507) ─────────────────────────────────────
  // Glue only: every rule lives in `rv-project-tree-search` and
  // `ProjectSearchResults`, which tests can reach and this host they cannot.
  /** The search field — the `/` / Ctrl+K target and the anchor after a folder hit. */
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** A typed term swaps the folder's cards for the flat, recursive hit list. */
  const searchMode = dash.search.trim() !== '';
  const searchIndex = useMemo(() => buildProjectSearchIndex(treeRoots), [treeRoots]);
  const searchGroups = useMemo(
    () => searchProjectIndex(searchIndex, dash.search), [searchIndex, dash.search]);
  const classificationOfNode = useCallback((node: ProjectTreeNode) => {
    const ref = tree.refs.get(node.path!);
    return ref?.kind === 'document' ? documentByPath.get(ref.path)?.classification : undefined;
  }, [tree.refs, documentByPath]);
  // Counted over the hits BEFORE the chip, like the folder chips.
  const searchChips = useMemo(
    () => documentChipOptions(searchDocumentRows(searchGroups, classificationOfNode), dash.chip),
    [searchGroups, classificationOfNode, dash.chip],
  );
  // Chip and tag only — never `matchesDocumentFilter`, whose substring term
  // would throw token hits like `line demo` → `demo-line.glb` out again.
  const searchResult = useMemo(() => capSearchResult(filterSearchGroups(searchGroups,
    hit => !isDocumentHit(hit)
      || (matchesDocumentChip(classificationOfNode(hit.entry.node), dash.chip)
        && matchesDocumentTag(classificationOfNode(hit.entry.node), dash.tag)))),
  [searchGroups, classificationOfNode, dash.chip, dash.tag]);
  /** Enter / double-click on a hit: a folder is navigated to, anything else opens. */
  const handleSearchActivate = useCallback((node: ProjectTreeNode) => {
    if (node.kind === 'folder') {
      setProjectsSelection({ kind: 'folder', rootId: node.rootId, relPath: node.relPath });
      setProjectsSearch('');
      // The list — and the focused row — unmount with the term; the field is
      // the stable place for the focus to land.
      searchInputRef.current?.focus();
      return;
    }
    handleTreeActivate(node);
  }, [handleTreeActivate]);
  // `/` and Ctrl/Cmd+K reach this field, not the scene search, while the
  // dashboard shows a project. Called here, above the pre-open early return.
  useDashboardSearchShortcut(searchInputRef,
    dash.open && dash.view === 'project' && project.project !== null);

  // ── The model search of the Projects screen (plan-509) ────────────────
  // Glue only: the index lives in `rv-model-index*`, the search in
  // `rv-model-search`, the list in `ModelSearchResults` — which tests can
  // reach and this host they cannot.
  const onProjectsScreen = projectsScreenActive(dash, project.project !== null);
  /** The Projects screen's field — its own `/` / Ctrl+K target. */
  const projectsSearchInputRef = useRef<HTMLInputElement | null>(null);
  useDashboardSearchShortcut(projectsSearchInputRef, onProjectsScreen);
  const [modelSnapshots, setModelSnapshots] = useState<ModelIndexSnapshot[]>([]);
  // Loaded when the screen shows, and again on every change in this tab or
  // another. The bundled demo is indexed from its HTTP manifest first, so it
  // is searchable without ever having been opened (F2). Nothing here asks
  // for a permission (F8).
  useEffect(() => {
    if (!onProjectsScreen) return;
    let alive = true;
    const reload = () => {
      void loadModelIndex().then(({ snapshots }) => { if (alive) setModelSnapshots(snapshots); });
    };
    const off = subscribeModelIndex(reload);
    reload();
    void indexBundledProject(store.getBundledBackend());
    return () => { alive = false; off(); };
  }, [onProjectsScreen, store]);
  /** The screen's rows as search groups — same order, current names. */
  const modelSearchProjects = useMemo<ModelSearchProject[]>(() => projectRows.map(r => ({
    key: modelIndexKey(r.hint === 'bundled' ? 'bundled' : r.hint === 'browser' ? 'browser' : 'folder', r.id),
    name: r.name,
  })), [projectRows]);
  const linkedIds = useMemo(() => linked.map(l => l.id), [linked]);
  const modelSearchIndex = useMemo(
    () => buildModelSearchIndex(visibleSnapshots(modelSnapshots, linkedIds), modelSearchProjects),
    [modelSnapshots, linkedIds, modelSearchProjects]);
  const modelSearchResult = useMemo(
    () => capModelSearch(searchModelIndex(modelSearchIndex, dash.search, MAX_MODEL_SEARCH_RESULTS)),
    [modelSearchIndex, dash.search]);
  const modelSearchUnindexed = useMemo(
    () => unindexedLinkedCount(modelSnapshots, linkedIds), [modelSnapshots, linkedIds]);
  const modelSearchStateOf = useCallback((group: ModelSearchGroup) =>
    (group.backend === 'folder' ? rowStates.get(group.projectId) : undefined), [rowStates]);
  /** A hit's chip: its last mode, else the INDEXED declared mode (display only). */
  const modelSearchModeOf = useCallback((hit: ModelSearchHit) =>
    openModeOf(hit.entry.backend, hit.entry.projectId, hit.entry.doc.id, hit.entry.doc.mode, false),
  [openModeOf]);
  /**
   * A recent's chip (plan-513): its last mode from the store — the ring's own
   * `mode` is history — else the declared mode, from the live row when the
   * project is open and from the model index when it is not (unknown there
   * until the Projects screen has loaded the index: then only a last mode).
   */
  const recentModeOf = useCallback((entry: RecentDocumentEntry) => {
    const open = project.project?.id === entry.projectId && project.backendKind === entry.backend;
    const openRow = open ? project.documents.find(d => d.id === entry.documentId) : undefined;
    const declared = open
      ? openRow?.mode
      : modelSnapshots.find(s => s.backend === entry.backend && s.projectId === entry.projectId)
        ?.docs.find(d => d.id === entry.documentId)?.mode;
    return openModeOf(entry.backend, entry.projectId, entry.documentId, declared,
      open && project.project?.kind === 'demo', allowedModesOf(openRow));
  }, [openModeOf, project.project, project.backendKind, project.documents, modelSnapshots]);

  /** Announce a card drag to the tree, which owns every drop. */
  const [cardDragPath, setCardDragPath] = useState<string | null>(null);

  /**
   * The classification chips + tag picker, collapsed behind the toolbar's
   * filter icon — the same gesture the hierarchy browser and the property
   * inspector already use, so one icon means one thing everywhere. An active
   * filter keeps narrowing the cards while collapsed; the badge dot on the
   * icon is what says so.
   */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const hasActiveFilters = dash.chip !== null || dash.tag !== null;

  const folderCards = useMemo<FolderCardModel[]>(
    () => folderRows
      .filter(row => matchesDocumentFilter(row, documentFilter))
      .map(({ node, ref, doc }) => {
        const path = node.path!;
        const catalogEntry = ref?.kind === 'catalogAsset'
          ? sources.find(s => s.providerId === ref.providerId && s.source.id === ref.sourceId)
            ?.source.getEntry(ref.assetId) ?? null
          : null;
        // The entry + saved-thumbnail pointer (plan-776 F9) — a pure rule in
        // `dashboard-documents.ts`, so it has a test. A card shows the picture
        // a SAVE wrote, or its type placeholder; nothing is rendered here.
        const { entry, thumbnailPointer } = documentCardPicture({
          path, name: node.name, doc, catalogEntry,
        });
        // A CONNECT config / knowledge file is what its ENDING says (plan-718):
        // it gets the stated glyph tile instead of a preview, and no Open verb
        // — the detail pane is where it is inspected, double-click opens
        // nothing.
        const isConnectConfig = ref?.kind === 'connectConfig';
        const isKnowledgeFile = ref?.kind === 'knowledgeFile';
        // plan-479: the third draggable reference source. Same treatment as
        // the two above — a stated tile, no Open verb, a drag that carries a
        // reference payload — because a script is bound, never opened here.
        const isScriptFile = ref?.kind === 'scriptFile';
        const isRefFile = isConnectConfig || isKnowledgeFile || isScriptFile;
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
        return {
          key: path,
          entry,
          thumbnailPointer,
          thumbnailBackend: thumbnailPointer ? store.getBackend() : null,
          ...(isConnectConfig ? { glyph: 'connect' as const } : {}),
          ...(isKnowledgeFile ? { glyph: 'knowledge' as const } : {}),
          // Every other plain file of the folder — PDF, slides, video, … —
          // gets the same-coloured tile with its extension as the label, so
          // the grid never shows a blank square for a file it knows the name
          // of (user decision 2026-09-10).
          // `scriptFile` is in this branch deliberately (plan-479 R14): it used
          // to BE a `plainFile`, and the `file:ts` tile is the icon 15 existing
          // project files already show. Reclassifying them must not blank them.
          ...(ref?.kind === 'plainFile' || ref?.kind === 'attachment'
            || ref?.kind === 'scriptFile'
            ? { glyph: fileGlyphOf(path) }
            : {}),
          // The document's own tier is the whole answer since plan-737. The
          // `isBundled` half beside it described a built-in-demo ROW, and there
          // are no such rows any more.
          tier: doc?.tier === 'bundled' ? 'bundled' : 'user',
          selected: selectedTreePath === path,
          onSelect: () => handleTreeSelect(node),
          onOpen: () => handleTreeActivate(node),
          menuActions,
          // plan-506 F6: the hover tooltip reads the manifest row's cache —
          // never the GLB — so a sweep over the grid costs no file access.
          documentInfo: doc?.documentInfo ?? null,
          classification: doc?.classification ?? null,
          // plan-513 F10 — the mode a double-click opens it in. Only a real
          // document of the open project opens as a scene; everything else
          // (catalog asset, attachment, plain file) shows no chip.
          openMode: doc?.id && ref?.kind !== 'catalogAsset' && project.project && project.backendKind
            ? openModeOf(project.backendKind, project.project.id, doc.id, doc.mode,
              project.project.kind === 'demo', allowedModesOf(doc))
            : null,
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
            if (isScriptFile) {
              e.dataTransfer.setData(SCRIPT_FILE_DRAG_TYPE, node.relPath);
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
      store, handleTreeSelect, handleTreeActivate, treeRoots,
      openModeOf, project.project, project.backendKind],
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
  const canDeleteEmptyFolder = useCallback((node: ProjectTreeNode) =>
    node.kind === 'folder' && node.rootId === project.project?.id
    && project.writable && node.writable && !node.inert && node.children.length === 0
    && (!!store.getBackend()?.deleteEmptyFolder || !diskFolders.includes(node.relPath)),
  [project.project?.id, project.writable, store, diskFolders]);

  const handleDeleteEmptyFolder = useCallback((node: ProjectTreeNode) => {
    if (!canDeleteEmptyFolder(node)) return;
    const backend = store.getBackend();
    const projectId = project.project?.id;
    setConfirmReq({
      title: 'Delete empty folder',
      message: `Delete the empty folder "${node.name}"?`,
      confirmLabel: 'Delete folder',
      onConfirm: () => {
        void runVerb('Delete folder', async () => {
          if (store.getBackend() !== backend || store.getProject()?.id !== projectId) {
            throw new Error('The project changed. Select the folder again.');
          }
          await backend?.deleteEmptyFolder?.(node.relPath);
          await store.applyManifestDelta(current => withProjectFolders(current,
            readProjectFolders(current).filter(path => path !== node.relPath)));
          setDiskFolders(current => current.filter(path => path !== node.relPath));
          setProjectsSelection({ kind: 'none' });
          await refreshListings();
          setListingBump(value => value + 1);
        });
      },
    });
  }, [canDeleteEmptyFolder, store, project.project?.id, runVerb, refreshListings]);

  // `subfolderTiles` itself is built below `handleTreeMove`, which its drop
  // target needs and which is declared later in this component.

  /**
   * The attached libraries as root-level tiles (plan-458 F3).
   *
   * Only on the compact layout and only AT the project root: the tree column
   * that is their entrance on the desktop is not rendered on a phone, and a
   * library tile repeated in every subfolder would read as something that
   * lives there.
   */
  const libraryTiles = useMemo<FolderTileModel[]>(() => {
    if (!compactLayout) return [];
    if (selectedFolderPath !== (projectTreeRoots[0]?.path ?? null)) return [];
    return mobileLibraryTiles(libraryTreeRoots).map(tile => ({
      key: tile.key,
      name: tile.name,
      holdsSomething: tile.holdsSomething,
      onOpen: () => setProjectsSelection({ kind: 'folder', rootId: tile.rootId, relPath: '' }),
    }));
  }, [compactLayout, selectedFolderPath, projectTreeRoots, libraryTreeRoots]);

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
      let leftBehind: string | null = null;
      if (node.kind === 'folder') {
        const from = node.relPath;
        await store.applyManifestDelta((current) => {
          const remapped = readProjectFolders(current).map(p =>
            p === from ? to : (p.startsWith(`${from}/`) ? to + p.slice(from.length) : p));
          return withProjectFolders(current, remapped);
        });
        // The bytes moved FILE BY FILE, and on a disk backend that leaves the
        // directory itself standing under its old name — empty, but listed by
        // `listFolders` and present in the explorer (field finding 2026-09-25:
        // "renamed in the UI, not on disk"). Drop it now that it is empty. A
        // directory that is NOT empty holds files the tree never listed, and
        // those are not ours to delete: leave it and say so.
        const backend = store.getBackend();
        if (backend?.deleteEmptyFolder) {
          try {
            await backend.deleteEmptyFolder(from);
          } catch {
            leftBehind = from;
          }
        }
        setDiskFolders(current => current.filter(p => p !== from && !p.startsWith(`${from}/`)));
        setListingBump(value => value + 1);
      }
      // The document scan AND the provider listing both re-read, or the tree
      // row, the card and the pane keep the old name until the next open.
      await refreshListings();
      // Those two refresh the LISTINGS. Whatever renders the LIVING document —
      // the hero card, the hierarchy card — reads the open document's own name,
      // which no rescan touches: renaming the open document from the tree left
      // both on the old title until the next reload. `SceneStore.rename` adopts
      // its own rename inline; this is the same adoption for the tree route.
      sceneStore?.adoptDocumentRename();
      onDone?.(to);
      if (leftBehind) {
        setMessage(`Moved, but the old folder "${leftBehind}" still holds files this project does not list — it was left in place.`);
      } else if (outcome.docsIndexRows > 0) {
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
      // plan-725 §2.7 — this is a config-bearing write that never touches the
      // manifest: a raw `writeDocument` and nothing else. It no longer says so
      // by hand. Since plan-462 B2 the backend the store hands out announces a
      // written `*.connect.json` body itself (`withConnectConfigNotifier`), so
      // this path and every other producer of one are covered by the same rule
      // instead of by whoever remembered.
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
    if (canDeleteEmptyFolder(node)) verbs.push({
      key: 'delete', label: 'Delete folder', run: () => handleDeleteEmptyFolder(node),
    });
    if (revealAvailable && ownProject && !node.inert) {
      verbs.push({
        key: 'reveal',
        label: 'Show in Explorer',
        run: () => handleRevealInExplorer(node),
      });
    }
    return verbs;
  }, [treeMenu, treeRoots, project.project?.id, project.writable, handleNewFolder,
    revealAvailable, handleRevealInExplorer, canDeleteEmptyFolder, handleDeleteEmptyFolder]);

  const handleTreeMove = useCallback(
    (node: ProjectTreeNode, to: string) => runTreeEdit('Move', node, to),
    [runTreeEdit],
  );
  const handleTreeRename = useCallback(
    (node: ProjectTreeNode, to: string) => runTreeEdit('Rename', node, to),
    [runTreeEdit],
  );

  /**
   * The subfolder tiles of the folder in view (docblock above
   * `canDeleteEmptyFolder`). Built here because every tile is also a DROP
   * TARGET (customer feedback 2026-09-30): a card dropped onto a folder tile
   * moves into that folder, through the same `canMoveInTree` verdict and the
   * same `handleTreeMove` a drop onto the folder's tree row takes. Two drag
   * sources reach it — a card (`cardDragPath`) and a tree row (its path in
   * the tree's own drag type, readable only on drop).
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
        if (canDeleteEmptyFolder(node)) menuActions.push({
          key: 'delete', label: 'Delete folder', destructive: true,
          onClick: () => handleDeleteEmptyFolder(node),
        });
        return {
          key: path,
          name: node.name,
          holdsSomething: node.hasContent ?? node.children.length > 0,
          onOpen: () => handleTreeSelect(node),
          menuActions,
          acceptsDrop: (e: React.DragEvent) => {
            if (cardDragPath) return canMoveInTree(treeRoots, cardDragPath, path).ok;
            // A tree-row drag: only its TYPE is readable during drag-over, so
            // the verdict waits for the drop.
            return Array.from(e.dataTransfer?.types ?? []).includes(PROJECT_TREE_DRAG_TYPE);
          },
          onDrop: (e: React.DragEvent) => {
            let source = cardDragPath;
            if (!source) {
              try { source = e.dataTransfer.getData(PROJECT_TREE_DRAG_TYPE) || null; } catch { source = null; }
            }
            if (!source) return;
            const verdict = canMoveInTree(treeRoots, source, path);
            if (!verdict.ok) return;
            const moved = findTreeNode(treeRoots, source);
            if (moved) handleTreeMove(moved, verdict.to);
          },
        };
      }),
    [subfoldersInView, dash.search, treeRoots, project.project?.id, handleTreeSelect,
      canDeleteEmptyFolder, handleDeleteEmptyFolder, cardDragPath, handleTreeMove],
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
    if (kind === 'newDocument') {
      const name = value.trim();
      if (name) createNamedDocument(relPath, name);
      return;
    }
    if (kind === 'collections') {
      // The store, not the backend: collections live on the manifest row now
      // (§2.4). `runAssetOp` still wraps it — the writable check and the two
      // listing refreshes afterwards are the same for every asset verb.
      void runAssetOp('Set collections', () => setAssetCollections(store, relPath, value.split(',')));
      return;
    }
    renameLibraryAsset(relPath, value);
  }, [assetDialog, runAssetOp, renameLibraryAsset, store, createNamedDocument]);

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

  // ── No resume on a project click (decision 2026-09-25) ────────────────
  //
  // plan-703 §2.6.3 (decisions 3 and 24) had an effect here that, once a
  // project the user had just opened was loaded, resolved a document through
  // `resolveResumeTarget` and opened it — closing the dashboard. The user's
  // ruling replaces it: a click on a project folder shows the folder, always;
  // a document loads only when a document is clicked. The resolver and its
  // order still govern the BOOT (`main.ts`: reload, kiosk, demo), where there
  // is no dashboard to show and something has to be on screen.

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

  // ── Document description (plan-506 §2.7) ──────────────────────────────
  /**
   * The description block of the selected document, stacked under the
   * classification in the same `extra` slot.
   *
   * Same visibility rule as {@link classificationFor}: editable only for a
   * document this project owns in a writable project. The commit goes to the
   * store DIRECTLY, not through `runVerb` — `runVerb` drops a second call while
   * one runs and reports no outcome, and a blur-committed text field produces
   * exactly such overlapping calls (R1-1). The write is bound to the project
   * that is open NOW (`expectProjectId`), so a draft flushed after the user
   * switched projects is refused instead of landing in the new one (R2-5).
   */
  const projectId = project.project?.id ?? null;
  const documentInfoFor = useCallback((row: DocumentRow | undefined) => {
    const doc = row?.doc;
    if (!doc || !projectId) return null;
    const editable = doc.tier !== 'bundled' && project.writable;
    return (
      <DocumentInfoEditor
        projectId={projectId}
        documentId={doc.id}
        info={doc.documentInfo ?? null}
        busy={busy}
        onCommit={editable
          ? (next: DocumentInfo | null) => store.setDocumentInfo(doc.id, next, { expectProjectId: projectId })
          : undefined}
      />
    );
  }, [projectId, busy, project.writable, store]);

  /** Classification and description, stacked — the one `extra` slot of the pane. */
  const documentExtraFor = useCallback((row: DocumentRow | undefined) => {
    if (!row) return null;
    return <>{classificationFor(row)}{documentInfoFor(row)}</>;
  }, [classificationFor, documentInfoFor]);

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

  // The selected document's saved preview for the detail pane (plan-776 F9):
  // the row's pointer read through the backend — the same URL the card holds.
  const selectedDocumentThumbnail = useThumbnailUrl(
    dash.selection.kind === 'document' ? store.getBackend() : null,
    dash.selection.kind === 'document'
      ? documentById(project.documents, dash.selection.documentId)?.thumbnail ?? null
      : null,
  );

  // ── Detail pane for the current selection (§3.6) ──────────────────────
  const detail = useMemo(() => {
    const sel = dash.selection;

    if (sel.kind === 'document') {
      // THE one list (plan-716 F8). `scenes` was the `scenes/`-section
      // projection of exactly this array, so the lookup is the same lookup
      // against a superset — a selection that names a `library/` document now
      // gets the pane it always should have had instead of an empty column.
      const doc = documentById(project.documents, sel.documentId);
      if (!doc) return { title: null };
      const bundled = doc.tier === 'bundled';
      const fields: DetailField[] = [];
      if (doc.modifiedAt) fields.push({ label: 'Modified', value: doc.modifiedAt });
      // The GLB's size on disk, from the same stat pass that versions the
      // thumbnails. Absent (not "0 B") when the backend cannot size a body.
      const size = formatDocumentSize(docStats.get(doc.path)?.size);
      if (size) fields.push({ label: 'Size', value: size });
      if (project.project?.name) fields.push({ label: 'Project', value: project.project.name });
      // The document's CONNECT binding (`documents[].connectRef`, plan-718 §3).
      // Shown whenever set — and marked when the file it names is not in the
      // config listing, because a dead reference is exactly what this row
      // exists to surface.
      fields.push(...refFields(doc, connectConfigs, knowledgeFiles));
      const actions: DetailAction[] = [
        { key: 'open', label: 'Open', primary: true, onClick: () => openDocumentRow(doc.id) },
        // Same document in a fresh tab: the `?doc=<id>` deep link is the one
        // open verb, and the new tab restores the active project on its own
        // (`restoreLastProject`, no prompt). Every other parameter of the
        // current URL travels along, as the address-bar normalisation keeps it.
        {
          key: 'open-tab',
          label: 'Open in new tab',
          onClick: () => {
            window.open(sceneUrlToDocumentUrl(window.location.href, doc.id), '_blank', 'noopener,noreferrer');
          },
        },
      ];
      // A bundled document is offered a duplicate rather than five greyed-out
      // buttons — telling the user the way forward beats disabling (§3.6).
      if (bundled) {
        actions.push({
          key: 'dup',
          label: 'Duplicate to this project',
          onClick: () => duplicateDocumentRow(doc.id),
        });
      } else {
        // No "Rename" entry here either: the pane derives it from `onRename`
        // below (plan-450 §2.2), so a writable document gets the button without
        // this list restating the permission — and a bundled one, which never
        // supplies `onRename`, gets no button at all rather than a dead one.
        actions.push({ key: 'dup', label: 'Duplicate', onClick: () => duplicateDocumentRow(doc.id) });
        // `doc` IS the document row now — the second lookup that used to
        // stand here asked the same array for the same id.
        actions.push(...transferActionsFor(doc));
        actions.push({
          key: 'delete',
          label: 'Delete',
          destructive: true,
          onClick: () => deleteDocumentRow(doc.id, doc.name),
        });
      }
      const row = documentRows.find(r => r.key === 'document:' + doc.id);
      return {
        title: doc.name,
        // The subtitle says only what nothing else shows: writability. The
        // word "Document" said nothing the row's presence did not already say
        // — what the file IS is the type badge, where it LIVES is the place
        // badge, and the root earns no place chip at all.
        ...(bundled ? { subtitle: 'Read-only' } : {}),
        badge: bundled ? 'Sample' : null,
        badges: [documentTypeBadge(doc), documentRoleBadge(doc)],
        thumbnailUrl: selectedDocumentThumbnail,
        fields,
        actions,
        extra: documentExtraFor(row),
        // The title edits in place — the same commit the Rename action makes.
        ...(bundled || !sceneStore ? {} : {
          onRename: (name: string) => { renameDocumentRow(doc.id, name); },
        }),
      };
    }

    if (sel.kind === 'documentPath') {
      // No `published:` shape reaches this branch any more (plan-731 2c). A
      // path selection is a path selection: an example is an ordinary document
      // row and answers through `documentByPath` like every other one.
      //
      // One lookup over the one list (plan-777 F3). A bundled manifest declares
      // its paths URL-style (`/models/x.glb`) while the tree's paths never carry
      // the leading slash — the helper strips it on both sides, or a bundled
      // project's row answers with an empty detail pane.
      const doc = documentForSelectedPath(project.documents, sel.path);
      const label = doc?.name ?? baseNameOf(sel.path);
      if (!label) return { title: null };
      const row = doc ? documentRows.find(r => r.key === 'document:' + doc.id) : undefined;
      const readOnly = doc?.tier === 'bundled';
      return {
        title: label,
        // Same rule as the branch above: the subtitle carries only what no
        // badge shows.
        ...(readOnly ? { subtitle: 'Read-only' } : {}),
        badges: !doc ? [] : [documentTypeBadge(doc), documentRoleBadge(doc)],
        fields: [
          { label: 'Source', value: sel.path },
          // Same reference rows as the id-selected branch — one fact, both routes.
          ...refFields(doc, connectConfigs, knowledgeFiles),
        ],
        actions: [
          {
            key: 'open',
            label: 'Open',
            primary: true,
            onClick: () => openModel(sel.path, label),
          },
          ...(readOnly ? [] : transferActionsFor(doc)),
        ] as DetailAction[],
        extra: documentExtraFor(row),
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
      openDocumentRow, duplicateDocumentRow, deleteDocumentRow, buildAssetActions, openModel,
      project.documents, documentRows, documentExtraFor,
      transferActionsFor, documentByPath, sourceOfRoot, treeRoots, catalogRoots,
      handleRefreshLibrary, handleRemoveLibrary,
      sceneStore, selectedTreePath, runTreeEdit, renameLibraryAsset, renameDocumentRow,
      tree.refs, markdownPane, docStats, selectedDocumentThumbnail]);


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
    // plan-778: a library project's repair (Grant / Locate folder…) and its
    // Remove (direct only — a transitive library belongs to the library that
    // names it). The repair is dispatched straight from the click (activation).
    const libProject = registered.providerId === LIBRARY_PROJECTS_PROVIDER_ID && isLibraryProjectSource(src) ? src : null;
    const badge = libProject ? libraryStateBadge(libProject.state, libProject.id) : null;
    const removable = !!src.remove || !!libProject?.direct;
    return (
      <Box
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, ml: 0.5 }}
      >
        {libProject && badge?.repairLabel && (
          <Button
            size="small"
            data-library-repair={libProject.id}
            onClick={() => {
              ensureLibraryCommandsRegistered();
              void runLibraryRepair(libProject.id, libProject.state, viewer)
                ?.then((r) => { if (!r.ok) setMessage(r.reason); });
            }}
            sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}
          >
            {badge.repairLabel}
          </Button>
        )}
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
        {removable && (
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
  }, [sourceOfRoot, handleRefreshLibrary, handleRemoveLibrary, viewer]);

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

  /**
   * Quick Open (plan-478 F4) — the ONE thing this host renders even before the
   * dashboard has ever been opened.
   *
   * The shortcut is reachable from the viewport, so the popover cannot live
   * behind the "mounted once, then kept" gate below: a fresh session's first
   * `Ctrl/Cmd+Shift+F` would set the flag and paint nothing. It is rendered
   * once — here on the pre-open path, and through `sharedChrome` on both
   * screens afterwards — never twice, or the two copies would fight over the
   * focus each of them returns. Never under a kiosk lock (F5).
   */
  const quickOpenPopover = modeLocked ? null : (
    <RecentDocumentsPopover
      open={quickOpen}
      autoFocus={!getRecentDocumentsHoverOpened()}
      entries={recents}
      rowStates={rowStates}
      modeLabel={recentModeLabel}
      modeOf={recentModeOf}
      busy={recentBusy}
      onOpen={openRecent}
      onClose={() => setRecentDocumentsOpen(false)}
      onForget={(e) => forgetRecent(e.projectId, e.documentId)}
      onClear={clearRecents}
    />
  );

  if (!everOpenedRef.current) return quickOpenPopover;

  const onProjectScreen = dash.view === 'project' && project.project !== null;

  /**
   * The way OUT of unsaved work, on both screens.
   * `Save as…` existed only inside the switch-confirmation dialog, which
   * meant the offer appeared solely when the user was already leaving —
   * and a TRANSIENT workspace (a shared link, an Example) could not be
   * saved at all without first trying to navigate away from it. Someone
   * who opens a shared demo, binds their signals and wants to keep the
   * result had no verb to reach for. The dialog still calls the same
   * `setNameDialog`; this is the missing free-standing entry point.
   *
   * It is the ONE visible element of the shared chrome and therefore lives
   * apart from it: `sharedChrome` is dropped into the dashboard body, a flex
   * row, and a button rendered there becomes a stretched flex item — a
   * full-height orange column reading "Save as…" beside the project list.
   * Title actions are where it belongs on both screens.
   */
  const saveAsButton = sceneSnap?.dirty ? (
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
  ) : null;

  // Dialogs and the snackbar ride along on both screens: a verb started on one
  // can surface its failure after the user has navigated to the other.
  // Nothing in here paints inline — see `saveAsButton` for the one verb that does.
  const sharedChrome = (
    <>
      {/* Quick Open rides in the shared chrome because the shortcut works on
          BOTH dashboard screens — see where it is built, above the gate. */}
      {quickOpenPopover}
      {/* Attaching a library is a viewer-level verb, so it rides in the shared
          chrome. The Asset-Manager tab inside it appears only when the private
          extension supplied a cloud store. */}
      <AddLibraryDialog
        open={addLibraryOpen}
        onClose={() => setAddLibraryOpen(false)}
        onAttach={attachLibraryToProject}
        projects={project.project ? libraryProjectsOptions : undefined}
        attachHint={'Added to this project ' + '—' + ' the reference is stored in project.json and travels with the project.'}
        onConnectAssetManager={cloudStore
          ? (req) => cloudStore.addConnection(req.label, {
              projectId: req.projectId,
              keyId: req.keyId,
              secretKey: req.secretKey,
            })
          : undefined}
      />
      {/* "Create a project here?" is gone with the workspace: a plain folder
          picked through Add becomes a project by being SCANNED, and naming one
          from scratch is what New is for. */}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreate={handleCreateProject}
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
        onCancel={() => {
          setPendingSwitch(null);
          // A chain waiting on this answer gets it (plan-478 R3-1). Null for
          // every `trySwitch` caller, which simply drops its continuation —
          // that is what "cancel" has always meant on this path.
          const reject = dirtyGuardRef.current;
          dirtyGuardRef.current = null;
          reject?.(false);
        }}
      />
      <ProjectOperationDialog label={operationLabel} />
      <RegenerateThumbnailsDialog />
      <Snackbar open={successMessage !== null} autoHideDuration={4000}
        onClose={() => setSuccessMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="success" onClose={() => setSuccessMessage(null)} sx={{ fontSize: 12 }}>
          {successMessage}
        </Alert>
      </Snackbar>
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
    /**
     * The trail the compact layout shows (plan-458 F4).
     *
     * A library's own trail starts at the library, which on a phone leaves no
     * way back to the project that attached it — the tree that used to be that
     * way is not rendered. So the project is prepended whenever the selection
     * sits in a catalog root. Past three levels the MIDDLE folds behind an
     * ellipsis: the root is where you came from and the tail is where you are,
     * and neither survives a trail that simply scrolls off the left edge.
     */
    const inLibrary = folderCrumbs.length > 0
      && treeRoots.find(r => r.rootId === folderCrumbs[0].rootId)?.rootKind === 'catalog';
    const projectRoot = projectTreeRoots[0];
    const trail = compactLayout && inLibrary && projectRoot
      ? [{
        path: projectRoot.path!, name: projectRoot.name,
        rootId: projectRoot.rootId, relPath: '',
      }, ...folderCrumbs]
      : folderCrumbs;
    const crumbEntries = compactLayout ? collapseCrumbs(trail, 3) : trail;
    return (
      <ProjectsDashboard
        title={project.project?.name ?? 'Project'}
        subtitle={[
          project.backendKind ? `${project.backendKind} project` : null,
          `${documentRows.length} document${documentRows.length === 1 ? '' : 's'}`,
          project.writable ? null : 'read-only',
        ].filter(Boolean).join(' · ')}
        onBack={() => setProjectsView('projects')}
        hero={<DocumentHeroSection onReveal={handleHeroReveal} compactLayout={compactLayout} />}
        // The tools moved down onto the grid's own toolbar, where the things
        // they filter are: a separate full-width bar carrying nothing but a
        // centred search field was a third horizontal rule between the user
        // and the documents.
        showSearch={false}
        titleActions={
          <>
            {saveAsButton}
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
              {/* plan-778: hidden where no folder can be picked (Firefox/Safari). */}
              {typeof window !== 'undefined' && 'showDirectoryPicker' in window && (
                <MenuItem
                  disabled={project.backendKind !== 'folder'}
                  data-testid="pack-with-libraries"
                  onClick={() => { handlePackWithLibraries(); setProjectMenuAnchor(null); }}
                >
                  <ListItemText
                    primary="Pack with libraries…"
                    secondary={project.backendKind !== 'folder'
                      ? 'Only a project folder can be packed.'
                      : 'Copy the project and the library parts it uses into a folder.'}
                    primaryTypographyProps={{ fontSize: 13 }}
                    secondaryTypographyProps={{ fontSize: 10 }}
                  />
                </MenuItem>
              )}
              <MenuItem
                onClick={() => { setProjectMenuAnchor(null); handleImportProject(); }}
                sx={{ fontSize: 13 }}
              >
                Import .rvproject…
              </MenuItem>
              {/* The verb lives on the Libraries header of the tree column,
                  and that column is not rendered on the compact layout — so
                  it moves here rather than growing a second header nobody
                  asked for. The desktop keeps the header button. */}
              {compactLayout && (
                <MenuItem
                  onClick={() => { setProjectMenuAnchor(null); setAddLibraryOpen(true); }}
                  sx={{ fontSize: 13 }}
                >
                  Add library…
                </MenuItem>
              )}
            </Menu>
          </>
        }
      >
        {/* Folders left, contents right — the Unity project window (Lauf 13).
            The tree is a fixed column rather than a flex share: it holds names
            of a known length, while the grid is what should take the space a
            wider window offers.

            Not RENDERED at all on the compact layout (plan-458 F2): 280px of
            tree plus 260px of detail leaves the grid nothing on a 390px phone,
            and a hidden column would still pay for its subscriptions. The
            breadcrumb drill-down is the navigation there. */}
        {!compactLayout && (
        <Box
          data-testid="projects-tree-column"
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
              px: 1.25, minHeight: 40, flexShrink: 0,
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
          {/* The boundary between the sections is clear space plus the next
              dark header band — no separator line (user decision 2026-09-02,
              revised same day: the band alone carries it). */}
          <Box sx={{ flexShrink: 0, height: 12 }} />
          <Box
            sx={{
              display: 'flex', alignItems: 'center',
              px: 1.25, minHeight: 40, flexShrink: 0,
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
        )}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* ONE toolbar for the grid: where you are, what you are filtering
              it by, and what you can make in it — left to right in the order
              you would say them. The chips and the search used to live on a
              separate bar spanning the whole window, which put them nearer the
              tree they do NOT filter than the cards they do. */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.75,
              // Same height as the left panel's Project/Libraries headers —
              // the three columns open on one shared 40px header line.
              px: 1.5, minHeight: 40, flexShrink: 0,
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              // Narrow: the trail takes a row of its own and the verbs the
              // next one. Squeezed onto one row, either the trail or the
              // search field ends up too small to use.
              ...(compactLayout ? { flexWrap: 'wrap', rowGap: 0.5, py: 0.5 } : {}),
            }}
          >
            <Box
              data-testid="folder-header-name"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 1, minWidth: 0,
                overflow: 'hidden', whiteSpace: 'nowrap',
                ...(compactLayout ? { flex: '1 1 100%', minHeight: 44 } : {}) }}
            >
              {crumbEntries.map((entry, i) => {
                const last = i === crumbEntries.length - 1;
                if (isCollapsedCrumbs(entry)) {
                  return (
                    <Box
                      key="crumb-ellipsis"
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}
                    >
                      <ChevronRight sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }} />
                      <IconButton
                        size="small"
                        aria-label="Show hidden folders"
                        onClick={(e) => setCrumbMenu({
                          anchor: e.currentTarget, hidden: entry.hidden,
                        })}
                        sx={{ p: 0, width: compactLayout ? 44 : 24, height: compactLayout ? 44 : 24 }}
                      >
                        <MoreHoriz sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Box>
                  );
                }
                const crumb = entry;
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
                        // A trail segment is a navigation target, so on a
                        // finger it is a 44px one — the type stays 12px, the
                        // box around it grows.
                        ...(compactLayout ? { display: 'inline-flex', alignItems: 'center', minHeight: 44 } : {}),
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
              {/* The folded levels. Anchored to the ellipsis rather than the
                  pointer: unlike the card menus this one has a button. */}
              <Menu
                anchorEl={crumbMenu?.anchor ?? null}
                open={crumbMenu !== null}
                onClose={() => setCrumbMenu(null)}
              >
                {(crumbMenu?.hidden ?? []).map(crumb => (
                  <MenuItem
                    key={crumb.path}
                    onClick={() => {
                      setCrumbMenu(null);
                      setProjectsSelection({
                        kind: 'folder', rootId: crumb.rootId, relPath: crumb.relPath,
                      });
                    }}
                    sx={{ fontSize: 13 }}
                  >
                    {crumb.name}
                  </MenuItem>
                ))}
              </Menu>
            </Box>

            <Box sx={{ flex: 1, minWidth: 8, ...(compactLayout ? { display: 'none' } : {}) }} />

            {/* The classification chips live in a drawer under this bar,
                behind the same filter icon the hierarchy browser and the
                property inspector use — open = Instrument Blue, active-while-
                collapsed = badge dot. The chips are the same gesture as the
                search at a different grain; the icon keeps them one reach away
                without spending header width on every chip all the time. */}
            <Tooltip title={filtersOpen ? 'Hide filter' : 'Filter by classification or tag'} disableInteractive>
              <IconButton
                size="small"
                aria-label="Filter documents"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen(open => !open)}
                sx={{
                  // One control height for the whole bar (24px) — icon, search
                  // field and button sit on a shared cap and base line.
                  p: 0, width: compactLayout ? 44 : 24, height: compactLayout ? 44 : 24,
                  flexShrink: 0,
                  color: filtersOpen || hasActiveFilters ? 'primary.main' : 'text.secondary',
                  bgcolor: filtersOpen ? 'rgba(79, 195, 247, 0.12)' : 'transparent',
                  '&:hover': { bgcolor: filtersOpen ? 'rgba(79, 195, 247, 0.18)' : 'rgba(255, 255, 255, 0.08)' },
                }}
              >
                <Badge
                  color="primary"
                  variant="dot"
                  invisible={!hasActiveFilters}
                  sx={{ '& .MuiBadge-badge': { minWidth: 6, height: 6, top: 1, right: 1 } }}
                >
                  <FilterList sx={{ fontSize: 16 }} />
                </Badge>
              </IconButton>
            </Tooltip>

            <TextField
              size="small"
              placeholder="Search this project…"
              value={dash.search}
              onChange={(e) => setProjectsSearch(e.target.value)}
              inputRef={searchInputRef}
              slotProps={{
                htmlInput: { 'aria-label': 'Search this project' },
                input: {
                  startAdornment: (
                    <InputAdornment position="start" sx={{ mr: 0.5 }}>
                      <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                    </InputAdornment>
                  ),
                  // 16px on a coarse pointer, whatever the layout: below it
                  // iOS zooms the page on focus and never zooms back.
                  sx: { fontSize: touchInput ? 16 : 12, height: compactLayout ? 44 : touchInput ? 36 : 24 },
                },
              }}
              sx={compactLayout
                ? { flex: '1 1 calc(100% - 52px)', minWidth: 0 }
                : { width: 200, flexShrink: 0 }}
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
                    py: 0,
                    height: 24,
                    minHeight: 0,
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
                  sx={{ p: 0, width: 24, height: 24 }}
                >
                  <SettingsEthernet sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          {/* The filter drawer — right-aligned so the chips sit under the
              icon that opened them. Stays mounted while collapsed: an active
              chip keeps narrowing the cards, exactly like the hierarchy
              browser's collapsed search (the badge dot signals it). */}
          <Collapse in={filtersOpen} timeout={150} sx={{ flexShrink: 0 }}>
            <Box
              sx={{
                display: 'flex', justifyContent: 'flex-end',
                px: 1.5, pb: 0.75,
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <DocumentFilterBar
                chips={searchMode ? searchChips : folderChips}
                chip={dash.chip}
                onChipChange={setProjectsChip}
                tags={documentTags}
                tag={dash.tag}
                onTagChange={setProjectsTag}
              />
            </Box>
          </Collapse>
          {searchMode ? (
          <ProjectSearchResults
            result={searchResult}
            selectedPath={selectedTreePath}
            compactLayout={compactLayout}
            touchInput={touchInput}
            onSelect={handleTreeSelect}
            onActivate={handleSearchActivate}
          />
          ) : (
          <ProjectFolderContents
            cards={folderCards}
            modeLabel={recentModeLabel}
            folders={subfolderTiles}
            tileGroups={libraryTiles.length > 0
              ? [{ key: 'libraries', label: 'Libraries', tiles: libraryTiles }]
              : []}
            compactLayout={compactLayout}
            touchInput={touchInput}
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
          )}
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
        {/* Desktop: always present, so the layout never jumps when a
            selection comes and goes; without one it says so ("Nothing
            selected"). Compact: a sheet over the grid, which is only up while
            there IS something to describe — so it never needs that state. */}
        {compactLayout
          ? (
            <ProjectsDetailSheet
              open={detailSheetOpen}
              onClose={() => setDetailSheetOpen(false)}
              detail={detail}
            />
          )
          : <ProjectsDetailPane {...detail} />}
        {/* Dialogs and the snackbar — nothing here paints inline, so the
            body row is a safe place for them. */}
        {sharedChrome}
      </ProjectsDashboard>
    );
  }

  // ── Screen one: which project ─────────────────────────────────────────
  // The kiosk gate is a statement about the DEPLOYMENT, not about the model
  // that happens to be open. A project plugin may lock the mode — the large CAD line and
  // a CAD-import showcase model both do, to make their model a single-purpose 3D-HMI — while the very
  // same build sits next to a dozen other linked projects. Reading `modeLocked`
  // alone told that developer "This deployment opens a single fixed project"
  // and took the list away. So the screen closes only when the lock is backed
  // by there being nothing else to offer: no linked projects, and at most the
  // one project the box was given (plan-721 §2.13).
  const kioskSingleProject = modeLocked && linked.length === 0 && projectRows.length <= 1;
  return (
    <ProjectsDashboard
      title="Projects"
      // The search bar is back on the project-picking screen (plan-509), and
      // the 2026-09-08 reason for removing it does not apply to what it does
      // now: it no longer filters the handful of project rows, it searches the
      // MODELS of every project — linked, bundled, locked — from the persisted
      // model index. Add and New stay in the Projects section's own header.
      showSearch
      // "documents", not "models": the dashboard's labels say document
      // (plan-413; guarded by projects-dashboard-tree.test.tsx).
      searchPlaceholder="Search documents…"
      searchInputRef={projectsSearchInputRef}
      headerActions={null}
      // The one way out of unsaved work sits in the title row, not in the
      // body: the body is a flex row, and a button dropped in there was the
      // full-height "Save as…" column beside the project list.
      titleActions={saveAsButton}
    >
      {/* Dialogs and the snackbar only — nothing in here paints inline. */}
      {sharedChrome}
      {/* Drop is armed on the SCREEN, not on the list: a folder dragged
          anywhere over the dashboard means the same thing, and a drop zone the
          user has to aim at is a drop zone they miss. */}
      <Box
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={handleDashboardDrop}
        sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        {dash.search.trim() !== ''
          ? (
            // A typed term swaps the cards for the model hits (F4).
            <ModelSearchResults
              result={modelSearchResult}
              stateOf={modelSearchStateOf}
              unindexedCount={modelSearchUnindexed}
              busy={recentBusy}
              compactLayout={compactLayout}
              touchInput={touchInput}
              modeOf={modelSearchModeOf}
              modeLabel={recentModeLabel}
              onActivate={openModelHit}
            />
          )
          : (
            <ProjectsList
              rows={projectRows}
              activeProjectId={project.project?.id ?? null}
              modeLocked={kioskSingleProject}
              onOpenProject={handleOpenProject}
              onAdd={handleAddPick}
              onNew={() => setNewProjectOpen(true)}
              onLocate={handleLocate}
              onRemove={handleRemove}
              onRenameProject={handleRenameProject}
              onDeleteProject={handleDeleteProject}
              onRegenerateThumbnails={handleRegenerateThumbnails}
              regenerateThumbnailsState={regenerateThumbnailsState}
            />
          )}
      </Box>
    </ProjectsDashboard>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-library-origin-inspector — the origin of a placement made from a library
 * project (plan-778 Phase 5, §2.4 / §3.3).
 *
 * Read-only "From library: <label>" plus three actions:
 *  - **Open library** — the Projects dashboard with that library's document
 *    selected;
 *  - **Edit in library** — a confirmation that names the library; its confirm
 *    click asks B's folder for readwrite FIRST, then opens B's document in the
 *    editor bound to B (saves go into B);
 *  - **Copy into project** — fork B's document into the open project and point
 *    this placement at the copy, one Undo step.
 *
 * Built from the inspector blocks (`InspectorSubheader`, `InspectorRow`,
 * `InspectorActionRow`, DESIGN.md). Renders nothing for any other node.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Object3D } from 'three';
import {
  Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Typography,
} from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import { InspectorActionRow, InspectorSubheader, inspectorActionButtonSx } from './rv-inspector-blocks';
import { InspectorRow } from './rv-inspector-row';
import { ERROR, FS, INK_HIGH, INK_MID } from './shared-sx';
import { getAssetReference } from '../engine/rv-asset-reference';
import { isQualifiedRef } from '../library/library-origin';
import { planReferencedAssetOpen } from '../project/rv-referenced-asset-open';
import { LIBRARY_PROJECTS_PROVIDER_ID } from '../library/library-projects-provider';
import { getLibrarySourcesSnapshot, subscribeLibrarySources } from '../library/library-source-registry';
import {
  editInLibraryMessage,
  editInLibraryTitle,
  grantLibraryWrite,
  libraryDocumentBaseOf,
  libraryEditRefusal,
  libraryLabelOf,
} from '../library/library-document-edit';
import { openProjectsDashboard, setProjectsSelection } from './projects/projects-dashboard-store';
import { setPendingAssetOpen } from '@rv-private/plugins/asset-editor/shared/pending-open-store';

/** Where a placement came from, when it came from a library project. */
export interface PlacementLibraryOrigin {
  /** The planner placement id (null when the node is a reference the planner does not own). */
  placementId: string | null;
  libraryProjectId: string;
  documentId: string;
}

interface PlannerLookup {
  findPlacedAncestor?(node: Object3D): { id: string; root: Object3D } | null;
  store?: { getSnapshot(): { placed: ReadonlyArray<{ id: string; catalogId: string; providerId?: string; sourceId?: string }> } };
}

/**
 * The library origin of `node`, when `node` IS a placement root made from a
 * library project: the planner record's qualifier first (a live placement has
 * no `AssetReference` until it is saved), else the node's own qualified
 * `AssetReference`.
 */
export function placementLibraryOrigin(viewer: RVViewer | null, node: Object3D | null): PlacementLibraryOrigin | null {
  if (!node) return null;
  const planner = viewer?.getPlugin?.('layout-planner') as unknown as PlannerLookup | undefined;
  const hit = planner?.findPlacedAncestor?.(node) ?? null;
  const placementId = hit && hit.root === node ? hit.id : null;
  if (placementId) {
    const rec = planner?.store?.getSnapshot().placed.find((p) => p.id === placementId);
    if (rec?.providerId === LIBRARY_PROJECTS_PROVIDER_ID && rec.sourceId) {
      return { placementId, libraryProjectId: rec.sourceId, documentId: rec.catalogId };
    }
  }
  const ref = getAssetReference(node);
  if (ref && isQualifiedRef(ref) && ref.sourceId && ref.assetId) {
    return { placementId, libraryProjectId: ref.sourceId, documentId: ref.assetId };
  }
  // plan-780 2.3 / D2: read in the document's scope, never the open project.
  const scope = viewer?.currentModelScope ?? null;
  if (scope) {
    const rec = placementId ? planner?.store?.getSnapshot().placed.find((p) => p.id === placementId) : undefined;
    const assetId = ref?.assetId || rec?.catalogId || '';
    const plan = assetId ? planReferencedAssetOpen({ ...(ref ?? {}), assetId }, null, null, scope) : null;
    if (plan?.via === 'library') return { placementId, libraryProjectId: plan.libraryProjectId, documentId: plan.documentId };
  }
  return null;
}

type Note = { tone: 'info' | 'error'; text: string } | null;

export interface LibraryOriginInspectorProps {
  viewer: RVViewer;
  node: Object3D | null;
  /** Copy into project (injected for tests; default = the real fork + repoint). */
  copyIntoProject?: (viewer: RVViewer, origin: PlacementLibraryOrigin) => Promise<{ kind: 'ok'; name: string } | { kind: 'error'; message: string }>;
}

async function defaultCopyIntoProject(
  viewer: RVViewer,
  origin: PlacementLibraryOrigin,
): Promise<{ kind: 'ok'; name: string } | { kind: 'error'; message: string }> {
  if (!origin.placementId) return { kind: 'error', message: 'Only a placement of the open layout can be copied into the project.' };
  const { copyLibraryPlacementIntoProject } = await import('../library/library-copy-into-project');
  const r = await copyLibraryPlacementIntoProject(viewer, origin.placementId, origin.libraryProjectId, origin.documentId);
  return r.kind === 'ok' ? { kind: 'ok', name: r.row.name } : r;
}

export function LibraryOriginInspector({ viewer, node, copyIntoProject = defaultCopyIntoProject }: LibraryOriginInspectorProps) {
  // Library state changes (ready / locked / renamed) re-render the label and the refusal.
  useSyncExternalStore(subscribeLibrarySources, getLibrarySourcesSnapshot);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const origin = placementLibraryOrigin(viewer, node);
  const projectId = origin?.libraryProjectId ?? '';
  const label = projectId ? libraryLabelOf(projectId) : '';

  const openLibrary = useCallback(() => {
    if (!origin) return;
    openProjectsDashboard();
    setProjectsSelection({
      kind: 'asset', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: origin.libraryProjectId, assetId: origin.documentId,
    });
  }, [origin]);

  const askEdit = useCallback(() => {
    if (!origin) return;
    const refusal = libraryEditRefusal(origin.libraryProjectId);
    if (refusal) { setNote({ tone: 'error', text: refusal }); return; }
    setNote(null);
    setConfirmOpen(true);
  }, [origin]);

  // The confirm click: the readwrite request is its FIRST await (inside
  // `grantLibraryWrite`, everything before the prompt is synchronous).
  const confirmEdit = useCallback(() => {
    if (!origin) return;
    const granting = grantLibraryWrite(origin.libraryProjectId);
    setConfirmOpen(false);
    void granting.then((grant) => {
      if (!grant.ok) { setNote({ tone: 'error', text: grant.reason }); return; }
      const base = libraryDocumentBaseOf(origin.libraryProjectId, origin.documentId);
      if (!base) {
        setNote({ tone: 'error', text: `Library '${label}' no longer lists this document.` });
        return;
      }
      setPendingAssetOpen(base);
      void viewer.modes?.requestMode('editor');
    });
  }, [origin, label, viewer]);

  const copy = useCallback(() => {
    if (!origin || busy) return;
    setBusy(true);
    setNote(null);
    void copyIntoProject(viewer, origin).then((r) => {
      setBusy(false);
      setNote(r.kind === 'ok'
        ? { tone: 'info', text: `Copied into this project as "${r.name}". The placement now uses the copy (Undo reverts it).` }
        : { tone: 'error', text: r.message });
    });
  }, [origin, busy, copyIntoProject, viewer]);

  if (!origin) return null;

  return (
    <>
      <InspectorSubheader data-testid="rv-library-origin">Library</InspectorSubheader>
      <InspectorRow label="From library" labelTitle={origin.libraryProjectId}>
        <Typography sx={{ fontSize: FS.body, color: INK_HIGH }} noWrap title={`${label} (${origin.libraryProjectId})`}>
          {label}
        </Typography>
      </InspectorRow>
      <InspectorActionRow data-testid="rv-library-origin-actions">
        <Button size="small" variant="outlined" color="primary" sx={inspectorActionButtonSx} onClick={openLibrary}>
          Open library
        </Button>
        <Button size="small" variant="outlined" color="primary" sx={inspectorActionButtonSx} onClick={askEdit}>
          Edit in library
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="primary"
          sx={inspectorActionButtonSx}
          disabled={busy || !origin.placementId}
          onClick={copy}
        >
          {busy ? 'Copying…' : 'Copy into project'}
        </Button>
      </InspectorActionRow>
      {note && (
        <InspectorRow label="">
          <Typography
            data-testid="rv-library-origin-note"
            sx={{ fontSize: FS.label, color: note.tone === 'error' ? ERROR : INK_MID, whiteSpace: 'normal' }}
          >
            {note.text}
          </Typography>
        </InspectorRow>
      )}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: FS.title, fontWeight: 600 }}>{editInLibraryTitle(label)}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: FS.body }}>{editInLibraryMessage(label)}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={confirmEdit} data-testid="rv-library-edit-confirm">Edit in library</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

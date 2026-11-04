// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * scenario-persistence — WHERE the planning scenarios of the open document can be saved,
 * and the save itself (plan-630 §2.8).
 *
 * Kept out of the plugin module on purpose: it reaches into the project store and the
 * open-document handle, and the plugin is in the eager bundle. The planning window imports
 * this statically (it is itself a lazy chunk); the plugin imports it dynamically on save.
 *
 * ## Saveable or session-only
 *
 * A save writes the open document's GLB through `ProjectStore.setDocumentPlanning`. That
 * needs an open project, a writable backend and a document row that is not bundled. A
 * hosted delivery without a project folder has none of that: its values live for the
 * session, and the window says so instead of offering a Save that cannot work.
 */

import { getProjectStore } from '../../core/project/project-store';
import { getActiveAssetContext, getOpenDocumentBase } from '../../core/editor/active-asset-store';
import type { PlanningScenarioBlock } from '../../core/planning/rv-planning-scenario';

/** Where a save would go — or why there is nowhere to go. */
export interface ScenarioTarget {
  persistable: boolean;
  /** Why not, in words for the window (absent when persistable). */
  reason?: string;
  documentId?: string;
  projectId?: string;
  /** Display name of the document. */
  documentName?: string;
}

interface DocumentRowLike { id: string; path: string; name: string; tier?: string }

function normalisePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

/** Resolves the open document against the open project. Never throws. */
export function resolveScenarioTarget(): ScenarioTarget {
  try {
    const store = getProjectStore();
    const snap = store.getSnapshot();
    if (!snap.project) return { persistable: false, reason: 'No project is open — values last for this session only.' };
    if (!snap.writable) return { persistable: false, reason: 'This project is read-only — values last for this session only.' };
    const base = getOpenDocumentBase() as { documentId?: unknown; path?: unknown } | null;
    const id = typeof base?.documentId === 'string' ? base.documentId : '';
    const path = typeof base?.path === 'string' ? base.path : '';
    const rows = snap.documents as readonly DocumentRowLike[];
    const row = (id ? rows.find((r) => r.id === id) : undefined)
      ?? (path ? rows.find((r) => normalisePath(r.path) === normalisePath(path)) : undefined);
    if (!row) return { persistable: false, reason: 'This model is not a document of the open project — values last for this session only.' };
    if (row.tier === 'bundled') {
      return { persistable: false, reason: `"${row.name}" is read-only — values last for this session only.` };
    }
    return { persistable: true, documentId: row.id, projectId: snap.project.id, documentName: row.name };
  } catch {
    return { persistable: false, reason: 'Values last for this session only.' };
  }
}

/** Re-resolve when the project changes (open, close, writability). */
export function subscribeScenarioTarget(listener: () => void): () => void {
  return getProjectStore().subscribe(listener);
}

/** Result of a save. */
export interface ScenarioSaveResult {
  persistedTo: 'glb' | 'session';
  /** What the file now carries (`null` = block removed, nothing but the empty default). */
  block: PlanningScenarioBlock | null;
  /** The document is also open in the asset editor — its next save writes its own copy. */
  openInEditor?: boolean;
  reason?: string;
}

/**
 * Writes `block` into `target` (default: the open document, resolved now). Session-only
 * targets answer `persistedTo: 'session'` with the reason; a failed write throws.
 */
export async function saveScenarioBlock(
  block: PlanningScenarioBlock,
  target: ScenarioTarget = resolveScenarioTarget(),
): Promise<ScenarioSaveResult> {
  if (!target.persistable || !target.documentId) {
    return { persistedTo: 'session', block, reason: target.reason };
  }
  const written = await getProjectStore().setDocumentPlanning(target.documentId, block, { expectProjectId: target.projectId });
  // The known gap of plan-506 (web_document_info_set): an open editor session of the same
  // document is warned about, not refused.
  const editorBase = getActiveAssetContext()?.doc.getSnapshot().base as { kind?: string; documentId?: string } | undefined;
  const openInEditor = editorBase?.kind === 'document' && editorBase.documentId === target.documentId;
  return { persistedTo: 'glb', block: written, ...(openInEditor ? { openInEditor: true } : {}) };
}

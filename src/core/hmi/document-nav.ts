// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-nav — open the asset a reference places, in THIS tab, and come back.
 *
 * Outside the asset editor (whose own descend stack edits a child in isolation)
 * a click on a reference row's link glyph opens the referenced DOCUMENT as the
 * working scene, through the same open chain the projects dashboard uses: one
 * mode decision (the document's last mode, else its declared one), the exit
 * guards of the mode being left, the editor handoff. A frame remembering where
 * the user came from — document, mode, camera — is pushed; Back reopens that
 * document the same way and restores the camera.
 *
 * Unsaved work of the document being left is not asked about: its autosave
 * draft is flushed first and the document resumes from it when Back reopens it
 * (`draftBacked`). That is the same promise the editor's stack makes for its
 * parent frames — leaving is not discarding.
 *
 * The stack only describes a chain of opens made HERE. When the open document
 * changes any other way (dashboard, recents, MCP) it no longer matches the top
 * and is cleared ({@link syncDocumentNav}).
 */

import type { RecentBackend } from '../project/rv-project-recents';
import {
  openProjectDocument,
  type OpenDocumentDeps,
  type OpenRecentModes,
  type OpenRecentResult,
} from './projects/open-recent-entry';

// ─── Store ──────────────────────────────────────────────────────────────

export interface NavCamera {
  position: [number, number, number];
  target: [number, number, number];
}

/** Where the user came from: one per level above the open document. */
export interface NavFrame {
  documentId: string;
  name: string;
  /** The mode the document was in when it was left; Back reopens it there. */
  mode: string | null;
  camera: NavCamera | null;
}

export interface NavSnapshot {
  /** Oldest first. Empty = no Back. */
  frames: readonly NavFrame[];
  /** The document the last navigation opened (the top of the chain). */
  current: { documentId: string; name: string } | null;
  /** A navigation is running; the bar disables itself. */
  busy: boolean;
}

const EMPTY: NavSnapshot = { frames: [], current: null, busy: false };
let snapshot: NavSnapshot = EMPTY;
const listeners = new Set<() => void>();

function setSnapshot(next: NavSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

export function getDocumentNav(): NavSnapshot {
  return snapshot;
}

export function subscribeDocumentNav(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearDocumentNav(): void {
  if (snapshot.frames.length === 0 && snapshot.current === null && !snapshot.busy) return;
  setSnapshot(EMPTY);
}

/**
 * Drop the chain when the open document is no longer the one it leads to —
 * the user opened something else another way. Ignored while a navigation runs:
 * its own load passes through other documents.
 */
export function syncDocumentNav(openDocumentId: string | null): void {
  if (snapshot.busy || snapshot.current === null) return;
  if (openDocumentId !== snapshot.current.documentId) clearDocumentNav();
}

// ─── Navigation ─────────────────────────────────────────────────────────

/** What the navigation needs from the viewer, the stores and the UI. */
export interface DocumentNavHost {
  modes: OpenRecentModes;
  /** The open project, or null. */
  project(): {
    id: string;
    backend: RecentBackend;
    name: string;
    isDemo: boolean;
    documents: readonly { id: string; name?: string; mode?: string; modes?: unknown }[];
  } | null;
  /** The document the viewer shows now, or null (an unsaved working scene). */
  openDocument(): { documentId: string; name: string } | null;
  /** The mode a document was last used in (`rv-document-modes`). */
  readLastMode(backend: RecentBackend, projectId: string, documentId: string): Promise<string | null>;
  /** Open a document as the working scene — the dashboard's editor handoff. */
  openAsWorkingScene(documentId: string, switchToken?: symbol, targetMode?: string): Promise<void | boolean>;
  /** Write the open document's pending autosave. */
  flushAutosave(): Promise<void>;
  getCamera(): NavCamera | null;
  /** Restore a camera once the reopened document is ready. */
  restoreCamera(camera: NavCamera): Promise<void>;
  notify(message: string): void;
}

export type NavResult = OpenRecentResult | 'no-document' | 'not-found' | 'same-document' | 'nothing-to-go-back-to';

function chainDeps(host: DocumentNavHost): OpenDocumentDeps {
  // Always the open project: the project-opening members are never reached
  // (the chain takes them only for a FOREIGN project), so they refuse.
  return {
    modes: host.modes,
    currentProject: () => {
      const p = host.project();
      return p ? { id: p.id, backend: p.backend } : null;
    },
    isLinked: () => false,
    resolveLinkedOpen: async () => ({ kind: 'missing' as const }),
    store: {
      openDemoProject: async () => false,
      openWorkspaceProject: async () => false,
      openRecentProject: async () => false,
      openProjectFolder: async () => false,
    },
    isDemoProject: () => host.project()?.isDemo ?? false,
    documents: () => host.project()?.documents ?? [],
    openDocument: (id, token, targetMode) => host.openAsWorkingScene(id, token, targetMode),
    notify: (m) => host.notify(m),
    forget: () => {},
  };
}

async function openInProject(host: DocumentNavHost, documentId: string, lastMode: string | null): Promise<NavResult> {
  const project = host.project();
  if (!project) return 'not-found';
  return openProjectDocument({
    projectId: project.id,
    backend: project.backend,
    documentId,
    projectName: project.name,
    ...(lastMode ? { lastMode } : {}),
  }, chainDeps(host));
}

/**
 * Open `documentId` (the asset a reference places) in this tab, in its last
 * mode, and remember the way back.
 */
export async function openReferencedDocument(host: DocumentNavHost, documentId: string): Promise<NavResult> {
  if (snapshot.busy) return 'busy';
  const project = host.project();
  const from = host.openDocument();
  if (!project) return 'not-found';
  if (!from) {
    host.notify('Save this layout as a document first — Back needs a document to return to');
    return 'no-document';
  }
  if (from.documentId === documentId) return 'same-document';
  const row = project.documents.find((d) => d.id === documentId);
  if (!row) return 'not-found';

  const frame: NavFrame = {
    documentId: from.documentId,
    name: from.name,
    mode: host.modes.activeMode,
    camera: host.getCamera(),
  };
  // A chain that no longer leads here (opened elsewhere since) starts over.
  const base = snapshot.current?.documentId === from.documentId ? snapshot.frames : [];
  setSnapshot({ ...snapshot, busy: true });
  let result: NavResult = 'busy';
  try {
    await host.flushAutosave();
    const lastMode = await host.readLastMode(project.backend, project.id, documentId);
    result = await openInProject(host, documentId, lastMode);
  } finally {
    setSnapshot(result === 'opened'
      ? { frames: [...base, frame], current: { documentId, name: row.name ?? documentId }, busy: false }
      : { ...snapshot, busy: false });
  }
  return result;
}

/**
 * Go back to frame `index` (default: the one directly above), reopening that
 * document in the mode it was left in and restoring its camera. The frames
 * above it are dropped.
 */
export async function navigateBack(host: DocumentNavHost, index = snapshot.frames.length - 1): Promise<NavResult> {
  if (snapshot.busy) return 'busy';
  const frame = snapshot.frames[index];
  if (!frame) return 'nothing-to-go-back-to';
  setSnapshot({ ...snapshot, busy: true });
  let result: NavResult = 'busy';
  try {
    await host.flushAutosave();
    result = await openInProject(host, frame.documentId, frame.mode);
  } finally {
    setSnapshot(result === 'opened'
      ? {
        frames: snapshot.frames.slice(0, index),
        current: index > 0 ? { documentId: frame.documentId, name: frame.name } : null,
        busy: false,
      }
      : { ...snapshot, busy: false });
  }
  if (result === 'opened' && frame.camera) await host.restoreCamera(frame.camera);
  return result;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-index-writer — keeps the cross-project model index current
 * (plan-509 Phase 1).
 *
 * Two sources, both prompt-free:
 *
 *  - **the open project** — {@link startModelIndexWriter} subscribes to the
 *    `ProjectStore`; after every publish with a project open it snapshots the
 *    document list and, when the signature differs from the last one written,
 *    schedules a write 500 ms later (one timer per project, reset by every
 *    further change);
 *  - **the bundled demo** — {@link indexBundledProject} reads its HTTP manifest
 *    when the Projects screen mounts, so the demo's models are searchable
 *    without it ever having been opened.
 *
 * ## Never a prompt (F8)
 *
 * The writer only ever reads what the store has ALREADY published, and the
 * bundled manifest over HTTP. It never calls `resolveLinkedOpen`,
 * `openProjectFolder` or `requestPermission`, and it never touches a folder
 * handle.
 *
 * ## A deleted snapshot stays deleted (SOL F7)
 *
 * Unlinking a project deletes its folder snapshot through
 * `forgetModelIndexOfProject`, which first calls {@link cancelPendingWrite} for
 * the key (registered as a forget hook). And because the unlinked project may
 * still be OPEN — its next publish would schedule a fresh write — a `folder`
 * snapshot is committed only while the project is still in the linked list.
 */

import { readLinkedProjects } from './rv-project-linked';
import { documentsOf } from './rv-project-documents';
import type { RvDocumentEntry, RvProject } from './rv-project-types';
import {
  modelIndexKey, signatureOf, snapshotFromDocuments,
  type ModelIndexBackend, type ModelIndexSnapshot,
} from './rv-model-index';
import { onModelIndexProjectForget, putSnapshot, readSnapshot } from './rv-model-index-store';

/** Debounce of one project's write, in milliseconds. */
export const MODEL_INDEX_WRITE_DEBOUNCE_MS = 500;

/** The slice of `ProjectStore` the writer reads. */
export interface ModelIndexSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    project: { id: string; name: string } | null;
    backendKind: ModelIndexBackend | null;
    documents: readonly RvDocumentEntry[];
  };
}

export interface ModelIndexWriterDeps {
  put(snapshot: ModelIndexSnapshot): Promise<boolean>;
  read(backend: ModelIndexBackend, projectId: string): Promise<ModelIndexSnapshot | null>;
  /** Is this folder project still in the linked list? Synchronous, never prompts. */
  isLinked(projectId: string): boolean;
  now(): string;
  debounceMs: number;
}

const defaultDeps: ModelIndexWriterDeps = {
  put: putSnapshot,
  read: readSnapshot,
  isLinked: (id) => readLinkedProjects().some(r => r.id === id),
  now: () => new Date().toISOString(),
  debounceMs: MODEL_INDEX_WRITE_DEBOUNCE_MS,
};

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  snapshot: ModelIndexSnapshot;
  signature: string;
}

/** At most one scheduled write per key. */
const pending = new Map<string, Pending>();
/** Signature of the last successful write per key, this session. */
const lastWritten = new Map<string, string>();
let deps: ModelIndexWriterDeps = defaultDeps;

/**
 * Drop a scheduled write for `key` and forget what was last written there, so
 * a project that is linked again later is written afresh.
 */
export function cancelPendingWrite(key: string): void {
  const p = pending.get(key);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(key);
  }
  lastWritten.delete(key);
}

async function commit(key: string): Promise<void> {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  const { snapshot, signature } = p;
  // Checked HERE, not when the write was scheduled: the unlink may have
  // happened in between, and the project may still be open behind it.
  if (snapshot.backend === 'folder' && !deps.isLinked(snapshot.projectId)) return;
  if (lastWritten.get(key) === signature) return;
  if (await deps.put(snapshot)) lastWritten.set(key, signature);
}

function schedule(snapshot: ModelIndexSnapshot): void {
  const key = modelIndexKey(snapshot.backend, snapshot.projectId);
  const signature = signatureOf(snapshot);
  const p = pending.get(key);
  if (p?.signature === signature) return;
  if (p) {
    clearTimeout(p.timer);
    pending.delete(key);
  }
  if (lastWritten.get(key) === signature) return;
  const timer = setTimeout(() => { void commit(key); }, deps.debounceMs);
  pending.set(key, { timer, snapshot, signature });
}

/**
 * Subscribe to the project store and index the open project on every change.
 *
 * Returns the stop function (unsubscribes, drops pending writes). Starting a
 * second writer stops nothing: call it once, at boot (`main.ts`).
 */
export function startModelIndexWriter(
  source: ModelIndexSource,
  overrides: Partial<ModelIndexWriterDeps> = {},
): () => void {
  deps = { ...defaultDeps, ...overrides };
  // A publish that changes nothing about the documents (a write-status flip,
  // a warning) must cost nothing: the same array and name are the same list.
  let seenDocs: readonly RvDocumentEntry[] | null = null;
  let seenKey: string | null = null;
  let seenName: string | null = null;

  const onPublish = (): void => {
    const snap = source.getSnapshot();
    const project = snap.project;
    if (!project || !snap.backendKind) return;
    const key = modelIndexKey(snap.backendKind, project.id);
    if (snap.documents === seenDocs && key === seenKey && project.name === seenName) return;
    seenDocs = snap.documents;
    seenKey = key;
    seenName = project.name;
    schedule(snapshotFromDocuments(project, snap.backendKind, snap.documents, deps.now()));
  };

  const offForget = onModelIndexProjectForget((key) => {
    cancelPendingWrite(key);
    // The next publish of a still-open project must be judged afresh.
    if (key === seenKey) seenDocs = null;
  });
  const unsubscribe = source.subscribe(onPublish);
  onPublish();   // the project the boot already opened, if any
  return () => {
    unsubscribe();
    offForget();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
  };
}

/**
 * Index the bundled demo from its HTTP manifest, without opening it (F2).
 *
 * A snapshot the LIVE project wrote wins: it also carries the user tier the
 * manifest cannot know about, so a manifest read only fills in a missing
 * snapshot or refreshes one it wrote itself. Failures — offline, a 404, no
 * IndexedDB — are logged and swallowed.
 */
export async function indexBundledProject(
  backend: { readManifest(): Promise<RvProject | null> },
  overrides: Partial<ModelIndexWriterDeps> = {},
): Promise<void> {
  const d: ModelIndexWriterDeps = { ...deps, ...overrides };
  try {
    const manifest = await backend.readManifest();
    if (!manifest || typeof manifest.id !== 'string' || manifest.id === '') return;
    const existing = await d.read('bundled', manifest.id);
    if (existing && existing.source !== 'manifest') return;
    const snapshot = snapshotFromDocuments(
      { id: manifest.id, name: manifest.name ?? manifest.id },
      'bundled', documentsOf(manifest), d.now(), 'manifest');
    if (existing && signatureOf(existing) === signatureOf(snapshot)) return;
    await d.put(snapshot);
  } catch (e) {
    console.warn('[model-index] bundled indexing failed:', e);
  }
}

/** Tests only. */
export function __resetModelIndexWriter(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  lastWritten.clear();
  deps = defaultDeps;
}

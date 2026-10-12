// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-scan — turn a plain folder of GLBs into a project (plan-743 F3).
 *
 * ## Recursive, uncapped, and with no ignore list — deliberately
 *
 * That is a user decision, and it is the honest one: a folder of CAD exports is
 * nested however the exporter felt like nesting it, and a depth limit would
 * silently drop half of somebody's models with no way to tell that it had. The
 * cost is that Add pointed at `C:\` runs until it is cancelled. The mitigations
 * are the ones a user can actually see and use, not a heuristic that guesses on
 * their behalf:
 *
 *  - a visible counter, so a symlink loop LOOKS like a symlink loop;
 *  - Cancel that takes effect at the next entry;
 *  - a yield to the main thread every {@link YIELD_EVERY} entries, so the
 *    counter keeps painting and the Cancel button keeps responding.
 *
 * ## Nothing is written until the scan is COMPLETE
 *
 * {@link scanGlbTree} touches no file at all, and {@link seedProjectFromScan}
 * is a separate call the caller only makes after the scan finished. So Cancel —
 * and a closed tab, and a crash — leave the folder exactly as it was found.
 * There is no half-written manifest to clean up because there is no manifest
 * until the last step.
 *
 * ## A nested project is a sibling, not content
 *
 * A subfolder with its own `project.json` is NOT descended into and its GLBs do
 * not become documents of the new project. It is reported in
 * {@link ScanResult.nestedProjectDirs} so the caller can link it as its own
 * project — the same thing the `parent` branch of Add does, reached from the
 * other direction.
 */

import { hasManifestFile } from './rv-project-add';
import { writeManifest } from './rv-project-storage';
import { newDocumentId } from './rv-project-documents';
import { newProject, type RvDocumentEntry, type RvProject } from './rv-project-types';

/** Entries between two yields to the main thread. */
const YIELD_EVERY = 100;

export interface ScanProgress {
  /** Directory entries looked at so far — files and folders alike. */
  visited: number;
  /** GLBs found so far. */
  found: number;
  /** Subfolders skipped because they are projects of their own. */
  nestedProjects: number;
  /** The folder currently being read, relative to the root. `''` at the root. */
  current: string;
}

export interface ScanDocument {
  /** Path relative to the scan root, `/`-separated. What the manifest stores. */
  relPath: string;
  /** File name without the `.glb` extension. */
  name: string;
}

export interface ScanResult {
  documents: ScanDocument[];
  nestedProjectDirs: { relPath: string; dir: FileSystemDirectoryHandle }[];
}

export interface ScanOptions {
  signal: AbortSignal;
  onProgress: (p: ScanProgress) => void;
}

/**
 * Hand the main thread back a slice.
 *
 * `scheduler.yield()` resumes at the front of the task queue, so the scan keeps
 * its priority; `setTimeout(0)` is the fallback everywhere else and goes to the
 * back, which is slower but never wrong.
 */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  const y = scheduler?.yield;
  if (typeof y === 'function') return y.call(scheduler);
  return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

function isGlb(name: string): boolean {
  // Case-insensitive: Windows exporters write `.GLB` as readily as `.glb`, and
  // an extension comparison that misses those finds nothing in half the CAD
  // folders this feature exists for.
  return name.toLowerCase().endsWith('.glb');
}

function baseNameOf(fileName: string): string {
  return fileName.slice(0, fileName.length - '.glb'.length);
}

/**
 * Walk `root` depth-first and collect every GLB.
 *
 * Throws `AbortError` — and nothing else, for a folder-shaped reason — when the
 * signal fires. An unreadable subfolder is skipped rather than fatal: one
 * permission-denied directory in a deep tree must not cost the user the other
 * nine hundred models.
 */
export async function scanGlbTree(
  root: FileSystemDirectoryHandle,
  opts: ScanOptions,
): Promise<ScanResult> {
  const { signal, onProgress } = opts;
  const documents: ScanDocument[] = [];
  const nestedProjectDirs: { relPath: string; dir: FileSystemDirectoryHandle }[] = [];
  let visited = 0;
  let sinceYield = 0;

  const throwIfAborted = (): void => {
    if (signal.aborted) throw new DOMException('The scan was cancelled.', 'AbortError');
  };

  const report = (current: string): void => {
    onProgress({
      visited,
      found: documents.length,
      nestedProjects: nestedProjectDirs.length,
      current,
    });
  };

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    throwIfAborted();
    report(prefix);

    // Collected first so the recursion does not hold an async iterator open on
    // every level of the tree at once.
    const children: [string, FileSystemHandle][] = [];
    try {
      for await (const entry of dir.entries()) {
        throwIfAborted();
        children.push(entry as [string, FileSystemHandle]);
      }
    } catch (e) {
      // Cancel is not an unreadable folder. Without this re-throw the abort
      // check inside the loop above would be swallowed and the scan would
      // "succeed" with whatever it had collected so far — which is exactly the
      // half-result the Cancel contract promises never to produce.
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
      // Unreadable folder — skip it, keep the rest of the tree.
      return;
    }

    for (const [name, handle] of children) {
      throwIfAborted();
      visited++;
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        report(prefix);
        await yieldToMain();
        throwIfAborted();
      }

      const relPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') {
        if (isGlb(name)) documents.push({ relPath, name: baseNameOf(name) });
        continue;
      }

      const child = handle as FileSystemDirectoryHandle;
      if (await hasManifestFile(child)) {
        // Its own project: linked separately by the caller, never absorbed.
        nestedProjectDirs.push({ relPath, dir: child });
        continue;
      }
      await walk(child, relPath);
    }
  }

  await walk(root, '');
  report('');
  return { documents, nestedProjectDirs };
}

/**
 * Write the manifest that makes the scanned folder a project.
 *
 * The one write of the whole Add flow, and it happens in the folder the user
 * picked — never in a parent, never in a nested project.
 *
 * Refuses when a manifest turned up while the scan was running. On a long scan
 * that is a real race (a second tab, a sync client, the user's own second Add),
 * and overwriting would destroy a project that already existed. An empty result
 * is NOT a refusal: an empty folder legitimately becomes an empty project.
 */
export async function seedProjectFromScan(
  root: FileSystemDirectoryHandle,
  name: string,
  result: ScanResult,
): Promise<RvProject> {
  if (await hasManifestFile(root)) {
    throw new Error(
      'This folder became a project while it was being scanned — nothing was written.',
    );
  }

  const now = new Date().toISOString();
  const project = newProject(name);
  const documents: RvDocumentEntry[] = result.documents.map(d => ({
    id: newDocumentId(),
    path: d.relPath,
    name: d.name,
    createdAt: now,
    modifiedAt: now,
  }));
  project.documents = documents;

  await writeManifest(root, project);
  return project;
}

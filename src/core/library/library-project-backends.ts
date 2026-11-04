// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-project-backends — the app's {@link LibraryBackendFactory} and loader
 * deps (plan-778 Phase 1).
 *
 * The loader takes its backends injected so it never imports the project
 * store; this is the one module that knows the concrete classes. Every backend
 * it builds is READ-ONLY and never activated (spike result: reads need no
 * `activate()`), with an id unique per library project (F3):
 * `folder:<projectId>`, `browser:<projectId>`, `remote:<url>`.
 */

import { FolderBackend } from '../project/backends/folder-backend';
import { BrowserBackend, browserManifestKey } from '../project/backends/browser-backend';
import { BundledBackend } from '../project/backends/bundled-backend';
import { ensureHandlePermission, getHandle, projectHandleKey } from '../engine/rv-local-filesystem';
import { readLocalStorage } from '../rv-safe-storage';
import { getProjectStore } from '../project/project-store';
import type { ProjectBackend } from '../project/backends/project-backend';
import { buildCatalogFromGitHub } from './library-store';
import {
  LibraryProjectLoader,
  type LibraryBackendFactory,
  type LibraryProjectLoaderDeps,
} from './library-project-loader';

/** The production backend factory. */
export function createLibraryBackendFactory(): LibraryBackendFactory {
  return {
    folder: (handle, projectId) => new FolderBackend(handle, { writable: false, id: `folder:${projectId}` }),
    // `BrowserBackend.readManifest()` synthesises a manifest when none is
    // stored, so existence is asked first — a library id this browser never
    // held is `unknown`, not an empty project of that id.
    browser: (projectId) => (readLocalStorage(browserManifestKey(projectId))
      ? new BrowserBackend(projectId, { requestPersistence: false, id: `browser:${projectId}` })
      : null),
    // `discover: false`: a library is its `project.json`; no `models.json` probe (404 noise).
    remote: (baseUrl) => {
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return new BundledBackend({ baseUrl: base, discover: false, id: `remote:${base}` });
    },
  };
}

/** The production loader deps. */
export function createLibraryProjectLoaderDeps(): LibraryProjectLoaderDeps {
  return {
    factory: createLibraryBackendFactory(),
    getLinkedHandle: async (projectId) => {
      try { return await getHandle(projectHandleKey(projectId)); } catch { return null; }
    },
    // READ, never a prompt: a lapsed grant is `locked`, the Grant click is Phase 2.
    hasReadPermission: async (handle) => (await ensureHandlePermission(handle, { mode: 'read', prompt: false })) !== null,
    builtinBaseUrl: () => builtinLibraryBaseUrl(
      (import.meta.env?.BASE_URL as string | undefined) ?? '/',
      typeof document !== 'undefined' ? document.baseURI : null,
    ),
    scanGitHub: (url) => buildCatalogFromGitHub(url),
    openRelative: (relDir, projectId) => openRelativeToBackend(getProjectStore().getBackend(), relDir, projectId),
  };
}

/** `<BASE_URL>library/` resolved against the document (review C1). */
export function builtinLibraryBaseUrl(baseUrl: string, documentBaseUri: string | null): string {
  const base = baseUrl || '/';
  const root = base.endsWith('/') ? base : `${base}/`;
  const rel = `${root}library/`;
  if (!documentBaseUri) return rel;
  try { return new URL(rel, documentBaseUri).href; } catch { return rel; }
}

/**
 * A read-only backend for the folder `relDir` inside the project `backend`
 * serves — how a DELIVERED or PACKED project finds the trimmed library copies
 * it carries under `libraries/<id>/` (plan-778 Phase 4: its hints are rewritten
 * to `libraries/<id>/project.json`, relative to the project root).
 *
 *  - a local folder project → the sub-directory handle (read access is the open
 *    project's own grant), as `folder:<projectId>`;
 *  - a hosted / deploy-root project (`BundledBackend`) → a remote backend at
 *    `<base><basePath><relDir>/` (the hosted layout is `{code}/p/libraries/<id>/`).
 *
 * Anything else (a browser project, no open project, a missing folder) → null.
 */
export async function openRelativeToBackend(
  backend: ProjectBackend | null,
  relDir: string,
  projectId: string,
  factory: LibraryBackendFactory = createLibraryBackendFactory(),
): Promise<{ backend: ProjectBackend; via: 'folder' | 'hosted' } | null> {
  const segments = relDir.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  if (backend instanceof FolderBackend) {
    let dir: FileSystemDirectoryHandle = backend.directory;
    try {
      for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    } catch {
      return null;
    }
    return { backend: factory.folder(dir, projectId), via: 'folder' };
  }
  if (backend instanceof BundledBackend) {
    const root = /^(https?:)?\/\//i.test(backend.basePath) ? backend.basePath : `${backend.baseUrl}${backend.basePath}`;
    const base = root.endsWith('/') ? root : `${root}/`;
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(base) || typeof location === 'undefined'
      ? base
      : new URL(base, location.href).href;
    return { backend: factory.remote(`${absolute}${segments.join('/')}/`), via: 'hosted' };
  }
  return null;
}

/** A loader with the production deps. */
export function createAppLibraryProjectLoader(): LibraryProjectLoader {
  return new LibraryProjectLoader(createLibraryProjectLoaderDeps());
}

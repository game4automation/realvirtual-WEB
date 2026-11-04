// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 Phase 5 — the Inspector origin rows of a library placement.
 *
 * "From library: <label>" + Open library / Edit in library / Copy into
 * project. Edit in library asks with a confirmation that NAMES the library and
 * requests readwrite on B's folder inside the confirming click; a library that
 * cannot be written (hosted, built-in, delivered copy) answers with its reason
 * instead of a dialog. Copy into project reports the outcome in a message row.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Object3D } from 'three';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import { LibraryProjectLoader, setLibraryProjectLoader } from '../src/core/library/library-project-loader';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import { resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import { releaseLibraryWriteGrants } from '../src/core/library/library-document-edit';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { LibraryOriginInspector } from '../src/core/hmi/rv-library-origin-inspector';
import { getProjectsDashboardSnapshot } from '../src/core/hmi/projects/projects-dashboard-store';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb } from './helpers/fake-document-project';

const PUMP = 'models/pump';

async function libraryB(opts: { hosted?: boolean } = {}): Promise<FakeDir> {
  const b = new FakeDir('Shared');
  b.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_b', name: 'SharedConveyors', canonicalName: 'shared', createdAt: 'x', modifiedAt: 'x',
    documents: [{ id: PUMP, path: 'models/pump.glb', name: 'Pump' }],
  }));
  b.seedDir('models').seedBytes('pump.glb', fakeGlb('b:pump'));
  b.permissions.readwrite = 'prompt';
  const hosted = new FolderBackend(asDirHandle(b), { writable: false, id: 'remote:https://hosted.test/b/' });
  const loader = new LibraryProjectLoader({
    factory: {
      folder: (handle, id) => new FolderBackend(handle, { writable: false, id: `folder:${id}` }),
      browser: () => null,
      remote: () => hosted as unknown as ProjectBackend,
    },
    getLinkedHandle: async (id) => (id === 'prj_b' && !opts.hosted ? asDirHandle(b) : null),
    hasReadPermission: async () => true,
    builtinBaseUrl: () => null,
  });
  setLibraryProjectLoader(loader);
  installLibraryProjectsProvider(loader);
  loader.setProject({
    schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a',
    libraries: [{ projectId: 'prj_b', ...(opts.hosted ? { hint: 'https://hosted.test/b/' } : {}) }],
  } as unknown as RvProject);
  await loader.whenSettled();
  return b;
}

function placement(): Object3D {
  const node = new Object3D();
  setAssetReference(node, { assetId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
  return node;
}

function viewerStub() {
  return { getPlugin: () => undefined, modes: { requestMode: vi.fn(async () => true) } };
}

afterEach(() => {
  cleanup();
  releaseLibraryWriteGrants();
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  setLibraryProjectLoader(null);
});

describe('LibraryOriginInspector (plan-778 Phase 5)', () => {
  it('renders nothing for a node that is not a library placement', () => {
    const { container } = render(<LibraryOriginInspector viewer={viewerStub() as never} node={new Object3D()} />);
    expect(container.textContent).toBe('');
  });

  it('shows the library by name with the three actions; Open library selects the document in the dashboard', async () => {
    await libraryB();
    render(<LibraryOriginInspector viewer={viewerStub() as never} node={placement()} />);
    expect(screen.getByText('From library')).toBeTruthy();
    expect(screen.getByText('SharedConveyors')).toBeTruthy();
    for (const label of ['Open library', 'Edit in library', 'Copy into project']) expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByText('Open library'));
    expect(getProjectsDashboardSnapshot().selection).toEqual({
      kind: 'asset', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b', assetId: PUMP,
    });
  });

  it('Edit in library: the confirmation names B; its click asks readwrite and opens the editor', async () => {
    const b = await libraryB();
    const viewer = viewerStub();
    render(<LibraryOriginInspector viewer={viewer as never} node={placement()} />);
    fireEvent.click(screen.getByText('Edit in library'));
    expect(await screen.findByText("Save changes into library 'SharedConveyors'? Every project that uses it gets the change.")).toBeTruthy();
    expect(b.requestPermissionCalls).toBe(0);
    fireEvent.click(screen.getByTestId('rv-library-edit-confirm'));
    // Inside the click — before any await.
    expect(b.requestPermissionCalls).toBe(1);
    await waitFor(() => expect(viewer.modes.requestMode).toHaveBeenCalledWith('editor'));
    expect(b.permissions.readwrite).toBe('granted');
  });

  it('a hosted library answers with its reason instead of a confirmation', async () => {
    const b = await libraryB({ hosted: true });
    render(<LibraryOriginInspector viewer={viewerStub() as never} node={placement()} />);
    fireEvent.click(screen.getByText('Edit in library'));
    expect(screen.getByTestId('rv-library-origin-note').textContent).toContain('published online');
    expect(screen.queryByTestId('rv-library-edit-confirm')).toBeNull();
    expect(b.requestPermissionCalls).toBe(0);
  });

  it('Copy into project reports its outcome', async () => {
    await libraryB();
    const node = placement();
    const copy = vi.fn(async () => ({ kind: 'ok' as const, name: 'Pump' }));
    // A reloaded node the planner does not own has no placement id → the action is disabled.
    const { unmount } = render(<LibraryOriginInspector viewer={viewerStub() as never} node={node} copyIntoProject={copy} />);
    expect((screen.getByText('Copy into project').closest('button') as HTMLButtonElement).disabled).toBe(true);
    unmount();

    const planner = {
      findPlacedAncestor: (n: Object3D) => (n === node ? { id: 'pl_1', root: node } : null),
      store: { getSnapshot: () => ({ placed: [{ id: 'pl_1', catalogId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' }] }) },
    };
    const viewer = { ...viewerStub(), getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined) };
    render(<LibraryOriginInspector viewer={viewer as never} node={node} copyIntoProject={copy} />);
    fireEvent.click(screen.getByText('Copy into project'));
    await waitFor(() => expect(screen.getByTestId('rv-library-origin-note').textContent).toContain('Copied into this project as "Pump"'));
    expect(copy).toHaveBeenCalledWith(viewer, { placementId: 'pl_1', libraryProjectId: 'prj_b', documentId: PUMP });
  });
});

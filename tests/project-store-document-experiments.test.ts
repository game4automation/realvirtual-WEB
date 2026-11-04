// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `ProjectStore.setDocumentExperiments` — the experiment save declares the archive
 * on the document row, so a deploy of the folder reads it without probing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';

const PTR = 'experiments/doc_a.rvexp.ndjson';
let project: FakeDocumentProject;
const row = (id: string, path: string) => ({ id, path, name: id }) as RvDocumentEntry;

beforeEach(() => {
  resetProjectStore();
  project = installFakeDocumentProject({ documents: [row('doc_a', 'models/A.glb'), row('doc_b', 'models/B.glb')] });
});
afterEach(() => {
  vi.restoreAllMocks();
  project.restore();
  resetProjectStore();
});

describe('setDocumentExperiments', () => {
  it('writes the pointer on the row, in memory and in the manifest, and touches no other row', async () => {
    const store = getProjectStore();
    await store.setDocumentExperiments('doc_a', PTR);
    const onDisk = (await project.backend.readManifest())!.documents!;
    expect(onDisk.find(d => d.id === 'doc_a')?.experiments).toBe(PTR);
    expect(onDisk.find(d => d.id === 'doc_b')?.experiments).toBeUndefined();
    await store.rescanDocuments();
    expect(store.getSnapshot().documents.find(d => d.id === 'doc_a')?.experiments).toBe(PTR);
  });

  it('is a no-op once the row already declares the archive', async () => {
    const store = getProjectStore();
    await store.setDocumentExperiments('doc_a', PTR);
    await store.rescanDocuments();
    const delta = vi.spyOn(store, 'applyManifestDelta');
    await store.setDocumentExperiments('doc_a', PTR);
    expect(delta).not.toHaveBeenCalled();
    await store.setDocumentExperiments('doc_b', PTR.replace('doc_a', 'doc_b'));
    expect(delta).toHaveBeenCalledTimes(1);
  });
});

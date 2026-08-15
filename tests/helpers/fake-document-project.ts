// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A writable project with real compare-and-swap, for the plan-716 Phase-3 tests.
 *
 * Phase 3 leaves exactly one save path and that path writes a DOCUMENT FILE, so
 * every test about saving now needs somewhere to save to. Before the phase most
 * of them needed nothing at all — `_save()` minted a `scn_` id and wrote
 * localStorage — which is precisely the state the plan removes: after Phase 1
 * there is always "My Workspace", and a projectless save is not a case the
 * product has any more.
 *
 * ## Why the CAS is real here
 *
 * §9.3 asks for "Save = Datei + CAS (Konflikt bei fremder Zwischenschreibung)",
 * and a backend that merely RECORDS `expectedRevision` cannot answer that: the
 * interesting behaviour is the REFUSAL, and a fake that never refuses would let
 * a store that passes the wrong precondition — or none — pass every assertion.
 * So the revision is the same SHA-256 of the bytes the real backends compute
 * (`revisionOfBytes`) and the same `SceneRevisionConflictError` is thrown, which
 * makes this fixture behave exactly as the two writable backends do under the
 * contract test.
 *
 * ## Why it injects rather than boots
 *
 * `resolveActiveProject()` + `hydrateProjectScenes()` would drag OPFS, the
 * migration, the library provider and the conflict prompt into a test about one
 * method. The two private fields set below are the same seam
 * `scene-save-into-document.test.ts` has used since Stage 1.
 */

import { getProjectStore, type ProjectStore } from '../../src/core/project/project-store';
import type { ProjectBackend } from '../../src/core/project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../../src/core/project/rv-project-types';
import {
  revisionOfBytes,
  SceneRevisionConflictError,
} from '../../src/core/project/rv-scene-record';

export interface FakeDocumentProject {
  backend: ProjectBackend;
  /** relPath → bytes, as the project's storage surface holds them. */
  files: Map<string, Uint8Array>;
  /** Every blob write, in order, with the precondition it carried. */
  writes: { relPath: string; expected: string | null | undefined }[];
  /** The manifest as the store currently holds it. */
  project(): RvProject;
  documents(): RvDocumentEntry[];
  /** Bytes written by somebody else — the CAS conflict fixture. */
  writeForeign(relPath: string, text: string): void;
  restore(): void;
}

interface StorePrivates {
  _backend: ProjectBackend | null;
  _project: RvProject | null;
}

/** A minimal valid binary GLB, so a "document" is loadable bytes and not a stub. */
export function fakeGlb(marker = 'doc'): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: marker }],
  }));
  const jsonPad = (json.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPad;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);   // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);  // 'JSON'
  out.fill(0x20, 20, 20 + jsonPad);
  out.set(json, 20);
  return out;
}

function toBytes(blob: BlobPart): Promise<Uint8Array> {
  return new Blob([blob]).arrayBuffer().then(b => new Uint8Array(b));
}

/**
 * Install a writable browser-shaped project into the singleton project store.
 *
 * @param documents rows the manifest starts with; their bytes are seeded too
 *                  unless `files` says otherwise.
 */
export function installFakeDocumentProject(opts: {
  id?: string;
  documents?: RvDocumentEntry[];
  files?: Record<string, Uint8Array>;
} = {}): FakeDocumentProject {
  const store = getProjectStore();
  const privates = store as unknown as StorePrivates;
  const before: StorePrivates = { _backend: privates._backend, _project: privates._project };

  const files = new Map<string, Uint8Array>();
  const writes: { relPath: string; expected: string | null | undefined }[] = [];
  for (const row of opts.documents ?? []) files.set(row.path, fakeGlb(row.name));
  for (const [path, bytes] of Object.entries(opts.files ?? {})) files.set(path, bytes);

  let manifest: RvProject = {
    schemaVersion: 3,
    id: opts.id ?? 'prj_fake_documents',
    name: 'Fake Workspace',
    documents: [...(opts.documents ?? [])],
  } as RvProject;

  const backend = {
    kind: 'browser',
    id: 'fake:documents',
    writable: true,
    isActive: true,
    async readManifest() { return manifest; },
    async writeManifest(next: RvProject) { manifest = next; },
    async listModels() { return []; },
    async listLibrary() { return []; },
    async listDocuments() { return [...(manifest.documents ?? [])]; },
    async statDocuments() { return []; },
    async activate() {},
    async deactivate() {},
    async readScene() { return null; },
    async readSettings() { return null; },
    async writeScene() { return 'rev'; },
    async deleteScene() {},
    async readBlobBytes(relPath: string) {
      const found = files.get(relPath);
      return found ? (found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength) as ArrayBuffer) : null;
    },
    async readBlobUrl() { return null; },
    async writeBlob(relPath: string, blob: Blob, o?: { expectedRevision?: string | null }) {
      const expected = o === undefined ? undefined : o.expectedRevision;
      writes.push({ relPath, expected });
      if (expected !== undefined) {
        const stored = files.get(relPath);
        const actual = stored ? await revisionOfBytes(stored) : null;
        if (actual !== expected) {
          throw new SceneRevisionConflictError(relPath, expected ?? null, actual);
        }
      }
      files.set(relPath, await toBytes(blob));
    },
    async deleteBlob(relPath: string) { files.delete(relPath); },
    async flush() {},
  } as unknown as ProjectBackend;

  privates._backend = backend;
  privates._project = manifest;

  return {
    backend,
    files,
    writes,
    project: () => (getProjectStore() as unknown as StorePrivates)._project ?? manifest,
    documents: () => [
      ...((getProjectStore() as unknown as StorePrivates)._project?.documents ?? []),
    ],
    writeForeign(relPath, text) { files.set(relPath, new TextEncoder().encode(text)); },
    restore() {
      privates._backend = before._backend;
      privates._project = before._project;
    },
  };
}

/** The revision a document's current bytes hash to — the CAS precondition. */
export async function revisionOfFile(
  fixture: FakeDocumentProject,
  relPath: string,
): Promise<string | null> {
  const bytes = fixture.files.get(relPath);
  return bytes ? revisionOfBytes(bytes) : null;
}

/** Narrowing helper: the store, typed as the document ops expect it. */
export function documentHost(): ProjectStore {
  return getProjectStore();
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 #20 — "Regenerate thumbnails" of a project, the registry command
 * `project.regenerateThumbnails`.
 *
 * A fake writable project (real CAS), a real WebGL renderer and the REAL
 * writer: the command opens every document through the scene store (a stand-in
 * that swaps the viewer's content per document, like a background open does),
 * and the one writer renders and points each row. Covered: three documents —
 * an own part, a placed reference (a baked chunk under the reference node, the
 * shape `BakeRegistry.instantiate` builds) and one that fails to open → two
 * written, one failure named; Cancel stops after the current document; the
 * previous document is re-opened; a read-only project disables the command.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene, WebGLRenderer } from 'three';

// The scene store is the seam: the command opens documents through it.
const sceneHolder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneHolder.store,
  initSceneStore: () => sceneHolder.store,
}));

import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  ensureThumbnailCommandsRegistered,
  regenerateThumbnailsEnabled,
  READ_ONLY_PROJECT,
  REGENERATE_THUMBNAILS_COMMAND,
  UNSAVED_WORK,
  unknownProject,
} from '../src/core/thumbnails/rv-thumbnail-regenerate-commands';
import {
  NOT_WRITTEN_REASON,
  UNSAVED_DRAFT_REASON,
  regenerateProjectThumbnails,
  type RegenerateResult,
} from '../src/core/thumbnails/rv-thumbnail-regenerate';
import { writeDocumentThumbnail } from '../src/core/thumbnails/rv-thumbnail-write';
import {
  _resetRegenerateProgressForTest,
  getRegenerateProgress,
  requestRegenerateCancel,
} from '../src/core/thumbnails/rv-thumbnail-regenerate-progress';
import { DEMO_PROJECT_ID } from '../src/core/project/backends/bundled-backend';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';

const PROJECT_ID = 'prj_fake_documents';
const HASHED = (id: string) => new RegExp(`^\\.thumbnails/${id}\\.[0-9a-f]{8}\\.webp$`);

function row(id: string, name: string): RvDocumentEntry {
  return { id, path: `models/${name}.glb`, name } as RvDocumentEntry;
}

let renderer: WebGLRenderer;
let project: FakeDocumentProject;
let registry: CommandRegistry;

/** A viewer the writer can render: one model root whose content the "open" swaps. */
interface FakeViewer {
  renderer: WebGLRenderer;
  scene: Scene;
  currentModelRoot: Group;
  whenSceneReady(): Promise<void>;
  modes: {
    activeMode: string | null;
    list(): { id: string }[];
    setMode(id: string): void;
    requestMode(id: string): Promise<boolean>;
  };
}
let viewer: FakeViewer;

function box(color: number, x = 0): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color }));
  m.position.x = x;
  return m;
}

/** What each document "contains" once opened. */
function contentOf(id: string): Group {
  const g = new Group();
  if (id === 'doc_part') g.add(box(0x30a060));
  if (id === 'doc_ref') {
    // A placed reference as the PlacementInstancer leaves it: the reference
    // node holding an identity-matrix baked chunk.
    const ref = new Group();
    ref.name = 'Gantry_1';
    ref.userData.realvirtual = { AssetReference: { url: 'library/gantry.glb' } };
    const chunk = box(0xc04030, 2);
    chunk.userData._rvBakeChunk = true;
    ref.add(chunk);
    g.add(ref);
  }
  return g;
}

/** The scene-store stand-in: a background open swaps the viewer's content. */
function makeSceneStore(opts: { onOpen?: (id: string) => void; dirtyFor?: Set<string> } = {}) {
  let open: string | null = 'doc_part';
  const calls: { id: string; background: boolean }[] = [];
  return {
    calls,
    current: () => open,
    async openDocument(id: string, o: { background?: boolean } = {}) {
      calls.push({ id, background: o.background === true });
      if (id === 'doc_bad') throw new Error('The file could not be read.');
      viewer.currentModelRoot.clear();
      viewer.currentModelRoot.add(contentOf(id));
      viewer.scene.updateMatrixWorld(true);
      open = id;
      opts.onOpen?.(id);
    },
    getSnapshot: () => ({ dirty: !!open && !!opts.dirtyFor?.has(open), transient: false, draft: null }),
    documentIdentity: () => (open ? { kind: 'document', documentId: open, name: open, path: '' } : null),
    async openBuiltin() {},
    async openEmpty() {},
  };
}

function rowOf(id: string): RvDocumentEntry | undefined {
  return project.documents().find(d => d.id === id);
}

async function run(): Promise<{ ok: boolean; value?: RegenerateResult; reason?: string; kind?: string }> {
  return registry.execute(REGENERATE_THUMBNAILS_COMMAND, { projectId: PROJECT_ID }, {
    origin: 'mcp', viewer: viewer as never,
  }) as never;
}

beforeEach(() => {
  localStorage.clear();
  resetProjectStore();
  _resetRegenerateProgressForTest();
  renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true });
  const scene = new Scene();
  const root = new Group();
  scene.add(root);
  viewer = {
    renderer,
    scene,
    currentModelRoot: root,
    whenSceneReady: async () => {},
    modes: {
      activeMode: 'hmi',
      list: () => [{ id: 'hmi' }, { id: 'editor' }],
      setMode(id) { this.activeMode = id; },
      async requestMode(id) { this.activeMode = id; return true; },
    },
  };
  project = installFakeDocumentProject({
    documents: [row('doc_part', 'Part'), row('doc_ref', 'Cell'), row('doc_bad', 'Bad')],
  });
  registry = new CommandRegistry();
  ensureThumbnailCommandsRegistered(registry);
});

afterEach(() => {
  vi.restoreAllMocks();
  sceneHolder.store = null;
  project.restore();
  resetProjectStore();
  _resetRegenerateProgressForTest();
  renderer.dispose();
});

describe('project.regenerateThumbnails — the run', () => {
  it('3 documents (own part, placed reference, one that fails): 2 written, 1 failure named, pointers set', async () => {
    const scene = makeSceneStore();
    sceneHolder.store = scene;

    const r = await run();
    expect(r.ok, r.reason).toBe(true);
    const result = r.value!;
    expect(result).toMatchObject({ projectId: PROJECT_ID, total: 3, processed: 3, written: 2, cancelled: false });
    expect(result.failed).toEqual([
      { documentId: 'doc_bad', name: 'Bad', reason: 'The file could not be read.' },
    ]);

    // The ONE writer pointed each row at its hashed sidecar, which exists.
    for (const id of ['doc_part', 'doc_ref']) {
      const pointer = rowOf(id)?.thumbnail;
      expect(pointer, id).toMatch(HASHED(id));
      expect(project.files.has(pointer!), id).toBe(true);
    }
    expect(rowOf('doc_bad')?.thumbnail).toBeUndefined();

    // Every document went through the open funnel as a BACKGROUND open, and the
    // previously open document came back at the end.
    expect(scene.calls.map(c => c.id)).toEqual(['doc_part', 'doc_ref', 'doc_bad', 'doc_part']);
    expect(scene.calls.every(c => c.background)).toBe(true);

    // The progress store the dialog reads says the same.
    expect(getRegenerateProgress()).toMatchObject({
      running: false, finished: true, total: 3, done: 3, written: 2, cancelled: false, error: null,
    });
    expect(getRegenerateProgress().failures.map(f => f.name)).toEqual(['Bad']);
  });

  it('the placed reference IS the picture: without its baked chunk the same document renders nothing', async () => {
    sceneHolder.store = makeSceneStore();
    await run();
    const withChunk = project.files.get(rowOf('doc_ref')!.thumbnail!)!;

    // Same document, the chunk stripped: the writer renders nothing (blank) →
    // the pointer is removed. The chunk alone made the picture.
    viewer.currentModelRoot.clear();
    const bare = new Group();
    bare.add(new Group());
    viewer.currentModelRoot.add(bare);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pointer = await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_ref',
    });
    expect(withChunk.byteLength).toBeGreaterThan(0);
    expect(pointer).toBeNull();
  });

  it('Cancel stops after the current document; written thumbnails stay', async () => {
    const scene = makeSceneStore({ onOpen: (id) => { if (id === 'doc_part') requestRegenerateCancel(); } });
    sceneHolder.store = scene;

    const r = await run();
    expect(r.ok, r.reason).toBe(true);
    expect(r.value).toMatchObject({ total: 3, processed: 1, written: 1, cancelled: true, failed: [] });
    expect(rowOf('doc_part')?.thumbnail).toMatch(HASHED('doc_part'));
    expect(rowOf('doc_ref')?.thumbnail).toBeUndefined();
    // doc_part rendered, then the restore re-opened it — doc_ref never opened.
    expect(scene.calls.map(c => c.id)).toEqual(['doc_part', 'doc_part']);
    expect(getRegenerateProgress()).toMatchObject({ finished: true, cancelled: true, done: 1, written: 1 });
  });

  it('a document that opens with a recovered draft is a failure and is not rendered', async () => {
    const writes = vi.fn(async () => '.thumbnails/x.webp');
    const result = await regenerateProjectThumbnails({
      documents: () => [row('doc_part', 'Part')],
      open: async () => {},
      showsUnsavedChanges: () => true,
      write: writes,
    }, { projectId: PROJECT_ID });
    expect(writes).not.toHaveBeenCalled();
    expect(result.failed).toEqual([{ documentId: 'doc_part', name: 'Part', reason: UNSAVED_DRAFT_REASON }]);
  });

  it('a writer that writes nothing is a failure; restore runs even when a document throws', async () => {
    const restore = vi.fn(async () => {});
    const result = await regenerateProjectThumbnails({
      documents: () => [row('a', 'A'), row('b', 'B')],
      open: async (d) => { if (d.id === 'b') throw new Error('boom'); },
      write: async () => null,
      restore,
    }, { projectId: PROJECT_ID });
    expect(result.written).toBe(0);
    expect(result.failed.map(f => f.reason)).toEqual([NOT_WRITTEN_REASON, 'boom']);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe('project.regenerateThumbnails — the rule', () => {
  it('a writable open project is enabled', () => {
    sceneHolder.store = makeSceneStore();
    expect(regenerateThumbnailsEnabled(viewer, { projectId: PROJECT_ID })).toBe(true);
    expect(registry.enabled(REGENERATE_THUMBNAILS_COMMAND, { projectId: PROJECT_ID }, viewer as never)).toBe(true);
  });

  it('a read-only project is refused — tooltip and tool answer are the same reason, nothing runs', async () => {
    sceneHolder.store = makeSceneStore();
    (project.backend as { writable: boolean }).writable = false;
    expect(registry.enabled(REGENERATE_THUMBNAILS_COMMAND, { projectId: PROJECT_ID }, viewer as never))
      .toEqual({ reason: READ_ONLY_PROJECT });
    const r = await run();
    expect(r).toMatchObject({ ok: false, kind: 'disabled', reason: READ_ONLY_PROJECT });
    expect(getRegenerateProgress().running).toBe(false);
    expect(getRegenerateProgress().finished).toBe(false);
    expect(project.writes).toEqual([]);
  });

  it('the bundled demo is read-only; an unknown id is named; unsaved work refuses', () => {
    sceneHolder.store = makeSceneStore();
    expect(regenerateThumbnailsEnabled(viewer, { projectId: DEMO_PROJECT_ID })).toEqual({ reason: READ_ONLY_PROJECT });
    expect(regenerateThumbnailsEnabled(viewer, { projectId: 'prj_nope' })).toEqual({ reason: unknownProject('prj_nope') });
    vi.spyOn(getProjectStore(), 'hasUnsavedWork').mockReturnValue(true);
    expect(regenerateThumbnailsEnabled(viewer, { projectId: PROJECT_ID })).toEqual({ reason: UNSAVED_WORK });
  });
});

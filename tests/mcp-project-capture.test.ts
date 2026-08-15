// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.6.2 / §9.9 — the MCP tools write into the PROJECT, not a work folder.
 *
 * Removing the work folder would otherwise take two capabilities away from an
 * AI agent without replacing them: "keep this screenshot" and "import that
 * file". Both now go through the project backend, and both must FAIL LOUDLY
 * with no project open rather than write somewhere the user cannot find — the
 * quiet second store is the thing this plan removes.
 *
 * Tested at the level of the two seams the tools call (`saveCanvasToProject`,
 * `_readProjectFile`) rather than through the MCP dispatcher: the routing is
 * what changed, and a dispatcher round-trip would only add a canvas and a
 * viewer to the fixture without adding an assertion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveCanvasToProject, CAPTURES_FOLDER } from '../src/plugins/mcp-bridge/rv-frame-capture';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { getProjectStore } from '../src/core/project/project-store';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

interface Recorder { writes: { path: string; blob: Blob }[] }

function fakeBackend(opts: { writable?: boolean; files?: Record<string, string> } = {}) {
  const rec: Recorder = { writes: [] };
  const files = opts.files ?? {};
  const backend = {
    kind: 'browser', id: 'test', writable: opts.writable !== false, isActive: true,
    writeBlob: async (path: string, blob: Blob) => { rec.writes.push({ path, blob }); },
    readBlobBytes: async (path: string) =>
      path in files ? (new TextEncoder().encode(files[path]).buffer as ArrayBuffer) : null,
  } as unknown as ProjectBackend;
  return { backend, rec };
}

function setBackend(backend: ProjectBackend | null): void {
  (getProjectStore() as unknown as { _backend: ProjectBackend | null })._backend = backend;
}

/** A canvas whose `toBlob` always succeeds — the encoder is not under test. */
function canvasStub(): HTMLCanvasElement {
  return {
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
  } as unknown as HTMLCanvasElement;
}

describe('web_render / web_screenshot_annotated savePath', () => {
  afterEach(() => setBackend(null));

  it('writes a bare name into the project captures folder', async () => {
    const { backend, rec } = fakeBackend();
    setBackend(backend);

    const out = await saveCanvasToProject(canvasStub(), 'overview');

    expect(out).toEqual({ savedPath: `${CAPTURES_FOLDER}/overview.png` });
    expect(rec.writes.map(w => w.path)).toEqual([`${CAPTURES_FOLDER}/overview.png`]);
  });

  it('keeps a path that names its own folders', async () => {
    const { backend, rec } = fakeBackend();
    setBackend(backend);

    const out = await saveCanvasToProject(canvasStub(), 'knowledge/Belt/views/axis-z.png');

    expect(out).toEqual({ savedPath: 'knowledge/Belt/views/axis-z.png' });
    expect(rec.writes).toHaveLength(1);
  });

  it('refuses without a writable project instead of writing elsewhere', async () => {
    setBackend(null);
    expect(await saveCanvasToProject(canvasStub(), 'x.png'))
      .toEqual({ saveError: expect.stringMatching(/No writable project is open/) as unknown as string });

    const { backend, rec } = fakeBackend({ writable: false });
    setBackend(backend);
    expect(await saveCanvasToProject(canvasStub(), 'x.png'))
      .toEqual({ saveError: expect.stringMatching(/No writable project is open/) as unknown as string });
    expect(rec.writes).toEqual([]);
  });

  it('refuses a path that tries to climb out of the project', async () => {
    const { backend, rec } = fakeBackend();
    setBackend(backend);
    expect(await saveCanvasToProject(canvasStub(), '../../etc/x.png'))
      .toEqual({ saveError: expect.stringMatching(/\.\./) as unknown as string });
    expect(rec.writes).toEqual([]);
  });
});

describe('web_editor_import_glb source file', () => {
  let tools: McpEditorTools;
  /** The private reader both import tools share. */
  let read: (relPath: string) => Promise<{ bytes: ArrayBuffer; name: string } | { error: string }>;

  beforeEach(() => {
    tools = new McpEditorTools(() => undefined);
    read = (relPath) => (tools as unknown as {
      _readProjectFile: (p: string) => Promise<{ bytes: ArrayBuffer; name: string } | { error: string }>;
    })._readProjectFile(relPath);
  });

  afterEach(() => setBackend(null));

  it('reads a project-relative path', async () => {
    const { backend } = fakeBackend({ files: { 'library/imports/part.glb': 'GLB' } });
    setBackend(backend);

    const out = await read('library/imports/part.glb');

    expect('error' in out).toBe(false);
    if ('error' in out) throw new Error('unreachable');
    expect(out.name).toBe('part.glb');
    expect(new TextDecoder().decode(out.bytes)).toBe('GLB');
  });

  it('names the project in its not-found error, not a work folder', async () => {
    const { backend } = fakeBackend();
    setBackend(backend);
    const out = await read('library/imports/gone.glb');
    expect('error' in out && out.error).toMatch(/not found in the open project/);
  });

  it('says no project is open rather than asking for a folder', async () => {
    setBackend(null);
    const out = await read('library/imports/part.glb');
    expect('error' in out && out.error).toMatch(/No project is open/);
  });
});

describe('web_editor_project_info', () => {
  afterEach(() => {
    setBackend(null);
    vi.restoreAllMocks();
  });

  it('reports the project rather than a work folder name', async () => {
    const { backend } = fakeBackend();
    setBackend(backend);
    const store = getProjectStore() as unknown as { _project: unknown };
    const previous = store._project;
    store._project = { id: 'prj_x', name: 'Line 2' };

    const { setActiveAssetContext, libraryDocumentBase } = await import('../src/core/editor/active-asset-store');
    const viewer = { modes: { activeMode: 'editor' } };
    setActiveAssetContext({
      viewer,
      doc: {
        getSnapshot: () => ({
          name: 'Belt / Drive', base: libraryDocumentBase('Custom/Belt.glb'),
          dirty: false, opCount: 3,
        }),
      },
    } as never);

    try {
      const tools = new McpEditorTools(() => viewer as never);
      const info = JSON.parse(await tools.webEditorProjectInfo()) as Record<string, unknown>;

      expect(info.projectOpen).toBe(true);
      expect(info.projectName).toBe('Line 2');
      expect(info.writable).toBe(true);
      expect(info.capturesRelPath).toBe('captures');
      expect(info.assetRelPath).toBe('library/Custom/Belt.glb');
      // Slashes in the asset name must not become folders in the knowledge path.
      expect(info.knowledgeRelPath).toBe('knowledge/Belt _ Drive');
      expect(info).not.toHaveProperty('workFolderName');
    } finally {
      setActiveAssetContext(null);
      store._project = previous;
    }
  });
});

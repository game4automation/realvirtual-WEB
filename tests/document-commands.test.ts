// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { resetProjectStore } from '../src/core/project/project-store';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';
import { AUTOMAP_CATEGORIES, summariseReport, type AutoMapReport } from '../src/core/import/rv-plc-automap';

// The project backend is real enough to exercise tree moves and manifest writes.
// Only the viewer open seam and external CONNECT / USD provider are doubles.
const h = vi.hoisted(() => ({
  sceneAvailable: true,
  connected: true,
  view: null as unknown,
  create: vi.fn(), open: vi.fn(), adopt: vi.fn(), commit: vi.fn(),
  check: vi.fn(), apply: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => h.sceneAvailable ? {
    createEmpty: h.create, openDocument: h.open, adoptDocumentRename: h.adopt,
  } : null,
}));
vi.mock('../src/core/editor/active-document-view', async (original) => ({
  ...await original<typeof import('../src/core/editor/active-document-view')>(),
  resolveActiveDocumentView: () => h.view,
}));
vi.mock('../src/core/hmi/connect-store', async (original) => ({
  ...await original<typeof import('../src/core/hmi/connect-store')>(),
  getConnectSnapshot: () => ({
    state: h.connected ? 'connected' : 'disconnected',
    interfaces: [{ id: 'plc', type: 'S7' }],
  }),
  fetchInterfaces: h.fetch, checkAutoMap: h.check, applyAutoMap: h.apply,
}));

const viewer = { registry: { getAll: () => [] } } as never;
const tools = new McpCommandTools(() => viewer);
let fixture: FakeDocumentProject;
let report: AutoMapReport;

async function exec(command: string, args: Record<string, unknown> = {}) {
  const result = JSON.parse(await tools.webExecute(command, JSON.stringify(args)));
  return result.value ?? { error: result.error };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectStore();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  fixture = installFakeDocumentProject({ documents: [
    { id: 'part', name: 'Part', path: 'Part.glb' },
    { id: 'other', name: 'Other', path: 'parts/Other.glb' },
  ] });
  fixture.backend.statDocuments = async () => [...fixture.files].map(([path, bytes]) => ({ path, size: bytes.length, mtime: 1 }));
  h.sceneAvailable = true;
  h.connected = true;
  h.create.mockResolvedValue('part');
  h.open.mockResolvedValue(undefined);
  h.view = { actions: { exports: [{ id: 'usd', apply: { commit: h.commit } }] } };
  h.commit.mockResolvedValue({ committed: true, documentId: 'part' });
  report = {
    protocol: 'S7', interfaceId: 'plc',
    counts: { total: 0, toApply: 0, ...Object.fromEntries(AUTOMAP_CATEGORIES.map(c => [c, 0])) } as AutoMapReport['counts'],
    categories: Object.fromEntries(AUTOMAP_CATEGORIES.map(c => [c, []])) as unknown as AutoMapReport['categories'],
    hints: [], dataBlockFilter: [],
  };
  h.check.mockResolvedValue(report);
  h.apply.mockResolvedValue(report);
});
afterEach(() => { fixture.restore(); resetProjectStore(); });

describe('document commands (plan-2007 Phase 2B)', () => {
  it('create retains defaults, folder normalization, open and the stored result', async () => {
    expect(await exec('document.create')).toEqual({ ok: true, documentId: 'part', path: 'Part.glb', name: 'Part' });
    expect(h.create).toHaveBeenLastCalledWith('Untitled', undefined);
    expect(h.open).toHaveBeenCalledWith('part');
    await exec('document.create', { name: ' Named ', folder: '/parts/' });
    expect(h.create).toHaveBeenLastCalledWith('Named', 'parts');
  });

  it('rename preserves identity and reports the tree edit result', async () => {
    expect(await exec('document.rename', { relPath: 'Part.glb', newName: 'Named' })).toMatchObject({
      renamed: true, from: 'Part.glb', relPath: 'Named.glb', documentId: 'part',
      note: 'The document id is unchanged — references keep resolving.',
    });
    expect(fixture.documents()).toContainEqual(expect.objectContaining({ id: 'part', path: 'Named.glb' }));
    expect(fixture.files.has('Part.glb')).toBe(false);
    expect(fixture.files.has('Named.glb')).toBe(true);
    expect(h.adopt).toHaveBeenCalledOnce();
  });

  it('move accepts the same destination-folder argument and preserves identity', async () => {
    expect(await exec('document.move', { relPath: 'Part.glb', toFolder: 'parts' })).toMatchObject({
      moved: true, from: 'Part.glb', relPath: 'parts/Part.glb', documentId: 'part',
    });
    expect(fixture.files.has('parts/Part.glb')).toBe(true);
    expect(fixture.documents()).toContainEqual(expect.objectContaining({ id: 'part', path: 'parts/Part.glb' }));
  });

  it('delete remains destructive and retires the document through the existing trash path', async () => {
    h.sceneAvailable = false;
    expect(commandRegistry.get('document.delete')).toMatchObject({ readOnly: false, destructive: true });
    expect(await exec('document.delete', { relPath: 'Part.glb' })).toEqual({
      deleted: true, relPath: 'Part.glb', documentId: 'part',
      recoverable: 'Bytes were moved to .trash/, not erased.',
    });
    expect(fixture.documents().some(d => d.id === 'part')).toBe(false);
    expect(fixture.files.has('Part.glb')).toBe(false);
    expect([...fixture.files.keys()].some(p => p.startsWith('.trash/'))).toBe(true);
  });

  // document.bind write/read-back is covered through web_execute in tests/rv-mcp-document-bind.test.ts
  // (its fixture models the project store write; this file's fixture does not).

  it('USD commit keeps its timeout, token normalization, confirmations and provider result', async () => {
    const desc = commandRegistry.get('document.usdExtrasCommit')!;
    expect(desc.timeoutMs).toBe(180_000);
    // Run through the registry directly here: web_execute deliberately starts a job at 180 s.
    commandRegistry.attachViewer(viewer);
    const result = await commandRegistry.execute('document.usdExtrasCommit', {
      previewToken: ' token ', acceptExtrasLoss: true, confirmExtrasLost: true,
    }, { origin: 'mcp', viewer });
    expect(result).toMatchObject({ ok: true, value: { committed: true, documentId: 'part' } });
    expect(h.commit).toHaveBeenCalledWith('token', { acceptExtrasLoss: true, confirmExtrasLost: true });
  });

  it('retains early refusal sentences and branch validation', async () => {
    expect(await exec('document.rename', { relPath: 'Part.glb' })).toEqual({ error: 'action=rename needs newName.' });
    expect(await exec('document.move', { relPath: 'Part.glb' })).toEqual({ error: 'action=move needs toFolder ("" = project root).' });
    h.sceneAvailable = false;
    expect(await exec('document.create')).toEqual({ error: 'Scene store not available' });
    fixture.restore();
    for (const id of ['document.delete', 'document.rename', 'document.move', 'document.bind']) {
      expect(await exec(id, { relPath: 'Part.glb' })).toEqual({ error: 'No project is open — open one with web_project_open.' });
    }
  });

  it('refuses read-only projects before resolving an invalid document or field', async () => {
    Object.defineProperty(fixture.backend, 'writable', { value: false });
    expect(await exec('document.bind', { document: 'missing', field: 'invalid' })).toEqual({
      error: 'This project is read-only — its bindings cannot be changed.',
    });
    for (const id of ['document.delete', 'document.rename', 'document.move']) {
      expect(await exec(id, { relPath: 'missing.glb' })).toEqual({
        error: 'This project is read-only — its documents cannot be changed.',
      });
    }
    expect(fixture.writes).toEqual([]);
  });

  it('USD preconditions and provider failures retain their messages and details', async () => {
    h.view = null;
    const options = { origin: 'mcp' as const, viewer };
    expect(await commandRegistry.execute('document.usdExtrasCommit', { previewToken: 'token' }, options))
      .toMatchObject({ ok: false, reason: 'No document is open.' });
    h.view = { actions: { exports: [{ id: 'usd', apply: { commit: h.commit } }] } };
    h.commit.mockRejectedValue(Object.assign(new Error('Local changes'), { code: 'local-changes', file: 'Part.glb' }));
    expect(await commandRegistry.execute('document.usdExtrasCommit', { previewToken: 'token' }, options))
      .toMatchObject({ ok: true, value: { error: 'Local changes', code: 'local-changes', file: 'Part.glb' } });
  });

  it('does not record any of these project / CONNECT operations as asset macros', () => {
    for (const id of ['document.create', 'document.delete', 'document.rename', 'document.move', 'document.bind', 'document.usdExtrasCommit', 'signal.automapApply', 'signal.automapCheck']) {
      expect(commandRegistry.get(id)?.macro, id).not.toBe(true);
    }
  });
});

describe('signal auto-map commands', () => {
  it('check returns the old summary, is read-only, and never applies', async () => {
    expect(commandRegistry.get('signal.automapCheck')?.readOnly).toBe(true);
    expect(await exec('signal.automapCheck')).toEqual({ mode: 'check', ...summariseReport(report, 100) });
    expect(h.check).toHaveBeenCalledWith('plc', []);
    expect(h.apply).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
    const refused = await exec('signal.automapCheck', { mode: 'apply' });
    expect(refused.error).toContain('use check');
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('apply returns the old apply summary and uses the explicit interface', async () => {
    expect(await exec('signal.automapApply', { interfaceId: ' plc ', mode: ' APPLY ' })).toEqual({ mode: 'apply', ...summariseReport(report, 100) });
    expect(h.apply).toHaveBeenCalledWith('plc', []);
    expect(h.check).not.toHaveBeenCalled();
  });

  it('CONNECT refusal is unchanged and performs no request', async () => {
    h.connected = false;
    expect(await exec('signal.automapCheck')).toEqual({ error: 'Not connected to a CONNECT gateway — connect in the CONNECT panel first.' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('web_query admits check and refuses apply before touching CONNECT', async () => {
    expect(JSON.parse(await tools.webQuery('signal.automapApply', '{}'))).toMatchObject({ kind: 'not-read-only' });
    expect(h.apply).not.toHaveBeenCalled();
    expect(JSON.parse(await tools.webQuery('signal.automapCheck', '{}'))).toMatchObject({
      value: { mode: 'check', ...summariseReport(report, 100) },
    });
  });
});

it.each([
  ['web_document_new', ['document.create']],
  ['web_document_update', ['document.delete', 'document.rename', 'document.move']],
  ['web_document_bind', ['document.bind']],
  ['web_import_usd_extras_commit', ['document.usdExtrasCommit']],
  ['web_signal_automap', ['signal.automapApply', 'signal.automapCheck']],
] as const)('%s is replaced by registered commands', (name, ids) => {
  for (const id of ids) expect(commandRegistry.get(id), id).toBeDefined();
});

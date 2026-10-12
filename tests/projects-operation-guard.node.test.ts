// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the host's actual callbacks without booting its viewer/private plugins.
// Keeping their composition intact catches nested runVerb calls that unit tests
// of the individual folder/open helpers cannot see.
const source = ts.createSourceFile('host.tsx', readFileSync(new URL(
  '../src/core/hmi/projects/ProjectsDashboardHost.tsx', import.meta.url), 'utf8'),
ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set([
  'runVerb', 'openProject', 'handleOpenProject', 'addProjectFolder', 'handleAdd',
  'handleAddPick', 'handleLocate',
]);
const declarations: string[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(source))) {
    declarations.push(`const ${node.getText(source)};`);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const executable = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function setup() {
  const dir = { name: 'Plant' };
  const manifest = { id: 'plant', name: 'Plant' };
  const operationRef = { current: false };
  const store = {
    openProjectFolder: vi.fn(async () => true),
    getProject: () => manifest,
  };
  const deps = {
    useCallback: (fn: unknown) => fn,
    operationRef, store, busy: false,
    setSuccessMessage: vi.fn(), setMessage: vi.fn(), setOperationLabel: vi.fn(), setBusy: vi.fn(),
    project: { project: null, backendKind: null }, linked: [manifest],
    setProjectsView: vi.fn(), setRowState: vi.fn(), refreshLinked: vi.fn(async () => {}),
    DEMO_PROJECT_ID: 'demo',
    resolveLinkedOpen: vi.fn(),
    openProjectById: vi.fn(async () => 'opened'),
    pickFolder: vi.fn(async () => dir),
    getAddJobSnapshot: () => ({ status: 'idle' }),
    verdictForAdd: vi.fn(async () => ({ kind: 'project', manifest, probe: {} })),
    probeAddTarget: vi.fn(async () => ({ hasManifest: true })),
    readManifest: vi.fn(async () => ({ project: manifest })),
    relinkProject: vi.fn(async () => {}), unlinkProject: vi.fn(async () => {}),
    forgetProjectTraces: vi.fn(async () => {}),
    window: { confirm: () => true },
  };
  const callbacks = new Function(...Object.keys(deps), `${executable}\n
    return { handleAddPick, handleAdd, handleLocate, handleOpenProject };`)(...Object.values(deps));
  return { ...deps, ...callbacks, dir };
}

describe('dashboard project operation guard', () => {
  it('a project click browses the project and never arms a document resume (2026-09-25)', async () => {
    // The host used to arm `pendingResumeRef` on every project open and an
    // effect then resolved a document (URL, remembered pair, activeSceneId,
    // defaultModel) and opened it — closing the dashboard the user had just
    // clicked into. Neither the ref nor the resolver may return to this file:
    // resuming into a document is the boot's job (`main.ts`).
    const text = source.getFullText();
    expect(text).not.toMatch(/pendingResumeRef/);
    expect(text).not.toMatch(/resolveResumeTarget\(/);
    expect(text).not.toMatch(/findStartDocument\(/);
    const h = setup();
    h.handleOpenProject('plant');
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.openProjectById).toHaveBeenCalledOnce();
    expect(h.setProjectsView).toHaveBeenCalledWith('project');
  });

  it('adds the picked project and holds the guard until opening finishes', async () => {
    const h = setup();
    let finish!: (value: boolean) => void;
    h.store.openProjectFolder.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.handleAddPick();
    await vi.waitFor(() => expect(h.store.openProjectFolder).toHaveBeenCalledWith(h.dir));
    expect(h.operationRef.current).toBe(true);
    h.handleAddPick();
    expect(h.pickFolder).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.setProjectsView).toHaveBeenCalledWith('project');
  });

  it('reopens the existing project after locating its folder', async () => {
    const h = setup();
    h.handleLocate('plant');
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.relinkProject).toHaveBeenCalledWith('plant', h.dir);
    expect(h.openProjectById).toHaveBeenCalledOnce();
    expect(h.setProjectsView).toHaveBeenCalledWith('project');
  });

  it('adds a replacement folder after Locate resolves a different project', async () => {
    const h = setup();
    h.handleLocate('old-plant');
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.unlinkProject).toHaveBeenCalledWith('old-plant');
    // The replaced entry's recents and model-index snapshot go with it (plan-509 F7).
    expect(h.forgetProjectTraces).toHaveBeenCalledWith('old-plant');
    expect(h.store.openProjectFolder).toHaveBeenCalledWith(h.dir);
  });

  it('still opens an existing project directly', async () => {
    const h = setup();
    h.handleOpenProject('plant');
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.openProjectById).toHaveBeenCalledOnce();
  });

  it('releases the guard and reports an open failure so Add can be retried', async () => {
    const h = setup();
    h.store.openProjectFolder.mockRejectedValueOnce(new Error('Folder unavailable'));
    h.handleAddPick();
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.setMessage).toHaveBeenCalledWith('Folder unavailable');
    h.handleAddPick();
    await vi.waitFor(() => expect(h.operationRef.current).toBe(false));
    expect(h.store.openProjectFolder).toHaveBeenCalledTimes(2);
    expect(h.setProjectsView).toHaveBeenCalledWith('project');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVSource } from '../src/core/engine/rv-source';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { McpCommandTools, setCommandStepHooks, setGatewayCommandClassesState } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { macroBookOf, macroRecorder, type RvMacroCommandStep } from '../src/plugins/mcp-bridge/rv-mcp-macro';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';

const type = 'CommandFieldsTest';
const path = 'Asset/Part';

function fixture() {
  const scene = new Scene();
  const root = new Group(); root.name = 'Asset'; scene.add(root);
  const node = new Object3D(); node.name = 'Part'; root.add(node);
  node.userData.realvirtual = { [type]: { Speed: 10, Enabled: false, Reference: null, Forward: null } };
  const registry = new NodeRegistry();
  root.traverse(n => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const overlay = new RvExtrasEditorPlugin();
  const viewer = {
    scene, registry, currentModelRoot: root, signalStore: null, transportManager: null,
    modes: { activeMode: 'editor' },
    getPlugin: (id: string) => id === 'rv-extras-editor' ? overlay : undefined,
    selectionManager: { getSnapshot: () => ({ selectedPaths: [] }), selectPaths() {}, clear() {} },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on: () => () => {},
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;
  // Use the real overlay writer without mounting its UI/event subscriptions.
  (overlay as unknown as { _viewer: RVViewer })._viewer = viewer;
  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });
  const tools = new McpCommandTools(() => viewer);
  const exec = async (fields: Record<string, unknown>) => JSON.parse(await tools.webExecute(
    'component.setFields', JSON.stringify({ path, type, props: JSON.stringify(fields) }),
  ));
  return { viewer, node, overlay, doc, exec };
}

let env: ReturnType<typeof fixture>;
beforeEach(async () => {
  await __clearDraftStoresForTests();
  registerComponentSchema(type, {
    Speed: { type: 'number', min: 0 }, Enabled: { type: 'boolean' },
    Reference: { type: 'componentRef' }, Forward: { type: 'componentRef', signal: 'PLCOutputBool' },
    Readonly: { type: 'number', readonly: true }, Direction: { type: 'enum', enumMap: { LinearX: 0, LinearY: 1 } },
  });
  ensureComponentCommandsRegistered();
  ensureQueryCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  ensureEditorCommandsRegistered();
  setCommandStepHooks(null);
  setGatewayCommandClassesState('none');
  env = fixture();
});
afterEach(() => {
  macroRecorder._resetForTest();
  setActiveAssetContext(null);
  env.doc.dispose();
  vi.restoreAllMocks();
});

describe('component.setFields through web_execute', () => {
  it('groups editor fields into one Set fields undo step, with joint undo and redo', async () => {
    const before = env.doc.getSnapshot().opCount;
    const result = await env.exec({ Speed: 500, Enabled: true });
    expect(result).toMatchObject({ status: 'ok', value: { path, type, applied: { Speed: 500, Enabled: true }, rejected: [] } });
    expect(env.doc.getSnapshot().opCount).toBe(before + 1);
    expect(env.doc.opsSince(before)[0]).toMatchObject({ kind: 'composite', label: 'Set fields' });
    expect(env.node.userData.realvirtual[type]).toMatchObject({ Speed: 500, Enabled: true });
    await env.doc.undo();
    expect(env.node.userData.realvirtual[type]).toMatchObject({ Speed: 10, Enabled: false });
    await env.doc.redo();
    expect(env.node.userData.realvirtual[type]).toMatchObject({ Speed: 500, Enabled: true });
  });

  it('records exactly one macro command with explicit arguments', async () => {
    const doc = env.doc.document;
    const book = macroBookOf(doc);
    macroRecorder.start(doc, book, 'fields', { name: 'Asset' });
    const result = await env.exec({ Speed: 50, Enabled: true });
    expect(result.recorded).toBe(true);
    const steps = book.macros.get('fields')!.steps as RvMacroCommandStep[];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ command: 'component.setFields', args: { path, type, props: '{"Speed":50,"Enabled":true}' } });
  });

  it.each(['hmi', 'planner'])('writes the inspector overlay in %s mode', async mode => {
    (env.viewer.modes as unknown as { activeMode: string }).activeMode = mode;
    const write = vi.spyOn(env.overlay, 'updateOverlayField');
    const result = await env.exec({ Speed: 25, Enabled: true });
    expect(result.value.applied).toEqual({ Speed: 25, Enabled: true });
    expect(write).toHaveBeenCalledWith(path, type, 'Speed', 25);
    expect(env.overlay.getSnapshot().overlay?.nodes[path]?.[type]).toMatchObject({ Speed: 25, Enabled: true });
  });

  it('accepts the existing Drive and Source guide examples', async () => {
    registerComponentSchema('Drive', RVDrive.schema);
    registerComponentSchema('Source', RVSource.schema);
    (env.viewer.modes as unknown as { activeMode: string }).activeMode = 'hmi';
    env.node.userData.realvirtual.Drive = { TargetSpeed: 10, Direction: 'LinearX' };
    env.node.userData.realvirtual.Source = { LimitNumber: false, MaxNumberMUs: 0 };
    const tools = new McpCommandTools(() => env.viewer);
    for (const [componentType, fields] of [
      ['Drive', { TargetSpeed: 500 }],
      ['Source', { LimitNumber: true, MaxNumberMUs: 1 }],
    ] as const) {
      const result = JSON.parse(await tools.webExecute('component.setFields', JSON.stringify({ path, type: componentType, props: JSON.stringify(fields) })));
      expect(result.value).toMatchObject({ applied: fields, rejected: [] });
    }
  });

  it('resolves the new editor command defaults without changing the document', async () => {
    const captured = commandRegistry.captureContext(env.viewer);
    const before = env.doc.getSnapshot().opCount;
    expect(await commandRegistry.prepare('editor.kinematize', captured, { paths: path, groupName: ' Axis ' }, env.viewer))
      .toMatchObject({ ok: true, resolved: true, args: { paths: path, groupName: 'Axis', direction: 'LinearX', centerPivot: true } });
    expect(await commandRegistry.prepare('editor.importGlb', captured, { relPath: ' /imports/part.glb ' }, env.viewer))
      .toMatchObject({ ok: true, resolved: true, args: { relPath: 'imports/part.glb' } });
    expect(await commandRegistry.prepare('editor.importCad', captured, { relPath: ' /imports/part.step ', quality: '' }, env.viewer))
      .toMatchObject({ ok: true, resolved: true, args: { relPath: 'imports/part.step', quality: 'standard' } });
    expect(env.doc.getSnapshot().opCount).toBe(before);
  });

  it.each(['editor', 'hmi', 'planner'])('applies valid fields and explains every invalid field in %s', async mode => {
    (env.viewer.modes as unknown as { activeMode: string }).activeMode = mode;
    const result = await env.exec({ Speed: 30, Enabled: 'yes', Bogus: 1, Readonly: 2, Direction: 'diagonal' });
    expect(result.value.applied).toEqual({ Speed: 30 });
    expect(result.value.rejected).toEqual(['Enabled', 'Bogus', 'Readonly', 'Direction'].map(field => ({ field, reason: expect.any(String) })));
    expect(env.node.userData.realvirtual[type]).toMatchObject({ Speed: 30, Enabled: false });
    expect(env.node.userData.realvirtual[type].Bogus).toBeUndefined();
  });

  it.each(['editor', 'hmi'])('accepts ComponentReference objects and signal slots, rejects plain paths in %s', async mode => {
    (env.viewer.modes as unknown as { activeMode: string }).activeMode = mode;
    const reference = { type: 'ComponentReference', path: 'Missing/Target', componentType: 'Drive' };
    const signal = { type: 'ComponentReference', path: 'Missing/Signal', componentType: 'PLCOutputBool' };
    const accepted = await env.exec({ Reference: reference, Forward: signal });
    expect(accepted.value).toMatchObject({ applied: { Reference: reference, Forward: signal }, rejected: [] });
    const refused = await env.exec({ Reference: 'Missing/Target', Forward: 'Missing/Signal' });
    expect(refused.value.applied).toEqual({});
    expect(refused.value.rejected).toEqual([
      { field: 'Reference', reason: expect.stringContaining('ComponentReference object') },
      { field: 'Forward', reason: expect.stringContaining('ComponentReference object') },
    ]);
  });
});

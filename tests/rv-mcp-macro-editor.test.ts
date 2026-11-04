// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.0 (alias parity) + §9.1 / §9.4 / §9.5 on the REAL bridge path:
 * `McpBridgePlugin._handleMessage` → `_handleCall` → tool → `runCommandStep` →
 * registry → (private) editor command → AssetDocument.
 *
 * Private edition: `web_editor_set_field` and `web_execute('editor.setField')`
 * write the same op; a recording through `_handleCall` strips the meta
 * arguments before the bound tool and stores them as the note; a selection
 * fallback is stored resolved; the macro reaches the exported GLB; a replay job
 * restores the recorded state after undo, regardless of the selection.
 *
 * Community edition (`VITE_PUBLIC_BUILD=1`, stubs): the same calls answer
 * `requires-commercial`, and a replayed editor line is reported as
 * `requires-commercial` instead of failing.
 */

import { bridgeExecuteValue } from './helpers/execute-value';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { defaultSceneExtras, parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { _resetButtonSimStateForTest } from '../src/core/hmi/button-sim-state';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  macroBookOf,
  macroJobs,
  macroRecorder,
  macrosForEmbed,
  RV_MACROS_KEY,
  type RvMacroCommandStep,
} from '../src/plugins/mcp-bridge/rv-mcp-macro';

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  root: Group;
  box: Object3D;
  call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  callError: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  select: (paths: string[]) => void;
}

function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const box = new Object3D();
  box.name = 'Box';
  (box.userData as Record<string, unknown>)['realvirtual'] = { Drive: { TargetSpeed: 100, Direction: 'LinearX' } };
  root.add(box);
  const other = new Object3D();
  other.name = 'Other';
  root.add(other);
  box.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
  scene.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  let selectedPaths: string[] = [];
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  const viewer = {
    scene, registry, camera, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    modes: { activeMode: 'editor', has: () => true, setMode() {}, list: () => [{ id: 'editor' }], subscribe: () => () => {} },
    selectionManager: {
      select(p: string) { selectedPaths = [p]; }, clear() { selectedPaths = []; },
      selectPaths(p: string[]) { selectedPaths = [...p]; },
      getSnapshot: () => ({ selectedPaths, primaryPath: selectedPaths[0] ?? null }),
    },
    leftPanelManager: { isOpen: () => true, open() {} },
    highlighter: { flash() {} },
    fitToNodes() {}, getPlugin: () => undefined, use() {},
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });

  const plugin = new McpBridgePlugin();
  // plan-668: the test transport stands for a tab with AI control on.
  (plugin as unknown as { _aiEnabled: boolean })._aiEnabled = true;
  (plugin as unknown as { viewer: RVViewer }).viewer = viewer;
  (plugin as unknown as { _dispatcher: ReturnType<typeof buildMultiDispatcher> })._dispatcher =
    buildMultiDispatcher(plugin.mcpToolInstances);
  const sent: string[] = [];
  (plugin as unknown as { _ws: unknown })._ws = {
    readyState: 1, send: (d: string) => { sent.push(d); }, close: vi.fn(), onclose: null, onerror: null, onmessage: null,
  };
  const handleMessage = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })._handleMessage.bind(plugin);
  let id = 0;
  const callFrame = async (tool: string, args: Record<string, unknown>) => {
    const n = sent.length;
    await handleMessage(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
    return JSON.parse(sent[n]);
  };
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const frame = await callFrame(tool, args);
    expect(frame.error, `transport error: ${frame.error}`).toBeUndefined();
    return JSON.parse(frame.result);
  };
  const callError = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const frame = await callFrame(tool, args);
    expect(frame.result).toBeUndefined();
    expect(frame.error).toBeTypeOf('string');
    return JSON.parse(frame.error);
  };
  return { viewer, doc, root, box, call, callError, select: (p) => { selectedPaths = [...p]; } };
}

const speedOf = (env: Env): unknown => ((env.box.userData as Record<string, Record<string, Record<string, unknown>>>)['realvirtual']['Drive'])['TargetSpeed'];

async function waitJob(env: Env, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const s = await env.call('web_macro_status', { jobId });
    if (s['state'] !== 'running') return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

let env: Env;

beforeEach(async () => {
  await __clearDraftStoresForTests();
  _resetButtonSimStateForTest();
  env = makeEnv();
});

afterEach(() => {
  macroRecorder._resetForTest();
  macroJobs._resetForTest();
  setActiveAssetContext(null);
  env.doc.dispose();
  _resetButtonSimStateForTest();
});

const SET = { path: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '250' };

describe.runIf(__RV_HAS_PRIVATE__)('plan-641 — editor commands through the bridge (private)', () => {
  it('the old alias answers MOVED without writing; web_execute writes the field', async () => {
    const count = env.doc.document.ops.length;
    expect(await env.callError('web_editor_set_field', SET)).toMatchObject({ error: 'MOVED', movedTo: ['editor.setField'] });
    expect(env.doc.document.ops.length).toBe(count);
    expect(speedOf(env)).toBe(100);
    expect(await env.call('web_execute', { command: 'editor.setField', args: JSON.stringify(SET) })).toMatchObject({ ok: true, status: 'ok' });
    expect(speedOf(env)).toBe(250);
  });

  it('§9.1 record via _handleCall: meta split off a bound tool, selection stored resolved; save embeds; replay restores', async () => {
    expect(await env.call('web_macro_record_start', { name: 'round-1' })).toMatchObject({ recording: 'round-1' });
    const r1 = await bridgeExecuteValue(env.call, 'editor.setField', { ...SET, _reason: 'DFM-6-5 has 5 mm stroke', _source: 'parts:DFM-6-5' });
    expect(r1).toMatchObject({ value: 250 });
    expect(r1).not.toHaveProperty('_reason');
    // The bridge's editor feedback selects the node a call touched — fire-and-forget,
    // so let it land before the agent's own selection.
    await new Promise((r) => setTimeout(r, 100));
    env.select(['Asset/Other']);
    const r2 = await env.call('web_execute', { command: 'editor.hide', args: '{}', _reason: 'cover hides the nest' });
    expect(r2).toMatchObject({ ok: true, recorded: true, macroStep: 2 });
    const stop = await env.call('web_macro_record_stop', {});
    expect(stop).toMatchObject({ name: 'round-1', steps: 2, newSteps: 2 });

    const lines = macroBookOf(env.doc.document).macros.get('round-1')!.steps as RvMacroCommandStep[];
    expect(lines[0]).toMatchObject({ command: 'editor.setField', args: SET, note: { reason: 'DFM-6-5 has 5 mm stroke', source: 'parts:DFM-6-5' } });
    expect(lines[0].args).not.toHaveProperty('_reason');
    expect(lines[1]).toMatchObject({ command: 'editor.hide', args: { paths: ['Asset/Other'] }, result: { status: 'ok' } });

    // M5: the document save path embeds the book.
    const glb = await exportAssetGlb(env.root, 'Asset', undefined, undefined, { macros: macrosForEmbed(env.doc.document) });
    const rv = defaultSceneExtras(parseGlbChunks(new Uint8Array(glb)).json)?.realvirtual as Record<string, unknown>;
    expect((rv[RV_MACROS_KEY] as Array<{ name: string }>).map((m) => m.name)).toEqual(['round-1']);

    // Take both edits back, change the selection — the replay still targets the recorded nodes.
    await env.doc.undo();
    await env.doc.undo();
    expect(speedOf(env)).toBe(100);
    expect(env.root.getObjectByName('Other')!.visible).toBe(true);
    env.select(['Asset/Box']);
    const dry = await env.call('web_macro_replay', { name: 'round-1', dryRun: true });
    expect((dry['steps'] as Array<{ willRun: boolean }>).every((s) => s.willRun)).toBe(true);
    const job = await env.call('web_macro_replay', { name: 'round-1' });
    const s = await waitJob(env, job['jobId'] as string);
    expect(s).toMatchObject({ state: 'done', counts: { ok: 2 } });
    expect(speedOf(env)).toBe(250);
    expect(env.root.getObjectByName('Other')!.visible).toBe(false);
    expect(env.root.getObjectByName('Box')!.visible).toBe(true);
    expect(macroBookOf(env.doc.document).macros.get('round-1')!.steps).toHaveLength(2); // never recorded
  });

  it('M8: web_editor_undo during a recording ends it in a controlled way', async () => {
    await env.call('web_macro_record_start', { name: 'u' });
    await bridgeExecuteValue(env.call, 'editor.setField', SET);
    await bridgeExecuteValue(env.call, 'editor.undo', {});
    const stop = await env.call('web_macro_record_stop', {});
    expect(stop).toMatchObject({ recording: null, interrupted: { name: 'u', reason: 'history-undo', afterStep: 1 } });
  });
});

describe.runIf(!__RV_HAS_PRIVATE__)('plan-641 §9.5 — community edition', () => {
  it('editor commands answer requires-commercial; a replayed editor line is requires-commercial', async () => {
    expect(await env.call('web_execute', { command: 'editor.setField', args: JSON.stringify(SET) })).toMatchObject({
      ok: false, status: 'requires-commercial', kind: 'unavailable', error: ERR_EDITOR_UNAVAILABLE,
    });
    macroBookOf(env.doc.document).macros.set('shared', {
      $schema: 'rv-macro/1', name: 'shared', document: { name: 'Asset' },
      steps: [{ kind: 'command', command: 'editor.setField', args: SET, note: { author: 'agent' }, result: { status: 'ok' }, at: '' }],
    });
    const job = await env.call('web_macro_replay', { name: 'shared' });
    const s = await waitJob(env, job['jobId'] as string);
    expect(s).toMatchObject({ state: 'done', counts: { 'requires-commercial': 1 } });
  });
});

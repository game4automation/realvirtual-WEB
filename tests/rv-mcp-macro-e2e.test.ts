// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 — browser E2E of the macro workflow on the REAL bridge path:
 * `McpBridgePlugin._handleMessage` → `_handleCall` → tool → `runCommandStep` →
 * command registry → (private) editor command → AssetDocument, the same strecke
 * a CONNECT / Node MCP client reaches through the bridge socket.
 *
 * Private edition, one flow:
 *  1. a small model (GLB bytes: `Cell` with a `Slide` carrying a Drive and a
 *     `Plate` 200 mm away) lies in a project folder; it is opened the way the
 *     asset editor opens it (`loadGLB`, `preserveHierarchy`);
 *  2. `web_macro_record_start` → `web_execute(editor.setField)` + the bound alias
 *     `web_editor_set_field` + `web_execute(editor.transform)`, each with
 *     `_reason`/`_source` → `web_macro_assert` (gap Slide↔Plate = 5 mm) →
 *     `web_macro_record_stop` → `web_macro_save`;
 *  3. `web_editor_save` writes the GLB into the project folder; both artefacts are
 *     read back from the folder: `scenes[0].extras.realvirtual.Macros` in the GLB
 *     and `macros/<name>.macro.json` with the same steps and notes;
 *  4. "reload": module state reset, a NEW project store opens the same folder, the
 *     saved GLB is read through the backend and loaded into a new scene / viewer /
 *     document / bridge — `web_macro_list` / `web_macro_get` answer from the file;
 *  5. a FRESH copy of the original model (before the changes, no macro inside)
 *     is opened; `web_macro_list(files)` shows the folder's JSON, `web_macro_import`
 *     takes it into the copy's book (Phase 2b); replay as a job, `web_macro_status`
 *     until terminal: every command line ok, the assertion line ok with its
 *     measured gap, the field values equal the recorded model;
 *  6. negative: the same macro with a falsified target, imported inline
 *     (`web_macro_import json`) → a failed line and a `macro-step-failed` entry in
 *     the Problems store.
 *
 * What is SIMULATED, and why:
 *  - The project folder is the in-memory File System Access fake
 *    (`tests/helpers/fake-fs-handles.ts`) opened by the REAL `ProjectStore` /
 *    `FolderBackend` (`openProjectFolder`) — a browser test has no folder picker
 *    and no disk. Every byte goes through the production write/read paths.
 *  - The "page reload" is a fresh project store + fresh viewer/document/bridge in
 *    the same JS realm, with the module-level macro recorder/job registry reset;
 *    a real navigation is not possible inside one vitest browser test.
 *  - The viewer is the stub every editor-bridge test uses (scene, registry,
 *    selection, modes); the model tree itself comes from real GLB bytes.
 *  - Nothing is simulated in bringing the macro onto the fresh copy: it goes through
 *    the real `web_macro_import` from `macros/<name>.macro.json` of the project folder.
 *  - The thumbnail renderer is mocked (no GPU frame needed; a failed thumbnail
 *    never fails a save anyway).
 *
 * Community edition (`VITE_PUBLIC_BUILD=1`): editor commands are stubs, so the
 * recording half cannot run. The community block loads a GLB that already carries
 * a macro, writes it to the folder (`web_macro_save`, AGPL), and replays it: the
 * editor line is `requires-commercial`, the assertion line still measures.
 */

import { bridgeExecuteValue } from './helpers/execute-value';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { documentBase, setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { _resetButtonSimStateForTest } from '../src/core/hmi/button-sim-state';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import { writeMacros } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { defaultSceneExtras, parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { MACRO_STEP_FAILED } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import {
  macroJobs,
  macroRecorder,
  parseMacros,
  RV_MACROS_KEY,
  type RvMacro,
  type RvMacroAssertStep,
  type RvMacroCommandStep,
} from '../src/plugins/mcp-bridge/rv-mcp-macro';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';

// plan-776: the save reaches the renderer only through the thumbnail writer —
// one shared stand-in for it (tests/helpers/mock-thumbnail-write.ts).
vi.mock('../src/core/thumbnails/rv-thumbnail-write', async () =>
  (await import('./helpers/mock-thumbnail-write')).mockThumbnailWriteModule());

// ─── fixture ───────────────────────────────────────────────────────────────

const MAT = new MeshStandardMaterial();
const MODEL_PATH = 'models/Cell.glb';
const MACRO = 'cell-round-1';

/** The original model: Slide (Drive, 0.1 m box at x=0) and Plate (0.1 m box at x=0.3) → 200 mm gap. */
async function originalGlb(): Promise<Uint8Array> {
  const scene = new Scene();
  const cell = new Group();
  cell.name = 'Cell';
  scene.add(cell);
  const slide = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), MAT);
  slide.name = 'Slide';
  slide.userData.realvirtual = { Drive: { TargetSpeed: 100, Acceleration: 100, Direction: 'LinearX' } };
  cell.add(slide);
  const plate = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), MAT);
  plate.name = 'Plate';
  plate.position.set(0.3, 0, 0);
  cell.add(plate);
  const ab = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  return new Uint8Array(ab);
}

function manifest(docs: Array<{ id: string; path: string; name: string }>): string {
  return JSON.stringify({ schemaVersion: 3, id: 'prj_macro_e2e', name: 'Macro E2E', documents: docs });
}

async function seedFile(dir: FakeDir, sub: string, name: string, bytes: Uint8Array): Promise<void> {
  const folder = await dir.getDirectoryHandle(sub, { create: true });
  const file = await folder.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(new Blob([bytes as unknown as BlobPart]));
  await w.close();
}

async function readFileBytes(dir: FakeDir, sub: string, name: string): Promise<Uint8Array> {
  const f = await (await (await dir.getDirectoryHandle(sub)).getFileHandle(name)).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

function rawMacros(bytes: Uint8Array): unknown {
  const extras = defaultSceneExtras(parseGlbChunks(bytes).json);
  return (extras?.realvirtual as Record<string, unknown> | undefined)?.[RV_MACROS_KEY];
}

/** Original bytes with a macro block embedded by the production scene-writer function. */
function withEmbeddedMacros(bytes: Uint8Array, macros: RvMacro[]): Uint8Array {
  const chunks = parseGlbChunks(bytes.slice());
  writeMacros(chunks.json, macros);
  return rebuildGlbWithJson(chunks);
}

// ─── one opened document behind one bridge ─────────────────────────────────

type Json = Record<string, unknown>;

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  root: Object3D;
  registry: NodeRegistry;
  call: (tool: string, args: Json) => Promise<Json>;
  node: (path: string) => Object3D;
}

let openDocs: AssetDocument[] = [];

/** Load GLB bytes the way the asset editor does and put a real bridge in front of the document. */
async function openDocument(bytes: Uint8Array, base: { id: string; name: string; path: string }): Promise<Env> {
  const scene = new Scene();
  const loaded = await loadGLB(`${base.name}.glb`, scene, { data: toArrayBuffer(bytes), preserveHierarchy: true });
  const root = loaded.root;
  const registry = loaded.registry;
  scene.updateMatrixWorld(true);

  let selectedPaths: string[] = [];
  const viewer = {
    scene, registry, camera: new PerspectiveCamera(50, 1, 0.1, 1000), signalStore: null, transportManager: null,
    drives: [],
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

  const doc = new AssetDocument(viewer as never, {
    id: `asset_${base.id}`, name: base.name, base: documentBase(base.id, base.name, base.path),
  });
  openDocs.push(doc);
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
  const call = async (tool: string, args: Json): Promise<Json> => {
    const n = sent.length;
    await handleMessage(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
    const frame = JSON.parse(sent[n]);
    expect(frame.error, `transport error on ${tool}: ${frame.error}`).toBeUndefined();
    return JSON.parse(frame.result) as Json;
  };
  const node = (path: string): Object3D => {
    const n = registry.getNode(path);
    if (!n) throw new Error(`node "${path}" not in the registry`);
    return n;
  };
  return { viewer, doc, root, registry, call, node };
}

/** Poll `web_macro_status` until the job leaves `running` — generous timeout, no fixed short window. */
async function waitJob(env: Env, jobId: string): Promise<Json> {
  let status: Json = {};
  await vi.waitFor(async () => {
    status = await env.call('web_macro_status', { jobId });
    if (status['state'] === 'running') throw new Error(`job ${jobId} still running: ${JSON.stringify(status['progress'])}`);
  }, { timeout: 60_000, interval: 50 });
  return status;
}

const driveOf = (env: Env): Json =>
  ((env.node('Cell/Slide').userData as Record<string, Record<string, Json>>)['realvirtual']['Drive']);

/** The authored state the macro is about: two Drive fields and the Plate position. */
function modelState(env: Env): Json {
  const d = driveOf(env);
  const p = env.node('Cell/Plate').position;
  return { TargetSpeed: d['TargetSpeed'], Acceleration: d['Acceleration'], plateX: Number(p.x.toFixed(6)) };
}

async function openProject(root: FakeDir): Promise<void> {
  localStorage.removeItem('rv-project/last');
  resetProjectStore();
  expect(await getProjectStore().openProjectFolder(asDirHandle(root))).toBe(true);
  expect(getProjectStore().getBackend()?.writable).toBe(true);
}

async function resetModuleState(): Promise<void> {
  macroRecorder._resetForTest();
  macroJobs._resetForTest();
  setActiveAssetContext(null);
  for (const d of openDocs.splice(0)) d.dispose();
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
  _resetButtonSimStateForTest();
  clearAllProblems();
});

afterEach(async () => {
  await resetModuleState();
  try { await getProjectStore().closeProject(); } catch { /* nothing open */ }
  resetProjectStore();
  setDraftScope(null);
  localStorage.removeItem('rv-project/last');
  _resetButtonSimStateForTest();
  clearAllProblems();
});

// ─── private edition: the whole workflow ───────────────────────────────────

describe.runIf(__RV_HAS_PRIVATE__)('plan-641 E2E — record → save into the project folder → reload → replay (private)', () => {
  it('records, writes GLB + macro JSON, reads them back after a reload and replays onto a fresh copy', async () => {
    const original = await originalGlb();
    const folder = new FakeDir('macro-e2e');
    await seedFile(folder, 'models', 'Cell.glb', original);
    folder.seedText('project.json', manifest([{ id: 'doc-cell', path: MODEL_PATH, name: 'Cell' }]));
    await openProject(folder);

    // ── 1. open the model in the editor ──
    const env = await openDocument(original, { id: 'doc-cell', name: 'Cell', path: MODEL_PATH });
    expect(modelState(env)).toEqual({ TargetSpeed: 100, Acceleration: 100, plateX: 0.3 });
    const before = await env.call('web_check_gap', { a: 'Cell/Slide', b: 'Cell/Plate' });
    expect(before['gapMm'] as number).toBeCloseTo(200, 1);

    // ── 2. record ──
    expect(await env.call('web_macro_record_start', { name: MACRO })).toMatchObject({ recording: MACRO });
    const s1 = await env.call('web_execute', {
      command: 'editor.setField',
      args: JSON.stringify({ path: 'Cell/Slide', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '250' }),
      _reason: 'cycle time needs 250 mm/s', _source: 'customer:e2e/2026-10-21',
    });
    expect(s1).toMatchObject({ ok: true, status: 'ok', recorded: true, macroStep: 1 });
    const s2 = await bridgeExecuteValue(env.call, 'editor.setField', {
      path: 'Cell/Slide', componentType: 'Drive', fieldName: 'Acceleration', valueJson: '400',
      _reason: 'DFM-6-5 datasheet acceleration', _source: 'parts:DFM-6-5', _confidence: 'observed',
    });
    expect(s2, JSON.stringify(s2)).not.toHaveProperty('error');
    expect(s2).not.toHaveProperty('_reason');
    const s3 = await env.call('web_execute', {
      command: 'editor.transform',
      args: JSON.stringify({ path: 'Cell/Plate', px: 0.105 }),
      _reason: 'plate sits 5 mm in front of the slide', _source: 'customer:e2e/2026-10-21',
    });
    expect(s3).toMatchObject({ ok: true, status: 'ok', recorded: true, macroStep: 3 });
    const recordedState = modelState(env);
    expect(recordedState).toEqual({ TargetSpeed: 250, Acceleration: 400, plateX: 0.105 });

    const assert = await env.call('web_macro_assert', {
      name: MACRO, check: 'gap',
      args: JSON.stringify({ a: 'Cell/Slide', b: 'Cell/Plate' }),
      expect: JSON.stringify({ gapMm: { min: 4.9, max: 5.1 } }),
      _reason: 'the slide must keep 5 mm to the plate', _source: 'customer:e2e/2026-10-21',
    });
    expect(assert).toMatchObject({ name: MACRO, step: 4, check: 'gap', passesNow: true });
    expect((assert['measured'] as Json)['gapMm'] as number).toBeCloseTo(5, 2);

    const stop = await env.call('web_macro_record_stop', {});
    expect(stop).toMatchObject({ name: MACRO, steps: 4, newSteps: 4, failedOrNoop: 0 });

    const saveJson = await env.call('web_macro_save', { name: MACRO });
    expect(saveJson).toMatchObject({ written: `macros/${MACRO}.macro.json`, steps: 4, stripNotes: false });

    // ── 3. web_editor_save into the project folder ──
    const saved = await env.call('web_editor_save', {});
    expect(saved, JSON.stringify(saved)).not.toHaveProperty('error');
    expect(saved).toMatchObject({ saved: true, relPath: MODEL_PATH, saveVerb: 'save' });

    const savedBytes = await readFileBytes(folder, 'models', 'Cell.glb');
    const embedded = rawMacros(savedBytes) as RvMacro[];
    expect(embedded.map((m) => m.name)).toEqual([MACRO]);
    const json = JSON.parse((await folder.readTextAt('macros', `${MACRO}.macro.json`))!) as RvMacro;
    // GLB block and JSON file carry the same macro — steps, args, notes, results.
    expect(parseMacros({ [RV_MACROS_KEY]: [json] })).toEqual([embedded[0]]);
    const steps = embedded[0].steps;
    expect(steps.map((s) => (s.kind === 'command' ? s.command : `assert:${s.check}`)))
      .toEqual(['editor.setField', 'editor.setField', 'editor.transform', 'assert:gap']);
    expect(steps[0]).toMatchObject({
      args: { path: 'Cell/Slide', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '250' },
      note: { author: 'agent', reason: 'cycle time needs 250 mm/s', source: 'customer:e2e/2026-10-21' },
      result: { status: 'ok' },
    });
    expect(steps[1]).toMatchObject({
      args: { path: 'Cell/Slide', fieldName: 'Acceleration', valueJson: '400' },
      note: { reason: 'DFM-6-5 datasheet acceleration', source: 'parts:DFM-6-5', confidence: 'observed' },
    });
    expect((steps[1] as RvMacroCommandStep).args).not.toHaveProperty('_reason');
    expect(steps[2]).toMatchObject({ args: { path: 'Cell/Plate', px: 0.105 }, result: { status: 'ok' } });
    expect(steps[3] as RvMacroAssertStep).toMatchObject({
      args: { a: 'Cell/Slide', b: 'Cell/Plate' }, expect: { gapMm: { min: 4.9, max: 5.1 } },
      note: { reason: 'the slide must keep 5 mm to the plate' },
    });

    // ── 4. reload: fresh module state, fresh store on the same folder, saved GLB loaded anew ──
    await resetModuleState();
    await getProjectStore().closeProject();
    await openProject(folder);
    const record = await getProjectStore().getBackend()!.readDocument(MODEL_PATH);
    expect(record?.bytes).toBeTruthy();
    const reloaded = await openDocument(record!.bytes!, { id: 'doc-cell', name: 'Cell', path: MODEL_PATH });
    expect(modelState(reloaded)).toEqual(recordedState);
    const list = await reloaded.call('web_macro_list', {});
    expect(list).toMatchObject({ macros: [{ name: MACRO, steps: 4, replayable: 4 }], recording: null });
    const got = await reloaded.call('web_macro_get', { name: MACRO });
    expect((got['steps'] as Array<Json>).map((s) => s['step'])).toEqual([1, 2, 3, 4]);
    expect((got['steps'] as Array<Json>)[1]).toMatchObject({ note: { source: 'parts:DFM-6-5' } });

    // ── 5. a FRESH copy of the original model: import the folder's macro, replay it ──
    await resetModuleState();
    const fresh = await openDocument(original, { id: 'doc-cell-fresh', name: 'Cell', path: 'models/Cell-fresh.glb' });
    expect(modelState(fresh)).toEqual({ TargetSpeed: 100, Acceleration: 100, plateX: 0.3 });
    const listed = await fresh.call('web_macro_list', { files: true });
    expect(listed).toMatchObject({ macros: [], files: [{ name: MACRO, path: `macros/${MACRO}.macro.json`, steps: 4 }] });
    const imported = await fresh.call('web_macro_import', { source: MACRO });
    expect(imported).toEqual({ name: MACRO, steps: 4, warnings: [], from: `macros/${MACRO}.macro.json` });
    expect((await fresh.call('web_macro_get', { name: MACRO }))['steps']).toEqual(
      json.steps.map((s, i) => ({ step: i + 1, ...s })),
    );
    expect(await fresh.call('web_macro_import', { source: MACRO })).toMatchObject({ error: expect.stringMatching(/already exists/) });
    const dry = await fresh.call('web_macro_replay', { name: MACRO, dryRun: true });
    expect((dry['steps'] as Array<{ willRun: boolean }>).map((s) => s.willRun)).toEqual([true, true, true, true]);
    expect(modelState(fresh)).toEqual({ TargetSpeed: 100, Acceleration: 100, plateX: 0.3 }); // dryRun changes nothing

    const job = await fresh.call('web_macro_replay', { name: MACRO });
    expect(job).toMatchObject({ state: 'running', total: 4 });
    const done = await waitJob(fresh, job['jobId'] as string);
    expect(done, JSON.stringify(done)).toMatchObject({ state: 'done', progress: { done: 4, total: 4 }, counts: { ok: 4 } });
    const report = done['report'] as Array<Json>;
    expect(report.map((l) => l['status'])).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report[3]).toMatchObject({ kind: 'assert', check: 'gap', status: 'ok' });
    expect((report[3]['measured'] as Json)['gapMm'] as number).toBeCloseTo(5, 2);
    expect(modelState(fresh)).toEqual(recordedState);
    expect(getProblems().filter((p) => p.code === MACRO_STEP_FAILED)).toEqual([]);

    // ── 6. negative: the same macro with a falsified target ──
    const broken: RvMacro = JSON.parse(JSON.stringify(json));
    broken.name = `${MACRO}-broken`;
    (broken.steps[2] as RvMacroCommandStep).args['path'] = 'Cell/NoSuchPlate';
    await resetModuleState();
    const fresh2 = await openDocument(original, {
      id: 'doc-cell-fresh2', name: 'Cell', path: 'models/Cell-fresh2.glb',
    });
    expect(await fresh2.call('web_macro_import', { json: JSON.stringify(broken) }))
      .toMatchObject({ name: broken.name, steps: 4, warnings: [], from: 'json' });
    const job2 = await fresh2.call('web_macro_replay', { name: broken.name });
    const done2 = await waitJob(fresh2, job2['jobId'] as string);
    const report2 = done2['report'] as Array<Json>;
    expect(done2['state']).toBe('done');
    // stopOnError (default) — the failed transform line ends the run before the assertion.
    expect(report2.map((l) => l['status'])).toEqual(['ok', 'ok', 'failed']);
    expect(report2[2]).toMatchObject({ step: 3, command: 'editor.transform', status: 'failed' });
    const problems = getProblems().filter((p) => p.code === MACRO_STEP_FAILED);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', nodePath: 'Cell/NoSuchPlate' });
    expect(problems[0].title).toContain(`"${broken.name}" step 3`);
    expect(modelState(fresh2).plateX).toBe(0.3);
  }, 120_000);
});

// ─── community edition: the requires-commercial path ───────────────────────

describe.runIf(!__RV_HAS_PRIVATE__)('plan-641 E2E — community edition (editor commands are stubs)', () => {
  it('a macro from the file: saved to the folder, listed, replayed — editor line requires-commercial, assertion measured', async () => {
    const macro: RvMacro = {
      $schema: 'rv-macro/1', name: MACRO, document: { name: 'Cell' },
      steps: [
        {
          kind: 'command', command: 'editor.setField',
          args: { path: 'Cell/Slide', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '250' },
          note: { author: 'agent', reason: 'cycle time' }, result: { status: 'ok' }, at: '2026-10-21T00:00:00.000Z',
        },
        {
          kind: 'assert', check: 'gap', args: { a: 'Cell/Slide', b: 'Cell/Plate' }, expect: { gapMm: { min: 199, max: 201 } },
          note: { author: 'agent', reason: 'unchanged geometry' }, at: '2026-10-21T00:00:01.000Z',
        },
      ],
    };
    const bytes = withEmbeddedMacros(await originalGlb(), [macro]);
    const folder = new FakeDir('macro-e2e-community');
    await seedFile(folder, 'models', 'Cell.glb', bytes);
    folder.seedText('project.json', manifest([{ id: 'doc-cell', path: MODEL_PATH, name: 'Cell' }]));
    await openProject(folder);
    const record = await getProjectStore().getBackend()!.readDocument(MODEL_PATH);
    const env = await openDocument(record!.bytes!, { id: 'doc-cell', name: 'Cell', path: MODEL_PATH });

    expect(await env.call('web_execute', {
      command: 'editor.setField', args: JSON.stringify(macro.steps[0].args),
    })).toMatchObject({ ok: false, status: 'requires-commercial', kind: 'unavailable' });

    expect(await env.call('web_macro_list', {})).toMatchObject({ macros: [{ name: MACRO, steps: 2 }] });
    expect(await env.call('web_macro_save', { name: MACRO })).toMatchObject({ written: `macros/${MACRO}.macro.json`, steps: 2 });
    expect(JSON.parse((await folder.readTextAt('macros', `${MACRO}.macro.json`))!)).toEqual(macro);
    // Import is AGPL: from the folder (collision without overwrite) and inline.
    expect(await env.call('web_macro_import', { source: MACRO })).toMatchObject({ error: expect.stringMatching(/already exists/) });
    expect(await env.call('web_macro_import', { source: MACRO, overwrite: true }))
      .toMatchObject({ name: MACRO, steps: 2, replaced: true, from: `macros/${MACRO}.macro.json` });
    expect(await env.call('web_macro_import', { json: JSON.stringify({ ...macro, name: `${MACRO}-copy` }) }))
      .toMatchObject({ name: `${MACRO}-copy`, steps: 2, warnings: [], from: 'json' });

    const job = await env.call('web_macro_replay', { name: MACRO });
    const done = await waitJob(env, job['jobId'] as string);
    expect(done, JSON.stringify(done)).toMatchObject({ state: 'done', counts: { 'requires-commercial': 1, ok: 1 } });
    const report = done['report'] as Array<Json>;
    expect(report[1]).toMatchObject({ kind: 'assert', status: 'ok' });
    expect((report[1]['measured'] as Json)['gapMm'] as number).toBeCloseTo(200, 1);
    expect(driveOf(env)['TargetSpeed']).toBe(100);
    expect(getProblems().filter((p) => p.code === MACRO_STEP_FAILED)).toEqual([]);
  }, 120_000);
});

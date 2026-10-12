// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.11 (bridge half) — the REAL MCP path of a bound tool:
 * `McpBridgePlugin._handleMessage` → `_handleCall` → (preflight) →
 * choreography → tool body → `dispatchBoundCommand` → registry.
 *
 * Pinned: exactly ONE `execute` per call (origin 'mcp'); the result serialises
 * as before (`{ok:true, path}`); the afterglow lands on the bound button; the
 * activity pill shows the command label; a refusal answers `{error: <the
 * enabled() reason>}` with no mutation, no afterglow and — the preflight —
 * NO hover/press phase at all; multiplexer branches (pivot) dispatch the right
 * command or refuse without dispatching; and a document swap A → B (same node
 * path) during hover/press writes nothing to either document.
 *
 * Runs in both editions: private (real implementations) and community
 * (`VITE_PUBLIC_BUILD=1` → stubs), where bound editor tools answer
 * ERR_EDITOR_UNAVAILABLE before any guard.
 *
 * plan-504 adds the Mechanism section's eleven bound tools: row-exact
 * afterglow (only the addressed body / joint row glows), the row opened
 * before the press, world-anchored side A, the target's reason instead of the
 * selection's, the statics gates, two joint components on one node.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { setAppConfig } from '../src/core/rv-app-config';
import { RENDER_MODE_LOCKED } from '../src/core/hmi/render-mode-controller';
import { loadVisualSettings, saveVisualSettings } from '../src/core/hmi/visual-settings-store';
import {
  listShippedPresets, loadPublishedPresets, matchPreset, type VisualPreset,
} from '../src/core/hmi/visual-presets';
import {
  LOGIC_STEP_NEEDS_CONTAINER,
  NEEDS_SIGNAL_OBJECT,
  NEEDS_TARGET,
  SIGNAL_ALREADY_TYPE,
  SIGNAL_EDITABLE_FIELDS,
  SIGNAL_NAME_READONLY,
  SIGNAL_NEEDS_PLAIN_PARENT,
} from '../src/core/hmi/editor-command-descriptors';
import { PLC_BINDING_NEEDS_CONNECT } from '../src/core/hmi/connect-store';
import { ERR_DOCUMENT_CHANGED, ERR_EDITOR_UNAVAILABLE, ERR_NOT_EDITOR } from '../src/core/editor/rv-editor-guard-core';
import { _resetButtonSimStateForTest, getButtonSimPhase } from '../src/core/hmi/button-sim-state';
import { getAiActivity } from '../src/core/hmi/ai-activity-store';
import { computeSubtreeAABB } from '../src/core/engine/rv-traverse-utils';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  setMechanismUiBridge,
  type MechanismForcesSnapshot,
  type MechanismJointView,
  type MechanismLinkView,
  type MechanismUiBridge,
  type MechanismView,
} from '../src/core/engine/rv-kinematic-registry';
import {
  LIMITS_ORDER,
  NEEDS_ALL_BODIES,
  NEEDS_BODY,
  NEEDS_DRIVE_NODE,
  NEEDS_VALID_MASS,
  STATICS_INVALID,
  bodyRowKey,
  registerMechanismRowExpander,
  staticsKey,
} from '../src/core/hmi/mechanism-command-descriptors';

// ─── Fixture ────────────────────────────────────────────────────────────

interface Env {
  plugin: McpBridgePlugin;
  viewer: RVViewer;
  doc: AssetDocument;
  box: Object3D;
  boxPath: string;
  sent: string[];
  call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const box = new Object3D();
  box.name = 'Box';
  box.position.set(0, 5, 0);
  root.add(box);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  mesh.name = 'Body';
  box.add(mesh);
  scene.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  let selectedPaths: string[] = [];
  const plugins = new Map<string, unknown>();
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 2, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const viewer: RVViewer = {
    scene, registry, camera,
    signalStore: null,
    transportManager: null,
    // plan-761: the render-mode state `view.renderMode` reads and writes. Plain
    // fields — `setRenderMode` assigns the lighting setters, `web_status` reads
    // `renderMode` / `wireframeActive`.
    renderMode: 'default',
    wireframe: false,
    wireframeActive: false,
    // plan-591: the quality axis `view.visualPreset` reads and writes.
    // `antialiasActive` is a renderer fact (`web_status` reports it, the reload
    // hint derives from it) and `applyVisualSettings` is where a preset lands —
    // a no-op here, because this stub has no renderer at all.
    antialiasActive: false,
    applyVisualSettings() { /* no renderer in the bridge stub */ },
    get currentModelRoot() { return root; },
    modes: {
      activeMode: 'editor',
      has: () => true, setMode() {}, list: () => [{ id: 'editor' }], subscribe: () => () => {},
    },
    selectionManager: {
      select(p: string) { selectedPaths = [p]; }, clear() { selectedPaths = []; },
      selectPaths(p: string[]) { selectedPaths = [...p]; },
      getSnapshot: () => ({ selectedPaths, primaryPath: selectedPaths[0] ?? null }),
    },
    leftPanelManager: { isOpen: () => true, open() {} },
    highlighter: { flash() {} },
    fitToNodes() {},
    // plan-504: mechanism.statics registers the force recorder plugin on demand.
    getPlugin<T>(pid: string): T | undefined { return plugins.get(pid) as T | undefined; },
    use(plugin: { id: string; init?: (v: RVViewer) => void }): void {
      plugins.set(plugin.id, plugin);
      plugin.init?.(viewer);
    },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });

  const plugin = new McpBridgePlugin();
  (plugin as unknown as { viewer: RVViewer }).viewer = viewer;
  (plugin as unknown as { _dispatcher: ReturnType<typeof buildMultiDispatcher> })._dispatcher =
    buildMultiDispatcher(plugin.mcpToolInstances);
  const sent: string[] = [];
  (plugin as unknown as { _ws: unknown })._ws = {
    readyState: 1, send: (d: string) => { sent.push(d); }, close: vi.fn(),
    onclose: null, onerror: null, onmessage: null,
  };
  const handleMessage = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })
    ._handleMessage.bind(plugin);
  let id = 0;
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const n = sent.length;
    await handleMessage(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
    const frame = JSON.parse(sent[n]);
    expect(frame.error, `transport error: ${frame.error}`).toBeUndefined();
    return JSON.parse(frame.result);
  };
  return { plugin, viewer, doc, box, boxPath: NodeRegistry.computeNodePath(box), sent, call };
}

function worldMinY(o: Object3D): number {
  o.updateMatrixWorld(true);
  return computeSubtreeAABB(o, new Box3()).box.min.y;
}

/** Record every distinct phase a button goes through while `fn` runs. */
async function watchPhases(key: string, fn: () => Promise<unknown>): Promise<string[]> {
  const phases: string[] = [];
  const probe = setInterval(() => {
    const p = getButtonSimPhase(key);
    if (p && phases[phases.length - 1] !== p) phases.push(p);
  }, 5);
  try { await fn(); } finally { clearInterval(probe); }
  const last = getButtonSimPhase(key);
  if (last && phases[phases.length - 1] !== last) phases.push(last);
  return phases;
}

let env: Env;
let buttons: HTMLElement[] = [];

function mountButton(key: string): void {
  const b = document.createElement('button');
  b.setAttribute('data-rv-button-id', key);
  document.body.appendChild(b);
  buttons.push(b);
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
  _resetButtonSimStateForTest();
  env = makeEnv();
  mountButton('qe.to-ground');
  mountButton('qe.pivot-bottom');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const b of buttons) b.remove();
  buttons = [];
  setActiveAssetContext(null);
  env.doc.dispose();
  _resetButtonSimStateForTest();
});

// ─── 1:1 binding ────────────────────────────────────────────────────────

describe('bound tool through _handleCall', () => {
  it('the dispatcher entry carries the binding (metadata, not on the wire)', () => {
    const entry = (env.plugin as unknown as {
      _dispatcher: Map<string, { command?: unknown }>;
    })._dispatcher.get('web_editor_to_ground');
    expect(entry?.command).toBe('editor.toGround');
  });

  it('success: ONE execute (origin mcp), result as before, hover → pressed → afterglow, label in the pill', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const minBefore = worldMinY(env.box);
    let res: Record<string, unknown> = {};
    // The pill label auto-clears 3 s after it is set; the click choreography can
    // outlast that, so record what the pill showed DURING the call.
    const shown = new Set<string>();
    const poll = setInterval(() => { const a = getAiActivity(); if (a) shown.add(a); }, 10);
    const phases = await watchPhases('qe.to-ground', async () => {
      res = await env.call('web_editor_to_ground', { path: env.boxPath });
    });
    clearInterval(poll);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('editor.toGround');
    expect(spy.mock.calls[0][1]).toEqual({ path: env.boxPath });
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp', buttonKey: 'qe.to-ground' });
    expect([...shown]).toContain('To Ground');

    if (__RV_HAS_PRIVATE__) {
      expect(res).toMatchObject({ ok: true, path: env.boxPath });
      expect(minBefore).toBeCloseTo(4.5, 5);
      expect(worldMinY(env.box)).toBeCloseTo(0, 5);
      expect(phases).toEqual(['hover', 'pressed', 'afterglow']);
    } else {
      expect(res).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      expect(worldMinY(env.box)).toBeCloseTo(minBefore, 5);
      expect(phases).toEqual([]); // the preflight refused: no choreography
    }
  }, 15000);

  it('refusal: {error} == the tooltip reason, no mutation, no afterglow and NO hover/press (preflight)', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const opsBefore = env.doc.ops.length;
    const minBefore = worldMinY(env.box);
    let res: Record<string, unknown> = {};
    const phases = await watchPhases('qe.to-ground', async () => {
      res = await env.call('web_editor_to_ground', { path: '' });
    });

    expect(spy).toHaveBeenCalledTimes(1);
    await commandRegistry.preload(['editor.toGround']);
    const tooltip = commandRegistry.enabled('editor.toGround', { path: '' }, env.viewer);
    const expected = __RV_HAS_PRIVATE__ ? NEEDS_TARGET : ERR_EDITOR_UNAVAILABLE;
    expect(res).toEqual({ error: expected });
    expect(tooltip).toEqual({ reason: expected });
    expect(phases).toEqual([]); // not a single simulated hover or press
    expect(env.doc.ops.length).toBe(opsBefore);
    expect(worldMinY(env.box)).toBeCloseTo(minBefore, 5);
  }, 15000);

  it('guard text is unchanged outside the editor (private) / unavailable first (community)', async () => {
    (env.viewer.modes as unknown as { activeMode: string }).activeMode = 'planner';
    const res = await env.call('web_editor_to_ground', { path: env.boxPath });
    expect(res).toEqual({ error: __RV_HAS_PRIVATE__ ? ERR_NOT_EDITOR : ERR_EDITOR_UNAVAILABLE });
  });

  it('document swap A → B (same node path) during hover/press: stale, nothing written to A or B', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: refused before any choreography
    const docA = env.doc;
    const docB = scratchAssetDocument(env.viewer, 'B');
    const minBefore = worldMinY(env.box);
    const spy = vi.spyOn(commandRegistry, 'execute');
    // Swap while the choreography dwells on the button (beat 80 ms + hover >= 80 ms).
    const swap = setTimeout(() => setActiveAssetContext({ viewer: env.viewer, doc: docB }), 120);
    let res: Record<string, unknown> = {};
    const phases = await watchPhases('qe.to-ground', async () => {
      res = await env.call('web_editor_to_ground', { path: env.boxPath });
    });
    clearTimeout(swap);
    try {
      expect(phases[0]).toBe('hover'); // the swap happened during the choreography
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ error: ERR_DOCUMENT_CHANGED });
      expect(docA.ops.length).toBe(0);
      expect(docB.ops.length).toBe(0);
      expect(worldMinY(env.box)).toBeCloseTo(minBefore, 5);
      expect(phases).not.toContain('afterglow'); // no afterglow on a stale call
    } finally {
      docB.dispose();
    }
  }, 15000);
});

// ─── Multiplexer (web_editor_pivot) ─────────────────────────────────────

describe('multiplexer binding through _handleCall', () => {
  it('mode=bottom dispatches editor.pivotToBottom on qe.pivot-bottom', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const res = await env.call('web_editor_pivot', { path: env.boxPath, mode: 'BOTTOM' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('editor.pivotToBottom');
    expect(spy.mock.calls[0][1]).toEqual({ path: env.boxPath });
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp', buttonKey: 'qe.pivot-bottom' });
    if (__RV_HAS_PRIVATE__) {
      expect(res).toMatchObject({ ok: true, path: env.boxPath, mode: 'bottom' });
      expect(Array.isArray(res['pivotWorld'])).toBe(true);
    } else {
      expect(res).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
    }
  }, 15000);

  it('object_center without targetPath refuses without a dispatch; an unknown mode too', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    expect(await env.call('web_editor_pivot', { path: env.boxPath, mode: 'object_center' }))
      .toEqual({ error: 'object_center needs targetPath' });
    expect(await env.call('web_editor_pivot', { path: env.boxPath, mode: 'sideways' }))
      .toEqual({ error: 'mode must be bottom | object_center | group_center | align_y_up' });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── Result fields (private build) ──────────────────────────────────────

describe('result fields stay what the tools answered before', () => {
  it('create_empty → path, rename → new path, delete → deleted count', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    const created = await env.call('web_editor_create_empty', { name: 'Rig' });
    expect(created).toMatchObject({ ok: true, path: 'Asset/Rig' });
    const renamed = await env.call('web_editor_rename', { path: 'Asset/Rig', name: 'Frame' });
    expect(renamed).toMatchObject({ ok: true, path: 'Asset/Frame' }); // + plan-707 `verified`
    const deleted = await env.call('web_editor_delete', { paths: 'Asset/Frame' });
    expect(deleted).toMatchObject({ ok: true, deleted: 1 });
  }, 15000);
});

// ─── Quick Edit signals / logic steps (plan-499 Phase 4) ────────────────

describe('signals and logic steps: the Quick Edit rules are the tool rules', () => {
  it('add / convert / flip a signal; a Drive parent is refused with the button text', async () => {
    if (!__RV_HAS_PRIVATE__) {
      expect(await env.call('web_editor_add_signal', { parentPath: env.boxPath, sigType: 'PLCOutputBool' }))
        .toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    const added = await env.call('web_editor_add_signal', { parentPath: env.boxPath, sigType: 'PLCOutputBool', name: 'Start' });
    expect(added).toMatchObject({ ok: true, path: 'Asset/Box/Start' });
    const sig = env.viewer.registry!.getNode('Asset/Box/Start')!;
    expect(Object.keys(sig.userData['realvirtual'] as object)).toContain('PLCOutputBool');

    expect(await env.call('web_editor_convert_signal', { path: 'Asset/Box/Start', target: 'Int' }))
      .toMatchObject({ ok: true, path: 'Asset/Box/Start' });
    expect(await env.call('web_editor_convert_signal', { path: 'Asset/Box/Start', target: 'Int' }))
      .toEqual({ error: SIGNAL_ALREADY_TYPE });
    expect(await env.call('web_editor_toggle_signal_direction', { path: env.boxPath }))
      .toEqual({ error: NEEDS_SIGNAL_OBJECT });
    expect(await env.call('web_editor_toggle_signal_direction', { path: 'Asset/Box/Start' }))
      .toMatchObject({ ok: true });
    expect(Object.keys(env.viewer.registry!.getNode('Asset/Box/Start')!.userData['realvirtual'] as object))
      .toContain('PLCInputInt');

    env.doc.addComponent(env.boxPath, 'Drive', {});
    await env.doc.whenIdle();
    const ops = env.doc.ops.length;
    expect(await env.call('web_editor_add_signal', { parentPath: env.boxPath, sigType: 'PLCInputBool' }))
      .toEqual({ error: SIGNAL_NEEDS_PLAIN_PARENT });
    expect(env.doc.ops.length).toBe(ops);
  }, 15000);

  /**
   * plan-589 F5 (test 9.2, moved here because the command only exists since Phase 2) — the NAME of
   * an existing signal is not editable.
   *
   * The refusal is the point: the SignalStore registration, every model binding and every CONNECT
   * entry couple by the name, so a successful write here would silently unbind all three. Renaming
   * with reference refactoring is plan-590.
   */
  it('signalSetField writes Comment / OriginDataType / Type and REFUSES Name', async () => {
    if (!__RV_HAS_PRIVATE__) {
      expect(await env.call('web_editor_signal_set_field', { path: env.boxPath, field: 'Comment', value: 'x' }))
        .toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    await env.call('web_editor_add_signal', { parentPath: env.boxPath, sigType: 'PLCOutputBool', name: 'Lamp' });
    const path = 'Asset/Box/Lamp';
    const extrasOf = () => (env.viewer.registry!.getNode(path)!
      .userData['realvirtual'] as Record<string, Record<string, unknown>>);

    expect(await env.call('web_editor_signal_set_field', { path, field: 'Comment', value: 'Signal lamp' }))
      .toMatchObject({ ok: true, path, field: 'Comment' });
    expect(extrasOf()['PLCOutputBool']['Comment']).toBe('Signal lamp');

    expect(await env.call('web_editor_signal_set_field', { path, field: 'OriginDataType', value: 'BOOL' }))
      .toMatchObject({ ok: true, field: 'OriginDataType' });
    expect(extrasOf()['PLCOutputBool']['OriginDataType']).toBe('BOOL');

    // Type routes through the existing convert + flip operations.
    expect(await env.call('web_editor_signal_set_field', { path, field: 'Type', value: 'PLCInputFloat' }))
      .toMatchObject({ ok: true, field: 'Type' });
    expect(Object.keys(extrasOf())).toContain('PLCInputFloat');

    // The refusals — and NOTHING is written for either.
    const ops = env.doc.ops.length;
    expect(await env.call('web_editor_signal_set_field', { path, field: 'Name', value: 'Lamp2' }))
      .toEqual({ error: SIGNAL_NAME_READONLY });
    const unknown = await env.call('web_editor_signal_set_field', { path, field: 'Nope', value: 'x' });
    expect(unknown['error']).toContain(SIGNAL_EDITABLE_FIELDS.join(' | '));
    expect(unknown['fields']).toEqual([...SIGNAL_EDITABLE_FIELDS]);
    expect(await env.call('web_editor_signal_set_field', { path: env.boxPath, field: 'Comment', value: 'x' }))
      .toEqual({ error: NEEDS_SIGNAL_OBJECT });
    expect(env.doc.ops.length).toBe(ops);
    expect(extrasOf()['PLCInputFloat']['Name']).toBe('Lamp');
  }, 20000);

  /**
   * plan-589 F4 — the binding command refuses without CONNECT instead of pretending.
   *
   * Addresses live in the gateway; with no connection there is nowhere to write one, and the tool
   * must say so rather than reporting a success nothing came of.
   */
  it('signalSetBinding refuses without a CONNECT connection', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    expect(await env.call('web_editor_signal_set_binding', { name: 'Lamp', interfaceId: 's7-1' }))
      .toEqual({ error: PLC_BINDING_NEEDS_CONNECT });
    expect(await env.call('web_editor_signal_set_binding', { name: '', interfaceId: 's7-1' }))
      .toEqual({ error: 'name is required (the model signal name)' });
  }, 15000);

  it('logic steps: palette steps only inside a container, the starter only on a plain object, unknown type → palette', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    const unknown = await env.call('web_editor_add_logic_step', { path: env.boxPath, stepType: 'LogicStep_Nope' });
    expect(unknown['error']).toBe('Unknown stepType "LogicStep_Nope"');
    expect(Array.isArray(unknown['palette'])).toBe(true);
    expect(await env.call('web_editor_add_logic_step', { path: env.boxPath, stepType: 'LogicStep_Delay' }))
      .toEqual({ error: LOGIC_STEP_NEEDS_CONTAINER });
    expect(await env.call('web_editor_add_logic_step', { path: env.boxPath, stepType: 'LogicStep_SerialContainer' }))
      .toMatchObject({ ok: true });
    // Inside the container (the node itself now is one) the palette is open.
    expect(await env.call('web_editor_add_logic_step', { path: env.boxPath, stepType: 'LogicStep_Delay' }))
      .toMatchObject({ ok: true });
  }, 15000);
});

// ─── plan-504 — the Mechanism section's bound tools ─────────────────────

/**
 * The mechanism tools through the REAL bridge path. Scene: `Asset` carries the
 * `KinematicMechanism`; `Base` has a body, `L1`/`L2` do not; `J` carries TWO
 * joint components (`KinematicJoint`, `KinematicJoint_1`); `Motor` has a Drive.
 * The private solver is a recording double (views, jog, statics).
 */
describe('plan-504 — mechanism bound tools through _handleCall', () => {
  interface MechEnv { rebuilt: string[]; jogCalls: { path: string; componentType?: string }[]; views: () => MechanismView[] }
  let mech: MechEnv;
  let statics: MechanismForcesSnapshot | null = null;
  let linkOverride: Partial<MechanismLinkView>[] | null = null;

  const rv = (path: string): Record<string, Record<string, unknown>> =>
    (env.viewer.registry!.getNode(path)!.userData['realvirtual'] ?? {}) as Record<string, Record<string, unknown>>;
  const hasBody = (path: string): boolean => Object.keys(rv(path)).some((k) => k.startsWith('MechanismBody'));

  function linkView(path: string, over: Partial<MechanismLinkView> = {}): MechanismLinkView {
    const body = hasBody(path);
    return {
      nodePath: path, name: path.split('/').pop()!, hasBody: body, hasMass: body,
      densityPreset: 'steel', densityKgM3: 7850, massKg: body ? 1 : 0, comLocalMm: [0, 0, 0],
      massOverridden: false, comOverridden: false, massSource: body ? 'mesh' : 'none', massWarning: '',
      ...over,
    };
  }

  function jointView(componentType: string): MechanismJointView {
    return {
      nodePath: 'Asset/J', componentType, name: 'J', jointType: 'Revolute',
      bodyAName: null, bodyBName: 'L1', bodyAPath: null, bodyBPath: 'Asset/L1', worldAnchored: true,
      driveName: null, currentValue: 0, joggable: true, lowerLimit: -90, upperLimit: 90, useLimits: false,
      originWorld: [0, 0, 0], axisWorld: [0, 0, 1],
    };
  }

  beforeEach(() => {
    const root = env.viewer.currentModelRoot!;
    root.userData['realvirtual'] = { KinematicMechanism: { SolverIterations: 4 } };
    const add = (name: string, extras?: Record<string, unknown>): void => {
      const n = new Object3D();
      n.name = name;
      if (extras) n.userData['realvirtual'] = extras;
      root.add(n);
      env.viewer.registry!.registerNode(NodeRegistry.computeNodePath(n), n);
    };
    add('Base', { MechanismBody: { DensityPreset: 'steel', DensityKgM3: 7850 } });
    add('L1');
    add('L2');
    add('Motor', { Drive: { Direction: 'RotationZ' } });
    add('J', {
      KinematicJoint: { JointType: 'Revolute', UseLimits: false },
      KinematicJoint_1: { JointType: 'Revolute', UseLimits: false },
    });
    statics = null;
    linkOverride = null;
    const views = (): MechanismView[] => [{
      nodePath: 'Asset', name: 'Asset', active: true, converged: true, residualError: 0, solveTimeMs: 0,
      disabledReason: '', jointCount: 2, linkCount: 3, loopCount: 0, dof: 1, cog: null, findings: [],
      joints: [jointView('KinematicJoint'), jointView('KinematicJoint_1')],
      links: ['Asset/Base', 'Asset/L1', 'Asset/L2'].map((p, i) => linkView(p, linkOverride?.[i] ?? {})),
    }];
    mech = { rebuilt: [], jogCalls: [], views };
    setMechanismUiBridge({
      list: views,
      validate: () => [],
      jog: (path: string, _v: number, componentType?: string) => {
        mech.jogCalls.push({ path, componentType });
        return { converged: true, residualError: 0 };
      },
      solve: () => ({ converged: true, residualError: 0 }),
      rebuild: (p: string) => { mech.rebuilt.push(p); },
      suggestFix: () => null,
      setForceAnalysis() {},
      forcesSnapshot: () => null,
      solveStatics: () => statics,
      resetForces() {},
      linkNodes: () => [],
    } as unknown as MechanismUiBridge);
  });

  afterEach(() => {
    setMechanismUiBridge(null);
  });

  it('add_body: ONE execute, the section row is opened first, the afterglow lands on THAT body row only', async () => {
    const expanded: string[] = [];
    const unregister = registerMechanismRowExpander((t) => { expanded.push(t); return true; });
    mountButton(bodyRowKey('Asset/L1'));
    mountButton(bodyRowKey('Asset/L2'));
    try {
      const spy = vi.spyOn(commandRegistry, 'execute');
      let res: Record<string, unknown> = {};
      const phases = await watchPhases(bodyRowKey('Asset/L1'), async () => {
        res = await env.call('web_editor_mechanism_add_body', { path: 'Asset/L1' });
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe('mechanism.addBody');
      expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp', buttonKey: 'mech.body-row:Asset/L1' });
      if (!__RV_HAS_PRIVATE__) {
        expect(res).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
        expect(phases).toEqual([]);
        return;
      }
      expect(res).toMatchObject({ ok: true, path: 'Asset/L1', densityPreset: 'steel', densityKgM3: 7850 });
      expect(hasBody('Asset/L1')).toBe(true);
      expect(expanded).toContain('Asset/L1'); // opened BEFORE the press
      expect(phases).toEqual(['hover', 'pressed', 'afterglow']);
      expect(getButtonSimPhase(bodyRowKey('Asset/L2'))).toBeNull(); // the other row stays dark
      expect(mech.rebuilt).toEqual(['Asset']);
    } finally {
      unregister();
    }
  }, 15000);

  it('world-anchored side A: pickJson + assignBody:false keeps Body A absent; the default assigns the picked part; one undo step each', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    const pickJson = JSON.stringify({ nodePath: 'Asset/L2', worldPosition: [0.1, 0.2, 0], worldNormal: [0, 0, 1] });
    const kept = await env.call('web_editor_mechanism_set_anchor_snap', {
      path: 'Asset/J', componentType: 'KinematicJoint', side: 'A', pickJson, assignBody: false,
    });
    expect(kept).toMatchObject({ ok: true, side: 'A', candidate: null, body: null });
    await env.doc.whenIdle();
    expect(rv('Asset/J')['KinematicJoint']['BodyA']).toBeUndefined();
    expect(rv('Asset/J')['KinematicJoint']['AnchorA']).toBeDefined();
    const opsAfterKeep = env.doc.getSnapshot().opCount;

    const assigned = await env.call('web_editor_mechanism_set_anchor_snap', {
      path: 'Asset/J', componentType: 'KinematicJoint', side: 'A', pickJson,
    });
    expect(assigned).toMatchObject({ ok: true, body: 'Asset/L2' });
    await env.doc.whenIdle();
    expect(rv('Asset/J')['KinematicJoint']['BodyA']).toMatchObject({ path: 'Asset/L2' });

    await env.doc.undo();
    await env.doc.whenIdle();
    expect(rv('Asset/J')['KinematicJoint']['BodyA']).toBeUndefined(); // ONE step took anchor AND body
    expect(env.doc.getSnapshot().opCount).toBe(opsAfterKeep);
    await env.doc.redo();
    await env.doc.whenIdle();
    expect(rv('Asset/J')['KinematicJoint']['BodyA']).toMatchObject({ path: 'Asset/L2' });
  }, 15000);

  it('set_mass: the selection is A, the target is B — the reason is B\'s, not the selection\'s', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    env.viewer.selectionManager.select('Asset/Base'); // has a body
    const ops = env.doc.getSnapshot().opCount;
    const res = await env.call('web_editor_mechanism_set_mass', { path: 'Asset/L2', massKg: '2' });
    expect(res['error']).toBe(NEEDS_BODY);
    expect(env.doc.getSnapshot().opCount).toBe(ops);
    const ok = await env.call('web_editor_mechanism_set_mass', { path: 'Asset/Base', massKg: '2', comJson: '{"x":0,"y":5,"z":0}' });
    expect(ok).toMatchObject({ ok: true, path: 'Asset/Base', applied: ['massOverride', 'comOverride'] });
  }, 15000);

  it('statics: no body → NEEDS_ALL_BODIES, a body without a valid mass → NEEDS_VALID_MASS (no choreography); an invalid solve → STATICS_INVALID', async () => {
    mountButton(staticsKey('Asset'));
    if (!__RV_HAS_PRIVATE__) {
      expect(await env.call('web_editor_mechanism_statics', { mechanismPath: 'Asset' })).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    let res: Record<string, unknown> = {};
    let phases = await watchPhases(staticsKey('Asset'), async () => {
      res = await env.call('web_editor_mechanism_statics', { mechanismPath: 'Asset' });
    });
    expect(res['error']).toBe(NEEDS_ALL_BODIES);
    expect(phases).toEqual([]);

    // Every link has a body now, one of them without a usable mass (source `none`).
    linkOverride = [{}, { hasBody: true, hasMass: false, massSource: 'none' }, { hasBody: true, hasMass: true }];
    phases = await watchPhases(staticsKey('Asset'), async () => {
      res = await env.call('web_editor_mechanism_statics', { mechanismPath: 'Asset' });
    });
    expect(res['error']).toBe(NEEDS_VALID_MASS);
    expect(phases).toEqual([]);

    linkOverride = [{}, { hasBody: true, hasMass: true }, { hasBody: true, hasMass: true }];
    statics = {
      mechanismPath: 'Asset', status: 2, statusText: 'a link without mass', dynamicsValid: false,
      redundant: false, channels: [], joints: [],
    } as unknown as MechanismForcesSnapshot;
    phases = await watchPhases(staticsKey('Asset'), async () => {
      res = await env.call('web_editor_mechanism_statics', { mechanismPath: 'Asset' });
    });
    expect(res).toMatchObject({ error: STATICS_INVALID, status: 2 });
    expect(phases).not.toContain('afterglow'); // a failed run never glows
  }, 20000);

  it('two joint components on one node: set_limits on KinematicJoint_1 mutates only _1 and glows only its Apply', async () => {
    const k0 = 'mech.limits-apply:Asset/J#KinematicJoint';
    const k1 = 'mech.limits-apply:Asset/J#KinematicJoint_1';
    mountButton(k0);
    mountButton(k1);
    const res = await env.call('web_editor_mechanism_set_limits', {
      path: 'Asset/J', componentType: 'KinematicJoint_1', useLimits: true, lower: -10, upper: 10,
    });
    if (!__RV_HAS_PRIVATE__) {
      expect(res).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    expect(res).toMatchObject({ ok: true, path: 'Asset/J', componentType: 'KinematicJoint_1', useLimits: true, lower: -10, upper: 10 });
    await env.doc.whenIdle();
    expect(rv('Asset/J')['KinematicJoint_1']['UseLimits']).toBe(true);
    expect(rv('Asset/J')['KinematicJoint']['UseLimits']).toBe(false);
    expect(getButtonSimPhase(k1)).toBe('afterglow');
    expect(getButtonSimPhase(k0)).toBeNull();

    // The same rule the Apply button shows: lower >= upper is LIMITS_ORDER, nothing written.
    const ops = env.doc.getSnapshot().opCount;
    expect(await env.call('web_editor_mechanism_set_limits', {
      path: 'Asset/J', componentType: 'KinematicJoint', useLimits: true, lower: 10, upper: 10,
    })).toMatchObject({ error: LIMITS_ORDER });
    expect(env.doc.getSnapshot().opCount).toBe(ops);
  }, 15000);

  it('jog without componentType drives the FIRST joint key and targets its row key', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const res = await env.call('web_editor_mechanism_jog', { path: 'Asset/J', value: 12 });
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp', buttonKey: 'mech.jog:Asset/J#KinematicJoint' });
    if (!__RV_HAS_PRIVATE__) {
      expect(res).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    expect(res).toEqual({ ok: true, path: 'Asset/J', value: 12, converged: true, residualError: 0 });
    expect(mech.jogCalls).toEqual([{ path: 'Asset/J', componentType: undefined }]);
    await env.call('web_editor_mechanism_jog', { path: 'Asset/J', value: 5, componentType: 'KinematicJoint_1' });
    expect(mech.jogCalls[1]).toEqual({ path: 'Asset/J', componentType: 'KinematicJoint_1' });
  }, 15000);

  it('assign_drive: a node without a Drive is refused with the picker\'s rule; a Drive node is written', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    expect(await env.call('web_editor_mechanism_assign_drive', {
      path: 'Asset/J', componentType: 'KinematicJoint', drivePath: 'Asset/L1',
    })).toMatchObject({ error: NEEDS_DRIVE_NODE });
    expect(await env.call('web_editor_mechanism_assign_drive', {
      path: 'Asset/J', componentType: 'KinematicJoint', drivePath: 'Asset/Motor',
    })).toMatchObject({ ok: true, path: 'Asset/J', componentType: 'KinematicJoint', drive: 'Asset/Motor' });
  }, 15000);
});

// ─── plan-761: web_view_render_mode (view.renderMode) + web_status ───────

describe('web_view_render_mode through _handleCall (plan-761)', () => {
  afterEach(() => { setAppConfig({}); localStorage.removeItem('rv-visual-settings'); });

  it('dispatches view.renderMode with origin mcp and the per-mode button; web_status reports the mode', async () => {
    mountButton('view.renderMode:simple');
    const spy = vi.spyOn(commandRegistry, 'execute');
    let res: Record<string, unknown> = {};
    const phases = await watchPhases('view.renderMode:simple', async () => {
      res = await env.call('web_view_render_mode', { mode: 'simple' });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 2)).toEqual(['view.renderMode', { mode: 'simple' }]);
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp', buttonKey: 'view.renderMode:simple' });
    expect(res).toEqual({ ok: true, renderMode: 'simple', wireframe: false });
    expect(phases).toEqual(['hover', 'pressed', 'afterglow']);
    // The viewer carries the new mode and the store persisted it (the Visual tab reads it back).
    expect(env.viewer.renderMode).toBe('simple');
    expect(loadVisualSettings().renderMode).toBe('simple');
    // web_status: the VALUE, not just the property.
    const status = await env.call('web_status', {});
    expect(status).toMatchObject({ renderMode: 'simple', wireframe: false });
  }, 15000);

  it("refuses 'wireframe' and unknown modes with the rule text, dispatching once and glowing nothing", async () => {
    mountButton('view.renderMode:wireframe');
    const spy = vi.spyOn(commandRegistry, 'execute');
    let res: Record<string, unknown> = {};
    const phases = await watchPhases('view.renderMode:wireframe', async () => {
      res = await env.call('web_view_render_mode', { mode: 'wireframe' });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ error: 'mode must be one of simple|default|toon' });
    expect(phases).toEqual([]); // the preflight refused: no choreography
    expect(env.viewer.renderMode).toBe('default');
  }, 15000);

  it('a locked deployment (lockSettings) refuses with the lock reason — the tooltip text, nothing changes', async () => {
    setAppConfig({ lockSettings: true });
    const spy = vi.spyOn(commandRegistry, 'execute');
    const res = await env.call('web_view_render_mode', { mode: 'toon' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ error: RENDER_MODE_LOCKED });
    expect(commandRegistry.enabled('view.renderMode', { mode: 'toon' }, env.viewer)).toEqual({ reason: RENDER_MODE_LOCKED });
    expect(env.viewer.renderMode).toBe('default');
    // lockedTabs: ['visual'] is the same lock for this command.
    setAppConfig({ lockedTabs: ['visual'] });
    expect(await env.call('web_view_render_mode', { mode: 'toon' })).toEqual({ error: RENDER_MODE_LOCKED });
    expect(env.viewer.renderMode).toBe('default');
  }, 15000);
});

// ─── plan-591: web_view_visual_preset (view.visualPreset) + web_status ───

describe('web_view_visual_preset through _handleCall (plan-591)', () => {
  /** Inject a browser-local preset — the tier that must NOT win for `shipped`. */
  const putLocalPreset = (p: VisualPreset): void => {
    const raw = localStorage.getItem('rv-visual-presets');
    const arr: VisualPreset[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem('rv-visual-presets', JSON.stringify([...arr.filter((x) => x.name !== p.name), p]));
  };

  beforeEach(async () => {
    localStorage.removeItem('rv-visual-presets');
    // Vite serves public/presets in browser mode, so this is the REAL tier.
    await loadPublishedPresets();
  });
  afterEach(() => {
    setAppConfig({});
    localStorage.removeItem('rv-visual-settings');
    localStorage.removeItem('rv-visual-presets');
  });

  it('dispatches view.visualPreset with origin mcp and the per-name button; web_status reports the preset', async () => {
    mountButton('view.visualPreset:Fast');
    const spy = vi.spyOn(commandRegistry, 'execute');
    let res: Record<string, unknown> = {};
    const phases = await watchPhases('view.visualPreset:Fast', async () => {
      res = await env.call('web_view_visual_preset', { name: 'Fast' });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('view.visualPreset');
    expect(spy.mock.calls[0][1]).toMatchObject({ name: 'Fast' });
    expect(spy.mock.calls[0][2]).toMatchObject({ origin: 'mcp', buttonKey: 'view.visualPreset:Fast' });
    expect(res).toMatchObject({ ok: true, name: 'Fast', source: 'shipped' });
    expect(res).toHaveProperty('antialiasNeedsReload');
    // The hover/press pre-choreography lives in the private sibling
    // (`@rv-private/.../button-sim-store`); the community stub's
    // `simulateButtonClick` is an inert no-op, so only the afterglow is
    // observable there. What holds in BOTH editions is that the afterglow lands
    // on THIS row's key — one of the two keys the trigger proxies.
    expect(phases).toEqual(__RV_HAS_PRIVATE__ ? ['hover', 'pressed', 'afterglow'] : ['afterglow']);
    expect(matchPreset(listShippedPresets())).toBe('Fast');

    // F7 + F14: both new status fields, by VALUE.
    const status = await env.call('web_status', {});
    expect(status).toMatchObject({ visualPreset: 'Fast' });
    expect(status['antialiasActive']).toBe(env.viewer.antialiasActive);
  }, 20000);

  it('web_status reports visualPreset null on "Custom"', async () => {
    await env.call('web_view_visual_preset', { name: 'Default' });
    saveVisualSettings({ ...loadVisualSettings(), shadowRadius: 4 });
    expect(await env.call('web_status', {})).toMatchObject({ visualPreset: null });
  }, 20000);

  it('an unknown name is refused with the rule text, and nothing is applied', async () => {
    const before = JSON.stringify(loadVisualSettings());
    const res = await env.call('web_view_visual_preset', { name: 'Nope' });
    expect(res['error']).toMatch(/name must be one of/);
    expect(res['error']).toMatch(/Default/);
    expect(JSON.stringify(loadVisualSettings())).toBe(before);
  }, 20000);

  it('a locked deployment refuses with the SAME reason as the render mode', async () => {
    setAppConfig({ lockSettings: true });
    expect(await env.call('web_view_visual_preset', { name: 'Default' }))
      .toEqual({ error: RENDER_MODE_LOCKED });
    setAppConfig({ lockedTabs: ['visual'] });
    expect(await env.call('web_view_visual_preset', { name: 'Default' }))
      .toEqual({ error: RENDER_MODE_LOCKED });
  }, 20000);

  it("F12: source 'shipped' with a LOCAL-only name is refused, not substituted", async () => {
    putLocalPreset({
      name: 'MyOwn', schemaVersion: 1,
      settings: { maxDpr: 0.5 } as unknown as VisualPreset['settings'],
    });
    // Reachable through the generic path …
    expect(await env.call('web_view_visual_preset', { name: 'MyOwn', source: 'any' }))
      .toMatchObject({ ok: true, name: 'MyOwn', source: 'local' });
    // … and refused for the fixed rows, with the refusal derived from the
    // SHIPPED list — `enabled()` and `run()` check the very same set.
    const res = await env.call('web_view_visual_preset', { name: 'MyOwn', source: 'shipped' });
    expect(res['error']).toMatch(/name must be one of/);
    expect(res['error']).not.toMatch(/MyOwn/);
  }, 20000);
});

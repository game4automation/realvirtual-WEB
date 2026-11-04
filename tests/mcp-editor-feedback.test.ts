// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { setAiClicks } from '../src/core/hmi/ai-click-choreography-store';
beforeEach(() => setAiClicks(true));
afterEach(() => setAiClicks(true));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerspectiveCamera, Mesh, BoxGeometry, MeshBasicMaterial, Object3D } from 'three';
import { UserActivity } from '../src/core/rv-user-activity';
import { choreographyToolOf } from '../src/plugins/mcp-bridge/rv-mcp-command-choreography';
import { _resetFollowForTest } from '../src/plugins/mcp-bridge/rv-mcp-follow-policy';
import { setFollowAgent, _resetFollowAgentForTest } from '../src/core/hmi/follow-agent-store';
import { MCP_FOLLOW_AGENT_KEY } from '../src/core/hmi/rv-storage-keys';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  applyEditorFeedback,
  prepareEditorChoreography,
  _resetFrameThrottleForTest,
} from '../src/plugins/mcp-bridge/rv-mcp-editor-feedback';
import {
  getButtonSimSnapshot,
  _setSimTimingsForTest,
} from '@rv-private/plugins/asset-editor/shared/button-sim-store';
import { getAiTouches, _resetButtonSimStateForTest } from '../src/core/hmi/button-sim-state';
import {
  getInspectorFieldReveal,
  inspectorFieldKey,
  _resetInspectorFieldRevealForTest,
} from '../src/core/hmi/inspector-field-touch';

interface FakeViewer {
  viewer: RVViewer;
  selectPaths: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  flash: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  fitToNodes: ReturnType<typeof vi.fn>;
  setSelection: (paths: string[]) => void;
  setPanelOpen: (open: boolean) => void;
}

function makeViewer(nodes: Record<string, Object3D>): FakeViewer {
  let selectedPaths: string[] = [];
  let panelOpen = false;
  const selectPaths = vi.fn((p: string[]) => { selectedPaths = [...p]; });
  const clear = vi.fn(() => { selectedPaths = []; });
  const flash = vi.fn();
  const open = vi.fn(() => { panelOpen = true; });
  const fitToNodes = vi.fn();
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const viewer = {
    registry: { getNode: (p: string) => nodes[p] ?? null },
    selectionManager: {
      getSnapshot: () => ({ selectedPaths }),
      selectPaths,
      clear,
    },
    leftPanelManager: {
      isOpen: () => panelOpen,
      open,
    },
    highlighter: { flash },
    camera,
    fitToNodes,
  } as unknown as RVViewer;
  return {
    viewer, selectPaths, clear, flash, open, fitToNodes,
    setSelection: (p) => { selectedPaths = [...p]; },
    setPanelOpen: (o) => { panelOpen = o; },
  };
}

function meshAt(x: number, y: number, z: number): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.position.set(x, y, z);
  m.updateMatrixWorld(true);
  return m;
}

describe('applyEditorFeedback', () => {
  beforeEach(() => {
    _resetFrameThrottleForTest();
  });

  it('does nothing for unknown tools', () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    applyEditorFeedback(f.viewer, 'web_editor_verify_drive', { path: 'A' }, '{"ok":true}');
    expect(f.selectPaths).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('does nothing when the result carries an error', () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    applyEditorFeedback(f.viewer, 'web_editor_to_ground', { path: 'A' }, '{"error":"nope"}');
    expect(f.selectPaths).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('selects the acted-on node and opens the kinematics panel', () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    applyEditorFeedback(f.viewer, 'web_editor_to_ground', { path: 'A' }, '{"ok":true}');
    expect(f.selectPaths).toHaveBeenCalledWith(['A']);
    expect(f.open).toHaveBeenCalled();
    expect(f.open.mock.calls[0][0]).toBe('kinematics');
  });

  it('does not reopen an already-open panel and does not reselect the same set', () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    f.setSelection(['A']);
    f.setPanelOpen(true);
    applyEditorFeedback(f.viewer, 'web_editor_set_field', { path: 'A' }, '{"ok":true}');
    expect(f.selectPaths).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.flash).not.toHaveBeenCalled(); // no pulsing highlight — ever
  });

  it('clears the selection on delete', () => {
    const f = makeViewer({});
    applyEditorFeedback(f.viewer, 'web_editor_delete', { paths: 'A,B' }, '{"ok":true}');
    expect(f.clear).toHaveBeenCalled();
  });

  it('uses the result path for rename (node exists under the NEW path)', () => {
    const f = makeViewer({ 'Root/New': meshAt(0, 0, 0) });
    applyEditorFeedback(f.viewer, 'web_editor_rename',
      { path: 'Root/Old', name: 'New' }, '{"ok":true,"path":"Root/New"}');
    expect(f.selectPaths).toHaveBeenCalledWith(['Root/New']);
  });

  it('frames only offscreen targets and throttles repeat framing', () => {
    let t = 0;
    _resetFrameThrottleForTest(() => t);
    const f = makeViewer({ On: meshAt(0, 0, 0), Off: meshAt(500, 0, 0) });
    // On-screen: no camera move.
    applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'On' }, '{"ok":true}');
    expect(f.fitToNodes).not.toHaveBeenCalled();
    // Offscreen: framed once.
    applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'Off' }, '{"ok":true}');
    expect(f.fitToNodes).toHaveBeenCalledTimes(1);
    // Within the throttle window: no second move.
    t = 2000;
    applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'Off' }, '{"ok":true}');
    expect(f.fitToNodes).toHaveBeenCalledTimes(1);
    // After the window: framed again.
    t = 6000;
    applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'Off' }, '{"ok":true}');
    expect(f.fitToNodes).toHaveBeenCalledTimes(2);
  });

  it('extracts materialize sample paths and opens the materials panel', () => {
    const f = makeViewer({ 'M/1': meshAt(0, 0, 0) });
    const args = { assignmentsJson: JSON.stringify([{ samplePath: 'M/1', presetId: 'steel' }]) };
    applyEditorFeedback(f.viewer, 'web_editor_materialize', args, '{"ok":true,"applied":[]}');
    expect(f.open.mock.calls[0][0]).toBe('materials');
    expect(f.flash).not.toHaveBeenCalled(); // no pulsing highlight — ever
    expect(f.selectPaths).not.toHaveBeenCalled(); // select:false for materialize
  });

  it('survives non-JSON results (image payloads) without throwing', () => {
    const f = makeViewer({});
    expect(() =>
      applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'A' }, 'not-json'),
    ).not.toThrow();
  });
});

describe('prepareEditorChoreography', () => {
  it('selects the target, opens the panel and walks the button through hover → pressed → release', async () => {
    _setSimTimingsForTest(10, 10);
    const el = document.createElement('button');
    el.setAttribute('data-rv-button-id', 'qe.to-ground');
    document.body.appendChild(el);
    try {
      const f = makeViewer({ A: meshAt(0, 0, 0) });
      const phases: (string | null)[] = [];
      const probe = setInterval(() => {
        const s = getButtonSimSnapshot();
        if (s && phases[phases.length - 1] !== s.phase) phases.push(s.phase);
      }, 2);
      // plan-499: the button comes from the call context (the bound command's key).
      await prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' }, 'qe.to-ground');
      clearInterval(probe);
      expect(f.selectPaths).toHaveBeenCalledWith(['A']);
      expect(f.open.mock.calls[0][0]).toBe('kinematics');
      expect(phases).toEqual(['hover', 'pressed']);
      expect(getButtonSimSnapshot()).toBeNull(); // released
    } finally {
      el.remove();
    }
  });

  it('without a button key (unbound tool / no branch) it selects and opens the panel but presses nothing', async () => {
    _setSimTimingsForTest(10, 10);
    const el = document.createElement('button');
    el.setAttribute('data-rv-button-id', 'qe.to-ground');
    document.body.appendChild(el);
    try {
      const f = makeViewer({ A: meshAt(0, 0, 0) });
      const phases: string[] = [];
      const probe = setInterval(() => { const s = getButtonSimSnapshot(); if (s) phases.push(s.phase); }, 2);
      await prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' });
      clearInterval(probe);
      expect(f.selectPaths).toHaveBeenCalledWith(['A']);
      expect(f.open.mock.calls[0][0]).toBe('kinematics');
      expect(phases).toEqual([]); // no buttonId table any more — nothing to press
    } finally {
      el.remove();
    }
  });

  it('resolves without dwell when the button is not in the DOM and never throws', async () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    // plan-520: a viewer without an activity clock never counts as idle → 'fallback'.
    await expect(
      prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' }, 'qe.to-ground'),
    ).resolves.toBe('fallback');
    expect(getButtonSimSnapshot()).toBeNull();
  });
});

// ─── Inspector field writes (editor.setField / component.setFields) ──

function componentFieldsFeedbackKey(): string {
  const key = choreographyToolOf('component.setFields', new Map());
  expect(key).toBe('web_component_set');
  return key!;
}

/** A fake extras editor on top of the fake viewer: records how the inspector was opened. */
function withEditor(f: FakeViewer, snap: { panelOpen: boolean; showInspector: boolean; selectedNodePath: string | null }) {
  const selectNode = vi.fn((p: string, show: boolean) => { snap.selectedNodePath = p; snap.showInspector = show; });
  const selectAndReveal = vi.fn((p: string, show: boolean) => { snap.selectedNodePath = p; snap.showInspector = show; snap.panelOpen = true; });
  (f.viewer as unknown as { getPlugin: (id: string) => unknown }).getPlugin = (id: string) =>
    id === 'rv-extras-editor' ? { getSnapshot: () => ({ ...snap }), selectNode, selectAndReveal } : undefined;
  return { selectNode, selectAndReveal };
}

describe('inspector field choreography', () => {
  let widthSpy: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    _resetButtonSimStateForTest();
    _resetInspectorFieldRevealForTest();
    // Desktop layout: the compact (<900 px) layout has no docked inspector.
    widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  });
  afterEach(() => { widthSpy?.mockRestore(); });

  it('web_editor_set_field opens the inspector (hierarchy closed → reveal), requests the field and presses its row', async () => {
    _setSimTimingsForTest(10, 10);
    const key = inspectorFieldKey('A', 'Drive', 'TargetSpeed');
    const row = document.createElement('div');
    row.setAttribute('data-rv-button-id', key);
    document.body.appendChild(row);
    try {
      const f = makeViewer({ A: meshAt(0, 0, 0) });
      const ed = withEditor(f, { panelOpen: false, showInspector: false, selectedNodePath: null });
      const phases: string[] = [];
      const probe = setInterval(() => {
        const s = getButtonSimSnapshot();
        if (s && s.id === key && phases[phases.length - 1] !== s.phase) phases.push(s.phase);
      }, 2);
      await prepareEditorChoreography(
        f.viewer, 'web_editor_set_field',
        { path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '500' }, key,
      );
      clearInterval(probe);
      expect(ed.selectAndReveal).toHaveBeenCalledWith('A', true);
      expect(f.open).not.toHaveBeenCalled(); // no Quick Edit panel for a field write
      expect(getInspectorFieldReveal()).toMatchObject({ path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed' });
      expect(phases).toEqual(['hover', 'pressed']);
    } finally {
      row.remove();
    }
  });

  it('component.setFields presses the first field row itself and keeps an open hierarchy', async () => {
    _setSimTimingsForTest(10, 10);
    const key = inspectorFieldKey('A', 'Source', 'Interval');
    const row = document.createElement('div');
    row.setAttribute('data-rv-button-id', key);
    document.body.appendChild(row);
    try {
      const f = makeViewer({ A: meshAt(0, 0, 0) });
      const ed = withEditor(f, { panelOpen: true, showInspector: false, selectedNodePath: null });
      const phases: string[] = [];
      const probe = setInterval(() => { const s = getButtonSimSnapshot(); if (s && phases[phases.length - 1] !== s.phase) phases.push(s.phase); }, 2);
      await prepareEditorChoreography(f.viewer, componentFieldsFeedbackKey(), { path: 'A', type: 'Source', props: '{"Interval":2,"Enabled":true}' });
      clearInterval(probe);
      expect(ed.selectNode).toHaveBeenCalledWith('A', true);
      expect(ed.selectAndReveal).not.toHaveBeenCalled();
      expect(phases).toEqual(['hover', 'pressed']);
    } finally {
      row.remove();
    }
  });

  it('presses nothing when the field row never renders (custom renderer / filtered) and never throws', async () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    withEditor(f, { panelOpen: true, showInspector: true, selectedNodePath: 'A' });
    await expect(prepareEditorChoreography(
      f.viewer, 'web_editor_set_field', { path: 'A', componentType: 'Drive', fieldName: 'Nope', valueJson: '1' },
      inspectorFieldKey('A', 'Drive', 'Nope'),
    )).resolves.toBe('fallback');
    expect(getButtonSimSnapshot()).toBeNull();
  });

  it('component.setFields leaves the afterglow on every APPLIED field, not on rejected ones', () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    applyEditorFeedback(
      f.viewer, componentFieldsFeedbackKey(), { path: 'A', type: 'Source', props: '{"Interval":2,"Bogus":1}' },
      JSON.stringify({ path: 'A', type: 'Source', applied: { Interval: 2 }, rejected: [{ field: 'Bogus', reason: 'Unknown field' }] }),
    );
    expect(getAiTouches().map((t) => t.buttonKey)).toEqual([inspectorFieldKey('A', 'Source', 'Interval')]);
    expect(f.selectPaths).toHaveBeenCalledWith(['A']);
  });
});

// ─── plan-520: Follow agent ─────────────────────────────────────────────

function smallMeshAt(x: number, y: number, z: number): Mesh {
  const m = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshBasicMaterial());
  m.position.set(x, y, z);
  m.updateMatrixWorld(true);
  return m;
}

/** Give the fake viewer what the follow policy reads: activity clock, follow mode, renderer. */
function withFollow(f: FakeViewer, clock: () => number, extra: Record<string, unknown> = {}): UserActivity {
  const activity = new UserActivity();
  activity._setClockForTest(clock);
  Object.assign(f.viewer as unknown as Record<string, unknown>, {
    userActivity: activity,
    cameraFollowMode: 'off',
    renderer: { xr: { isPresenting: false } },
    ...extra,
  });
  return activity;
}

function followCalls(f: FakeViewer): unknown[][] {
  return f.fitToNodes.mock.calls.filter((c) => (c[2] as { tag?: string } | undefined)?.tag === 'follow-agent');
}

describe('follow agent (plan-520)', () => {
  let t = 100_000;
  let widthSpy: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    t = 100_000;
    localStorage.removeItem(MCP_FOLLOW_AGENT_KEY);
    _resetFollowAgentForTest();
    _resetFollowForTest(() => t);
    _resetFrameThrottleForTest(() => t);
    _resetInspectorFieldRevealForTest();
    widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  });
  afterEach(() => {
    widthSpy?.mockRestore();
    localStorage.removeItem(MCP_FOLLOW_AGENT_KEY);
    _resetFollowAgentForTest();
  });

  it('idle + component.setFields on a small node flies once, tagged, BEFORE the tool runs', async () => {
    const f = makeViewer({ A: smallMeshAt(0, 0, 0) });
    withFollow(f, () => t);
    const decision = await prepareEditorChoreography(
      f.viewer, componentFieldsFeedbackKey(), { path: 'A', type: 'Source', props: '{"Interval":2}' },
    );
    // The pre phase already flew — the tool body has not run yet.
    expect(decision).toBe('fly');
    expect(f.fitToNodes).toHaveBeenCalledTimes(1);
    expect(f.fitToNodes.mock.calls[0][2]).toMatchObject({ tag: 'follow-agent', easing: 'easeInOut' });
    expect(f.selectPaths).toHaveBeenCalledWith(['A']);
    applyEditorFeedback(f.viewer, componentFieldsFeedbackKey(), { path: 'A', type: 'Source', props: '{"Interval":2}' },
      JSON.stringify({ path: 'A', applied: { Interval: 2 } }), decision);
    expect(f.fitToNodes).toHaveBeenCalledTimes(1);
  });

  it('a series of writes to the same node flies exactly once', async () => {
    const f = makeViewer({ A: smallMeshAt(0, 0, 0) });
    withFollow(f, () => t);
    for (let i = 0; i < 3; i++) {
      await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'A' });
      t += 2000; // past the cooldown — only the same-target rule holds the camera
    }
    expect(followCalls(f)).toHaveLength(1);
  });

  it('A → (user uses the view, idle again) → A flies again; A → A without input does not', async () => {
    const f = makeViewer({ A: smallMeshAt(0, 0, 0) });
    const activity = withFollow(f, () => t);
    await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'A' });
    expect(followCalls(f)).toHaveLength(1);
    t += 2000; // past the cooldown, no user input → same-target rule holds
    await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'A' });
    expect(followCalls(f)).toHaveLength(1);
    activity.markUserInput(t); // user orbits away …
    t += 3500; // … and is idle again (> 3 s, > cooldown)
    await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'A' });
    expect(followCalls(f)).toHaveLength(2);
  });

  it('A → B → A flies again to A, A → A never', async () => {
    const f = makeViewer({ A: smallMeshAt(0, 0, 0), B: smallMeshAt(1, 0, 0) });
    withFollow(f, () => t);
    for (const p of ['A', 'A', 'B', 'A']) {
      await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: p });
      t += 2000;
    }
    expect(followCalls(f)).toHaveLength(3);
  });

  it('user active → no flight for component.setFields; offscreen transform falls back to frameIfHelpful', async () => {
    const f = makeViewer({ A: smallMeshAt(0, 0, 0), Off: meshAt(500, 0, 0) });
    const activity = withFollow(f, () => t);
    activity.markUserInput(t - 1000);
    const d1 = await prepareEditorChoreography(f.viewer, componentFieldsFeedbackKey(), { path: 'A', type: 'Source', props: '{"Interval":2}' });
    expect(d1).toBe('fallback');
    expect(f.fitToNodes).not.toHaveBeenCalled();
    const d2 = await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'Off' });
    expect(d2).toBe('fallback');
    applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'Off' }, '{"ok":true}', d2);
    expect(f.fitToNodes).toHaveBeenCalledTimes(1);
    expect(followCalls(f)).toHaveLength(0); // the old, untagged offscreen framing
  });

  it('a pre-flight suppresses the post frameIfHelpful of the same call', async () => {
    const f = makeViewer({ Off: meshAt(500, 0, 0) });
    withFollow(f, () => t);
    const d = await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'Off' });
    expect(d).toBe('fly');
    applyEditorFeedback(f.viewer, 'web_editor_transform', { path: 'Off' }, '{"ok":true}', d);
    expect(f.fitToNodes).toHaveBeenCalledTimes(1);
  });

  it('toggle off → exactly the pre-plan-520 fitToNodes calls', async () => {
    setFollowAgent(false);
    const run = async (withActivity: boolean) => {
      _resetFrameThrottleForTest(() => t);
      _resetFollowForTest(() => t);
      const f = makeViewer({ On: smallMeshAt(0, 0, 0), Off: meshAt(500, 0, 0) });
      if (withActivity) withFollow(f, () => t);
      for (const p of ['On', 'Off', 'Off']) {
        const d = await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: p });
        applyEditorFeedback(f.viewer, 'web_editor_transform', { path: p }, '{"ok":true}', d);
      }
      return f.fitToNodes.mock.calls.map((c) => [(c[0] as Object3D[]).length, c[2]]);
    };
    const legacy = await run(false); // a viewer the follow policy cannot see = today's behaviour
    const off = await run(true);
    expect(off).toEqual(legacy);
    expect(off).toHaveLength(1);
    expect(off[0][1]).toEqual({ duration: 0.7, easing: 'easeInOut' });
  });

  it('web_drive_jog {name} selects the drive node and flies to it', async () => {
    const node = smallMeshAt(2, 0, 0);
    const f = makeViewer({ 'Line/Conveyor': node });
    withFollow(f, () => t, {
      drives: [{ name: 'Other', node: new Object3D() }, { name: 'Conveyor', node }],
    });
    (f.viewer.registry as unknown as { getPathForNode: (n: Object3D) => string | null }).getPathForNode =
      (n: Object3D) => (n === node ? 'Line/Conveyor' : null);
    const d = await prepareEditorChoreography(f.viewer, 'web_drive_jog', { name: 'Conveyor', forward: true });
    expect(d).toBe('fly');
    expect(f.selectPaths).toHaveBeenCalledWith(['Line/Conveyor']);
    expect(followCalls(f)).toHaveLength(1);
    expect(f.open).not.toHaveBeenCalled(); // no right-dock panel for a runtime drive
  });

  it('web_drive_stop with an unknown drive name does nothing and never throws', async () => {
    const f = makeViewer({});
    withFollow(f, () => t, { drives: [] });
    await expect(prepareEditorChoreography(f.viewer, 'web_drive_stop', { name: 'Nope' })).resolves.toBeUndefined();
    expect(f.fitToNodes).not.toHaveBeenCalled();
    expect(f.selectPaths).not.toHaveBeenCalled();
  });

  it('a result-addressed tool follows post; an {error} result does not', () => {
    const f = makeViewer({ 'Root/New': meshAt(500, 0, 0) });
    withFollow(f, () => t);
    applyEditorFeedback(f.viewer, 'web_editor_create_empty', { name: 'New' }, '{"error":"no document"}');
    expect(f.fitToNodes).not.toHaveBeenCalled();
    applyEditorFeedback(f.viewer, 'web_editor_create_empty', { name: 'New' }, '{"ok":true,"path":"Root/New"}');
    expect(followCalls(f)).toHaveLength(1);
  });

  it('property inspector not available (compact width) → flight + selection, no reveal', async () => {
    widthSpy?.mockRestore();
    widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500);
    const f = makeViewer({ A: smallMeshAt(0, 0, 0) });
    withFollow(f, () => t);
    const ed = withEditor(f, { panelOpen: false, showInspector: false, selectedNodePath: null });
    const d = await prepareEditorChoreography(
      f.viewer, 'web_editor_set_field',
      { path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '500' },
      inspectorFieldKey('A', 'Drive', 'TargetSpeed'),
    );
    expect(d).toBe('fly');
    expect(f.selectPaths).toHaveBeenCalledWith(['A']);
    expect(followCalls(f)).toHaveLength(1);
    expect(ed.selectAndReveal).not.toHaveBeenCalled();
    expect(ed.selectNode).not.toHaveBeenCalled();
    expect(getInspectorFieldReveal()).toBeNull();
  });

  it('a simulated button click dispatches no pointerdown (it can never count as viewport use)', async () => {
    _setSimTimingsForTest(10, 10);
    const el = document.createElement('button');
    el.setAttribute('data-rv-button-id', 'qe.to-ground');
    document.body.appendChild(el);
    const seen: string[] = [];
    const onPointer = (e: Event) => { seen.push(e.type); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('mousedown', onPointer, true);
    try {
      const f = makeViewer({ A: meshAt(0, 0, 0) });
      await prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' }, 'qe.to-ground');
      expect(seen).toEqual([]);
    } finally {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('mousedown', onPointer, true);
      el.remove();
    }
  });

  it('never flies while the camera rides a follow / sit-on source', async () => {
    const f = makeViewer({ A: smallMeshAt(0, 0, 0) });
    withFollow(f, () => t, { cameraFollowMode: 'follow' });
    const d = await prepareEditorChoreography(f.viewer, 'web_editor_transform', { path: 'A' });
    expect(d).toBe('none');
    expect(f.fitToNodes).not.toHaveBeenCalled();
  });
});


describe('AI clicks disabled', () => {
  afterEach(async () => {
    const { setAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
    setAiClicks(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('keeps selection and panel opening without timers', async () => {
    const { setAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
    setAiClicks(false);
    vi.useFakeTimers();
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    await prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' }, 'qe.to-ground');
    expect(f.selectPaths).toHaveBeenCalledWith(['A']);
    expect(f.open).toHaveBeenCalled();
    expect(getButtonSimSnapshot()).toBeNull();
  });
  it('opens the closed inspector and requests its field without waiting for DOM', async () => {
    const { setAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
    setAiClicks(false);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    _resetInspectorFieldRevealForTest();
    vi.useFakeTimers();
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    const ed = withEditor(f, { panelOpen: false, showInspector: false, selectedNodePath: null });
    await prepareEditorChoreography(f.viewer, 'web_editor_set_field', { path: 'A', componentType: 'Drive', fieldName: 'TargetSpeed', valueJson: '500' });
    expect(ed.selectAndReveal).toHaveBeenCalledWith('A', true);
    expect(getInspectorFieldReveal()).not.toBeNull();
  });
  it('skips the non-editor click without timers', async () => {
    const { setAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
    const { prepareCommandChoreography } = await import('../src/plugins/mcp-bridge/rv-mcp-editor-feedback');
    setAiClicks(false);
    vi.useFakeTimers();
    await prepareCommandChoreography('sim.play');
    expect(vi.getTimerCount()).toBe(0);
  });
});


it('AI click preference preserves the follow verdict and successful field afterglow', async () => {
  const { setAiClicks } = await import('../src/core/hmi/ai-click-choreography-store');
  const args = { path: 'A', type: 'Source', props: '{"Interval":2}' };
  const decisions: unknown[] = [];
  setFollowAgent(true);
  try {
    for (const on of [true, false]) {
      setAiClicks(on);
      _resetFollowForTest(() => 100000);
      const f = makeViewer({ A: smallMeshAt(0, 0, 0) });
      withFollow(f, () => 100000);
      const decision = await prepareEditorChoreography(f.viewer, componentFieldsFeedbackKey(), args);
      decisions.push(decision);
      expect(followCalls(f)).toHaveLength(1);
      _resetButtonSimStateForTest();
      applyEditorFeedback(f.viewer, componentFieldsFeedbackKey(), args, '{"applied":{"Interval":2}}', decision);
      expect(getAiTouches().length).toBeGreaterThan(0);
      expect(f.selectPaths).toHaveBeenCalledWith(['A']);
    }
    expect(decisions).toEqual(['fly', 'fly']);
  } finally { setAiClicks(true); }
});

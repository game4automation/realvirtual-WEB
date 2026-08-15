// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerspectiveCamera, Mesh, BoxGeometry, MeshBasicMaterial, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  applyEditorFeedback,
  prepareEditorChoreography,
  _resetFrameThrottleForTest,
} from '../src/plugins/mcp-bridge/rv-mcp-editor-feedback';
import {
  getButtonSimSnapshot,
  _setSimTimingsForTest,
} from '@rv-private/plugins/asset-editor/button-sim-store';

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
      await prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' });
      clearInterval(probe);
      expect(f.selectPaths).toHaveBeenCalledWith(['A']);
      expect(f.open.mock.calls[0][0]).toBe('kinematics');
      expect(phases).toEqual(['hover', 'pressed']);
      expect(getButtonSimSnapshot()).toBeNull(); // released
    } finally {
      el.remove();
    }
  });

  it('resolves without dwell when the button is not in the DOM and never throws', async () => {
    const f = makeViewer({ A: meshAt(0, 0, 0) });
    await expect(
      prepareEditorChoreography(f.viewer, 'web_editor_to_ground', { path: 'A' }),
    ).resolves.toBeUndefined();
    expect(getButtonSimSnapshot()).toBeNull();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraFollowPlugin lifecycle tests (plan-221 §9.5): mode toggle, exclusivity
 * guards (FPV / deselection), and camera-mode-changed emission. Plan-2030 §9.6
 * uses real camera/selection managers and plugins behind a thin viewer facade.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { CameraFollowPlugin } from '../src/plugins/camera-follow-plugin';
import { AgentEyePlugin } from '../src/plugins/agent-eye-plugin';
import { EventEmitter } from '../src/core/rv-events';
import { SelectionManager } from '../src/core/engine/rv-selection-manager';
import type { CameraManager, CameraFollowOwner } from '../src/core/rv-camera-manager';
import type { FollowSource } from '../src/core/engine/rv-follow-source';
import { makeTestCameraManager } from './helpers/camera-test-harness';

const cleanups: Array<() => void> = [];

function createTestViewer() {
  const cm = makeTestCameraManager();
  const real = cm as unknown as CameraManager;
  const events = new EventEmitter();
  const selectionManager = new SelectionManager();
  const scene = new Scene();
  const node = new Object3D();
  scene.add(node);
  cm.camera.position.set(3, 2, 5);

  const viewer = {
    scene,
    controls: cm.controls,
    get camera() { return cm.camera; },
    renderer: { domElement: document.createElement('canvas'), xr: { isPresenting: false } },
    registry: { getNode: (p: string) => (p === 'Part/A' ? node : null), getPathForNode: () => 'Part/A' },
    selectionManager,
    highlighter: { clearSelection() {}, highlightSelection() {} },
    currentModelUrl: '/models/CameraFollowRegression.glb',
    fov: 50,
    projection: 'perspective',
    getCameraState: () => ({ position: cm.camera.position.clone(), target: cm.controls.target.clone() }),
    markRenderDirty() {},
    getPlugin: vi.fn((_id: string): unknown => undefined),
    get cameraFollowMode() { return real.followMode; },
    get cameraFollowOwner() { return real.followOwner; },
    get cameraFollowSource() { return real.followSource; },
    startCameraFollow: vi.fn((src: FollowSource, owner?: CameraFollowOwner) => real.startFollow(src, owner)),
    startCameraSitOn: vi.fn((src: FollowSource, seat?: Vector3, owner?: CameraFollowOwner) => real.startSitOn(src, seat, owner)),
    stopCameraFollow: vi.fn((restore?: boolean) => real.stopFollowMode(restore)),
    applyCameraLookDelta: (dx: number, dy: number) => real.applyLookDelta(dx, dy),
    emit: events.emit.bind(events),
    on: events.on.bind(events),
    /** Test helper: change selection and emit selection-changed. */
    setPrimary(p: string | null) {
      if (p) selectionManager.select(p);
      else selectionManager.clear();
    },
  };
  // Match RVViewer's CameraManager hook, including the public off -> null mapping.
  real.onFollowModeChanged = (mode) => viewer.emit('camera-mode-changed', { mode: mode === 'off' ? null : mode });
  selectionManager.init(viewer as never);
  return { viewer, cm, real, node };
}

function setup() {
  const plugin = new CameraFollowPlugin();
  const harness = createTestViewer();
  const { viewer } = harness;
  plugin.init(viewer as never);
  plugin.onModelLoaded({ drives: [] } as never, viewer as never);
  const agentEye = new AgentEyePlugin();
  agentEye.init(viewer as never);
  agentEye.setShowAgentEye(true);
  cleanups.push(() => {
    plugin.dispose();
    agentEye.dispose();
    viewer.selectionManager.dispose();
  });
  return { plugin, agentEye, ...harness };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

describe('CameraFollowPlugin', () => {
  it('starts inactive and is a no-op without a followable selection', () => {
    const { plugin } = setup();
    expect(plugin.mode).toBe(null);
    expect(plugin.canFollow()).toBe(false);
    plugin.toggle('follow');
    expect(plugin.mode).toBe(null);          // nothing selected → no-op
  });

  it('enters follow for a selected part and emits camera-mode-changed', () => {
    const { plugin, viewer } = setup();
    const events: (string | null)[] = [];
    viewer.on('camera-mode-changed', (e) => events.push((e as { mode: string | null }).mode));

    viewer.setPrimary('Part/A');
    expect(plugin.canFollow()).toBe(true);
    plugin.toggle('follow');

    expect(plugin.mode).toBe('follow');
    expect(viewer.startCameraFollow).toHaveBeenCalledTimes(1);
    expect(events).toContain('follow');
  });

  it('toggling the active mode twice exits', () => {
    const { plugin, viewer } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('siton');
    expect(plugin.mode).toBe('siton');
    expect(viewer.startCameraSitOn).toHaveBeenCalledTimes(1);
    plugin.toggle('siton');
    expect(plugin.mode).toBe(null);
    expect(viewer.stopCameraFollow).toHaveBeenCalled();
  });

  it('exits when FPV starts (mutual exclusivity)', () => {
    const { plugin, viewer } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('follow');
    expect(plugin.mode).toBe('follow');
    viewer.emit('fpv-enter');                 // FPV took over
    expect(plugin.mode).toBe(null);
    expect(viewer.stopCameraFollow).toHaveBeenCalled();
  });

  it('exits when the selection is lost', () => {
    const { plugin, viewer } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('follow');
    expect(plugin.mode).toBe('follow');
    viewer.setPrimary(null);                  // deselected → not followable
    expect(plugin.mode).toBe(null);
  });

  it('does not enter while an XR session is presenting', () => {
    const { plugin, viewer } = setup();
    viewer.getPlugin.mockImplementation((id: string) =>
      id === 'webxr' ? { id: 'webxr', isPresenting: true } : undefined);
    viewer.setPrimary('Part/A');
    plugin.toggle('siton');
    expect(plugin.mode).toBe(null);
    expect(viewer.startCameraSitOn).not.toHaveBeenCalled();
  });

  it('reports source death from tickFollow and can toggle follow on again', () => {
    const { plugin, viewer, cm, real, node } = setup();
    const modes: (string | null)[] = [];
    viewer.on('camera-mode-changed', (e) => modes.push((e as { mode: string | null }).mode));
    viewer.setPrimary('Part/A');
    plugin.toggle('follow');
    const oldSource = real.followSource;
    node.removeFromParent();
    cm.tickFollow(1 / 60);

    expect(plugin.mode).toBeNull();
    expect(real.followOwner).toBeNull();
    expect(real.followSource).toBeNull();
    expect(modes).toEqual(['follow', null]);
    expect(real.cameraAnim).toBeNull();

    viewer.scene.add(node);
    plugin.toggle('follow');
    expect(plugin.mode).toBe('follow');
    expect(real.followSource).not.toBe(oldSource);
    expect(real.followOwner).toBe('selection');
    expect(modes).toEqual(['follow', null, 'follow']);
  });

  it.each(['follow', 'siton'] as const)('animateCameraTo ends selection-owned %s', (mode) => {
    const { plugin, viewer, cm, real } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle(mode);
    expect(real.followOwner).toBe('selection');
    const changed = vi.fn();
    viewer.on('camera-mode-changed', changed);
    const destination = new Vector3(10, 8, 6);
    const target = new Vector3(2, 1, 0);
    real.animateCameraTo(destination, target, 0.5);

    expect(plugin.mode).toBeNull();
    expect(real.followMode).toBe('off');
    expect(real.followOwner).toBeNull();
    expect(changed).toHaveBeenCalledExactlyOnceWith({ mode: null });
    expect(cm.controls.enabled).toBe(true);
    cm.tickFollow(1 / 60);
    cm.tickCameraAnimation(0.5);
    expect(cm.camera.position.distanceTo(destination)).toBeLessThan(1e-6);
    expect(cm.controls.target.distanceTo(target)).toBeLessThan(1e-6);
  });

  it('keeps the selection subscription across model clear and reload', () => {
    const { plugin, viewer, real } = setup();
    plugin.onModelCleared(viewer as never);
    plugin.onModelLoaded({ drives: [] } as never, viewer as never);
    viewer.setPrimary('Part/A');
    plugin.toggle('follow');
    expect(plugin.mode).toBe('follow');
    viewer.selectionManager.clear();
    expect(plugin.mode).toBeNull();
    expect(real.followMode).toBe('off');
    expect(viewer.stopCameraFollow).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('selection loss and plugin exit/toggle without selection leave agent-eye attached', () => {
    const { plugin, agentEye, viewer, real } = setup();
    viewer.setPrimary('Part/A');
    expect(agentEye.attach()).toEqual({ attached: true });
    const source = real.followSource!;
    const stopped = vi.spyOn(source, 'onFollowStopped');
    expect(real.followOwner).toBe('agent-eye');
    expect(plugin.mode).toBeNull();

    viewer.selectionManager.clear();
    plugin.exit();
    plugin.toggle('follow');
    plugin.toggle('siton');

    expect(real.followSource).toBe(source);
    expect(real.followMode).toBe('follow');
    expect(real.followOwner).toBe('agent-eye');
    expect(plugin.mode).toBeNull();
    expect(agentEye.attached).toBe(true);
    expect(stopped).not.toHaveBeenCalled();
    expect(viewer.stopCameraFollow).not.toHaveBeenCalled();
  });

  it('toggle hands agent-eye follow to selection and later detach leaves selection active', () => {
    const { plugin, agentEye, viewer, cm, real } = setup();
    viewer.setPrimary('Part/A');
    expect(agentEye.attach()).toEqual({ attached: true });
    const source = real.followSource!;
    const stopped = vi.spyOn(source, 'onFollowStopped');
    expect(plugin.mode).toBeNull();
    plugin.toggle('follow');

    expect(stopped).toHaveBeenCalledTimes(1);
    expect(agentEye.attached).toBe(false);
    expect(plugin.mode).toBe('follow');
    expect(real.followOwner).toBe('selection');
    expect(real.followSource).not.toBe(source);
    expect(cm.controls.enabled).toBe(true);
    expect(real.cameraAnim).toBeNull();

    const selectionSource = real.followSource;
    agentEye.detach();
    expect(real.followSource).toBe(selectionSource);
    expect(real.followOwner).toBe('selection');
    expect(plugin.mode).toBe('follow');
    expect(viewer.stopCameraFollow).not.toHaveBeenCalled();
    expect(real.cameraAnim).toBeNull();
  });

  it('sit-on to follow releases the old source, enables orbit and never flies back', () => {
    const { plugin, viewer, cm, real, node } = setup();
    viewer.setPrimary('Part/A');
    plugin.toggle('siton');
    const previous = real.followSource!;
    previous.onFollowStopped = vi.fn();
    expect(cm.controls.enabled).toBe(false);
    cm.tickFollow(1 / 60);
    const position = cm.camera.position.clone();
    plugin.toggle('follow');

    expect(previous.onFollowStopped).toHaveBeenCalledTimes(1);
    expect(real.followSource).not.toBe(previous);
    expect(real.followOwner).toBe('selection');
    expect(plugin.mode).toBe('follow');
    expect(cm.controls.enabled).toBe(true);
    expect(real.cameraAnim).toBeNull();
    expect(cm.camera.position.equals(position)).toBe(true);

    const target = cm.controls.target.clone();
    node.position.x = 10;
    cm.tickFollow(1 / 60);
    expect(cm.controls.target.x).toBeGreaterThan(target.x);
    expect(real.cameraAnim).toBeNull();
  });
});

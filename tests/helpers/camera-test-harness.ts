// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test harness for CameraManager Follow / Sit-On modes.
 *
 * Builds a CameraManager with real PerspectiveCamera / OrthographicCamera and a
 * plain-object OrbitControls stub (same pattern as controls-facade.test.ts /
 * rv-fpv-plugin.test.ts) — no DOM, no renderer, no WebGL needed. The renderer is
 * faked to `{ xr: { isPresenting: false } }` so animateCameraTo's XR guard works.
 *
 * `makeFakeSource` wraps a test Object3D in a FollowSource whose liveness is
 * controllable via `aliveRef.alive` (default true — standalone test nodes have
 * no parent, so we don't gate on node.parent here).
 */

import { PerspectiveCamera, OrthographicCamera, Vector3, type Object3D } from 'three';
import { CameraManager } from '../../src/core/rv-camera-manager';
import { Object3DFollowSource, type FollowSource } from '../../src/core/engine/rv-follow-source';

/**
 * Minimal OrbitControls stub used by the harness.
 *
 * It grew an event surface with plan-740 (T1): the agent-eye auto-detach is the
 * THIRD `'start'` listener on these controls (rv-viewer.ts sets `_isOrbiting`,
 * GenericTooltipController closes its tooltip), so a test that cannot register
 * a listener cannot show that the three coexist. `dispatchEvent` calls every
 * listener for the type in registration order, like three's own EventDispatcher.
 */
export interface FakeOrbitControls {
  target: Vector3;
  enabled: boolean;
  object: unknown;
  update(): void;
  addEventListener(type: string, fn: (e: { type: string }) => void): void;
  removeEventListener(type: string, fn: (e: { type: string }) => void): void;
  dispatchEvent(e: { type: string }): void;
  /** Listeners currently registered per type — lets a test assert clean teardown. */
  readonly listenerCount: (type: string) => number;
}

/** Build the controls stub, including its EventDispatcher-compatible surface. */
export function makeFakeOrbitControls(object: unknown): FakeOrbitControls {
  const listeners = new Map<string, Array<(e: { type: string }) => void>>();
  return {
    target: new Vector3(),
    enabled: true,
    object,
    update() {},
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      if (!list.includes(fn)) list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(e) {
      // Copy first: a listener may remove itself (the detach path does not, but
      // relying on that would make this stub lie about three's behaviour).
      for (const fn of [...(listeners.get(e.type) ?? [])]) fn(e);
    },
    listenerCount: (type) => (listeners.get(type) ?? []).length,
  };
}

/** CameraManager surface the tests touch, plus live getters into the state. */
export interface TestCameraManager {
  readonly camera: PerspectiveCamera | OrthographicCamera;
  readonly controls: FakeOrbitControls;
  readonly renderDirty: boolean;
  readonly followMode: 'off' | 'follow' | 'siton';
  readonly isCameraAnimating: boolean;
  readonly followOwner: 'selection' | 'agent-eye' | null;
  readonly followSource: FollowSource | null;
  startFollow(src: FollowSource, owner?: 'selection' | 'agent-eye'): void;
  startSitOn(src: FollowSource, seat?: Vector3): void;
  stopFollowMode(restore?: boolean): void;
  applyLookDelta(dx: number, dy: number): void;
  tickFollow(dtSec: number): void;
  tickCameraAnimation(dtSec: number): void;
}

export function makeTestCameraManager(): TestCameraManager {
  const persp = new PerspectiveCamera(50, 1, 0.1, 1000);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  const controls = makeFakeOrbitControls(persp);
  const state = {
    perspCamera: persp,
    orthoCamera: ortho,
    _activeCamera: persp as PerspectiveCamera | OrthographicCamera,
    controls,
    renderer: { xr: { isPresenting: false } },
    _renderDirty: false,
    leftPanelManager: {},
    getPlugin: () => undefined,
  };
  const cm = new CameraManager(state as never);
  Object.defineProperty(cm, 'camera', { get: () => state._activeCamera });
  Object.defineProperty(cm, 'controls', { get: () => state.controls });
  Object.defineProperty(cm, 'renderDirty', { get: () => state._renderDirty });
  return cm as unknown as TestCameraManager;
}

/** A FollowSource over a test node whose liveness is controllable. */
export interface FakeFollowSource extends FollowSource {
  aliveRef: { alive: boolean };
}

export function makeFakeSource(
  node: Object3D,
  opts?: { aliveRef?: { alive: boolean }; label?: string; seatForward?: 'negZ' | 'posZ'; seatHeight?: number },
): FakeFollowSource {
  const aliveRef = opts?.aliveRef ?? { alive: true };
  const base = new Object3DFollowSource(node, opts?.label);
  return {
    aliveRef,
    label: base.label,
    seatForward: opts?.seatForward,
    seatHeight: opts?.seatHeight,
    getWorldPosition: (o) => base.getWorldPosition(o),
    getWorldQuaternion: (o) => base.getWorldQuaternion(o),
    getBounds: (o) => base.getBounds(o),
    isAlive: () => aliveRef.alive,
  };
}

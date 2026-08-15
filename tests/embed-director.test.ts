// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineRVEmbedElement,
  RVEmbedElement,
  type RVEmbedErrorDetail,
  type RVEmbedReadyDetail,
} from '../src/embed/rv-embed-element';
import type {
  RVEmbedDirectorActionDetail,
  RVEmbedDirectorStepDetail,
} from '../src/embed/rv-embed-director';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';
import {
  delay,
  installEmbedBrowserMocks,
  type EmbedBrowserMocks,
} from './embed-test-kit';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const MODEL_URL = DEV_GLB.physicsZone;
const TEST_NODE_PATH = 'DirectorTestNode';
const elements: RVEmbedElement[] = [];
const viewers: RVEmbedViewer[] = [];
let mocks: EmbedBrowserMocks;

beforeEach(() => {
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
});

afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
  for (const viewer of viewers.splice(0)) viewer.dispose();
  mocks.restore();
});

describe('rv-embed director', () => {
  it('advances wait, camera, drag and loop only from unpaused simulation time', async () => {
    const steps: RVEmbedDirectorStepDetail[] = [];
    const viewer = new RVEmbedViewer({
      width: 320,
      height: 200,
      directorEvents: { step: (detail) => steps.push(detail) },
    });
    viewers.push(viewer);
    const node = await addDirectorTestNode(viewer);
    const cameraEnd = {
      position: [5, 4, 3] as const,
      target: [0.5, 0.25, 0] as const,
    };

    viewer.director.run([
      { wait: 1_000 },
      { camera: cameraEnd, duration: 1_000 },
      { drag: { node: TEST_NODE_PATH, to: [1, 2, 3], duration: 1_000 } },
      { loop: true },
    ]);

    viewer.step(0.5);
    expect(steps.map((detail) => actionName(detail.step))).toEqual(['wait']);
    expect(node.position.toArray()).toEqual([0, 0, 0]);

    viewer.setPaused('document-hidden', true);
    viewer.step(5);
    expect(steps).toHaveLength(1);
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    expect(viewer.controls.object.position.toArray()).not.toEqual(cameraEnd.position);

    viewer.setPaused('offscreen', true);
    viewer.setPaused('document-hidden', false);
    viewer.step(5);
    expect(steps).toHaveLength(1);
    expect(viewer.loop.pauseReasons).toEqual(['offscreen']);

    viewer.setPaused('offscreen', false);
    viewer.step(0.6);
    expect(steps.map((detail) => actionName(detail.step))).toEqual(['wait', 'camera']);

    viewer.step(0.5);
    expect(viewer.controls.object.position.toArray()).not.toEqual(cameraEnd.position);
    viewer.step(0.5);
    expect(viewer.controls.object.position.toArray()).toEqual(cameraEnd.position);
    expect(viewer.controls.target.toArray()).toEqual(cameraEnd.target);

    viewer.step(0.5);
    expect(node.position.toArray()).not.toEqual([0, 0, 0]);
    expect(node.position.toArray()).not.toEqual([1, 2, 3]);
    viewer.step(0.5);
    expect(node.position.toArray()).toEqual([1, 2, 3]);

    expect(steps.map((detail) => actionName(detail.step))).toEqual([
      'wait',
      'camera',
      'drag',
      'loop',
      'wait',
    ]);
    expect(steps.at(-1)?.iteration).toBe(1);
  }, 30_000);

  it('bridges every step, semantic actions and recoverable node errors to the element', async () => {
    const { element, engine } = await bootElement();
    const node = addNode(engine);
    const steps: RVEmbedDirectorStepDetail[] = [];
    const errors: RVEmbedErrorDetail[] = [];
    const clicks: RVEmbedDirectorActionDetail[] = [];
    const contextMenus: RVEmbedDirectorActionDetail[] = [];
    let overlayDetail: unknown;
    let namedOverlay = false;
    let fatalBefore = false;
    let fatalAfter = false;

    element.addEventListener('rv-director-step', ((event: CustomEvent<RVEmbedDirectorStepDetail>) => {
      steps.push(event.detail);
    }) as EventListener);
    element.addEventListener('rv-error', ((event: CustomEvent<RVEmbedErrorDetail>) => {
      errors.push(event.detail);
    }) as EventListener);
    element.addEventListener('rv-director-click', ((event: CustomEvent<RVEmbedDirectorActionDetail>) => {
      clicks.push(event.detail);
    }) as EventListener);
    element.addEventListener('rv-director-context-menu', ((event: CustomEvent<RVEmbedDirectorActionDetail>) => {
      contextMenus.push(event.detail);
    }) as EventListener);
    element.addEventListener('director-overlay', ((event: CustomEvent<unknown>) => {
      overlayDetail = event.detail;
    }) as EventListener);
    element.addEventListener('named-director-overlay', () => {
      namedOverlay = true;
    });
    element.addEventListener('fatal-before', () => { fatalBefore = true; });
    element.addEventListener('fatal-after', () => { fatalAfter = true; });

    engine.loadResult!.root.userData.realvirtual = {
      Director: {
        Scripts: {
          named: [{ overlay: 'named-director-overlay' }],
        },
      },
    };
    engine.setDirector('named');
    engine.step(1 / 60);
    expect(namedOverlay).toBe(true);

    element.viewer.director.run([
      { ghostCursor: { moveTo: TEST_NODE_PATH, duration: 100 } },
      { drag: { node: 'MissingDragNode', to: [1, 0, 0], duration: 100 } },
      { click: 'MissingClickNode' },
      { click: TEST_NODE_PATH },
      { signal: { name: 'Director.Test', value: 42 } },
      { overlay: { event: 'director-overlay', detail: { live: true } } },
      { contextMenu: { at: TEST_NODE_PATH, items: ['Jump to Signal', 'Isolate'] } },
    ]);
    engine.step(0.2);

    expect(steps.slice(-7).map((detail) => actionName(detail.step))).toEqual([
      'ghostCursor',
      'drag',
      'click',
      'click',
      'signal',
      'overlay',
      'contextMenu',
    ]);
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error.recoverable).toBe(true);
      expect(error.step).toBeDefined();
    }
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ type: 'click', nodePath: TEST_NODE_PATH });
    expect(engine.signalStore?.get('Director.Test')).toBe(42);
    expect(overlayDetail).toEqual({ live: true });
    expect(contextMenus.at(-1)).toMatchObject({
      type: 'contextMenu',
      open: true,
      nodePath: TEST_NODE_PATH,
      items: ['Jump to Signal', 'Isolate'],
    });
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    expect(element.shadowRoot?.querySelector('[part="ghost-cursor"]')?.getAttribute('data-visible'))
      .toBe('true');

    element.viewer.director.run([
      { overlay: 'fatal-before' },
      { invalidAction: true } as never,
      { overlay: 'fatal-after' },
    ]);
    const ticksBeforeFatal = engine.fixedTickCount;
    engine.step(0.1);
    expect(fatalBefore).toBe(true);
    expect(fatalAfter).toBe(false);
    expect(errors.at(-1)).toMatchObject({
      recoverable: false,
      index: 1,
      step: { invalidAction: true },
    });
    engine.step(0.1);
    expect(engine.fixedTickCount).toBeGreaterThan(ticksBeforeFatal);
    expect(engine.isDisposed).toBe(false);
  }, 30_000);

  it('snaps an active camera tween to its end state before user takeover', async () => {
    const { element, engine } = await bootElement();
    const end = {
      position: [7, 6, 5] as const,
      target: [1, 2, 3] as const,
    };
    let takeovers = 0;
    element.addEventListener('rv-user-takeover', () => { takeovers++; });

    element.viewer.director.run([{ camera: end, duration: 1_000 }]);
    engine.step(0.25);
    expect(engine.controls.object.position.toArray()).not.toEqual(end.position);

    element.click();

    expect(takeovers).toBe(1);
    expectVectorClose(engine.controls.object.position.toArray(), end.position);
    expectVectorClose(engine.controls.target.toArray(), end.target);
    expect(engine.controls.enabled).toBe(true);
  }, 30_000);

  it('stops a looping director deterministically when the element is disposed', async () => {
    const { element, engine } = await bootElement();
    let steps = 0;
    element.addEventListener('rv-director-step', () => { steps++; });

    element.viewer.director.run([{ wait: 10 }, { loop: true }]);
    engine.step(0.05);
    expect(steps).toBeGreaterThan(2);

    element.viewer.dispose();
    const stepsAtDispose = steps;
    const ticksAtDispose = engine.fixedTickCount;
    expect(engine.isDisposed).toBe(true);
    expect(engine.isPlaying).toBe(false);

    engine.director.run([{ overlay: 'must-not-fire' }, { loop: true }]);
    await delay(50);
    expect(steps).toBe(stepsAtDispose);
    expect(engine.fixedTickCount).toBe(ticksAtDispose);
  }, 30_000);
});

async function addDirectorTestNode(viewer: RVEmbedViewer): Promise<Object3D> {
  await viewer.loadModel(MODEL_URL);
  return addNode(viewer);
}

function addNode(viewer: RVEmbedViewer): Object3D {
  const node = new Object3D();
  node.name = TEST_NODE_PATH;
  viewer.loadResult!.root.add(node);
  viewer.loadResult!.registry.registerNode(TEST_NODE_PATH, node);
  return node;
}

async function bootElement(): Promise<{ element: RVEmbedElement; engine: RVEmbedViewer }> {
  const element = document.createElement('rv-embed') as RVEmbedElement;
  element.setAttribute('src', MODEL_URL);
  element.setAttribute('run', 'manual');
  element.style.width = '320px';
  element.style.height = '200px';
  elements.push(element);

  let resolveReady!: (viewer: RVEmbedViewer) => void;
  const ready = new Promise<RVEmbedViewer>((resolve) => {
    resolveReady = resolve;
  });
  element.addEventListener('rv-ready', ((event: CustomEvent<RVEmbedReadyDetail>) => {
    resolveReady(event.detail.viewer);
  }) as EventListener);
  document.body.append(element);
  await element.viewer.play();
  const engine = await ready;
  engine.loop.stop();
  engine.setPaused('document-hidden', false);
  engine.setPaused('offscreen', false);
  return { element, engine };
}

function actionName(step: RVEmbedDirectorStepDetail['step']): string {
  return Object.keys(step)[0] ?? '';
}

function expectVectorClose(
  actual: readonly number[],
  expected: readonly number[],
): void {
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 10);
  });
}

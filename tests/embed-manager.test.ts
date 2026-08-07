// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultZoneRegistry } from '../src/core/engine/rv-zone-registry';
import {
  defineRVEmbedElement,
  RVEmbedElement,
  type RVEmbedReadyDetail,
} from '../src/embed/rv-embed-element';
import {
  RV_EMBED_CONTEXT_RECYCLE_MS,
  RV_EMBED_SCROLL_IDLE_MS,
  rvEmbedManager,
} from '../src/embed/rv-embed-manager';
import { resetEmbedEngineRegistries } from '../src/embed/rv-embed-registry-reset';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';
import {
  delay,
  installEmbedBrowserMocks,
  MockIntersectionObserver,
  type EmbedBrowserMocks,
} from './embed-test-kit';

const MODEL_URL = '/models/physics-zone-test.glb';
const elements: RVEmbedElement[] = [];
let mocks: EmbedBrowserMocks;
let originalDevicePixelRatio: PropertyDescriptor | undefined;

beforeEach(() => {
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
  originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
});

afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
  vi.useRealTimers();
  if (originalDevicePixelRatio) {
    Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatio);
  }
  resetEmbedEngineRegistries();
  vi.restoreAllMocks();
  mocks.restore();
  expect(rvEmbedManager.state.registeredCount).toBe(0);
});

describe('rv-embed vignette manager', () => {
  it('grants simulation to only the most recently visible vignette and resets registries on switch', async () => {
    const first = makeElement();
    const firstObserver = MockIntersectionObserver.latest();
    const second = makeElement();
    const secondObserver = MockIntersectionObserver.latest();

    firstObserver.emit(first, 0.5);
    secondObserver.emit(second, 0.5);
    const [firstEngine, secondEngine] = await Promise.all([
      playElement(first),
      playElement(second),
    ]);
    releasePagePause(firstEngine);
    releasePagePause(secondEngine);

    const firstTicks = firstEngine.fixedTickCount;
    const secondTicks = secondEngine.fixedTickCount;
    firstEngine.step(1 / 60);
    secondEngine.step(1 / 60);
    expect(firstEngine.fixedTickCount).toBe(firstTicks);
    expect(secondEngine.fixedTickCount).toBeGreaterThan(secondTicks);

    defaultZoneRegistry.define('manager-switch-sentinel', 1);
    defaultZoneRegistry.claim('manager-switch-sentinel', 'second-vignette');
    expect(defaultZoneRegistry.holderCount('manager-switch-sentinel')).toBe(1);

    firstObserver.emit(first, 0);
    firstObserver.emit(first, 0.5);
    expect(defaultZoneRegistry.holderCount('manager-switch-sentinel')).toBe(0);

    const firstTicksAfterSwitch = firstEngine.fixedTickCount;
    const secondTicksAfterSwitch = secondEngine.fixedTickCount;
    firstEngine.step(1 / 60);
    secondEngine.step(1 / 60);
    expect(firstEngine.fixedTickCount).toBeGreaterThan(firstTicksAfterSwitch);
    expect(secondEngine.fixedTickCount).toBe(secondTicksAfterSwitch);
    expect(rvEmbedManager.state).toMatchObject({
      registeredCount: 2,
      visibleCount: 2,
      hasActiveSimulation: true,
    });
  }, 30_000);

  it('serializes simultaneously requested GLB loads', async () => {
    const originalLoadModel = RVEmbedViewer.prototype.loadModel;
    let overlappingLoads = 0;
    let maximumOverlap = 0;
    const loadSpy = vi.spyOn(RVEmbedViewer.prototype, 'loadModel').mockImplementation(
      async function (
        this: RVEmbedViewer,
        ...args: Parameters<RVEmbedViewer['loadModel']>
      ) {
        overlappingLoads++;
        maximumOverlap = Math.max(maximumOverlap, overlappingLoads);
        await delay(50);
        try {
          return await originalLoadModel.apply(this, args);
        } finally {
          overlappingLoads--;
        }
      },
    );
    const first = makeElement();
    const second = makeElement();

    await Promise.all([first.viewer.play(), second.viewer.play()]);

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(maximumOverlap).toBe(1);
    expect(rvEmbedManager.state).toMatchObject({
      queuedLoads: 0,
      activeLoads: 0,
    });
  }, 30_000);

  it('recycles an offscreen context, preserves a frame and freezes director simulation time', async () => {
    const element = makeElement();
    element.setAttribute('poster', '/poster.webp');
    const observer = MockIntersectionObserver.latest();
    observer.emit(element, 0.5);
    const engine = await playElement(element);
    releasePagePause(engine);
    const initialCanvas = engine.renderer.domElement;
    const forceContextLoss = vi.spyOn(engine.renderer, 'forceContextLoss');
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/webp;base64,last-frame');
    let directorFinished = false;
    element.addEventListener('manager-director-finished', () => {
      directorFinished = true;
    });
    element.viewer.director.run([
      { wait: 1_000 },
      { overlay: 'manager-director-finished' },
    ]);
    engine.step(0.25);

    vi.useFakeTimers();
    observer.emit(element, 0);
    await vi.advanceTimersByTimeAsync(RV_EMBED_CONTEXT_RECYCLE_MS);

    expect(engine.isContextSuspended).toBe(true);
    expect(forceContextLoss).toHaveBeenCalledTimes(1);
    const poster = element.shadowRoot?.querySelector<HTMLImageElement>('[part="poster"]');
    expect(poster?.src).toContain('data:image/webp;base64,last-frame');
    expect(poster?.dataset.hidden).toBe('false');

    engine.step(5);
    expect(directorFinished).toBe(false);

    observer.emit(element, 0.5);
    expect(engine.isContextSuspended).toBe(false);
    expect(engine.renderer.domElement).not.toBe(initialCanvas);
    expect(engine.renderer.domElement).toBe(
      element.shadowRoot?.querySelector<HTMLCanvasElement>('[part="canvas"]'),
    );
    engine.step(0.8);
    expect(directorFinished).toBe(true);
  }, 30_000);

  it('applies DPR and 30-fps scroll mode only at hysteresis transitions', async () => {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });
    const element = makeElement();
    const observer = MockIntersectionObserver.latest();
    observer.emit(element, 0.5);
    const engine = await playElement(element);
    releasePagePause(engine);
    const setPixelRatio = vi.spyOn(engine.renderer, 'setPixelRatio');
    const render = vi.spyOn(engine.renderer, 'render');
    engine.loop.stop();

    vi.useFakeTimers();
    for (let index = 0; index < 20; index++) window.dispatchEvent(new Event('scroll'));
    expect(setPixelRatio).toHaveBeenCalledTimes(1);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(rvEmbedManager.state.scrolling).toBe(true);
    render.mockClear();
    for (let index = 0; index < 6; index++) engine.loop.onRender(1 / 60);
    expect(render).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(RV_EMBED_SCROLL_IDLE_MS - 1);
    expect(setPixelRatio).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(RV_EMBED_SCROLL_IDLE_MS);
    expect(setPixelRatio).toHaveBeenCalledTimes(2);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(rvEmbedManager.state.scrolling).toBe(false);

    for (let index = 0; index < 10; index++) window.dispatchEvent(new Event('scroll'));
    expect(setPixelRatio).toHaveBeenCalledTimes(3);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
  }, 30_000);
});

function makeElement(): RVEmbedElement {
  const element = document.createElement('rv-embed') as RVEmbedElement;
  element.setAttribute('src', MODEL_URL);
  element.setAttribute('run', 'manual');
  element.style.width = '320px';
  element.style.height = '200px';
  document.body.append(element);
  elements.push(element);
  return element;
}

async function playElement(element: RVEmbedElement): Promise<RVEmbedViewer> {
  let readyViewer: RVEmbedViewer | null = null;
  element.addEventListener('rv-ready', ((event: CustomEvent<RVEmbedReadyDetail>) => {
    readyViewer = event.detail.viewer;
  }) as EventListener, { once: true });
  await element.viewer.play();
  if (!readyViewer) throw new Error('rv-ready did not provide an RVEmbedViewer');
  return readyViewer;
}

function releasePagePause(viewer: RVEmbedViewer): void {
  viewer.setPaused('document-hidden', false);
  viewer.setPaused('offscreen', false);
}

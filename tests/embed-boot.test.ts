// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineRVEmbedElement,
  RVEmbedElement,
  RV_EMBED_DWELL_MS,
  type RVEmbedReadyDetail,
} from '../src/embed/rv-embed-element';
import {
  delay,
  installEmbedBrowserMocks,
  MockIntersectionObserver,
  type EmbedBrowserMocks,
} from './embed-test-kit';

const MODEL_URL = '/models/physics-zone-test.glb';
const elements: RVEmbedElement[] = [];
let mocks: EmbedBrowserMocks;

function makeElement(run?: 'when-visible' | 'manual'): RVEmbedElement {
  const element = document.createElement('rv-embed') as RVEmbedElement;
  element.setAttribute('src', MODEL_URL);
  if (run) element.setAttribute('run', run);
  element.style.width = '320px';
  element.style.height = '200px';
  document.body.append(element);
  elements.push(element);
  return element;
}

beforeEach(() => {
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
});

afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
  mocks.restore();
});

describe('<rv-embed> boot lifecycle', () => {
  it('boots only after a continuous visibility dwell, fires rv-ready and ticks the engine', async () => {
    const element = makeElement();
    let readyDetail: RVEmbedReadyDetail | null = null;
    element.addEventListener('rv-ready', ((event: CustomEvent<RVEmbedReadyDetail>) => {
      readyDetail = event.detail;
    }) as EventListener);

    const observer = MockIntersectionObserver.latest();
    observer.emit(element, 0.5);
    await delay(Math.floor(RV_EMBED_DWELL_MS / 2));
    expect(readyDetail).toBeNull();

    // A short pass through the viewport must cancel the pending boot.
    observer.emit(element, 0);
    await delay(RV_EMBED_DWELL_MS);
    expect(readyDetail).toBeNull();

    observer.emit(element, 0.5);
    await waitFor(() => readyDetail !== null);
    const engine = readyDetail!.viewer;
    // Vitest's browser page may itself be document-hidden; advance one fixed
    // step explicitly so the assertion verifies the real engine pipeline
    // without weakening the production document-hidden pause contract.
    const tickBefore = engine.fixedTickCount;
    engine.step(1 / 60);
    expect(engine.fixedTickCount).toBeGreaterThan(tickBefore);

    observer.emit(element, 0);
    expect(engine.loop.pauseReasons).toContain('offscreen');
    observer.emit(element, 0.5);
    expect(engine.loop.pauseReasons).not.toContain('offscreen');
  }, 30_000);

  it('does not autostart when prefers-reduced-motion is active', async () => {
    mocks.restore();
    mocks = installEmbedBrowserMocks(true);
    const element = makeElement();
    let ready = false;
    element.addEventListener('rv-ready', () => { ready = true; });

    MockIntersectionObserver.latest().emit(element, 0.5);
    await delay(RV_EMBED_DWELL_MS + 100);
    expect(ready).toBe(false);
  });

  it('does not boot run=manual until the public play API is called', async () => {
    const element = makeElement('manual');
    let ready = false;
    let takeovers = 0;
    element.addEventListener('rv-ready', () => { ready = true; });
    element.addEventListener('rv-user-takeover', () => { takeovers++; });

    MockIntersectionObserver.latest().emit(element, 0.5);
    await delay(RV_EMBED_DWELL_MS + 100);
    expect(ready).toBe(false);

    await element.viewer.play();
    expect(ready).toBe(true);
    element.click();
    expect(takeovers).toBe(1);
  }, 30_000);

  it('reports a missing src through rv-error', async () => {
    const element = document.createElement('rv-embed') as RVEmbedElement;
    element.setAttribute('run', 'manual');
    document.body.append(element);
    elements.push(element);
    let message = '';
    element.addEventListener('rv-error', ((event: CustomEvent<{ message: string }>) => {
      message = event.detail.message;
    }) as EventListener);

    await element.viewer.play();
    expect(message).toContain('src');
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for condition');
    await delay(20);
  }
}

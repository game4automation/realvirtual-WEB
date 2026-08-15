// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineRVEmbedElement,
  RVEmbedElement,
  type RVEmbedReadyDetail,
} from '../src/embed/rv-embed-element';
import { installEmbedBrowserMocks, type EmbedBrowserMocks } from './embed-test-kit';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

let mocks: EmbedBrowserMocks;
let element: RVEmbedElement | null = null;

beforeEach(() => {
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
});

afterEach(() => {
  element?.remove();
  element = null;
  mocks.restore();
});

describe('rv-embed signal API', () => {
  it('round-trips subscribe/write through the loaded SignalStore', async () => {
    element = document.createElement('rv-embed') as RVEmbedElement;
    element.setAttribute('src', DEV_GLB.physicsZone);
    element.setAttribute('run', 'manual');
    element.style.width = '320px';
    element.style.height = '200px';

    let resolveReady!: (viewer: RVEmbedReadyDetail['viewer']) => void;
    const readyPromise = new Promise<RVEmbedReadyDetail['viewer']>((resolve) => {
      resolveReady = resolve;
    });
    element.addEventListener('rv-ready', ((event: CustomEvent<RVEmbedReadyDetail>) => {
      resolveReady(event.detail.viewer);
    }) as EventListener);

    const values: Array<boolean | number> = [];
    const unsubscribe = element.viewer.signals.subscribe('Embed.Test', (value) => values.push(value));
    document.body.append(element);
    await element.viewer.play();
    const engine = await readyPromise;

    element.viewer.signals.write('Embed.Test', 42);
    expect(values).toEqual([42]);
    expect(engine.signalStore?.get('Embed.Test')).toBe(42);

    unsubscribe();
    element.viewer.signals.write('Embed.Test', 43);
    expect(values).toEqual([42]);
  }, 30_000);
});

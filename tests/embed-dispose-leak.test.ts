// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ikSolverRegistry, type IKSolverProvider } from '../src/core/engine/rv-ik-solver';
import { defaultPathNetwork } from '../src/core/engine/rv-path-network';
import type { RVPath } from '../src/core/engine/rv-path';
import { physicsRegistry, type PhysicsProvider } from '../src/core/engine/rv-physics-registry';
import { defaultSpacingController } from '../src/core/engine/rv-spacing-controller';
import type { PathTraveler } from '../src/core/engine/rv-path-traveler';
import {
  isSignalLiveControlled,
  setSignalLiveControlled,
} from '../src/core/engine/rv-live-control';
import { defaultZoneRegistry } from '../src/core/engine/rv-zone-registry';
import {
  defineRVEmbedElement,
  RVEmbedElement,
  type RVEmbedReadyDetail,
} from '../src/embed/rv-embed-element';
import { resetEmbedEngineRegistries } from '../src/embed/rv-embed-registry-reset';
import {
  installEmbedBrowserMocks,
  MockIntersectionObserver,
  type EmbedBrowserMocks,
} from './embed-test-kit';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

// plan-395: everything in `DEV_GLB` lives in the private Development project
// and is absent from a public checkout. The suites below must then report
// `skipped` rather than `passed` - a probe-and-return would leave this file
// green while it checked nothing. The probe tests the CONTENT TYPE, not
// `res.ok`: without the private sibling nothing claims `/private-assets/`, so
// the dev server answers it with the SPA fallback, a 200 text/html.
const DEV_ASSETS = await devAssetAvailable(DEV_GLB.physicsZone);

let mocks: EmbedBrowserMocks;
let element: RVEmbedElement | null = null;

beforeEach(() => {
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
});

afterEach(() => {
  element?.remove();
  element = null;
  resetEmbedEngineRegistries();
  ikSolverRegistry.register(null);
  vi.restoreAllMocks();
  mocks.restore();
});

describe.skipIf(!DEV_ASSETS)('<rv-embed> disposal contract', () => {
  it('aborts DOM listeners and resets every shared engine registry on removal', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const mediaAdd = vi.spyOn(mocks.media, 'addEventListener');

    element = document.createElement('rv-embed') as RVEmbedElement;
    element.setAttribute('src', DEV_GLB.physicsZone);
    element.setAttribute('run', 'manual');
    element.style.width = '320px';
    element.style.height = '200px';
    const elementAdd = vi.spyOn(element, 'addEventListener');
    let ready: RVEmbedReadyDetail | null = null;
    element.addEventListener('rv-ready', ((event: CustomEvent<RVEmbedReadyDetail>) => {
      ready = event.detail;
    }) as EventListener);
    document.body.append(element);
    const observer = MockIntersectionObserver.latest();
    await element.viewer.play();
    expect(ready).not.toBeNull();

    const lifecycleSignal = eventSignal(documentAdd.mock.calls, 'visibilitychange');
    expect(lifecycleSignal).toBeInstanceOf(AbortSignal);
    expect(eventSignal(windowAdd.mock.calls, 'resize')).toBe(lifecycleSignal);
    expect(eventSignal(elementAdd.mock.calls, 'click')).toBe(lifecycleSignal);
    expect(eventSignal(mediaAdd.mock.calls, 'change')).toBe(lifecycleSignal);
    expect(observer.observedCount).toBe(1);

    defaultPathNetwork.register({ id: 'embed-leak-path' } as RVPath);
    defaultZoneRegistry.define('embed-leak-zone', 1);
    defaultZoneRegistry.claim('embed-leak-zone', 'embed-holder');
    defaultSpacingController.add({ id: 'embed-traveler' } as PathTraveler);
    physicsRegistry.register({} as PhysicsProvider);
    ikSolverRegistry.register({
      tier: 'free',
      maxRobots: 1,
      canBlend: false,
      solvePieper: () => [],
    } as IKSolverProvider);
    expect(ikSolverRegistry.claimLiveSolve('robot-a')).toBe(true);
    setSignalLiveControlled('Embed.Live', true);

    const disposedEngine = ready!.viewer;
    element.remove();
    element = null;

    expect(lifecycleSignal!.aborted).toBe(true);
    expect(observer.observedCount).toBe(0);
    expect(disposedEngine.isDisposed).toBe(true);
    expect(defaultPathNetwork.size).toBe(0);
    expect(defaultZoneRegistry.holderCount('embed-leak-zone')).toBe(0);
    expect(defaultSpacingController.size).toBe(0);
    expect(physicsRegistry.provider).toBeNull();
    expect(isSignalLiveControlled('Embed.Live')).toBe(false);
    // With maxRobots=1 this succeeds only when robot-a's previous claim was reset.
    expect(ikSolverRegistry.claimLiveSolve('robot-b')).toBe(true);
  }, 30_000);
});

function eventSignal(
  calls: Array<[type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions]>,
  type: string,
): AbortSignal | undefined {
  const call = calls.find(([eventType]) => eventType === type);
  const options = call?.[2];
  return typeof options === 'object' ? options.signal : undefined;
}

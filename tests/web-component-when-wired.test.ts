// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 §2.8 — `WebComponentPlugin.whenWired()`, the wiring join of the
 * parity harness.
 *
 * The plugin wires scripts ASYNCHRONOUSLY: the QuickJS host loads lazily on
 * the first scripted model, so `instances` read right after `whenSceneReady()`
 * is 0 on that first load (measured ~0.9 s on an idle machine before the
 * count became 1). Fixture (e) is the first parity fixture with a
 * `WebComponent`; joined on `whenSceneReady()` alone its two loads compared
 * 0 == 0 when idle, and under batch load the placement won the race the main
 * model lost — `webComponents`, `signals` (`Controller.Error`) and behaviour
 * diffs. The harness now joins on `whenWired()`; these tests pin that both
 * paths report the SETTLED count, which was red before the join.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parityFixture } from './fixtures/parity-fixtures';
import {
  createParityHost, fixtureBytes, loadAsMainModel, loadAsSinglePlacement, snapshot, type ParityHost,
} from './helpers/parity-harness';
import type { WebComponentPlugin } from '../src/plugins/web-component-plugin';

const HOOK_TIMEOUT = 120_000;

describe('WebComponentPlugin.whenWired — the harness reads the settled count', () => {
  let host: ParityHost;
  beforeAll(async () => { host = await createParityHost(); }, HOOK_TIMEOUT);
  afterAll(() => host?.dispose());

  it('main model of fixture (e): wired == authored and the script error signal exists right after the load', async () => {
    const fixture = parityFixture('e');
    const bytes = await fixtureBytes(fixture.build());
    const main = await loadAsMainModel(host, bytes, { claims: fixture.claims });
    const snap = snapshot(main);
    expect(snap.webComponents).toEqual({ authored: 1, wired: 1 });
    expect(Object.keys(snap.signals)).toContain('Controller/Error');
    main.release();
  }, HOOK_TIMEOUT);

  it('one placement of fixture (e): the same picture', async () => {
    const fixture = parityFixture('e');
    const bytes = await fixtureBytes(fixture.build());
    const placement = await loadAsSinglePlacement(host, bytes, fixture.rootName, { claims: fixture.claims });
    const snap = snapshot(placement);
    expect(snap.webComponents).toEqual({ authored: 1, wired: 1 });
    expect(Object.keys(snap.signals)).toContain('Controller/Error');
    placement.release();
  }, HOOK_TIMEOUT);

  it('whenWired() with nothing in flight resolves immediately', async () => {
    const plugin = host.viewer.getPlugin<WebComponentPlugin>('web-component');
    expect(plugin).toBeTruthy();
    await expect(plugin!.whenWired()).resolves.toBeUndefined();
  });
});

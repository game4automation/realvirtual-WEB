// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-ai-plugin.test.ts — capability-gated registration of the CONNECT
 * diagnose provider for the AI search (plan-283 §8, @rv-private). The plugin
 * is driven directly (init/dispose) with an injected FetchLike — no viewer,
 * no real network.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SearchAiPlugin } from '@rv-private/plugins/diagnose/search-ai-plugin';
import { RemoteDiagnoseProvider } from '@rv-private/plugins/diagnose/remote-diagnose-provider';
import type { FetchLike } from '@rv-private/plugins/diagnose/diagnose-capability';
import { setAppConfig } from '../src/core/rv-app-config';
import { getSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';

function healthFetch(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

let _plugin: SearchAiPlugin | null = null;

async function initPlugin(fetchImpl?: FetchLike): Promise<SearchAiPlugin> {
  _plugin = new SearchAiPlugin(fetchImpl);
  _plugin.init();
  await _plugin.__probeDone;
  return _plugin;
}

afterEach(() => {
  _plugin?.dispose();      // unregisters from the module-global registry
  _plugin = null;
  setAppConfig({});
});

describe('SearchAiPlugin', () => {
  it('registers RemoteDiagnoseProvider when probe reports diagnose:true', async () => {
    setAppConfig({ diagnostics: { diagnoseUrl: 'http://localhost:5100' } });
    await initPlugin(healthFetch({ status: 'ok', diagnose: true }));
    expect(getSearchDiagnoseProvider()).toBeInstanceOf(RemoteDiagnoseProvider);
  });

  it('does NOT register when diagnostics.diagnoseUrl unset', async () => {
    setAppConfig({});
    const fetchCalls: string[] = [];
    await initPlugin(async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 200, json: async () => ({ status: 'ok', diagnose: true }) };
    });
    expect(fetchCalls).toEqual([]);                  // no probe without a URL
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('does NOT register when probe reports diagnose:false', async () => {
    setAppConfig({ diagnostics: { diagnoseUrl: 'http://localhost:5100' } });
    await initPlugin(healthFetch({ status: 'ok', diagnose: false }));
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('does NOT register when CONNECT is unreachable', async () => {
    setAppConfig({ diagnostics: { diagnoseUrl: 'http://localhost:5100' } });
    await initPlugin(async () => { throw new TypeError('Failed to fetch'); });
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('dispose() unregisters', async () => {
    setAppConfig({ diagnostics: { diagnoseUrl: 'http://localhost:5100' } });
    const plugin = await initPlugin(healthFetch({ status: 'ok', diagnose: true }));
    expect(getSearchDiagnoseProvider()).not.toBeNull();
    plugin.dispose();
    expect(getSearchDiagnoseProvider()).toBeNull();
  });

  it('a probe finishing after dispose() does not register (race)', async () => {
    setAppConfig({ diagnostics: { diagnoseUrl: 'http://localhost:5100' } });
    let resolveHealth!: () => void;
    const gate = new Promise<void>((resolve) => { resolveHealth = resolve; });
    const plugin = new SearchAiPlugin(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ status: 'ok', diagnose: true }) };
    });
    _plugin = plugin;
    plugin.init();
    plugin.dispose();          // disposed while the probe is still pending
    resolveHealth();
    await plugin.__probeDone;
    expect(getSearchDiagnoseProvider()).toBeNull();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 Phase 2 — ModeManager enter guards + FeatureLoader mode triggers (§9.3, §9.10 behaviour case).
 *
 * Real ModeManager on a pure mock host, real FeatureLoader whose fake viewer exposes
 * that ModeManager — the same wiring RVViewer has, without Three.js or a browser.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModeManager, type ModeHost, type ModeChangeEvent } from '../src/core/rv-mode-manager';
import { FeatureLoader, ensureFeatureIfDeclared, type FeatureBody } from '../src/core/rv-feature-loader';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import type { RVViewer } from '../src/core/rv-viewer';

interface Rig {
  modes: ModeManager;
  features: FeatureLoader;
  events: Array<{ event: string; data: ModeChangeEvent }>;
  activate: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  release: () => void;
  fail: (e: Error) => void;
}

/** A deferred body load: the test decides when (and whether) the chunk "arrives". */
function rig(opts: { lazyMode?: string; failFirst?: boolean } = {}): Rig {
  const events: Rig['events'] = [];
  const viewer = {} as { modes?: ModeManager; features?: FeatureLoader };
  const host: ModeHost = {
    viewer: viewer as unknown as RVViewer,
    pluginsForMode: () => ({ enable: [], disable: [], activateHooks: [], deactivateHooks: [] }),
    enablePlugin: () => {},
    disablePlugin: () => {},
    callPlugin: () => {},
    setContext: () => {},
    emit: (event, data) => { events.push({ event, data }); },
  };
  const modes = new ModeManager(host);
  viewer.modes = modes;
  modes.register({ id: 'hmi', label: 'HMI' });
  modes.register({ id: 'planner', label: 'Planner' });
  const lazy = opts.lazyMode ?? 'editor';
  modes.register({ id: lazy, label: 'Editor' });
  const features = new FeatureLoader(viewer as unknown as RVViewer);
  viewer.features = features;

  let release: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const activate = vi.fn();
  let calls = 0;
  const load = vi.fn(() => new Promise<FeatureBody>((resolve, reject) => {
    calls++;
    release = () => resolve({ activate });
    fail = (e) => reject(e);
    if (opts.failFirst && calls === 1) { /* rejected via fail() */ }
  }));
  features.define({ id: 'asset-editor', label: 'Editor', activation: [`mode:${lazy}`], origin: 'commercial', load });
  return {
    modes, features, events, activate, load,
    release: () => release(),
    fail: (e) => fail(e),
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  clearAllProblems();
  for (const m of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ModeManager enter guards (plan-652)', () => {
  it('stays synchronous for modes without a lazy feature', () => {
    const r = rig();
    r.modes.setMode('hmi');
    expect(r.modes.activeMode).toBe('hmi');
    void r.modes.requestMode('planner');
    expect(r.modes.activeMode).toBe('planner');
    expect(r.load).not.toHaveBeenCalled();
  });

  it('requestMode stays synchronous once the feature is active', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    const first = r.features.ensure('asset-editor', 'intent');
    await flush();
    r.release();
    await first;
    void r.modes.requestMode('editor');
    expect(r.modes.activeMode).toBe('editor');
  });

  it('requestMode loads the feature, then switches with exactly one changing/changed pair', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.events.length = 0;
    const p = r.modes.requestMode('editor');
    expect(r.modes.activeMode).toBe('hmi');
    expect(r.events).toEqual([]);
    await flush();
    expect(r.load).toHaveBeenCalledTimes(1);
    r.release();
    expect(await p).toBe(true);
    expect(r.modes.activeMode).toBe('editor');
    expect(r.activate).toHaveBeenCalledTimes(1);
    expect(r.events.map((e) => e.event)).toEqual(['mode-changing', 'mode-changed']);
    expect(r.events[1].data).toEqual({ from: 'hmi', to: 'editor' });
  });

  it('is busy while loading: a second requestMode is refused, the first wins', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    const p = r.modes.requestMode('editor');
    expect(await r.modes.requestMode('planner')).toBe(false);
    await flush();
    r.release();
    expect(await p).toBe(true);
    expect(r.modes.activeMode).toBe('editor');
  });

  it('an exit veto costs no feature load', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.modes.registerExitGuard('hmi', () => false);
    expect(await r.modes.requestMode('editor')).toBe(false);
    expect(r.load).not.toHaveBeenCalled();
  });

  it('a failed activation keeps the old mode, fires no mode event and reports a problem', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.events.length = 0;
    const p = r.modes.requestMode('editor');
    await flush();
    r.fail(new Error('chunk 404'));
    expect(await p).toBe(false);
    expect(r.modes.activeMode).toBe('hmi');
    expect(r.events).toEqual([]);
    expect(getProblems().some((x) => x.id === 'feature-load-failed:asset-editor')).toBe(true);
    // Retry works: the failure was not cached.
    const again = r.modes.requestMode('editor');
    await flush();
    expect(r.load).toHaveBeenCalledTimes(2);
    r.release();
    expect(await again).toBe(true);
  });

  it('setMode on a lazy mode defers the switch until the feature is active (safety net)', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.modes.setMode('editor');
    expect(r.modes.activeMode).toBe('hmi');
    await flush();
    r.release();
    await flush();
    expect(r.modes.activeMode).toBe('editor');
  });

  it('a newer setMode overtakes a deferred one (generation check)', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.modes.setMode('editor');
    r.modes.setMode('planner');
    expect(r.modes.activeMode).toBe('planner');
    await flush();
    r.release();
    await flush();
    expect(r.modes.activeMode).toBe('planner');
    // The feature itself did load — only the stale switch was dropped.
    expect(r.features.isActive('asset-editor')).toBe(true);
  });

  it('setMode back to the active mode also cancels a deferred target', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.modes.setMode('editor');
    r.modes.setMode('hmi');
    await flush();
    r.release();
    await flush();
    expect(r.modes.activeMode).toBe('hmi');
  });

  it('lock(editor) pending + a rejected setMode(hmi) still lands in the editor', async () => {
    const r = rig();
    r.modes.lock('editor');
    expect(r.modes.activeMode).toBe(null);
    r.modes.setMode('hmi'); // rejected by the lock — must not bump the generation
    await flush();
    r.release();
    await flush();
    expect(r.modes.activeMode).toBe('editor');
  });

  it('setModeAsync resolves after the commit', async () => {
    const r = rig();
    r.modes.setMode('hmi');
    const p = r.modes.setModeAsync('editor');
    await flush();
    r.release();
    expect(await p).toBe(true);
    expect(r.modes.activeMode).toBe('editor');
    expect(await r.modes.setModeAsync('nope')).toBe(false);
  });

  it('switchMode answers synchronously when nothing loads, with a promise only for a lazy mode', async () => {
    const r = rig();
    expect(r.modes.switchMode('hmi')).toBe(true);
    expect(r.modes.activeMode).toBe('hmi');
    const p = r.modes.switchMode('editor');
    expect(typeof p).not.toBe('boolean');
    expect(r.modes.activeMode).toBe('hmi');
    await flush();
    r.release();
    expect(await p).toBe(true);
    expect(r.modes.activeMode).toBe('editor');
    expect(r.modes.switchMode('nope')).toBe(false);
  });

  it('restore() runs through the same safety net; peekRestoreTarget does not switch', async () => {
    const r = rig();
    expect(r.modes.peekRestoreTarget('editor')).toBe('editor');
    expect(r.modes.activeMode).toBe(null);
    r.modes.restore('editor');
    expect(r.modes.activeMode).toBe(null);
    await flush();
    r.release();
    await flush();
    expect(r.modes.activeMode).toBe('editor');
  });

  it('a throwing enter guard refuses the switch', () => {
    const r = rig();
    r.modes.setMode('hmi');
    r.modes.registerEnterGuard('planner', () => { throw new Error('x'); });
    r.modes.setMode('planner');
    expect(r.modes.activeMode).toBe('hmi');
  });
});

describe('ensureFeatureIfDeclared', () => {
  it('is a no-op without a loader, for an undeclared id and for an active feature', async () => {
    await expect(ensureFeatureIfDeclared(undefined, 'asset-editor', 'command:mcp')).resolves.toBeUndefined();
    const r = rig();
    await expect(ensureFeatureIfDeclared({ features: r.features }, 'unknown', 'command:mcp')).resolves.toBeUndefined();
    const p = ensureFeatureIfDeclared({ features: r.features }, 'asset-editor', 'command:mcp');
    await flush();
    r.release();
    await p;
    expect(r.features.isActive('asset-editor')).toBe(true);
    await ensureFeatureIfDeclared({ features: r.features }, 'asset-editor', 'command:mcp');
    expect(r.load).toHaveBeenCalledTimes(1);
  });
});

describe('FeatureLoader.recordStartup with an on-demand stub', () => {
  it('leaves a feature the stub declared in state declared, not active', async () => {
    const r = rig();
    // The real stub runs inside recordStartup and calls define() — simulate with a re-define.
    await r.features.recordStartup('asset-editor', async () => {
      r.features.define({ id: 'asset-editor', label: 'Editor', activation: ['mode:editor'], origin: 'commercial', load: r.load as never });
    });
    const row = r.features.statuses().find((s) => s.id === 'asset-editor');
    expect(row?.state).toBe('declared');
    expect(row?.trigger).toBeUndefined();
    expect(r.features.isModeReady('editor')).toBe(false);
    // Re-define replaced the enter guard instead of stacking a second one.
    r.modes.setMode('hmi');
    r.modes.setMode('editor');
    await flush();
    expect(r.load).toHaveBeenCalledTimes(1);
  });
});

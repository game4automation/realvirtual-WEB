// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 Phase 1 — FeatureLoader, memoizeAsync, retry command, chunk table (§9.1 / §9.8).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { memoizeAsync } from '../src/core/rv-memoize-async';
import {
  FeatureLoader, FEATURE_HINT_DELAY_MS, FEATURE_HINT_MIN_MS, FEATURE_RETRY_COMMAND,
  registerFeatureRetryCommand, featureChunkBytes, setFeatureChunksForTests,
  failedChunkUrl, withRetryQuery, FEATURE_RELOAD_COMMAND, FEATURE_MAX_RETRIES,
  type FeatureBody, type FeatureDefinition,
} from '../src/core/rv-feature-loader';
import { getProblems, clearAllProblems } from '../src/core/hmi/problems-store';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import type { RVViewer } from '../src/core/rv-viewer';

const fakeViewer = (): RVViewer => ({}) as unknown as RVViewer;

function def(over: Partial<FeatureDefinition> = {}): FeatureDefinition {
  return {
    id: 'x', label: 'X', activation: ['mode:x', 'component:XType'], origin: 'commercial',
    load: async () => ({ activate: vi.fn() }),
    ...over,
  };
}

beforeEach(() => { clearAllProblems(); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'debug').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setFeatureChunksForTests(null); });

describe('memoizeAsync', () => {
  it('shares one promise between parallel calls', async () => {
    const load = vi.fn(async () => 42);
    const m = memoizeAsync(load);
    expect(await Promise.all([m(), m()])).toEqual([42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(m.pending).toBe(true);
  });
  it('forgets a rejection so the next call loads again', async () => {
    let n = 0;
    const m = memoizeAsync(async () => { if (n++ === 0) throw new Error('boom'); return 'ok'; });
    await expect(m()).rejects.toThrow('boom');
    expect(m.pending).toBe(false);
    expect(await m()).toBe('ok');
  });
});

describe('FeatureLoader', () => {
  it('shares one load for parallel ensure calls and is active afterwards', async () => {
    const activate = vi.fn();
    const load = vi.fn(async (): Promise<FeatureBody> => ({ activate }));
    const fl = new FeatureLoader(fakeViewer());
    fl.define(def({ load }));
    expect(fl.isDeclared('x')).toBe(true);
    expect(fl.isActive('x')).toBe(false);
    expect(fl.isModeReady('x')).toBe(false);
    await Promise.all([fl.ensure('x', 'mode:x'), fl.ensure('x', 'intent')]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(fl.isActive('x')).toBe(true);
    expect(fl.isModeReady('x')).toBe(true);
    expect(fl.isModeReady('hmi')).toBe(true); // no feature needed
    const row = fl.statuses().find((s) => s.id === 'x')!;
    expect(row.state).toBe('active');
    expect(row.trigger).toBe('mode:x');
    expect(typeof row.ms).toBe('number');
  });

  it('resets the cache after a rejected load and after a failed preload, so a retry works', async () => {
    let calls = 0;
    const fl = new FeatureLoader(fakeViewer());
    fl.define(def({ load: async () => { calls++; if (calls <= 2) throw new Error('chunk 404'); return { activate() {} }; } }));
    fl.preload('x');
    await new Promise((r) => setTimeout(r, 0));
    await expect(fl.ensure('x', 'mode:x')).rejects.toThrow('chunk 404');
    expect(fl.statuses()[0]!.state).toBe('failed');
    const problem = getProblems().find((p) => p.id === 'feature-load-failed:x');
    expect(problem?.action?.commandId).toBe(FEATURE_RETRY_COMMAND);
    await fl.ensure('x', 'mode:x');
    expect(calls).toBe(3);
    expect(fl.isActive('x')).toBe(true);
    expect(getProblems().find((p) => p.id === 'feature-load-failed:x')).toBeUndefined();
  });

  it('retries a throwing activate without re-importing (idempotent body steps, §9.8)', async () => {
    const steps: string[] = [];
    let failStep2 = true;
    const load = vi.fn(async (): Promise<FeatureBody> => ({
      activate() {
        if (!steps.includes('one')) steps.push('one');
        if (failStep2) { failStep2 = false; throw new Error('step 2'); }
        steps.push('two');
      },
    }));
    const fl = new FeatureLoader(fakeViewer());
    fl.define(def({ load }));
    await expect(fl.ensure('x', 'mode:x')).rejects.toThrow('step 2');
    await fl.ensure('x', 'mode:x');
    expect(steps).toEqual(['one', 'two']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ensureForComponentTypes and ensureForMode only touch matching features', async () => {
    const a = vi.fn(async () => ({ activate() {} }));
    const b = vi.fn(async () => ({ activate() {} }));
    const fl = new FeatureLoader(fakeViewer());
    fl.define(def({ id: 'a', activation: ['component:DESSource'], load: a }));
    fl.define(def({ id: 'b', activation: ['mode:editor'], load: b }));
    await fl.ensureForComponentTypes(['Drive', 'Sensor']);
    await fl.ensureForMode('hmi');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    await fl.ensureForComponentTypes(['Drive', 'DESSource']);
    expect(a).toHaveBeenCalledTimes(1);
    expect(fl.statuses().find((s) => s.id === 'a')!.trigger).toBe('component:DESSource');
    await fl.ensureForMode('editor');
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown feature id', async () => {
    await expect(new FeatureLoader(fakeViewer()).ensure('nope', 'mode:nope')).rejects.toThrow(/unknown feature/);
  });

  it('records startup registrations with ms and a performance measure', async () => {
    const measure = vi.spyOn(performance, 'measure');
    const fl = new FeatureLoader(fakeViewer());
    await fl.recordStartup('share-decrypt', async () => {});
    await expect(fl.recordStartup('broken', async () => { throw new Error('x'); })).rejects.toThrow('x');
    const rows = fl.statuses();
    expect(rows.map((r) => [r.id, r.state, r.trigger])).toEqual([
      ['share-decrypt', 'active', 'startup'], ['broken', 'failed', 'startup'],
    ]);
    expect(measure.mock.calls.some((c) => c[0] === 'rv:feature.share-decrypt')).toBe(true);
    const info = vi.mocked(console.info);
    fl.define(def({ id: 'lazy' }));
    fl.logBootSummary();
    fl.logBootSummary();
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[boot] features:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/startup 2 .*deferred 1/);
  });

  it('shows the loading hint only after 300 ms, keeps it 400 ms and clears the timer on failure', async () => {
    vi.useFakeTimers();
    const showHint = vi.fn();
    const hideHint = vi.fn();
    const fl = new FeatureLoader(fakeViewer(), { showHint, hideHint });
    let release!: () => void;
    fl.define(def({ id: 'slow', label: 'Editor', load: () => new Promise((r) => { release = () => r({ activate() {} }); }) }));
    fl.define(def({ id: 'fast', label: 'Fast', load: async () => ({ activate() {} }) }));
    fl.define(def({ id: 'bad', label: 'Bad', load: async () => { throw new Error('no'); } }));

    await fl.ensure('fast', 'mode:fast');
    await vi.advanceTimersByTimeAsync(FEATURE_HINT_DELAY_MS + 50);
    expect(showHint).not.toHaveBeenCalled();

    await expect(fl.ensure('bad', 'mode:bad')).rejects.toThrow('no');
    await vi.advanceTimersByTimeAsync(FEATURE_HINT_DELAY_MS + 50);
    expect(showHint).not.toHaveBeenCalled();

    const p = fl.ensure('slow', 'mode:editor');
    await vi.advanceTimersByTimeAsync(FEATURE_HINT_DELAY_MS + 10);
    expect(showHint).toHaveBeenCalledWith('Loading Editor …');
    release();
    await p;
    expect(hideHint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FEATURE_HINT_MIN_MS);
    expect(hideHint).toHaveBeenCalledTimes(1);
  });

  it('shows no hint for a component-triggered (non-user) activation', async () => {
    vi.useFakeTimers();
    const showHint = vi.fn();
    const fl = new FeatureLoader(fakeViewer(), { showHint });
    let release!: () => void;
    fl.define(def({ load: () => new Promise((r) => { release = () => r({ activate() {} }); }) }));
    const p = fl.ensure('x', 'component:XType');
    await vi.advanceTimersByTimeAsync(1000);
    release();
    await p;
    expect(showHint).not.toHaveBeenCalled();
  });

  it('takes bytes from the chunk table', async () => {
    setFeatureChunksForTests({ x: { files: ['assets/x.body-1.js'], bytes: 2048 } });
    expect(featureChunkBytes('x')).toBe(2048);
    expect(featureChunkBytes('y')).toBeNull();
  });
});

describe('feature.retry command', () => {
  it('re-runs ensure with the last trigger', async () => {
    let fail = true;
    const fl = new FeatureLoader(fakeViewer());
    fl.define(def({ load: async () => { if (fail) { fail = false; throw new Error('x'); } return { activate() {} }; } }));
    await expect(fl.ensure('x', 'mode:x')).rejects.toThrow();
    const registry = new CommandRegistry();
    registerFeatureRetryCommand(registry as never);
    registerFeatureRetryCommand(registry as never); // idempotent
    const viewer = { features: fl } as unknown as RVViewer;
    const result = await registry.execute(FEATURE_RETRY_COMMAND, { id: 'x' }, { viewer, origin: 'ui' } as never);
    expect(fl.isActive('x')).toBe(true);
    expect(fl.statuses()[0]!.trigger).toBe('mode:x');
    expect(result).toBeTruthy();
  });
});

describe('retry after a failed chunk import (plan-652 Abnahme-Befund 1)', () => {
  it('reads the chunk URL from the engine error messages', () => {
    expect(failedChunkUrl(new TypeError('Failed to fetch dynamically imported module: http://h/assets/asset-editor.body-AB12.js')))
      .toBe('http://h/assets/asset-editor.body-AB12.js');
    expect(failedChunkUrl(new TypeError('error loading dynamically imported module: http://h/src/x.body.ts?t=1')))
      .toBe('http://h/src/x.body.ts?t=1');
    expect(failedChunkUrl(new TypeError('Importing a module script failed.'))).toBeNull();
  });
  it('appends the cache-bust query before a hash', () => {
    expect(withRetryQuery('http://h/a.js', 1)).toBe('http://h/a.js?rv-retry=1');
    expect(withRetryQuery('http://h/a.ts?t=5', 2)).toBe('http://h/a.ts?t=5&rv-retry=2');
    expect(withRetryQuery('http://h/a.js#x', 3)).toBe('http://h/a.js?rv-retry=3');
  });
  it('offers Retry for the first failures, then Reload', async () => {
    const fl = new FeatureLoader(fakeViewer());
    fl.define(def({ load: async () => { throw new Error('offline'); } }));
    for (let i = 1; i <= FEATURE_MAX_RETRIES + 1; i++) {
      await expect(fl.ensure('x', 'mode:x')).rejects.toThrow('offline');
      const action = getProblems().find((p) => p.id === 'feature-load-failed:x')?.action;
      expect(action?.commandId).toBe(i <= FEATURE_MAX_RETRIES ? FEATURE_RETRY_COMMAND : FEATURE_RELOAD_COMMAND);
    }
  });
  it('registers the reload command next to retry', () => {
    const registry = new CommandRegistry();
    registerFeatureRetryCommand(registry as never);
    expect(registry.get(FEATURE_RELOAD_COMMAND)).toBeTruthy();
  });
});

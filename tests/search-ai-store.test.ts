// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-ai-store.test.ts — AI documentation search store (plan-283 §8):
 * provider gating, status transitions, generation guard, error mapping and
 * the empty-answer path. No real network — providers are plain fakes.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  runAiSearch,
  abortAiSearch,
  resetAiSearch,
  getSearchAiSnapshot,
  subscribeSearchAi,
} from '../src/core/hmi/search-ai-store';
import { registerSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';
import type {
  DiagnoseOptions,
  DiagnoseProvider,
  DiagnoseRequest,
  DiagnoseResult,
} from '../src/plugins/diagnose/diagnose-provider';

/** Flush the promise chain (two .then hops in the store). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const RESULT: DiagnoseResult = {
  cause: 'Axis 2 overload',
  remedy: 'Reduce payload',
  sources: [{ title: 'Manual', url: 'http://x/m.pdf', page: 42 }],
  toolTrace: ['signal_read', 'sensor_list'],
};

let _unregister: (() => void) | null = null;

function register(provider: DiagnoseProvider): void {
  _unregister = registerSearchDiagnoseProvider(provider);
}

afterEach(() => {
  resetAiSearch();
  _unregister?.();
  _unregister = null;
  vi.restoreAllMocks();
});

describe('search-ai-store', () => {
  it('runAiSearch() with no registered provider stays idle', () => {
    runAiSearch('Achse 2');
    expect(getSearchAiSnapshot().status).toBe('idle');
  });

  it('runAiSearch() with a blank query stays idle', () => {
    const diagnose = vi.fn(async () => RESULT);
    register({ diagnose });
    runAiSearch('   ');
    expect(getSearchAiSnapshot().status).toBe('idle');
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('success path: idle → loading → done with parsed result', async () => {
    const diagnose = vi.fn(async (
      req: DiagnoseRequest,
      _options?: DiagnoseOptions,
    ): Promise<DiagnoseResult> => {
      expect(req).toEqual({ label: 'Achse 2' });   // free-text: label only, no nodePath
      return RESULT;
    });
    register({ diagnose });

    expect(getSearchAiSnapshot().status).toBe('idle');
    runAiSearch('Achse 2');
    expect(getSearchAiSnapshot()).toMatchObject({ status: 'loading', query: 'Achse 2' });

    await flush();
    expect(getSearchAiSnapshot()).toMatchObject({ status: 'done', query: 'Achse 2', result: RESULT });
    expect(getSearchAiSnapshot().result?.toolTrace).toEqual(['signal_read', 'sensor_list']);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(diagnose.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
  });

  it('merges plan-284 context (nodePath, docHints, machineContext) into the request', async () => {
    const diagnose = vi.fn(async (req: DiagnoseRequest): Promise<DiagnoseResult> => {
      expect(req).toEqual({
        label: 'Achse 2',
        nodePath: 'M7/GearMotor',
        docHints: ['docs/KA19.pdf'],
        machineContext: 'Node: M7/GearMotor\nDrive: TargetSpeed=250',
      });
      return RESULT;
    });
    register({ diagnose });

    runAiSearch('Achse 2', {
      nodePath: 'M7/GearMotor',
      docHints: ['docs/KA19.pdf'],
      machineContext: 'Node: M7/GearMotor\nDrive: TargetSpeed=250',
    });
    // Context is exposed on the state so the dialog can render its chip.
    expect(getSearchAiSnapshot().context?.nodePath).toBe('M7/GearMotor');

    await flush();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(getSearchAiSnapshot()).toMatchObject({ status: 'done', context: { nodePath: 'M7/GearMotor' } });
  });

  it('notifies subscribers on every transition (useSyncExternalStore contract)', async () => {
    register({ diagnose: async () => RESULT });
    const listener = vi.fn();
    const unsubscribe = subscribeSearchAi(listener);

    runAiSearch('x');
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);   // loading + done
    unsubscribe();
  });

  it('provider rejection → status "error" with readable message', async () => {
    register({ diagnose: async () => { throw new Error('Diagnose backend returned 500'); } });
    runAiSearch('x');
    await flush();
    expect(getSearchAiSnapshot()).toMatchObject({
      status: 'error',
      error: 'Diagnose backend returned 500',
    });
  });

  it('maps 429 to the rate-limit message', async () => {
    register({ diagnose: async () => { throw new Error('Diagnose backend returned 429'); } });
    runAiSearch('x');
    await flush();
    expect(getSearchAiSnapshot().error).toBe('Rate limit — try again in a minute');
  });

  it('maps 503 to the missing-API-key message', async () => {
    register({ diagnose: async () => { throw new Error('Diagnose backend returned 503'); } });
    runAiSearch('x');
    await flush();
    expect(getSearchAiSnapshot().error).toBe('No LLM API key configured in CONNECT');
  });

  it('second runAiSearch() aborts the first in-flight request (generation guard)', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const resolvers: ((r: DiagnoseResult) => void)[] = [];
    register({
      diagnose: (_req: DiagnoseRequest, options?: DiagnoseOptions) => {
        signals.push(options?.signal);
        return new Promise<DiagnoseResult>((resolve) => { resolvers.push(resolve); });
      },
    });

    runAiSearch('first');
    runAiSearch('second');
    expect(signals[0]?.aborted).toBe(true);       // first request aborted
    expect(signals[1]?.aborted).toBe(false);

    // Late answer of the FIRST request must be discarded (overtaken generation).
    resolvers[0]({ ...RESULT, cause: 'stale' });
    await flush();
    expect(getSearchAiSnapshot()).toMatchObject({ status: 'loading', query: 'second' });

    resolvers[1](RESULT);
    await flush();
    expect(getSearchAiSnapshot()).toMatchObject({ status: 'done', query: 'second', result: RESULT });
  });

  it('abortAiSearch() cancels and resets to idle', async () => {
    let signal: AbortSignal | undefined;
    let reject!: (e: unknown) => void;
    register({
      diagnose: (_req: DiagnoseRequest, options?: DiagnoseOptions) => {
        signal = options?.signal;
        return new Promise<DiagnoseResult>((_resolve, rej) => { reject = rej; });
      },
    });

    runAiSearch('x');
    expect(getSearchAiSnapshot().status).toBe('loading');
    abortAiSearch();
    expect(signal?.aborted).toBe(true);
    expect(getSearchAiSnapshot()).toMatchObject({ status: 'idle', query: '' });

    // The aborted request's rejection must NOT resurface as an error state.
    reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(getSearchAiSnapshot().status).toBe('idle');
  });

  it('empty result (cause="" remedy="" sources=[]) is "empty", not "error"', async () => {
    register({ diagnose: async () => ({ cause: '', remedy: '', sources: [] }) });
    runAiSearch('x');
    await flush();
    expect(getSearchAiSnapshot().status).toBe('empty');
  });

  it('CONNECT\'s literal "Nicht in der Dokumentation gefunden." remedy is "empty"', async () => {
    register({
      diagnose: async () => ({ cause: '', remedy: 'Nicht in der Dokumentation gefunden.', sources: [] }),
    });
    runAiSearch('x');
    await flush();
    expect(getSearchAiSnapshot().status).toBe('empty');
  });
});

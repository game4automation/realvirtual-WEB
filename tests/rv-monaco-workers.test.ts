// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-monaco-workers.test.ts — plan-555 9.1: the shared Monaco worker registry.
 *
 * Fake workers only (plain objects cast to Worker): every label gets the
 * factory registered first for it, unknown labels the '*' fallback, and the
 * order in which the loaders (TS, ST, JSON) register does not matter.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MONACO_FALLBACK_WORKER_LABEL, hasMonacoWorker, registerMonacoWorker, resetMonacoWorkersForTest,
} from '../src/core/hmi/monaco/rv-monaco-workers';

type Env = { MonacoEnvironment?: { getWorker?: (id: string, label: string) => Worker } };

const fake = (name: string) => () => ({ name } as unknown as Worker);
const nameOf = (w: Worker) => (w as unknown as { name: string }).name;
const getWorker = (label: string) => {
  const env = (self as unknown as Env).MonacoEnvironment;
  if (!env?.getWorker) throw new Error('no MonacoEnvironment installed');
  return nameOf(env.getWorker('id', label));
};

/** The three loaders as plan-555 wires them (fake factories). */
const loaders = {
  ts: () => {
    registerMonacoWorker(['typescript', 'javascript'], fake('ts'));
    registerMonacoWorker([MONACO_FALLBACK_WORKER_LABEL], fake('editor-from-ts'));
  },
  st: () => registerMonacoWorker([MONACO_FALLBACK_WORKER_LABEL], fake('editor-from-st')),
  json: () => {
    registerMonacoWorker(['json'], fake('json'));
    registerMonacoWorker([MONACO_FALLBACK_WORKER_LABEL], fake('editor-from-json'));
  },
};

afterEach(() => resetMonacoWorkersForTest());

describe('plan-555 9.1 — Monaco worker registry', () => {
  it('order TS → ST → JSON: every label gets its worker, unknown labels the fallback', () => {
    loaders.ts(); loaders.st(); loaders.json();
    expect(getWorker('typescript')).toBe('ts');
    expect(getWorker('javascript')).toBe('ts');
    expect(getWorker('json')).toBe('json');
    expect(getWorker('editorWorkerService')).toBe('editor-from-ts');
    expect(getWorker('css')).toBe('editor-from-ts');
  });

  it('order JSON → ST → TS: the same labels resolve to the same kinds of worker', () => {
    loaders.json(); loaders.st(); loaders.ts();
    expect(getWorker('typescript')).toBe('ts');
    expect(getWorker('json')).toBe('json');
    expect(getWorker('editorWorkerService')).toBe('editor-from-json');
  });

  it('the private ST loader first no longer takes the TS / JSON workers away', () => {
    loaders.st(); loaders.ts(); loaders.json();
    expect(getWorker('typescript')).toBe('ts');
    expect(getWorker('json')).toBe('json');
    expect(getWorker('editorWorkerService')).toBe('editor-from-st');
  });

  it('a second registration of a label is a no-op (first wins)', () => {
    registerMonacoWorker(['json'], fake('first'));
    registerMonacoWorker(['json'], fake('second'));
    registerMonacoWorker([MONACO_FALLBACK_WORKER_LABEL], fake('fallback'));
    expect(getWorker('json')).toBe('first');
    expect(hasMonacoWorker('json')).toBe(true);
    expect(hasMonacoWorker('typescript')).toBe(false);
  });

  it('installs ONE dispatcher, idempotently, keeping foreign environment fields', () => {
    (self as unknown as { MonacoEnvironment: Record<string, unknown> }).MonacoEnvironment = { baseUrl: 'x' };
    registerMonacoWorker(['json'], fake('json'));
    const first = (self as unknown as Env).MonacoEnvironment?.getWorker;
    registerMonacoWorker(['typescript'], fake('ts'));
    const env = (self as unknown as { MonacoEnvironment: Record<string, unknown> }).MonacoEnvironment;
    expect(env.getWorker).toBe(first);
    expect(env.baseUrl).toBe('x');
  });

  it('an unknown label without a fallback throws a clear error', () => {
    registerMonacoWorker(['json'], fake('json'));
    expect(() => getWorker('typescript')).toThrow(/no Monaco worker registered for label 'typescript'/);
  });
});

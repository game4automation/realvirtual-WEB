// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.2 — the manifest is read ONCE, also by concurrent callers.
 *
 * The old `_manifestRead` flag was set before the request finished, so a second
 * caller arriving while the first was in flight got `null` — a deploy "without a
 * project". Since `main.ts` now reads the demo manifest early (discovery) and the
 * project resolution reads the same backend later, that overlap is the normal
 * boot, not an edge case.
 */

import { describe, it, expect } from 'vitest';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';

const MANIFEST = {
  schemaVersion: 2,
  id: 'prj_once',
  name: 'Once',
  documents: [{ id: 'doc_a', path: 'models/A.glb', name: 'A' }],
};

function slowFetch(body: unknown, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('BundledBackend.readManifest — one request, every caller the same answer', () => {
  it('two concurrent calls resolve to the same manifest (not null) with exactly one fetch', async () => {
    const calls: string[] = [];
    const backend = new BundledBackend({ baseUrl: 'https://deploy.example/', fetchImpl: slowFetch(MANIFEST, calls) });
    const [a, b] = await Promise.all([backend.readManifest(), backend.readManifest()]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(a?.id).toBe('prj_once');
    expect(calls).toEqual(['https://deploy.example/project.json']);
  });

  it('a later call reuses the settled read', async () => {
    const calls: string[] = [];
    const backend = new BundledBackend({ baseUrl: 'https://deploy.example/', fetchImpl: slowFetch(MANIFEST, calls) });
    const first = await backend.readManifest();
    const again = await backend.readManifest();
    expect(again).toBe(first);
    expect(calls.length).toBe(1);
    expect(backend.hasDeployedManifest()).toBe(true);
  });

  it('a missing manifest is null for every caller, still with one request', async () => {
    const calls: string[] = [];
    const backend = new BundledBackend({
      baseUrl: 'https://deploy.example/',
      fetchImpl: (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('', { status: 404 }); }) as typeof fetch,
    });
    const [a, b] = await Promise.all([backend.readManifest(), backend.readManifest()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(calls.length).toBe(1);
  });
});

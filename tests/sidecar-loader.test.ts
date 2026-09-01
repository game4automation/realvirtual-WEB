// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSidecarProbeCache, tryFetchSidecarSpec } from '../src/core/engine/rv-scene-loader';

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string) => Promise<Response>): void {
  // @ts-expect-error override
  globalThis.fetch = vi.fn((url: string) => impl(url));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetSidecarProbeCache();
});

describe('tryFetchSidecarSpec', () => {
  it('auto-loads <glb>.kin.json when present', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('/models/Foo.kin.json');
      return new Response(JSON.stringify({
        drives: [{ target: 'Axis1', direction: 'LinearY' }],
      }), { status: 200 });
    });
    const spec = await tryFetchSidecarSpec('/models/Foo.glb');
    expect(spec).not.toBeNull();
    expect(spec!.drives).toHaveLength(1);
    expect(spec!.drives![0].direction).toBe('LinearY');
  });

  it('returns null on 404 silently (no warn)', async () => {
    mockFetch(async () => new Response('not found', { status: 404 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await tryFetchSidecarSpec('/models/Bar.glb');
    expect(spec).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null on network error silently', async () => {
    mockFetch(async () => { throw new Error('net'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await tryFetchSidecarSpec('/models/Baz.glb');
    expect(spec).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns on parse error but returns null (does not throw)', async () => {
    mockFetch(async () => new Response('{not json', { status: 200 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await tryFetchSidecarSpec('/models/Quux.glb');
    expect(spec).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null when URL does not end in .glb', async () => {
    const spec = await tryFetchSidecarSpec('/models/Foo.gltf');
    expect(spec).toBeNull();
  });

  it('preserves query string when re-locating sidecar', async () => {
    let seenUrl = '';
    mockFetch(async (url) => {
      seenUrl = url;
      return new Response('{}', { status: 200 });
    });
    await tryFetchSidecarSpec('/models/Foo.glb?v=42');
    expect(seenUrl).toBe('/models/Foo.kin.json?v=42');
  });
});

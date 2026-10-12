// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.4 — the shipped presets are fetched in parallel, the list keeps
 * the manifest order, and a first visit seeds only after the list is complete.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadPublishedPresets, listShippedPresets } from '../src/core/hmi/visual-presets';

const BASE = import.meta.env.BASE_URL ?? '/';

function preset(name: string) {
  return { name, schemaVersion: 1, settings: { lightIntensity: 1 } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('loadPublishedPresets (plan-598 F2)', () => {
  it('requests every preset file before the first one has answered, and keeps manifest order', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === `${BASE}presets/index.json`) return Response.json(['slow', 'fast', 'broken']);
      started.push(url);
      await new Promise<void>((r) => release.push(r));
      if (url.includes('broken')) return new Response('nope', { status: 500 });
      const name = url.includes('slow') ? 'Slow' : 'Fast';
      return Response.json(preset(name));
    }));
    const done = loadPublishedPresets();
    // Let the index resolve and the batch start.
    for (let i = 0; i < 10 && started.length < 3; i++) await new Promise((r) => setTimeout(r, 0));
    // All three are in flight at once — the serial loop would show exactly one here.
    expect(started.length).toBe(3);
    // Answer in reverse order; the result still follows the manifest.
    release.reverse().forEach((r) => r());
    await done;
    const names = listShippedPresets().map((p) => p.name);
    expect(names).toEqual(['Slow', 'Fast']);
  });

  it('the list is complete only when the batch has settled (what the first-visit seed awaits)', async () => {
    let answer!: () => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === `${BASE}presets/index.json`) return Response.json(['default']);
      await new Promise<void>((r) => { answer = r; });
      return Response.json(preset('Default'));
    }));
    const loaded = loadPublishedPresets();
    for (let i = 0; i < 10 && !answer; i++) await new Promise((r) => setTimeout(r, 0));
    answer();
    await loaded;
    expect(listShippedPresets().map((p) => p.name)).toEqual(['Default']);
  });
});

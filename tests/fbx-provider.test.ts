// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fbx-provider.test.ts — FBX provider contract against the unified import
 * facade (plan-238).
 *
 *   - registration in the importProviderRegistry (id 'fbx')
 *   - availability is always 'ready' (local import, no auth)
 *   - kill-switch localStorage 'rv.import.fbx'
 *   - resolve() failure path: broken input fails gracefully ({ ok, failed })
 *     instead of throwing — the dialog surfaces `failed` in its error overlay
 *   - picking textures without an .fbx is a named failure, not a silent no-op
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFbxImportProvider,
  isFbxImportEnabled,
  FBX_FLAG_KEY,
} from '@rv-private/plugins/import-providers/fbx-import-provider';
import {
  importProviderRegistry,
  resolveProviderSafe,
} from '../src/core/import/rv-import-provider';

beforeEach(() => {
  localStorage.clear();
  importProviderRegistry.unregister('fbx');
});

describe('FbxImportProvider (CadImportProvider contract)', () => {
  it('is always ready (local import, no auth)', () => {
    const p = createFbxImportProvider();
    expect(p.id).toBe('fbx');
    expect(p.label).toBe('FBX');
    expect(p.availability()).toBe('ready');
  });

  it('onAvailabilityChange returns a working unsubscribe', () => {
    const p = createFbxImportProvider();
    const off = p.onAvailabilityChange(() => undefined);
    expect(typeof off).toBe('function');
    off();
  });

  it('registers into the importProviderRegistry', () => {
    importProviderRegistry.register(createFbxImportProvider());
    expect(importProviderRegistry.get('fbx')).toBeDefined();
    expect(importProviderRegistry.list().some(p => p.id === 'fbx')).toBe(true);
    importProviderRegistry.unregister('fbx');
    expect(importProviderRegistry.get('fbx')).toBeUndefined();
  });
});

describe('kill-switch rv.import.fbx', () => {
  it('is ON by default', () => {
    expect(isFbxImportEnabled()).toBe(true);
  });

  it('is disabled by off/false/0', () => {
    for (const v of ['off', 'false', '0']) {
      localStorage.setItem(FBX_FLAG_KEY, v);
      expect(isFbxImportEnabled()).toBe(false);
    }
    localStorage.setItem(FBX_FLAG_KEY, 'on');
    expect(isFbxImportEnabled()).toBe(true);
  });
});

describe('resolve() failure path', () => {
  it('a non-FBX file fails gracefully into { failed } (no throw)', async () => {
    const p = createFbxImportProvider();
    const file = new File(['definitely not an fbx'], 'notes.fbx');
    const r = await p.resolve({ kind: 'files', files: [file] });
    expect(r.ok).toEqual([]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].id).toBe('notes.fbx');
    expect(r.failed[0].error).toMatch(/fbx/i);
  });

  it('images without an .fbx are a named failure, not a silent no-op', async () => {
    const p = createFbxImportProvider();
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'diffuse.png');
    const r = await resolveProviderSafe(p, { kind: 'files', files: [png] });
    expect(r.ok).toEqual([]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].error).toMatch(/no \.fbx file selected/i);
  });

  it('unusable input kinds resolve to an empty result, not a crash', async () => {
    const p = createFbxImportProvider();
    const r = await resolveProviderSafe(p, { kind: 'custom', data: {} });
    expect(r.ok).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it('honours an already-aborted signal without importing anything', async () => {
    const p = createFbxImportProvider();
    const file = new File(['x'], 'part.fbx');
    const controller = new AbortController();
    controller.abort();
    const r = await resolveProviderSafe(
      p, { kind: 'files', files: [file] }, undefined, controller.signal,
    );
    // A user cancel is not a failure — resolveProviderSafe swallows it entirely.
    expect(r.ok).toEqual([]);
    expect(r.failed).toEqual([]);
  });
});

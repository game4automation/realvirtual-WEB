// realvirtual WEB — AGPL-3.0 dual-licensed.
//
// editor.importCad falls back to the import-dialog provider that declares a
// file's extension when no CAD geometry provider exists for it (FBX, USD, DXF).
// This pins the registry lookup and the never-throwing resolve wrapper.

import { describe, expect, it } from 'vitest';
import {
  ImportProviderRegistry,
  fileExtensionOf,
  resolveFileViaImportProvider,
  type CadImportProvider,
  type ImportProviderInput,
  type ImportProviderResult,
  type ProviderAvailability,
} from '../src/core/import/rv-import-provider';

function fakeProvider(
  id: string,
  extensions: readonly string[] | undefined,
  resolve: (input: ImportProviderInput) => Promise<ImportProviderResult>,
  options: { order?: number; availability?: ProviderAvailability } = {},
): CadImportProvider {
  return {
    id,
    label: id.toUpperCase(),
    order: options.order,
    extensions,
    availability: () => options.availability ?? 'ready',
    onAvailabilityChange: () => () => undefined,
    renderConfigTab: () => null,
    resolve: (input) => resolve(input),
  };
}

const glbItem = (name: string): ImportProviderResult => ({
  ok: [{ kind: 'glb', bytes: new ArrayBuffer(4), suggestedName: name }],
  failed: [],
});

describe('fileExtensionOf', () => {
  it('returns the lower-case extension of the base name', () => {
    expect(fileExtensionOf('library/imports/Part.FBX')).toBe('fbx');
    expect(fileExtensionOf('a\\b\\model.usdz')).toBe('usdz');
  });

  it('returns empty for names without an extension or dotfiles', () => {
    expect(fileExtensionOf('README')).toBe('');
    expect(fileExtensionOf('dir.d/README')).toBe('');
    expect(fileExtensionOf('.gitignore')).toBe('');
  });
});

describe('ImportProviderRegistry.forFileName', () => {
  it('finds the provider that declares the extension, case-insensitively', () => {
    const registry = new ImportProviderRegistry();
    registry.register(fakeProvider('glb-file', undefined, async () => glbItem('x')));
    registry.register(fakeProvider('fbx', ['FBX'], async () => glbItem('x')));
    expect(registry.forFileName('imports/robot.fbx')?.id).toBe('fbx');
  });

  it('returns undefined for an undeclared extension and for providers without extensions', () => {
    const registry = new ImportProviderRegistry();
    registry.register(fakeProvider('glb-file', undefined, async () => glbItem('x')));
    expect(registry.forFileName('part.fbx')).toBeUndefined();
    expect(registry.forFileName('noext')).toBeUndefined();
  });

  it('picks the first provider in list() order when two claim the same extension', () => {
    const registry = new ImportProviderRegistry();
    registry.register(fakeProvider('late', ['usd'], async () => glbItem('x'), { order: 90 }));
    registry.register(fakeProvider('early', ['usd'], async () => glbItem('x'), { order: 10 }));
    expect(registry.forFileName('a.usd')?.id).toBe('early');
  });
});

describe('resolveFileViaImportProvider', () => {
  it('hands the file to the provider as a single file input and returns its items', async () => {
    const registry = new ImportProviderRegistry();
    let seen: ImportProviderInput | null = null;
    registry.register(fakeProvider('fbx', ['fbx'], async (input) => { seen = input; return glbItem('robot'); }));

    const file = new File([new Uint8Array([1, 2, 3])], 'robot.fbx');
    const result = await resolveFileViaImportProvider(registry, file);

    expect(result).toMatchObject({ ok: true, providerId: 'fbx', failed: [] });
    expect(result.ok && result.items).toHaveLength(1);
    expect(seen).toEqual({ kind: 'file', file });
  });

  it('reports an unsupported format without throwing', async () => {
    const result = await resolveFileViaImportProvider(new ImportProviderRegistry(), new File([], 'part.xyz'));
    expect(result).toEqual({ ok: false, error: 'No import provider for "part.xyz" (format not supported in this build)' });
  });

  it('refuses a provider that is not ready and never calls it', async () => {
    const registry = new ImportProviderRegistry();
    let called = false;
    registry.register(fakeProvider('usd', ['usd'], async () => { called = true; return glbItem('x'); },
      { availability: 'needs-setup' }));
    const result = await resolveFileViaImportProvider(registry, new File([], 'a.usd'));
    expect(result).toEqual({ ok: false, error: 'USD import is not ready (needs-setup)' });
    expect(called).toBe(false);
  });

  it('turns a throwing provider into an error naming the cause', async () => {
    const registry = new ImportProviderRegistry();
    registry.register(fakeProvider('fbx', ['fbx'], async () => { throw new Error('corrupt header'); }));
    const result = await resolveFileViaImportProvider(registry, new File([], 'bad.fbx'));
    expect(result).toEqual({ ok: false, error: 'FBX import of "bad.fbx" failed: corrupt header' });
  });

  it('keeps the failed entries of a partial success', async () => {
    const registry = new ImportProviderRegistry();
    registry.register(fakeProvider('fbx', ['fbx'], async () => ({
      ok: glbItem('a').ok,
      failed: [{ id: 'texture.png', error: 'missing' }],
    })));
    const result = await resolveFileViaImportProvider(registry, new File([], 'a.fbx'));
    expect(result).toMatchObject({ ok: true, failed: [{ id: 'texture.png', error: 'missing' }] });
  });
});

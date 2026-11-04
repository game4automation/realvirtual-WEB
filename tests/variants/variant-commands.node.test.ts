// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import '../../src/behaviors/Source';
import '../../src/behaviors/Agv';
import type { RVViewer } from '../../src/core/rv-viewer';
import { CommandRegistry } from '../../src/core/hmi/rv-command-registry';
import { VariantsPlugin } from '../../src/plugins/variants';
import { VARIANT_COMMAND_IDS, ensureVariantCommandsRegistered } from '../../src/plugins/variants/variant-command-descriptors';
import { renameVariant, setVariant } from '../../src/plugins/variants/variant-commands';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

let plugin: VariantsPlugin;
let commands: CommandRegistry;
let viewer: RVViewer;
let root: Object3D;
let src: Object3D;
let resets: number;
let findNodeForUser: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  root = new Object3D(); root.name = 'Root'; root.userData.realvirtual = {};
  src = new Object3D(); src.name = 'Src'; src.userData.realvirtual = { Source: { Interval: 10 } }; root.add(src);
  resets = 0;
  findNodeForUser = vi.fn((path: string) => path === 'Root/Src' ? { node: src, via: 'runtime' } : null);
  plugin = new VariantsPlugin();
  const registry = {
    findNodeForUser,
    getAddressForNode: (node: Object3D) => node === src ? '#src' : null,
    getPathForNode: (node: Object3D) => node === src ? 'Root/Src' : null,
    getNodeByAddress: (id: string, occurrence = '') => `${occurrence}#${id}` === '#src' ? src : null,
    getNode: (path: string) => path === 'Root/Src' ? src : null,
  };
  viewer = {
    registry,
    modes: { activeMode: 'viewer' },
    isSimulationPaused: false,
    setSimulationPaused() {},
    resetSimulation() { resets++; },
    async structuralEdit<T>(fn: () => T | Promise<T>) { return fn(); },
    simulationKernel: null,
    whenSceneReady: () => Promise.resolve(),
    getPlugin: (id: string) => id === 'variants' ? plugin : undefined,
  } as unknown as RVViewer;
  plugin.init(viewer);
  plugin.onModelLoaded({ root }, viewer);
  commands = new CommandRegistry();
  commands.attachViewer(viewer);
  ensureVariantCommandsRegistered(commands);
});

afterEach(() => {
  plugin.dispose();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

async function run(id: string, args: Record<string, unknown> = {}) {
  const result = await commands.execute(id, args, { origin: 'mcp' });
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value as Record<string, unknown>;
}

describe('variant commands (plan-2013 9.5)', () => {
  it('keeps list read-only and does not load an opted-out runtime', async () => {
    expect(await run('variant.list')).toMatchObject({ enabled: false, active: null, dirty: false, variants: [] });
    expect(plugin.runtimeLoaded).toBe(false);
  });

  // Concept D: a document WITH a block is auto-ON, so list/diff see it without a switch.
  it('binds a document with a block for list/diff and refuses a directly unbound save', async () => {
    root.userData.realvirtual = {
      Variants: {
        version: 1,
        active: 'fast',
        variants: [{
          id: 'fast', name: 'Fast', revision: 1,
          overrides: [{ address: '#src', component: 'Source', field: 'Interval', value: 4 }],
        }],
      },
    };
    plugin.onModelLoaded({ root }, viewer);

    expect(await run('variant.list')).toMatchObject({ enabled: true, active: null, variants: [{ id: 'fast', name: 'Fast' }] });
    expect(await run('variant.diff')).toMatchObject({ rows: [{ address: '#src', values: { fast: 4 } }] });
    const rt = await plugin.runtime();
    expect(rt.store.block.variants).toHaveLength(1);
    rt.unbindDocument();
    await expect(rt.save()).rejects.toThrow('No document bound');
    expect(root.userData.realvirtual.Variants).toBeDefined();
  }, 20_000); // pays the cold import of the lazy runtime chunk

  it('creates in scene, sets by path/address, unsets with null, diffs and duplicates without activation', async () => {
    const made = await run('variant.create', { name: 'Fast' });
    const id = made.id as string;
    const rt = await plugin.runtime();
    expect(plugin.enabled).toBe(true);
    expect(rt.store.sceneVariant).toBe(id);

    const byPath = await run('variant.set', { id, path: 'Root/Src', component: 'Source', field: 'Interval', value: 4 });
    expect(findNodeForUser).toHaveBeenCalledWith('Root/Src');
    expect(byPath).toMatchObject({ address: '#src', path: 'Root/Src', component: 'Source', field: 'Interval', unit: 's' });
    expect((byPath.values as Record<string, unknown>)[id]).toBe(4);

    await run('variant.set', { id, address: '#src', component: 'Source', field: 'Interval', value: 5 });
    expect(rt.store.variant(id)?.overrides[0].value).toBe(5);
    await run('variant.set', { id, address: '#src', component: 'Source', field: 'Interval', value: null });
    expect(rt.store.variant(id)?.overrides).toEqual([]);
    await setVariant(viewer, { id, address: '#src', component: 'Source', field: 'Interval', value: 4 });

    expect(await run('variant.diff')).toMatchObject({ rows: [{
      address: '#src', path: 'Root/Src', component: 'Source', field: 'Interval', unit: 's', base: 10,
      values: { [id]: 4 }, missingIn: [],
    }] });
    expect(await run('variant.activate', { id: 'base' })).toEqual({ ok: true });
    expect(await run('variant.activate', { id })).toEqual({ ok: true, id });

    const copy = await run('variant.duplicate', { id, name: 'Copy' });
    const copyId = copy.id as string;
    expect(rt.store.variant(copyId)?.overrides).toEqual(rt.store.variant(id)?.overrides);
    expect(rt.store.sceneVariant).toBe(id);
    expect(await run('variant.save')).toMatchObject({ persistedTo: 'session', revision: expect.any(Number) });
  }, 20_000); // the first test pays the cold import of the lazy runtime chunk

  it('read-only calls do not write, and direct UI functions use the same implementation seam', async () => {
    const id = (await run('variant.create', { name: 'One' })).id as string;
    await run('variant.set', { id, address: '#src', component: 'Source', field: 'Interval', value: 4 });
    const rt = await plugin.runtime();
    const before = JSON.stringify(rt.store.block);
    const resetCount = resets;
    await run('variant.list');
    await run('variant.diff');
    expect(JSON.stringify(rt.store.block)).toBe(before);
    expect(resets).toBe(resetCount);

    const rename = vi.spyOn(rt.store, 'rename');
    await renameVariant(viewer, { id, name: 'From UI' });
    await run('variant.rename', { id, name: 'From command' });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rt.store.variant(id)?.name).toBe('From command');
  });

  it('parses finite numeric strings and rejects invalid input without changing the override', async () => {
    const id = (await run('variant.create', { name: 'Numeric' })).id as string;
    expect(commands.get('variant.set')?.argsSchema.value).toBe('string');
    const args = { id, address: '#src', component: 'Source', field: 'Interval' };
    expect(await run('variant.set', { ...args, value: '800' })).toMatchObject({ values: { [id]: 800 } });
    expect(await run('variant.set', { ...args, value: 800 })).toMatchObject({ values: { [id]: 800 } });
    for (const value of ['abc', '', 'Infinity', '1e999']) {
      expect(await run('variant.set', { ...args, value })).toMatchObject({ ok: false, reason: expect.stringContaining('finite number') });
    }
    expect(await run('variant.diff')).toMatchObject({ rows: [{ unit: 's', values: { [id]: 800 } }] });
  });

  it('parses "true"/"false" strings for a boolean field and rejects anything else', async () => {
    src.userData.realvirtual.Source.LimitNumber = false;
    const id = (await run('variant.create', { name: 'Bool' })).id as string;
    const args = { id, address: '#src', component: 'Source', field: 'LimitNumber' };
    expect(await run('variant.set', { ...args, value: 'true' })).toMatchObject({ values: { [id]: true } });
    expect(await run('variant.set', { ...args, value: ' FALSE ' })).toMatchObject({ values: { [id]: false } });
    expect(await run('variant.set', { ...args, value: true })).toMatchObject({ values: { [id]: true } });
    for (const value of ['yes', '1', '']) {
      expect(await run('variant.set', { ...args, value })).toMatchObject({ ok: false, reason: expect.stringContaining('needs a boolean') });
    }
    const rt = await plugin.runtime();
    expect(rt.store.variant(id)?.overrides[0].value).toBe(true);
  });

  it('reports the Agv TargetSpeed schema unit', async () => {
    src.userData.realvirtual.Agv = { TargetSpeed: 1200 };
    const id = (await run('variant.create', { name: 'AGV speed' })).id as string;
    await run('variant.set', { id, address: '#src', component: 'Agv', field: 'TargetSpeed', value: '800' });
    expect(await run('variant.diff')).toMatchObject({ rows: [{ component: 'Agv', field: 'TargetSpeed', unit: 'mm/s' }] });
  });

  it('registers the requested classes only, without variant.generate', () => {
    expect(new Set(VARIANT_COMMAND_IDS)).toEqual(new Set([
      'variant.list', 'variant.diff', 'variant.create', 'variant.activate', 'variant.set',
      'variant.rename', 'variant.duplicate', 'variant.delete', 'variant.save',
    ]));
    expect(commands.get('variant.list')?.readOnly).toBe(true);
    expect(commands.get('variant.diff')?.readOnly).toBe(true);
    expect(commands.get('variant.activate')?.toolClass).toBe('sim');
    expect(commands.get('variant.delete')?.destructive).toBe(true);
    expect(commands.get('variant.save')?.toolClass).toBe('save');
    expect(commands.get('variant.generate')).toBeUndefined();
  });
});

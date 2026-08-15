// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.9 — the runtime resolver of a `scriptRef` (plan-718 stage 2b).
 *
 * Covers what the plan names: `.js`-sibling resolution, the `import()` error
 * path, cache invalidation after a save (cache-busting), class-or-instance, and
 * the consent gate in all three of its states (granted / refused / persisted).
 *
 * The importer is injected everywhere. A real dynamic `import()` of a Blob URL
 * works in the browser runner, but a test that used it would assert what
 * Chromium's module map does rather than what this code does — and could not
 * observe the URL that was handed over, which is where the cache-busting lives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  jsSiblingOf,
  hashBytes,
  resolveModuleExport,
  loadRuntimeScript,
  lastRuntimeScriptFailure,
  type RuntimeScriptSource,
} from '../src/core/rv-script-runtime-loader';
import {
  ModelPluginManager,
  asModelPluginModule,
  type ModelPluginModule,
} from '../src/core/rv-model-plugin-manager';
import { setContext, _resetStore } from '../src/core/hmi/ui-context-store';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Fixtures ───────────────────────────────────────────────────────────

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** A project whose files are an object literal. */
function sourceOf(files: Record<string, string>): RuntimeScriptSource {
  return {
    readBytes: (rel: string) =>
      Promise.resolve(rel in files ? bytesOf(files[rel]) : null),
  };
}

function pluginModule(): ModelPluginModule & { registered: number } {
  const mod = {
    registered: 0,
    registerModelPlugins: () => { mod.registered++; },
    unregisterModelPlugins: () => { /* noop */ },
  };
  return mod;
}

function fakeViewer(): RVViewer & { pendingModelUrl: string | null } {
  return {
    pendingModelUrl: null,
    projectAssetsPath: import.meta.env.BASE_URL,
    withDefaultOrigin: (_origin: string, fn: () => void) => fn(),
  } as unknown as RVViewer & { pendingModelUrl: string | null };
}

const allow = () => true;

beforeEach(() => { localStorage.clear(); });
afterEach(() => { setContext('planner', false); _resetStore(); localStorage.clear(); });

// ─── Paths ──────────────────────────────────────────────────────────────

describe('jsSiblingOf', () => {
  it('maps a TypeScript reference onto its compiled sibling', () => {
    expect(jsSiblingOf('scripts/linie1/index.ts')).toBe('scripts/linie1/index.js');
    expect(jsSiblingOf('scripts/a.tsx')).toBe('scripts/a.js');
    expect(jsSiblingOf('./scripts/a.ts')).toBe('scripts/a.js');
    expect(jsSiblingOf('scripts\\a.ts')).toBe('scripts/a.js');
  });

  it('treats a .js reference as its own sibling — a project may ship only compiled code', () => {
    expect(jsSiblingOf('scripts/a.js')).toBe('scripts/a.js');
    expect(jsSiblingOf('scripts/a.mjs')).toBe('scripts/a.mjs');
  });

  it('guesses nothing for a reference that names no script', () => {
    expect(jsSiblingOf('connect/config.json')).toBeNull();
    expect(jsSiblingOf('scripts')).toBeNull();
    expect(jsSiblingOf('')).toBeNull();
  });
});

// ─── Export shape ───────────────────────────────────────────────────────

describe('resolveModuleExport — class OR instance', () => {
  it('instantiates a default-exported class', () => {
    class Thing { readonly id = 'thing'; }
    const value = resolveModuleExport({ default: Thing }) as Thing;
    expect(value).toBeInstanceOf(Thing);
    expect(value.id).toBe('thing');
  });

  it('hands a default-exported instance over untouched', () => {
    const instance = { id: 'thing' };
    expect(resolveModuleExport({ default: instance })).toBe(instance);
  });

  it('falls back to the namespace when there is no default export', () => {
    const ns = { registerModelPlugins: () => {}, unregisterModelPlugins: () => {} };
    expect(resolveModuleExport(ns)).toBe(ns);
  });

  it('accepts all three shapes as a model-plugin module', () => {
    class Mod {
      registerModelPlugins() { /* noop */ }
      unregisterModelPlugins() { /* noop */ }
    }
    expect(asModelPluginModule(new Mod())).not.toBeNull();
    expect(asModelPluginModule(resolveModuleExport({ default: Mod }))).not.toBeNull();
    expect(asModelPluginModule({ registerModelPlugins: () => {} })).toBeNull();
    expect(asModelPluginModule(null)).toBeNull();
  });
});

// ─── Resolution ─────────────────────────────────────────────────────────

describe('loadRuntimeScript — the .js sibling', () => {
  it('loads the sibling of a .ts reference', async () => {
    const seen: string[] = [];
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: sourceOf({ 'scripts/a.js': 'export default {}' }),
      consent: allow,
      importer: (url) => { seen.push(url); return Promise.resolve({ default: { id: 'x' } }); },
    });
    expect(loaded?.jsRef).toBe('scripts/a.js');
    expect(loaded?.value).toEqual({ id: 'x' });
    expect(seen).toHaveLength(1);
    expect(seen[0].startsWith('blob:')).toBe(true);
  });

  it('reports "no sibling" — and asks for nothing — when the project has no compiled file', async () => {
    const consent = vi.fn(() => true);
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: sourceOf({ 'scripts/a.ts': 'export default {}' }),  // source only
      consent,
      importer: () => Promise.reject(new Error('must not be reached')),
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('no-sibling');
    expect(consent).not.toHaveBeenCalled();
  });

  it('reports the import failure rather than throwing', async () => {
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: sourceOf({ 'scripts/a.js': 'syntax error(' }),
      consent: allow,
      importer: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('import-failed');
  });

  it('survives a source that throws', async () => {
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: { readBytes: () => Promise.reject(new Error('disk gone')) },
      consent: allow,
      importer: () => Promise.resolve({}),
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('no-sibling');
  });

  it('falls back to a plain URL and cache-busts it when there are no bytes', async () => {
    const seen: string[] = [];
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: {
        readBytes: () => Promise.resolve(null),
        resolveUrl: (rel) => Promise.resolve(`https://example.test/${rel}`),
      },
      consent: allow,
      importer: (url) => { seen.push(url); return Promise.resolve({ default: {} }); },
    });
    expect(loaded).not.toBeNull();
    expect(seen[0]).toMatch(/^https:\/\/example\.test\/scripts\/a\.js\?v=/);
  });

  it('rejects a reference that names no script before touching the source', async () => {
    const loaded = await loadRuntimeScript('connect/config.json', {
      source: sourceOf({}),
      consent: allow,
      importer: () => Promise.resolve({}),
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('not-a-script-ref');
  });
});

// ─── Cache-busting ──────────────────────────────────────────────────────

describe('cache-busting', () => {
  it('hashes different bytes to different versions, equal bytes to one', async () => {
    const a = await hashBytes(bytesOf('export default 1'));
    const b = await hashBytes(bytesOf('export default 2'));
    const a2 = await hashBytes(bytesOf('export default 1'));
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
  });

  it('gives a re-saved script a fresh URL the module map has never seen', async () => {
    const files: Record<string, string> = { 'scripts/a.js': 'export default 1' };
    const seen: string[] = [];
    const opts = {
      source: sourceOf(files),
      consent: allow,
      importer: (url: string) => { seen.push(url); return Promise.resolve({ default: {} }); },
    };
    const first = await loadRuntimeScript('scripts/a.ts', opts);
    files['scripts/a.js'] = 'export default 2';                       // the save
    const second = await loadRuntimeScript('scripts/a.ts', {
      ...opts, source: sourceOf(files),
    });
    expect(first?.version).not.toBe(second?.version);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

// ─── Consent ────────────────────────────────────────────────────────────

describe('consent gate (R8)', () => {
  it('does not import when consent is refused', async () => {
    const importer = vi.fn(() => Promise.resolve({ default: {} }));
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: sourceOf({ 'scripts/a.js': 'export default {}' }),
      consent: () => false,
      importer,
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('denied');
    expect(importer).not.toHaveBeenCalled();
  });

  it('denies when no consent callback was wired at all', async () => {
    const importer = vi.fn(() => Promise.resolve({ default: {} }));
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: sourceOf({ 'scripts/a.js': 'export default {}' }),
      importer,
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('denied');
    expect(importer).not.toHaveBeenCalled();
  });

  it('denies when the consent callback throws', async () => {
    const loaded = await loadRuntimeScript('scripts/a.ts', {
      source: sourceOf({ 'scripts/a.js': 'export default {}' }),
      consent: () => { throw new Error('dialog exploded'); },
      importer: () => Promise.resolve({ default: {} }),
    });
    expect(loaded).toBeNull();
    expect(lastRuntimeScriptFailure()).toBe('denied');
  });
});

// ─── Through the manager ────────────────────────────────────────────────

describe('ModelPluginManager — runtime resolver (2b.1)', () => {
  const doc = { modelUrl: 'models/linie1.glb', modelName: 'linie1' };

  function manager(files: Record<string, string>, consent: () => boolean = allow) {
    return new ModelPluginManager({
      importers: {},                                    // nothing bundled
      scriptRefProvider: () => 'scripts/a.ts',
      runtimeScriptSource: () => ({
        readBytes: (rel: string) =>
          Promise.resolve(rel in files ? bytesOf(files[rel]) : null),
      }),
      runtimeScriptConsent: consent,
    });
  }

  it('binds a project-carried module when nothing in the build matches', async () => {
    // The loader imports a Blob URL for real here — so the file has to BE a
    // module. That is the one place where the real dynamic import is the point.
    const files = {
      'scripts/a.js':
        'export function registerModelPlugins(){ globalThis.__rvRuntimeTest = (globalThis.__rvRuntimeTest ?? 0) + 1; }\n'
        + 'export function unregisterModelPlugins(){}\n',
    };
    (globalThis as Record<string, unknown>).__rvRuntimeTest = 0;
    const mgr = manager(files);
    await mgr.onModelLoading(doc.modelUrl, fakeViewer());
    expect((globalThis as Record<string, unknown>).__rvRuntimeTest).toBe(1);
  });

  it('loads nothing when the project has no consent', async () => {
    (globalThis as Record<string, unknown>).__rvRuntimeTestDenied = 0;
    const files = {
      'scripts/a.js':
        'export function registerModelPlugins(){ globalThis.__rvRuntimeTestDenied = 1; }\n'
        + 'export function unregisterModelPlugins(){}\n',
    };
    const mgr = manager(files, () => false);
    await mgr.onModelLoading(doc.modelUrl, fakeViewer());
    expect((globalThis as Record<string, unknown>).__rvRuntimeTestDenied).toBe(0);
  });

  it('re-imports after invalidateScript — the save seam (R13)', async () => {
    (globalThis as Record<string, unknown>).__rvRuntimeVersion = '';
    const files: Record<string, string> = {
      'scripts/a.js':
        'export function registerModelPlugins(){ globalThis.__rvRuntimeVersion = "v1"; }\n'
        + 'export function unregisterModelPlugins(){}\n',
    };
    const mgr = new ModelPluginManager({
      importers: {},
      scriptRefProvider: () => 'scripts/a.ts',
      runtimeScriptSource: () => ({
        readBytes: (rel: string) =>
          Promise.resolve(rel in files ? bytesOf(files[rel]) : null),
      }),
      runtimeScriptConsent: allow,
    });
    const viewer = fakeViewer();
    await mgr.onModelLoading('models/linie1.glb', viewer);
    expect((globalThis as Record<string, unknown>).__rvRuntimeVersion).toBe('v1');

    // A save: new bytes on disk. Without the invalidation the cached module
    // would still be the one that writes "v1".
    files['scripts/a.js'] =
      'export function registerModelPlugins(){ globalThis.__rvRuntimeVersion = "v2"; }\n'
      + 'export function unregisterModelPlugins(){}\n';
    mgr.invalidateScript('scripts/a.ts');

    // A different model name is what makes the manager resolve again.
    await mgr.onModelLoading('models/linie2.glb', viewer);
    expect((globalThis as Record<string, unknown>).__rvRuntimeVersion).toBe('v2');
  });

  it('never falls back to the name match when the runtime path finds nothing', async () => {
    const named = pluginModule();
    const mgr = new ModelPluginManager({
      importers: { '/src/plugins/models/linie1/index.ts': () => Promise.resolve(named) },
      scriptRefProvider: () => 'scripts/missing.ts',
      runtimeScriptSource: () => ({ readBytes: () => Promise.resolve(null) }),
      runtimeScriptConsent: allow,
    });
    await mgr.onModelLoading('models/linie1.glb', fakeViewer());
    expect(named.registered).toBe(0);
  });
});

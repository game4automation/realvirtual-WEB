// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-591 §9.2 — the descriptor `view.visualPreset`: registration, the guards
 * (unknown name, the deployment lock), the per-name button key, the MCP mirror,
 * the return value — and above all F12: the two fixed quality rows must apply
 * the SHIPPED preset, never a browser-local one of the same name.
 *
 * The F12 cases are asserted through the real dispatch, not just the resolver:
 * the bug this guards against was precisely a view that resolved the shipped
 * preset and then applied the local one, because only the NAME travelled.
 *
 * Node environment. `loadPublishedPresets()` fetches the shipped manifest, so
 * `fetch` is stubbed with the real files' shape — the published tier cannot be
 * seeded any other way, and mocking the module would stop testing the resolver.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  ensureViewCommandsRegistered, visualPresetKey, visualPresetInvalid,
} from '../src/core/hmi/view-commands';
import { RENDER_MODE_LOCKED } from '../src/core/hmi/render-mode-controller';
import {
  captureCurrentPreset, listPresets, listShippedPresets, loadPublishedPresets, matchPreset,
  type VisualPreset,
} from '../src/core/hmi/visual-presets';
import { loadVisualSettings } from '../src/core/hmi/visual-settings-store';
import { setAppConfig } from '../src/core/rv-app-config';
import { fakeRenderViewer, type FakeRenderViewer } from './helpers/fake-render-viewer';

const ID = 'view.visualPreset';

/** The node environment has no DOM. The local preset tier and the settings
 *  store are plain `localStorage` users, so an in-memory one is enough. */
function installLocalStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  });
}

/** A preset built from the live defaults, with explicit overrides. */
function makePreset(name: string, overrides: Record<string, unknown> = {}): VisualPreset {
  const p = captureCurrentPreset(name);
  Object.assign(p.settings as Record<string, unknown>, overrides);
  return p;
}

function putLocalPreset(p: VisualPreset): void {
  const raw = localStorage.getItem('rv-visual-presets');
  const arr: VisualPreset[] = raw ? JSON.parse(raw) : [];
  localStorage.setItem('rv-visual-presets', JSON.stringify([...arr.filter((x) => x.name !== p.name), p]));
}

/** Serve a published tier through `fetch`, the only door into `_published`. */
async function seedPublished(presets: VisualPreset[]): Promise<void> {
  const names = presets.map((p) => p.name);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('presets/index.json')) {
      return { ok: true, json: async () => names } as unknown as Response;
    }
    const hit = presets.find((p) => u.endsWith(`presets/${encodeURIComponent(p.name)}.preset.json`));
    if (hit) return { ok: true, json: async () => hit } as unknown as Response;
    return { ok: false, json: async () => ({}) } as unknown as Response;
  }));
  await loadPublishedPresets();
}

/** A viewer the preset apply can run against: `applyVisualSettings` recorded. */
function presetViewer(antialiasActive = false): FakeRenderViewer & { applied: unknown[] } {
  const v = fakeRenderViewer({ renderMode: 'default' }) as unknown as Record<string, unknown>;
  const applied: unknown[] = [];
  v['applied'] = applied;
  v['applyVisualSettings'] = (s: unknown) => { applied.push(s); };
  v['antialiasActive'] = antialiasActive;
  v['maxDpr'] = 0;
  return v as unknown as FakeRenderViewer & { applied: unknown[] };
}

describe('view.visualPreset', () => {
  let registry: CommandRegistry;
  beforeEach(async () => {
    installLocalStorage();
    registry = new CommandRegistry();
    setAppConfig({});
    ensureViewCommandsRegistered(registry);
    ensureSessionOverlayCommandsRegistered(registry);
    ensureComponentCommandsRegistered(registry);
    ensureQueryCommandsRegistered(registry);
    ensureDocumentCommandsRegistered(registry);
    ensureSignalAutomapCommandsRegistered(registry);
    ensureDesPlcCommandsRegistered(registry);
    await seedPublished([]);
  });
  afterEach(() => {
    setAppConfig({});
    vi.unstubAllGlobals();
  });

  it('registers once (idempotent) with mcp mirror web_view_visual_preset and the wire argsSchema', () => {
    ensureViewCommandsRegistered(registry);
    ensureSessionOverlayCommandsRegistered(registry);
    ensureComponentCommandsRegistered(registry);
    ensureQueryCommandsRegistered(registry);
    ensureDocumentCommandsRegistered(registry);
    ensureSignalAutomapCommandsRegistered(registry);
    ensureDesPlcCommandsRegistered(registry);
    const d = registry.get(ID)!;
    expect(d).toBeDefined();
    expect(d.mcp?.tool).toBe('web_view_visual_preset');
    expect(d.mcp?.params).toEqual([
      { name: 'name', type: 'string', required: true },
      { name: 'source', type: 'string', required: false },
    ]);
    // Must be the WIRE shape — `source` travels to the apply, so it is a real
    // argument and not a caller-side detail (F12).
    expect(d.argsSchema).toEqual({ name: 'string', source: 'string' });
    expect(d.scope).toBe('none');
    expect(d.readOnly).toBe(false);
    expect(d.eagerImpl).toBeDefined();
    expect(registry.list().filter((x) => x.id === ID)).toHaveLength(1);
  });

  it('buttonKey is per preset name', () => {
    expect(registry.buttonKeyOf(ID, { name: 'Fast' })).toBe('view.visualPreset:Fast');
    expect(registry.buttonKeyOf(ID, { name: 'Default' })).toBe(visualPresetKey('Default'));
    expect(registry.buttonKeyOf(ID, undefined)).toBe('view.visualPreset:');
  });

  it('refuses an unknown name with a reason that NAMES the available presets', async () => {
    await seedPublished([makePreset('Default'), makePreset('Fast')]);
    const viewer = presetViewer();
    const refusal = registry.enabled(ID, { name: 'Nope' }, viewer);
    expect(refusal).toEqual({ reason: visualPresetInvalid() });
    expect((refusal as { reason: string }).reason).toMatch(/Default/);
    expect((refusal as { reason: string }).reason).toMatch(/Fast/);
    // Missing name is the same refusal, not a crash.
    expect(registry.enabled(ID, {}, viewer)).toEqual({ reason: visualPresetInvalid() });
    expect(registry.enabled(ID, { name: 'Fast' }, viewer)).toBe(true);
  });

  it('refuses a locked Visual tab with the SAME reason as view.renderMode, and the lock wins', async () => {
    await seedPublished([makePreset('Default')]);
    const viewer = presetViewer();
    setAppConfig({ lockedTabs: ['visual'] });
    expect(registry.enabled(ID, { name: 'Default' }, viewer)).toEqual({ reason: RENDER_MODE_LOCKED });
    // Even for a name that is invalid anyway: ONE reason, the lock.
    expect(registry.enabled(ID, { name: 'Nope' }, viewer)).toEqual({ reason: RENDER_MODE_LOCKED });
    setAppConfig({ lockSettings: true });
    expect(registry.enabled(ID, { name: 'Default' }, viewer))
      .toMatchObject({ reason: expect.stringMatching(/locked/) });
  });

  it('run returns {name, source, antialiasNeedsReload} and applies to the viewer', async () => {
    await seedPublished([makePreset('Default', { antialias: true, maxDpr: 2 })]);
    const viewer = presetViewer(false); // renderer has NO MSAA → a reload would change it
    const r = await registry.execute(ID, { name: 'Default' }, { origin: 'ui', viewer });
    expect(r).toEqual({
      ok: true,
      value: { name: 'Default', source: 'shipped', antialiasNeedsReload: true },
    });
    expect(viewer.applied).toHaveLength(1);
    expect(loadVisualSettings().maxDpr).toBe(2);
  });

  it('antialiasNeedsReload is false when the renderer already matches', async () => {
    await seedPublished([makePreset('Default', { antialias: true })]);
    const viewer = presetViewer(true);
    const r = await registry.execute(ID, { name: 'Default' }, { origin: 'ui', viewer });
    expect(r).toMatchObject({ ok: true, value: { antialiasNeedsReload: false } });
  });

  it("a missing source defaults to 'any' — a purely LOCAL preset is applicable", async () => {
    putLocalPreset(makePreset('MyOwn', { maxDpr: 0.75 }));
    const viewer = presetViewer();
    expect(registry.enabled(ID, { name: 'MyOwn' }, viewer)).toBe(true);
    const r = await registry.execute(ID, { name: 'MyOwn' }, { origin: 'mcp', viewer });
    expect(r).toMatchObject({ ok: true, value: { name: 'MyOwn', source: 'local' } });
  });

  it("source:'shipped' resolves against listShippedPresets() only", async () => {
    await seedPublished([makePreset('Default')]);
    putLocalPreset(makePreset('MyOwn'));
    const viewer = presetViewer();
    expect(listPresets().map((p) => p.name).sort()).toEqual(['Default', 'MyOwn']);
    expect(listShippedPresets().map((p) => p.name)).toEqual(['Default']);
    // A local-only name is NOT reachable through the fixed rows...
    expect(registry.enabled(ID, { name: 'MyOwn', source: 'shipped' }, viewer))
      .toEqual({ reason: visualPresetInvalid('shipped') });
    // ...and the refusal text is derived from the SHIPPED list, not from listPresets().
    expect((registry.enabled(ID, { name: 'MyOwn', source: 'shipped' }, viewer) as { reason: string }).reason)
      .not.toMatch(/MyOwn/);
    expect(registry.enabled(ID, { name: 'Default', source: 'shipped' }, viewer)).toBe(true);
  });

  it('F12 at the real dispatch: a local "Default" does NOT hijack the shipped one', async () => {
    // The shipped Default is the full look; a local one of the same name is junk.
    await seedPublished([makePreset('Default', { maxDpr: 2, shadowMapSize: 2048 })]);
    putLocalPreset(makePreset('Default', { maxDpr: 0.5, shadowMapSize: 256 }));
    // listPresets() lets the local one win — that is the trap.
    expect(listPresets().find((p) => p.name === 'Default')!.settings.maxDpr).toBe(0.5);
    const viewer = presetViewer();
    const r = await registry.execute(ID, { name: 'Default', source: 'shipped' }, { origin: 'ui', viewer });
    expect(r).toMatchObject({ ok: true, value: { name: 'Default', source: 'shipped' } });
    // The SHIPPED values landed, not the local ones.
    expect(loadVisualSettings().maxDpr).toBe(2);
    expect(loadVisualSettings().shadowMapSize).toBe(2048);
    // And the marking the row uses agrees with what it applied.
    expect(matchPreset(listShippedPresets())).toBe('Default');
  });

  it('F12, no fallback: a missing shipped preset refuses instead of taking the local one', async () => {
    // The manifest failed to load (visual-presets swallows that silently) while a
    // local preset of the same name exists.
    await seedPublished([]);
    putLocalPreset(makePreset('Default', { maxDpr: 0.5 }));
    const viewer = presetViewer();
    expect(registry.enabled(ID, { name: 'Default', source: 'shipped' }, viewer))
      .toEqual({ reason: visualPresetInvalid('shipped') });
    const r = await registry.execute(ID, { name: 'Default', source: 'shipped' }, { origin: 'ui', viewer });
    expect(r).toMatchObject({ ok: false, kind: 'disabled' });
    // Nothing was applied — no silent substitution.
    expect(viewer.applied).toEqual([]);
  });

  it('a refused execute touches the viewer not at all', async () => {
    await seedPublished([makePreset('Default')]);
    const viewer = presetViewer();
    setAppConfig({ lockSettings: true });
    const r = await registry.execute(ID, { name: 'Default' }, { origin: 'mcp', viewer });
    expect(r).toMatchObject({ ok: false, kind: 'disabled', reason: expect.stringMatching(/locked/) });
    expect(viewer.applied).toEqual([]);
  });
});

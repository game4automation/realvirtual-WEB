// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-373 F6 — the `?option=` deep link must survive a reload and be shareable,
 * without leaking onto a model that has no such option.
 *
 * Test seams (plan §9, "Test-Seams"): the URL rule is exported as named pure
 * functions on `model-option-plugin.ts` and tested directly — route (a). The
 * scene-store wiring around it is NOT reachable that way (`updateUrlSceneParam`
 * is module-private and deliberately stays so), so it is exercised through a real
 * `SceneStore` against the address bar — route (b). Both are used on purpose:
 * a pure test of the rule proves nothing about whether the store calls it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import {
  modelSupportsOption,
  nextOptionParam,
  optionIdFromUrl,
  registerModelOptionModules,
  resetModelOptionRegistry,
  withOptionParam,
} from '../src/plugins/models/model-option-plugin';

const DEMO = 'DemoRealvirtualWeb';

/** Mirrors what main.ts registers from the eager glob of model-options.ts modules. */
function registerFixtureModules(): void {
  registerModelOptionModules([
    { baseModel: DEMO, modelOptions: [], deepLinkOptions: [{ id: 'bosch', label: 'Bosch' }, { id: 'sew', label: 'SEW' }] },
    { baseModel: 'OtherModel', modelOptions: [{ id: 'variant-a', label: 'A' }] },
    { baseModel: 'NoOptions' },
  ]);
}

// ─── Route (a): the pure rule ───────────────────────────────────────────

describe('option URL rule', () => {
  beforeEach(registerFixtureModules);
  afterEach(resetModelOptionRegistry);

  it('knows deep-link-only options even though they are not in the selector', () => {
    expect(modelSupportsOption(DEMO, 'bosch')).toBe(true);
    expect(modelSupportsOption(DEMO, 'sew')).toBe(true);
  });

  it('knows selector options of other modules', () => {
    expect(modelSupportsOption('OtherModel', 'variant-a')).toBe(true);
  });

  it('rejects an option the model does not declare', () => {
    expect(modelSupportsOption(DEMO, 'variant-a')).toBe(false);
    expect(modelSupportsOption('NoOptions', 'bosch')).toBe(false);
    expect(modelSupportsOption(null, 'bosch')).toBe(false);
  });

  it('keeps a supported option and drops an unsupported one', () => {
    expect(nextOptionParam(DEMO, 'bosch')).toBe('bosch');
    expect(nextOptionParam('OtherModel', 'bosch')).toBeNull();
    expect(nextOptionParam(DEMO, null)).toBeNull();
  });

  it('folds a top-level option into the model url in the builtin: route', () => {
    expect(withOptionParam('/models/DemoRealvirtualWeb.glb', DEMO, 'bosch'))
      .toBe('/models/DemoRealvirtualWeb.glb?option=bosch');
    expect(optionIdFromUrl(withOptionParam('/models/DemoRealvirtualWeb.glb', DEMO, 'sew'))).toBe('sew');
  });

  it('appends with & when the model url already carries a query', () => {
    expect(withOptionParam('/models/DemoRealvirtualWeb.glb?v=2', DEMO, 'bosch'))
      .toBe('/models/DemoRealvirtualWeb.glb?v=2&option=bosch');
  });

  it('does not fold an option the model does not declare', () => {
    expect(withOptionParam('/models/Other.glb', 'OtherModel', 'bosch')).toBe('/models/Other.glb');
    expect(withOptionParam('/models/Demo.glb', DEMO, null)).toBe('/models/Demo.glb');
  });

  it('leaves an option already present in the model url alone', () => {
    expect(withOptionParam('/m.glb?option=sew', DEMO, 'bosch')).toBe('/m.glb?option=sew');
  });

  it('applies both bosch and sew', () => {
    for (const id of ['bosch', 'sew']) {
      expect(nextOptionParam(DEMO, id)).toBe(id);
      expect(optionIdFromUrl(withOptionParam('/m.glb', DEMO, id))).toBe(id);
    }
  });
});

// ─── Route (b): the store actually applies it to the address bar ─────────

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    availableModels: [
      { url: `/models/${DEMO}.glb`, label: DEMO },
      { url: '/models/OtherModel.glb', label: 'OtherModel' },
    ],
    currentScene: null,
    currentModelUrl: null,
    loadScene: vi.fn(async (s: RvScene) => { v.currentScene = s; }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

describe('scene url rewrite keeps or drops ?option=', () => {
  let store: SceneStore;
  let originalUrl: string;

  beforeEach(() => {
    originalUrl = window.location.href;
    localStorage.clear();
    registerFixtureModules();
    store = new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    resetModelOptionRegistry();
    window.history.replaceState(window.history.state, '', originalUrl);
  });

  function setSearch(search: string): void {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`);
  }
  function currentParams(): URLSearchParams {
    return new URL(window.location.href).searchParams;
  }

  it('keeps ?option= across a scene url rewrite on the model it belongs to', async () => {
    setSearch('?option=bosch');
    await store.openBuiltin(`/models/${DEMO}.glb?option=bosch`, DEMO);

    expect(currentParams().get('scene')).toBe(`builtin:${DEMO}.glb`);
    expect(currentParams().get('option')).toBe('bosch');
  });

  it('drops ?option= when switching to a model without that option', async () => {
    setSearch('?option=bosch');
    await store.openBuiltin('/models/OtherModel.glb', 'OtherModel');

    expect(currentParams().get('scene')).toBe('builtin:OtherModel.glb');
    expect(currentParams().get('option')).toBeNull();
  });

  it('drops ?option= when switching to an empty scene', async () => {
    setSearch('?option=bosch');
    await store.newEmpty();

    expect(currentParams().get('scene')).toBe('empty');
    expect(currentParams().get('option')).toBeNull();
  });

  it('leaves other query parameters untouched (urlValueForBase behaviour unchanged)', async () => {
    setSearch('?option=bosch&lang=de&debug=1');
    await store.openBuiltin(`/models/${DEMO}.glb`, DEMO);

    expect(currentParams().get('lang')).toBe('de');
    expect(currentParams().get('debug')).toBe('1');
    // The builtin value is still the bare filename — a folded parameter would
    // break the boot matcher in main.ts.
    expect(currentParams().get('scene')).toBe(`builtin:${DEMO}.glb`);
  });
});

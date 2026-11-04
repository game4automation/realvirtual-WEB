// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-680 §9.3b — the DES feature is a CORE feature.
 *
 * `registerDesFeature()` declares `des` on the viewer's FeatureLoader with
 * `origin: 'core'`; activating it hands the runner factory over and installs the
 * DES HMI with plugin origin `core` (feature origin and plugin
 * origin are separate fields). A second activation — and a direct second
 * `activate()` call — changes nothing (idempotent).
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { FeatureLoader } from '../../src/core/rv-feature-loader';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { DesRunnerFactory } from '../../src/core/material-flow/simulation-kernel';
import { registerDesFeature } from '../../src/features/des.register';

interface FakeViewer {
  features: FeatureLoader;
  uses: Array<{ id: string; origin: string }>;
  factory: DesRunnerFactory;
  use(plugin: { id: string }, origin: string): FakeViewer;
  getPlugin(id: string): unknown;
  setDesRunnerFactory(factory: DesRunnerFactory): void;
}

function fakeViewer(): FakeViewer {
  const plugins = new Map<string, unknown>();
  const v: FakeViewer = {
    features: null as unknown as FeatureLoader,
    uses: [],
    factory: null,
    use(plugin, origin) { plugins.set(plugin.id, plugin); v.uses.push({ id: plugin.id, origin }); return v; },
    getPlugin: (id) => plugins.get(id) ?? null,
    setDesRunnerFactory(factory) { v.factory = factory; },
  };
  v.features = new FeatureLoader(v as unknown as RVViewer);
  return v;
}

describe('plan-680 §9.3b: des is a core feature', () => {
  // The body pulls the whole DES tree (engine, HMI, MUI) — the first, cold transform takes
  // longer than one test's budget. Warm it once; the module cache serves the activations.
  beforeAll(async () => { await import('../../src/features/des.body'); }, 180_000);

  it('declares des with feature origin core and the manifest activation', () => {
    const v = fakeViewer();
    registerDesFeature(v as unknown as RVViewer);
    expect(v.features.isDeclared('des')).toBe(true);
    const row = v.features.statuses().find((s) => s.id === 'des');
    expect(row?.origin).toBe('core');
    expect(row?.state).toBe('declared');
    expect(row?.activation).toContain('mode:des');
    expect(row?.activation).toContain('component:Station');
    expect(row?.activation).not.toContain('component:DESSource');
  });

  it('activation installs the HMI with plugin origin core and hands the runner factory over', async () => {
    const v = fakeViewer();
    registerDesFeature(v as unknown as RVViewer);
    await v.features.ensure('des', 'mode:des');
    expect(v.features.isActive('des')).toBe(true);
    expect(typeof v.factory).toBe('function');
    expect(v.getPlugin('des-plugin')).toBeNull();
    expect(v.uses).toEqual([
      { id: 'des-hmi', origin: 'core' },
    ]);
  });

  it('a repeated activation is idempotent', async () => {
    const v = fakeViewer();
    registerDesFeature(v as unknown as RVViewer);
    await v.features.ensure('des', 'mode:des');
    await v.features.ensure('des', 'command:sim.discrete');
    const body = await import('../../src/features/des.body');
    await body.activate(v as unknown as RVViewer);
    expect(v.uses.map((u) => u.id)).toEqual(['des-hmi']);
    expect(v.features.statuses().filter((s) => s.id === 'des')).toHaveLength(1);
  });
});

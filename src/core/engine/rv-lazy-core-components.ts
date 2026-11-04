// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-lazy-core-components — the on-demand core components for a host WITHOUT a
 * FeatureLoader (the embed facade, plan-2227). Same contract as
 * `LoadGLBOptions.features`: the load path awaits the component types a model
 * carries before anything is built or baked. `RVViewer` does this through its
 * FeatureLoader (`signal-connector` feature) instead.
 */

const LAZY: Readonly<Record<string, () => Promise<unknown>>> = {
  SignalConnector: () => import('./rv-signal-connector'),
};

const loaded = new Set<string>();

export const lazyCoreComponentFeatures = {
  /** The lazy types not loaded yet — the prescan looks for these only. */
  pendingComponentTriggerTypes(): ReadonlySet<string> {
    return new Set(Object.keys(LAZY).filter((t) => !loaded.has(t)));
  },
  /** Load the modules of the given types (registers their components). */
  async ensureForComponentTypes(types: Iterable<string>): Promise<void> {
    for (const t of types) {
      const load = LAZY[t];
      if (!load || loaded.has(t)) continue;
      await load();
      loaded.add(t);
    }
  },
};

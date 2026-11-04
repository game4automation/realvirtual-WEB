// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import definition, { PalletYardPlugin, registerModelPlugins, unregisterModelPlugins } from '../../src/plugins/models/PalletYard/index';
import { FleetPlugin } from '../../src/plugins/fleet-plugin';
import { YardPlanning } from '../../src/plugins/models/PalletYard/yard-planning';
import { DEFAULT_YARD } from '../../src/plugins/models/PalletYard/yard-compose';
import { RETRIEVAL_RULES } from '../../src/core/fleet/core/strategies';
import type { RVViewer } from '../../src/core/rv-viewer';

describe('PalletYard definition entrypoint', () => {
  it('keeps the existing retrieval, production and repeating shipping pause defaults', () => {
    const cfg = DEFAULT_YARD.config;
    expect(definition.apiVersion).toBe(1);
    expect(definition.retrieval).toBe(RETRIEVAL_RULES[cfg.retrieval ?? 'legacy-fifo']);
    expect(definition.config.pauses).toEqual(cfg.shippingPauses);
    expect(definition.config.takts.map(t => t.station)).toEqual(cfg.stations.filter(s => s.kind === 'pick').map(s => s.id));
    expect(definition.parameters).toBeInstanceOf(YardPlanning);
  });

  it('registers FleetPlugin via the actual module exports', () => {
    const viewer = { use: vi.fn(), removePlugin: vi.fn() };
    registerModelPlugins(viewer as unknown as RVViewer);
    const plugin = viewer.use.mock.calls[0][0] as FleetPlugin;
    try {
      expect(plugin.constructor).toBe(FleetPlugin);
      expect(plugin.definition).toBe(definition);
      unregisterModelPlugins(viewer as unknown as RVViewer);
      expect(viewer.removePlugin).toHaveBeenCalledWith('pallet-yard');
    } finally { plugin.dispose(); }
  });

  it('routes the compatibility constructor through FleetPlugin with isolated planning state', () => {
    const first = new PalletYardPlugin(), second = new PalletYardPlugin();
    try {
      expect(first).toBeInstanceOf(FleetPlugin);
      expect(first.definition.parameters).not.toBe(second.definition.parameters);
      expect(first.definition.parameters).not.toBe(definition.parameters);
      expect(first.definition.retrieval).toBe(definition.retrieval);
    } finally { first.dispose(); second.dispose(); }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  definePlantPlugin, plantPluginExports, PLANT_PLUGIN_API_VERSION, type PlantPluginDefinition,
} from '../../src/core/fleet/define-plant-plugin';
import { isPaused } from '../../src/core/fleet/core/order-sources';
import { RETRIEVAL_RULES } from '../../src/core/fleet/core/strategies';
import { RETRIEVAL_RULES as yardRules } from '../../src/plugins/models/PalletYard/dispatch-policy';
import { FleetPlugin } from '../../src/plugins/fleet-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';

vi.mock('../../src/plugins/des/fleet/des-handover', () => ({
  PluginOwnerRegistry: class { clear() {} },
}));
afterEach(clearAllProblems);

describe('plant definition', () => {
  it('preserves the definition, project values and callback identities', () => {
    const def = {
      apiVersion: PLANT_PLUGIN_API_VERSION, id: 'minimal-plant',
      config: {
        takts: [{ station: 'Plant/Output', intervalSec: 20, startSec: 5 }],
        pauses: { everySec: 100, durationSec: 10, offsetSec: [30] },
        lamps: { green: 'ReadyLamp' }, projectValue: { count: 2 },
      },
      retrieval: RETRIEVAL_RULES['when-inbound-free'],
      lampMap: { red: () => 'off' as const },
    } satisfies PlantPluginDefinition;
    const result = definePlantPlugin(def);
    expect(result).toBe(def);
    expect(result.config.projectValue).toBe(def.config.projectValue);
    expect(result.retrieval).toBe(def.retrieval);
    expect(isPaused(result.config.pauses, 0, 30)).toBe(true);
    expect(isPaused(result.config.pauses, 0, 40)).toBe(false);
    expect(isPaused(result.config.pauses, 0, 130)).toBe(true);
  });

  it('accepts a plant with only its version and id', () => {
    expect(definePlantPlugin({ apiVersion: 1, id: 'minimal' })).toEqual({ apiVersion: 1, id: 'minimal' });
  });

  it('uses the existing viewer registration/removal convention', () => {
    const definition = definePlantPlugin({ apiVersion: 1, id: 'minimal' });
    const viewer = { use: vi.fn(), removePlugin: vi.fn() };
    const exports = plantPluginExports(definition);
    exports.registerModelPlugins(viewer as unknown as RVViewer);
    const plugin = viewer.use.mock.calls[0][0] as FleetPlugin;
    expect(plugin).toBeInstanceOf(FleetPlugin);
    expect(plugin.definition).toBe(definition);
    exports.unregisterModelPlugins(viewer as unknown as RVViewer);
    expect(viewer.removePlugin).toHaveBeenCalledWith('minimal');
    plugin.dispose();
  });

  it('reports an incompatible version at registration and ignores all project overrides', () => {
    const def = { apiVersion: 99, id: 'future', config: { project: 'unsupported' },
      retrieval: RETRIEVAL_RULES['when-inbound-free'], parameters: { dispose: vi.fn() },
    } as unknown as PlantPluginDefinition;
    const viewer = { use: vi.fn() };
    plantPluginExports(def).registerModelPlugins(viewer as unknown as RVViewer);
    const plugin = viewer.use.mock.calls[0][0] as FleetPlugin;
    expect(plugin.definition).toEqual({ apiVersion: 1, id: 'future' });
    expect(getProblems()).toEqual([expect.objectContaining({ code: 'plant-plugin-api-version', detail: expect.stringContaining('99') })]);
    plugin.dispose();
    expect(def.parameters!.dispose).not.toHaveBeenCalled();
    const corrected = new FleetPlugin({ apiVersion: 1, id: 'future' });
    expect(getProblems()).toEqual([]);
    corrected.dispose();
  });

  it('keeps the named retrieval gates identical for existing consumers', () => {
    expect(yardRules).toBe(RETRIEVAL_RULES);
    expect(Object.keys(RETRIEVAL_RULES).sort()).toEqual(['legacy-fifo', 'when-inbound-free']);
    for (const sources of [[], ['Plant/Output']]) {
      const ctx = { t: 0, waitingSources: () => sources };
      expect(RETRIEVAL_RULES['legacy-fifo'](ctx)).toBe(sources.length === 0);
      const rule: NonNullable<PlantPluginDefinition['retrieval']> = RETRIEVAL_RULES['when-inbound-free'];
      expect(rule(ctx)).toBe(true);
    }
  });
});

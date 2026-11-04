// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { variantModeActive } from '../../core/hmi/rv-variant-ui-mode';
import type { CommandContext, CommandEnabled, CommandImpl } from '../../core/hmi/rv-command-registry';
import { getPlanningPlugin, getPlanningRegistry } from './index';
import { resolveScenarioTarget } from './scenario-persistence';
import { checkPlanningValue } from '../../core/planning/rv-planning-params';
export { ensurePlanningCommandsRegistered } from './planning-command-descriptors';

function enabled({ viewer }: CommandContext): CommandEnabled {
  if (variantModeActive()) return { reason: 'variants-active' };
  return getPlanningRegistry(viewer)?.list().length ? true : { reason: 'no planning parameters declared' };
}

function list({ viewer }: CommandContext, owner?: string) {
  const registry = getPlanningRegistry(viewer)!;
  const plugin = getPlanningPlugin(viewer)!;
  const { block } = plugin.getScenarioState();
  return {
    params: registry.list().filter(p => owner == null || p.owner === owner),
    kpis: registry.kpis(),
    changeLog: registry.changeLog(),
    scenario: {
      active: block.active, names: Object.keys(block.scenarios),
      dirty: plugin.isScenarioDirty(), persistable: resolveScenarioTarget().persistable,
    },
  };
}

export const paramList: CommandImpl<{ owner?: string }> = {
  enabled, run: (ctx, args) => list(ctx, args.owner),
};

export const paramSet: CommandImpl<{ values: string }> = {
  enabled,
  run({ viewer }, { values }) {
    let parsed: unknown;
    try { parsed = JSON.parse(values); }
    catch { return { ok: false, error: 'values must be a JSON object' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'values must be a JSON object' };
    }
    return getPlanningRegistry(viewer)!.setMany(parsed as Record<string, unknown>, 'mcp');
  },
};

export const paramApply: CommandImpl = {
  enabled,
  async run(ctx) {
    const result = await getPlanningRegistry(ctx.viewer)!.applyPendingAndReset();
    return { ...result, ...list(ctx) };
  },
};

export const planningReset: CommandImpl<{ owner: string }> = {
  enabled,
  run({ viewer }, { owner }) {
    if (typeof owner !== 'string' || !owner) return { ok: false, error: 'owner is required' };
    return getPlanningRegistry(viewer)!.resetToDefaults(owner, 'mcp');
  },
};

export const scenarioSave: CommandImpl<{ name: string }> = {
  enabled,
  async run({ viewer }, { name }) {
    if (typeof name !== 'string' || !name) return { ok: false, error: 'name is required' };
    try { return { ok: true, ...await getPlanningPlugin(viewer)!.saveScenario(name) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  },
};

export const scenarioSwitch: CommandImpl<{ name: string }> = {
  enabled,
  run({ viewer }, { name }) {
    if (typeof name !== 'string' || !name) return { ok: false, error: 'name is required' };
    return getPlanningPlugin(viewer)!.switchScenario(name);
  },
};

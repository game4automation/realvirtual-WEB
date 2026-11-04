// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, CommandError, type CommandArgType, type CommandDescriptor, type CommandImpl, type CommandRegistry } from './rv-command-registry';
import type { CommandContext, CommandEnabled } from './rv-command-registry';
import { getPlcControl, getPlcPersistence, getPlcRuntime, type PlcCodePersistResult, type PlcControl } from '../plc-control';

function desEnabled({ viewer }: CommandContext): CommandEnabled {
  return viewer?.simulationKernel?.desControl?.() ? true
    : { reason: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' };
}

function plcFor(program: string | undefined): PlcControl | { error: string; programs?: string[] } {
  if (program) {
    const runtime = getPlcRuntime();
    const ctl = runtime?.program(program) ?? null;
    if (ctl) return ctl;
    return { error: `unknown PLC program '${program}'`, programs: runtime?.programs().map(p => p.name) ?? [] };
  }
  return getPlcControl() ?? { error: 'PLC not available in this build' };
}

function plcEnabled(program: string | undefined): CommandEnabled {
  const plc = plcFor(program);
  // The refusal keeps the program list the old tool answered with (plan-2007: same answer).
  return 'error' in plc ? { reason: plc.error, ...(plc.programs ? { details: { programs: plc.programs } } : {}) } : true;
}

export const desStep: CommandImpl<{ count?: number }> = {
  enabled: desEnabled,
  run: async ({ viewer }, { count }) => {
    const ctl = viewer?.simulationKernel?.desControl?.();
    if (!ctl) return { error: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' };
    const n = Math.max(1, count || 1);
    let stepped = 0;
    for (let i = 0; i < n; i++) { if (!ctl.step()) break; stepped++; }
    return { stepped, events: ctl.eventStats?.() ?? null };
  },
};

export const desSetMode: CommandImpl<{ subMode: string; multiplier?: number }> = {
  enabled: desEnabled,
  run: async ({ viewer }, { subMode, multiplier }) => {
    const ctl = viewer?.simulationKernel?.desControl?.();
    if (!ctl) return { error: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' };
    const valid = ['animated', 'hybrid', 'fastforward', 'step'];
    // A real failure (ok:false kind:'threw' + reason + details), not a success carrying an {error} payload.
    if (!valid.includes(subMode)) throw new CommandError(`Invalid subMode '${subMode}'`, { valid });
    ctl.setSubMode(subMode as 'animated' | 'hybrid' | 'fastforward' | 'step');
    if (multiplier !== undefined && multiplier !== null && !Number.isNaN(multiplier)) {
      ctl.setMultiplier(multiplier);
    }
    return { subMode: ctl.subMode, multiplier: ctl.multiplier };
  },
};

export const plcDeploy: CommandImpl<{ code: string; program?: string }> = {
  enabled: (_ctx, args) => plcEnabled(args?.program),
  run: async (_ctx, { code, program }) => {
    const plc = plcFor(program);
    if ('error' in plc) return plc;
    // The save target is fixed NOW, with the program deployed to: a selection
    // change while the compile is awaited must not redirect the save.
    const target = persistTargetOf(program);
    const diagnostics = await plc.deploy(code);
    const errorCount = diagnostics.filter(d => d.severity === 'error').length;
    const result = {
      state: plc.state,
      errorCount,
      warningCount: diagnostics.filter(d => d.severity === 'warning').length,
      diagnostics,
    };
    // A program that does not compile never replaces the saved one.
    if (errorCount > 0) return { ...result, persisted: false, persistSkipped: 'compile errors — the saved program is unchanged' };
    // Persist like the PLC editor does — without it the program is gone after save/reload.
    const persistence = getPlcPersistence();
    if (!persistence) return { ...result, persisted: false };
    let saved: PlcCodePersistResult;
    try {
      saved = await persistence.persistCode(code, target);
    } catch (e) {
      saved = { persisted: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!saved.persisted) {
      return {
        ...result, persisted: false,
        error: `PLC program deployed but NOT saved to the scene (${saved.error ?? 'unknown reason'}) — it is lost on reload.`,
      };
    }
    return {
      ...result, persisted: true, persistedTo: saved.nodePath,
      ...(saved.document ? { document: saved.document } : {}),
      ...(saved.created ? { created: true } : {}),
      ...(saved.warning ? { warning: saved.warning } : {}),
    };
  },
};

/** Scene path of the program a deploy addresses (`''` = the editor buffer without a node); undefined without a runtime. */
function persistTargetOf(program: string | undefined): string | undefined {
  const programs = getPlcRuntime()?.programs();
  if (!programs) return program;
  if (program === undefined) return programs.find(p => p.selected)?.path;
  const lower = program.toLowerCase();
  return (programs.find(p => p.path === program) ?? programs.find(p => p.name.toLowerCase() === lower))?.path ?? program;
}

export const plcRun: CommandImpl<{ program?: string }> = {
  enabled: (_ctx, args) => plcEnabled(args?.program),
  run: async (_ctx, { program }) => {
    const plc = plcFor(program);
    if ('error' in plc) return plc;
    await plc.run();
    return { state: plc.state, lastError: plc.lastError };
  },
};

export const plcStop: CommandImpl<{ program?: string }> = {
  enabled: (_ctx, args) => plcEnabled(args?.program),
  run: async (_ctx, { program }) => {
    const plc = plcFor(program);
    if ('error' in plc) return plc;
    plc.stop();
    return { state: plc.state };
  },
};

export const plcStatus: CommandImpl<{ program?: string }> = {
  enabled: () => true,
  run: async (_ctx, { program }) => {
    const plc = plcFor(program);
    if ('error' in plc) return plc;
    const runtime = getPlcRuntime();
    return {
      state: plc.state,
      scanTimeMs: +plc.scanTimeMs.toFixed(3),
      lastError: plc.lastError,
      watch: Object.fromEntries(plc.watch()),
      programs: runtime?.programs().map((p) => ({ name: p.name, path: p.path, order: p.order, selected: p.selected, state: p.state, scanTimeMs: +p.scanTimeMs.toFixed(3), lastError: p.lastError })) ?? [],
      conflicts: runtime?.conflicts() ?? [],
    };
  },
};

async function queryDesComponents(viewer: CommandContext['viewer'], busyOnly: boolean): Promise<string> {
  const ctl = viewer?.simulationKernel?.desControl?.();
  if (!ctl?.componentStates) return JSON.stringify({ error: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' });
  let states = ctl.componentStates();
  const total = states.length;
  if (busyOnly) states = states.filter(s => s.load > 0 || s.inTransit > 0 || s.blocked > 0);
  return JSON.stringify({ total, shown: states.length, components: states });
}

async function queryDesStats(viewer: CommandContext['viewer']): Promise<string> {
  const ctl = viewer?.simulationKernel?.desControl?.();
  if (!ctl?.statistics) return JSON.stringify({ error: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' });
  return JSON.stringify(ctl.statistics());
}

async function queryDesBottleneck(viewer: CommandContext['viewer']): Promise<string> {
  const ctl = viewer?.simulationKernel?.desControl?.();
  if (!ctl?.statistics) return JSON.stringify({ error: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' });
  const st = ctl.statistics();
  if (!st.bottleneck) {
    return JSON.stringify({ bottleneck: null, hint: 'No flow components, or nothing has run yet — play the simulation first.' });
  }
  const idx = st.components.findIndex((c) => c.path === st.bottleneck!.path);
  const blockedUpstream = st.components.slice(0, idx).filter((c) => c.blocked > 30).length;
  const starvedDownstream = st.components.slice(idx + 1).filter((c) => c.empty > 50).length;
  return JSON.stringify({
    bottleneck: st.bottleneck,
    meanUtilization: st.meanUtilization,
    throughputPerHour: st.throughputPerHour,
    diagnosis: `'${st.bottleneck.name}' is the bottleneck — working ${st.bottleneck.working}% of the time. `
      + `${blockedUpstream} upstream component(s) are blocked behind it; ${starvedDownstream} downstream component(s) are starved.`,
  });
}

const SPECS = [
  { id: 'des.components', label: 'des.components', readOnly: true, argsSchema: { busyOnly: 'boolean' } as Readonly<Record<string, CommandArgType>>, impl: {
    enabled: () => true,
    run: async (ctx, a) => JSON.parse(await queryDesComponents(ctx.viewer, a?.busyOnly ?? false)),
  } as CommandImpl<{ busyOnly?: boolean }, unknown> as CommandImpl<never, unknown> },
  { id: 'des.stats', label: 'des.stats', readOnly: true, argsSchema: {} as Readonly<Record<string, CommandArgType>>, impl: {
    enabled: () => true,
    run: async (ctx) => JSON.parse(await queryDesStats(ctx.viewer)),
  } as CommandImpl<{ busyOnly?: boolean }, unknown> as CommandImpl<never, unknown> },
  { id: 'des.bottleneck', label: 'des.bottleneck', readOnly: true, argsSchema: {} as Readonly<Record<string, CommandArgType>>, impl: {
    enabled: () => true,
    run: async (ctx) => JSON.parse(await queryDesBottleneck(ctx.viewer)),
  } as CommandImpl<{ busyOnly?: boolean }, unknown> as CommandImpl<never, unknown> },

  { id: 'des.step', label: 'Step DES', readOnly: false, argsSchema: { count: 'number' } as Readonly<Record<string, CommandArgType>>, impl: desStep as CommandImpl<never, unknown> },
  { id: 'des.setMode', label: 'DES mode', readOnly: false, argsSchema: { subMode: 'string', multiplier: 'number' } as Readonly<Record<string, CommandArgType>>, impl: desSetMode as CommandImpl<never, unknown> },
  { id: 'plc.deploy', label: 'Deploy PLC program', readOnly: false, argsSchema: { code: 'string', program: 'string' } as Readonly<Record<string, CommandArgType>>, impl: plcDeploy as CommandImpl<never, unknown> },
  { id: 'plc.run', label: 'Run PLC program', readOnly: false, argsSchema: { program: 'string' } as Readonly<Record<string, CommandArgType>>, impl: plcRun as CommandImpl<never, unknown> },
  { id: 'plc.stop', label: 'Stop PLC program', readOnly: false, argsSchema: { program: 'string' } as Readonly<Record<string, CommandArgType>>, impl: plcStop as CommandImpl<never, unknown> },
  { id: 'plc.status', label: 'PLC status', readOnly: true, argsSchema: { program: 'string' } as Readonly<Record<string, CommandArgType>>, impl: plcStatus as CommandImpl<never, unknown> },
];

export function createDesPlcCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map((s) => ({
    id: s.id, label: s.label, readOnly: s.readOnly,
    scope: 'none', available: true, unavailableReason: 'Not available',
    ...(s.id === 'des.setMode' ? {
      buttonKey: (args: { subMode: string; multiplier?: number }) => args?.subMode === 'animated'
        ? 'des.speed.1' : args?.subMode === 'hybrid' && args.multiplier !== undefined
          ? `des.speed.${args.multiplier}` : 'des.setMode',
    } : {}),
    argsSchema: s.argsSchema, eagerImpl: s.impl, impl: () => Promise.resolve(s.impl),
  }));
}

const registered = new WeakSet<CommandRegistry>();
export function ensureDesPlcCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createDesPlcCommandDescriptors()) registry.register(d);
}

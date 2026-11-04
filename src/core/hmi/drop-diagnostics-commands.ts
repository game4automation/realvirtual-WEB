// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-diagnostics-commands — making the unsupported-part case HAPPEN on
 * purpose (plan-2022 Phase 6).
 *
 * Detection, report card and silhouette have to be acceptable before a real
 * defect turns up in a customer model, so there has to be a way to produce the
 * case. Three candidates were on the table: a hidden developer flag, a debug
 * button on the component's inspector, and a command in the registry. The
 * command wins, for reasons that are this project's own rules:
 *
 *  - It is DISCOVERABLE: `web_commands` lists it with its id, its arguments and
 *    its availability rule. Nothing about it is hidden.
 *  - It is RECORDABLE and replayable like every other model change — the
 *    project deliberately binds MCP write tools to commands rather than giving
 *    them private back doors.
 *  - It is ONE verb for both callers: an MCP call and a future button dispatch
 *    the same thing, with the same refusal.
 *  - It needs no new UI and no switch that could be left on. A hidden flag that
 *    ships with a delivery and can change state is exactly what the plan's hard
 *    condition forbids; a command does nothing at all unless somebody calls it,
 *    and its label says what it is ("Diagnostics: ...").
 *
 * `diag.unsupportPart` does NOT fake a report. It only releases a part from
 * what holds it — the hold owner, the assigned surface, a GripTarget seat, and
 * optionally lifts it — so what the user then sees is the real detector
 * answering on real state. If the detection is broken, this command shows
 * nothing, which is the whole point of it.
 */

import {
  commandRegistry,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
  type CommandContext,
  type CommandEnabled,
} from './rv-command-registry';
import type { DropMU } from '../engine/rv-drop-manager';

/** The feature has to be armed, or the command would silently do nothing. */
function dropArmed({ viewer }: CommandContext): CommandEnabled {
  const mgr = viewer?.dropManager;
  if (!mgr) return { reason: 'No viewer.' };
  if (!mgr.isArmed) {
    return {
      reason: !mgr.optionsEnabled
        ? 'Drop detection is off in Settings > Simulation. Enable Unsupported-part detection.'
        : 'Drop detection is off: the scene DropDetection component has Enabled=false.',
    };
  }
  return true;
}

/** Live MUs of the running model, with their display names. */
function liveMus(viewer: CommandContext['viewer']): DropMU[] {
  return (viewer?.transportManager?.mus ?? []) as DropMU[];
}

function findMu(viewer: CommandContext['viewer'], part: string): DropMU | null {
  const mus = liveMus(viewer);
  // `mu:<id>` addresses one instance exactly; a bare name takes the first
  // match, which is what a model builder means when he types a part name.
  if (part.startsWith('mu:')) {
    const id = Number(part.slice(3));
    return mus.find((m) => m.id === id) ?? null;
  }
  return mus.find((m) => m.getName() === part) ?? null;
}

export const diagUnsupportPart: CommandImpl<{ part?: string; liftMm?: number }> = {
  enabled: dropArmed,
  run: async ({ viewer }, { part, liftMm }) => {
    const mgr = viewer.dropManager;
    const mus = liveMus(viewer);
    if (mus.length === 0) {
      return { error: 'No parts in the running model — play the simulation until a source has spawned one.' };
    }
    // No argument = the first part the transport owns, which is the common case
    // in a hand test ("just make one of them fall").
    const target = part ? findMu(viewer, part) : mus.find((m) => m.owner === 'transport') ?? null;
    if (!target) {
      return {
        error: part ? `No live part named '${part}'.` : 'No transport-owned part to release.',
        parts: mus.slice(0, 40).map((m) => ({ key: `mu:${m.id}`, name: m.getName(), owner: m.owner })),
      };
    }
    if (target.owner !== 'transport') {
      return {
        error: `'${target.getName()}' is owned by '${target.owner}' — a physics engine has it, and a part falling `
          + 'there is intended behaviour that the detection deliberately never reports. Pick a transport-owned part.',
      };
    }
    const lift = typeof liftMm === 'number' && Number.isFinite(liftMm) ? liftMm : 0;
    const { released, muKey } = mgr.releaseSupport(target, lift);
    const cfg = mgr.config;
    return {
      part: target.getName(),
      muKey,
      released,
      hint: released.length === 0
        ? 'Nothing was holding it already — it should be reported after the grace time.'
        : `Released. Expect a report after about ${cfg.GraceTime} s of simulated time, `
          + 'unless there is geometry below it within SupportProbeDistance '
          + `(${cfg.SupportProbeDistance} mm) — lift it with liftMm to clear that.`,
    };
  },
};

export const diagDropStatus: CommandImpl<Record<string, never>> = {
  enabled: () => true,
  run: async ({ viewer }) => {
    const mgr = viewer?.dropManager;
    if (!mgr) return { error: 'No viewer.' };
    return {
      armed: mgr.isArmed,
      optionsEnabled: mgr.optionsEnabled,
      hasComponent: mgr.hasComponent,
      config: mgr.config,
      reports: mgr.activeDrops.map((d) => ({
        part: d.muName, muKey: d.muKey, source: d.sourceName, atMm: d.atMm, deleted: d.deleted,
      })),
      ignoredSources: [...mgr.ignoredSources],
      supportProbes: mgr.probeCount,
    };
  },
};

export const diagDropReset: CommandImpl<Record<string, never>> = {
  enabled: dropArmed,
  run: async ({ viewer }) => {
    viewer.dropManager.reset();
    return { reports: 0 };
  },
};

const SPECS = [
  {
    id: 'diag.dropStatus',
    label: 'Diagnostics: drop detection status',
    readOnly: true,
    argsSchema: {} as Readonly<Record<string, CommandArgType>>,
    impl: diagDropStatus as unknown as CommandImpl<never, unknown>,
  },
  {
    id: 'diag.unsupportPart',
    label: 'Diagnostics: release a part from its support',
    readOnly: false,
    argsSchema: { part: 'string', liftMm: 'number' } as Readonly<Record<string, CommandArgType>>,
    impl: diagUnsupportPart as unknown as CommandImpl<never, unknown>,
  },
  {
    id: 'diag.dropReset',
    label: 'Diagnostics: clear the drop reports',
    readOnly: false,
    argsSchema: {} as Readonly<Record<string, CommandArgType>>,
    impl: diagDropReset as unknown as CommandImpl<never, unknown>,
  },
];

export function createDropDiagnosticsCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map((s) => ({
    id: s.id,
    label: s.label,
    readOnly: s.readOnly,
    scope: 'none' as const,
    available: true,
    unavailableReason: 'Not available',
    argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  }));
}

const registered = new WeakSet<CommandRegistry>();
export function ensureDropDiagnosticsCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createDropDiagnosticsCommandDescriptors()) registry.register(d);
}

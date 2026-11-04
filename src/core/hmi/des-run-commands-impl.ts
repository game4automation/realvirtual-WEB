// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { runLeaseBlocker } from './rv-run-lease';
import { CommandError, type CommandContext, type CommandEnabled, type CommandImpl } from './rv-command-registry';
import { boolArg, parseDesTimeArg, stringList } from './command-arg-validation';
import { USER_PAUSE_REASON } from '../engine/rv-constants';
import { applyDesMasterSeed, ensureDesManagerNode, persistDesEndTime, persistDesStatReset } from '../material-flow/des-manager-node';
import { getDesRunSettings, updateDesRunSettings, type SeedMode } from './des-run-settings-store';
import { getDesStatsHiddenKinds, setDesStatsHiddenKinds, setDesStatsWindowOpen } from '../../plugins/sim-controller/des-stats-window-store';

const DES_INACTIVE = 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.';

function desEnabled({ viewer }: CommandContext): CommandEnabled {
  return viewer?.simulationKernel?.desControl?.() ? true : { reason: DES_INACTIVE };
}

function control({ viewer }: CommandContext) {
  const ctl = viewer?.simulationKernel?.desControl?.();
  if (!ctl) throw new CommandError(DES_INACTIVE);
  return ctl;
}

export const desFastForward: CommandImpl<{ on?: boolean; untilSimTime?: string }> = {
  enabled: (ctx) => runLeaseBlocker() ?? desEnabled(ctx),
  run: async (ctx, args) => {
    const on = args?.on === undefined ? undefined : boolArg('on', args.on);
    const target = args?.untilSimTime === undefined ? undefined : parseDesTimeArg('untilSimTime', args.untilSimTime);
    const ctl = control(ctx);
    let reachedTarget = false;
    if (target !== undefined) {
      if (!ctl.fastForwardUntil) throw new CommandError('Fast Forward to a target is not available');
      reachedTarget = await ctl.fastForwardUntil(target);
      // Only a completed run of this same controller ends paused; cancel / busy / reset / mode
      // switch answer false and leave the pause state alone.
      if (reachedTarget && ctx.viewer.simulationKernel?.desControl?.() === ctl) {
        ctx.viewer.setSimulationPaused(USER_PAUSE_REASON, true);
      }
    } else {
      const next = on ?? (ctl.subMode !== 'fastforward');
      if (next) ctl.setSubMode('fastforward');
      else if (ctl.subMode === 'fastforward') {
        ctl.setSubMode(ctl.preFastForwardSubMode ?? (ctl.multiplier > 1 ? 'hybrid' : 'animated'));
      }
    }
    return { simTime: ctl.simTime, subMode: ctl.subMode, multiplier: ctl.multiplier,
      paused: ctl.paused ?? ctx.viewer.simulationPauseReasons.includes(USER_PAUSE_REASON), reachedTarget };
  },
};

export const desSetEnd: CommandImpl<{ end?: string; statReset?: string }> = {
  enabled: (ctx) => runLeaseBlocker() ?? desEnabled(ctx),
  run: (ctx, args) => {
    const end = args?.end === undefined ? undefined : parseDesTimeArg('end', args.end, { allowInf: true });
    const statReset = args?.statReset === undefined ? undefined : parseDesTimeArg('statReset', args.statReset);
    const ctl = control(ctx);
    if (end !== undefined && !ctl.setEndTime) throw new CommandError('DES end time is not available');
    if (statReset !== undefined && !ctl.setStatResetTime) throw new CommandError('DES statistics reset is not available');
    if (end !== undefined) {
      ctl.setEndTime!(end);
      persistDesEndTime(ensureDesManagerNode(ctx.viewer), end);
    }
    if (statReset !== undefined) {
      ctl.setStatResetTime!(statReset);
      persistDesStatReset(ensureDesManagerNode(ctx.viewer), statReset);
    }
    return { endTime: ctl.endTime, statResetTime: ctl.statResetTime };
  },
};

export const desStatsWindow: CommandImpl<{ open: boolean; hiddenKinds?: string[] }> = {
  enabled: desEnabled,
  run: (ctx, args) => {
    const open = boolArg('open', args?.open);
    const kinds = args?.hiddenKinds === undefined ? undefined : stringList('hiddenKinds', args.hiddenKinds);
    control(ctx);
    if (kinds !== undefined) setDesStatsHiddenKinds(kinds);
    setDesStatsWindowOpen(open);
    return { open, hiddenKinds: [...getDesStatsHiddenKinds()] };
  },
};

export const desBadges: CommandImpl<{ on: boolean }> = {
  enabled: desEnabled,
  run: async (ctx, args) => {
    const on = boolArg('on', args?.on);
    control(ctx);
    const { getDesStatsGizmos } = await import('../../plugins/des/hmi/des-stats-gizmos');
    control(ctx);
    getDesStatsGizmos(ctx.viewer).setEnabled(on);
    return { on };
  },
};

const MAX_SEED = 0x7fffffff;
function seedState(ctx: CommandContext) {
  const ctl = control(ctx);
  return { seed: ctl.masterSeed ?? null, mode: getDesRunSettings().seedMode };
}

/** The clock window's "Random seed": the master seed and whether it is fixed or rolled per run. */
export const desSeedGet: CommandImpl = {
  enabled: desEnabled,
  run: (ctx) => seedState(ctx),
};

/**
 * Same writes as the clock window: the mode is a user preference (`fixed` reproduces a run, `auto`
 * rolls a new seed before every new run), the seed goes to the live DES and the scene's DES manager.
 */
export const desSeedSet: CommandImpl<{ seed?: number; mode?: string }> = {
  enabled: (ctx) => runLeaseBlocker() ?? desEnabled(ctx),
  run: async (ctx, args) => {
    const mode = args?.mode;
    if (mode !== undefined && mode !== 'fixed' && mode !== 'auto') throw new CommandError("mode must be 'fixed' or 'auto'");
    const seed = args?.seed;
    if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > MAX_SEED)) {
      throw new CommandError(`seed must be an integer from 1 to ${MAX_SEED}`);
    }
    if (mode === undefined && seed === undefined) throw new CommandError('Give seed, mode or both');
    const ctl = control(ctx);
    const nextMode: SeedMode = (mode as SeedMode | undefined) ?? getDesRunSettings().seedMode;
    if (seed !== undefined && nextMode === 'auto') {
      throw new CommandError("A seed cannot be set in auto mode (a new seed is rolled before every run); pass mode 'fixed' with the seed");
    }
    if (seed !== undefined && !ctl.setMasterSeed) throw new CommandError('Setting the DES seed is not available');
    // The seed first: a refused seed (variant in the scene, failed scene write) changes nothing.
    if (seed !== undefined) {
      const r = await applyDesMasterSeed(ctx.viewer, ctl, seed);
      if (!r.ok) throw new CommandError(r.reason, { code: r.code });
    }
    if (mode !== undefined) updateDesRunSettings({ seedMode: nextMode });
    return seedState(ctx);
  },
};

export const desRunCommandImpls = {
  'des.fastForward': desFastForward,
  'des.setEnd': desSetEnd,
  'des.stats.window': desStatsWindow,
  'des.badges': desBadges,
  'des.seed.get': desSeedGet,
  'des.seed.set': desSeedSet,
};

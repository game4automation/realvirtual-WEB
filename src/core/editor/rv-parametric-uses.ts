// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5b — `editor.parametricUse`: maintain the declared child
 * families (`ParametricComponent.Uses`) of a family node as ONE undo step.
 *
 * Pick a child family by its document (`glbUrl`): `FamilyNodeId` and
 * `DocHash` are read from the bytes (`familyUseFromGlb`), never typed. Or pass
 * them explicitly (`familyNodeId` + `docHash`, e.g. from a library listing).
 * `remove: true` drops the entry. Because `Uses` is part of the parent
 * `InputHash`, the variant is regenerated in the same transaction.
 */

import type { CommandContext, CommandEnabled, CommandImpl } from '../hmi/rv-command-registry';
import { CommandError } from '../hmi/rv-command-registry';
import { MAX_PARAMETRIC_USES, PARAMETRIC_COMPONENT_TYPE, type ParametricUse } from '../engine/rv-parametric-component';

export const PARAMETRIC_USE_COMMAND = 'editor.parametricUse';

export interface ParametricUseArgs {
  readonly path: string | null | undefined;
  /** The key `children[].family` names (the child asset's catalog / project id). */
  readonly family: string | null | undefined;
  /** Child family document to read FamilyNodeId + DocHash from. */
  readonly glbUrl?: string | null;
  readonly familyNodeId?: string | null;
  readonly docHash?: string | null;
  /** Optional relative path fallback of the child asset. */
  readonly assetPath?: string | null;
  readonly remove?: boolean | null;
}

/** Pure: the new `Uses` list after adding / replacing / removing `family`. */
export function applyUseChange(
  current: readonly ParametricUse[] | undefined,
  change: { family: string; use?: ParametricUse; remove?: boolean },
): ParametricUse[] {
  const list = (current ?? []).filter((u) => u.Family !== change.family);
  if (change.remove) {
    if (list.length === (current ?? []).length) throw new Error(`"${change.family}" is not declared in Uses`);
    return list;
  }
  if (!change.use) throw new Error('a use entry is required');
  const at = (current ?? []).findIndex((u) => u.Family === change.family);
  if (at < 0 && list.length >= MAX_PARAMETRIC_USES) throw new Error(`Uses is full (limit ${MAX_PARAMETRIC_USES})`);
  const out = [...list];
  out.splice(at < 0 ? out.length : at, 0, change.use);
  return out;
}

function familyNodeOf(ctx: CommandContext, path: string): Record<string, unknown> | null {
  const node = ctx.viewer.registry?.getNode(path);
  const pc = node?.userData?.realvirtual?.[PARAMETRIC_COMPONENT_TYPE];
  return pc && typeof pc === 'object' ? pc as Record<string, unknown> : null;
}

export const parametricUseImpl: CommandImpl<ParametricUseArgs, Record<string, unknown>> = {
  enabled: (ctx, a): CommandEnabled => {
    const path = String(a?.path ?? '');
    if (!path) return { reason: 'Needs a family node path' };
    if (!String(a?.family ?? '').trim()) return { reason: 'Needs the child family key (family)' };
    if (!familyNodeOf(ctx, path)) return { reason: `"${path}" is not a parametric family` };
    if (!a?.remove && !a?.glbUrl && !(a?.familyNodeId && a?.docHash)) {
      return { reason: 'Needs glbUrl, or familyNodeId + docHash' };
    }
    return true;
  },
  resolveArgs: (_ctx, a) => ({ ...a }),
  run: async (ctx, a) => {
    const doc = ctx.doc;
    if (!doc) throw new CommandError('No document open in the editor');
    const path = String(a.path);
    const family = String(a.family).trim();
    const pc = familyNodeOf(ctx, path);
    if (!pc) throw new CommandError(`"${path}" is not a parametric family`);
    let use: ParametricUse | undefined;
    if (!a.remove) {
      if (a.glbUrl) {
        const res = await fetch(a.glbUrl);
        if (!res.ok) throw new CommandError(`Cannot read ${a.glbUrl}: HTTP ${res.status}`);
        const { familyUseFromGlb } = await import('../engine/rv-parametric-bundle');
        try {
          use = await familyUseFromGlb(new Uint8Array(await res.arrayBuffer()), family, a.assetPath ?? undefined);
        } catch (e) {
          throw new CommandError(e instanceof Error ? e.message : String(e));
        }
      } else {
        use = { Family: family, FamilyNodeId: String(a.familyNodeId), DocHash: String(a.docHash) };
        if (a.assetPath) use.Path = a.assetPath;
      }
    }
    // plan-780 R4: a project-document child is declared by id, no path fallback.
    if (use) {
      const { referenceForWrite } = await import('../library/library-reference-write');
      const written = referenceForWrite(
        { catalogId: use.Family, glbUrl: use.Path, providerId: use.ProviderId, sourceId: use.SourceId },
        (ctx.viewer as { currentModelScope?: import('../library/library-origin').DocumentScope }).currentModelScope ?? null,
      );
      if (!written.path) delete use.Path;
      if (written.providerId && written.sourceId) { use.ProviderId = written.providerId; use.SourceId = written.sourceId; }
      else { delete use.ProviderId; delete use.SourceId; }
    }
    const before = Array.isArray(pc.Uses) ? pc.Uses as ParametricUse[] : undefined;
    let next: ParametricUse[];
    try {
      next = applyUseChange(before, { family, use, remove: !!a.remove });
    } catch (e) {
      throw new CommandError(e instanceof Error ? e.message : String(e));
    }
    const regen = await import('./rv-parametric-regenerate');
    let outcome: Awaited<ReturnType<typeof regen.regenerateParametric>> | null = null;
    try {
      await doc.withTransaction(a.remove ? `Remove child family ${family}` : `Use child family ${family}`, async () => {
        await doc.setFieldAwaited(path, PARAMETRIC_COMPONENT_TYPE, 'Uses', next, before);
        // Uses is part of the InputHash: the stored variant is stale now.
        const out = await regen.regenerateParametric({ viewer: ctx.viewer, doc }, path, undefined, { force: true });
        outcome = out;
        if (out.status === 'failed') throw new Error(`${out.error.code}: ${out.error.message}`);
      });
    } catch (e) {
      throw new CommandError(`Uses not changed - ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ok: true, path, uses: next, regenerate: outcome };
  },
};

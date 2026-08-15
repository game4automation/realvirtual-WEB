// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * "Open in realvirtual WEB" — from looking at a shared GLB to working with it
 * (plan-386 §2.5, F12).
 *
 * ## Two outcomes, decided by the file and not by the link
 *
 * The URL says nothing about what the content *is* — that was the whole point
 * of collapsing `?asset=` and `?model=` into one parameter (§2.1). The answer
 * lives in `rv_share.level`:
 *
 * | `level` | escalation |
 * |---------|-----------|
 * | `'model'` | the GLB **is** the scene — open it as one |
 * | anything else, or absent | one placement inside an empty layout |
 *
 * An absent level defaults to *placement* on purpose: a component dropped into
 * a layout is recoverable in one click, while a stranger's file silently
 * replacing what the visitor was working on is not.
 *
 * ## Why the op path and not the plan-397 bake path
 *
 * plan-397 gave the loader a second way to materialise a placement: bake an
 * AssetReference node into the GLB body and let `adoptPlacements()` pick it up.
 * It is genuinely simpler for stored scenes — and unusable here. Baking
 * *produces bytes and writes them to a body slot*, which is precisely the
 * persistence the transient seam exists to forbid (F7): the escalation would
 * have to write the visitor's `draft/…` slot to show him somebody else's file.
 *
 * So the escalation takes the op route the plan already named (§5.3):
 * `AddPlacementOp` → `addPlacementForward()` → `placeFromRecord()` →
 * `LayoutStore.addComponent()`. No new executor, nothing written, and undo
 * works because the op is a normal entry in the in-memory log. The verification
 * of 2026-08-08 removed the only reason to hesitate: since plan-397 the loader
 * materialises placements itself, independent of the planner plugin and of the
 * mode, so R3 is answered and the "build the scene only on mode switch"
 * fallback is gone.
 *
 * ## Nothing here is reachable without a click
 *
 * Escalation is an explicit user action, and that is what licenses it to touch
 * the workspace at all. The consumer path (Phase 1) still writes nothing and
 * still never gets here on its own.
 */

import { makeDraftScene, type RvScene } from '../hmi/scene/rv-scene-types';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { freshOpId } from '../ops/rv-op-utils';
import type { AddPlacementOp } from '../hmi/scene/rv-scene-edits';
import type { PlacedComponent } from '../../plugins/layout-planner/rv-layout-store';
import { filenameFromUrl, type RvShareMeta, type SharedGlbInfo } from './rv-share-meta';

export type EscalationKind = 'scene' | 'placement';

export interface EscalationResult {
  kind: EscalationKind;
  /** Set for a placement escalation — the handle for transform / remove ops. */
  placementId?: string;
}

/**
 * What "Open in realvirtual WEB" will do with this file (§2.5).
 *
 * `plant` is the plan-413 spelling of what v1 called `model`; `parseShareMeta`
 * up-maps a v1 block before it ever reaches here, so an old share link keeps
 * escalating to a scene exactly as it did. `scene` — a level v1 had no word for
 * — escalates the same way: a file that says it IS a scene is one.
 */
export function escalationKindFor(meta: RvShareMeta | null | undefined): EscalationKind {
  return meta?.level === 'plant' || meta?.level === 'scene' ? 'scene' : 'placement';
}

/**
 * The synthetic scene a shared GLB becomes.
 *
 * Built on `makeDraftScene()` rather than assembled by hand: `RvScene` has more
 * required shape than any quick check would look at, and a hand-rolled literal
 * is how that gap turns into a scene that passes inspection and then fails to
 * load (R8). The `rv_share` block keeps its own version
 * (`RvShareMeta.v`) so the two schemas can move independently.
 */
export function makeSharedGlbScene(url: string, meta: RvShareMeta | null): RvScene {
  const label = meta?.name?.trim() || filenameFromUrl(url);
  return makeDraftScene({ kind: 'builtin', url, label }, label);
}

/** The empty layout a shared component is placed into. */
function makeSharedPlacementScene(label: string): RvScene {
  return makeDraftScene({ kind: 'empty' }, label);
}

/**
 * Build the placement record for a shared GLB.
 *
 * All seven required fields of `PlacedComponent` are filled explicitly. A
 * partially built record is the failure mode §9.5 `escalate_LevelAssembly_
 * OpensAsPlacement` guards: it survives `addComponent()` and then produces an
 * object at the origin with no scale and no label.
 */
export function makeSharedPlacement(info: {
  url: string;
  name: string;
  meta: RvShareMeta | null;
}): PlacedComponent {
  return {
    id: `shared_${freshOpId()}`,
    // A catalog id that says where this came from. It matches no catalogue
    // entry, which is correct — the visitor never subscribed to a library for
    // it — and the bookmark store is what turns it into one if he wants it.
    catalogId: `shared:${info.url}`,
    glbUrl: info.url,
    label: info.name,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    visible: true,
  };
}

/** The one thing the escalation asks the viewer: is the planner there? */
export interface PluginProbe {
  getPlugin<T>(id: string): T | undefined;
}

export interface EscalateOptions {
  /** Overrides the file's own verdict — used by an explicit UI choice. */
  kind?: EscalationKind;
  /**
   * Used to check for the Layout Planner **before** anything is opened.
   *
   * The check has to happen up front because `applyOp` deliberately swallows a
   * failing executor — an op that cannot be applied must not wedge the store,
   * so the "LayoutPlannerPlugin not registered" error ends up in the console
   * and the promise resolves as if all were well. Discovering that after the
   * workspace has already been replaced would leave the visitor staring at an
   * empty scene with no explanation (§9.5
   * `escalate_MissingPlannerPlugin_FailsClearly`).
   */
  viewer?: PluginProbe | null;
}

/**
 * Escalate the shared content into the full app.
 *
 * Throws with a sentence rather than returning a flag: every failure here is
 * something the visitor must be told (no store yet, no planner plugin, a GLB
 * that will not load), and a silent no-op after a button press is the worst of
 * the available outcomes.
 */
export async function escalateSharedGlb(
  info: SharedGlbInfo,
  opts: EscalateOptions = {},
): Promise<EscalationResult> {
  const store = getSceneStore();
  if (!store) {
    throw new Error('The workspace is not ready yet — try again in a moment.');
  }

  const kind = opts.kind ?? escalationKindFor(info.meta);

  if (kind === 'placement' && opts.viewer && !opts.viewer.getPlugin('layout-planner')) {
    throw new Error(
      'This build has no Layout Planner, so a shared component cannot be placed. '
      + 'LayoutPlannerPlugin not registered.',
    );
  }

  if (kind === 'scene') {
    await store.openTransient(makeSharedGlbScene(info.url, info.meta));
    return { kind };
  }

  await store.openTransient(makeSharedPlacementScene(info.name));

  const placement = makeSharedPlacement({ url: info.url, name: info.name, meta: info.meta });
  const op: AddPlacementOp = {
    id: freshOpId(),
    ts: Date.now(),
    schemaV: 1,
    kind: 'addPlacement',
    placement,
  };
  // A normal op: it goes on the in-memory log, so undo removes the placement
  // again and the transient seam keeps it out of storage.
  await store.applyOp(op);

  return { kind, placementId: placement.id };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The modes in which layout AUTHORING is available — the single place this set
 * is written down.
 *
 * Kept in its own dependency-free module so core code (the mode-owned panel
 * reconciler, `src/core/hmi/mode-owned-panels.ts`) can ask "does the planner own
 * the screen in this mode?" without importing the whole planner plugin.
 * `layout-planner/index.ts` re-exports both names, so existing imports keep
 * working.
 *
 * `'planner'` is the dedicated authoring workspace; `'des'` joined it because
 * DES is where material-flow layouts are actually built, and everything that
 * makes authoring work hangs off this plugin: the TransformControls drag, the
 * `layout-drag-start/tick/end` broadcast that arms magnetic snap
 * (snap-point/index.ts), the placement ops, the grid and the library panel.
 * Without the plugin participating there is no drag in a mode, and therefore
 * nothing for the snap system to attach to — gating the snap system alone
 * would have been dead code.
 *
 * Note the two INDEPENDENT gates that both resolve from here (doc-ui-visibility.md):
 *  - participation — `modes` → `pluginParticipatesInMode`, and the UI registry
 *    turns it into `shownOnlyInAny: ['mode:planner', 'mode:des']` on every slot;
 *  - the legacy `'planner'` UI CONTEXT, set by `LayoutPlannerPlugin.setActive`
 *    and read by the toolbar slots, by snap-point's `_applyMode`, its magnetic
 *    arming and its chain preview. It is a statement about "authoring is live",
 *    not about which mode is selected, which is why it needs no per-mode variant.
 */

import type { ModeId } from '../../core/rv-mode-manager';
import type { UIVisibilityRule } from '../../core/hmi/ui-context-store';

export const AUTHORING_MODES: readonly ModeId[] = ['planner', 'des'];

/** True while `mode` is one of the layout-authoring workspaces. */
export function isAuthoringMode(mode: ModeId | null | undefined): boolean {
  return mode != null && AUTHORING_MODES.includes(mode);
}

/**
 * The UI CONTEXT id that means "layout authoring is live" (plan-2010).
 *
 * It is the legacy string `'planner'`, set by `LayoutPlannerPlugin.setActive`
 * in EVERY authoring mode (planner and des). Despite the name it does NOT mean
 * "the Planner mode is selected" — that is `modeContext('planner')`
 * (`'mode:planner'`). Not renamed: snap-point's `_applyMode`, the magnetic
 * arming and the chain preview read it.
 */
export const AUTHORING_LIVE_CONTEXT = 'planner';

/**
 * Visibility rule of a left-toolbar tool that belongs to layout authoring:
 * authoring is live AND the mode is one of {@link AUTHORING_MODES}.
 *
 * Use this instead of the bare `{ shownOnlyIn: ['planner'] }`, which reads as
 * "only in Planner mode" but in fact also shows the tool in DES. Spread it into
 * a slot's `visibilityRule` (`{ ...AUTHORING_TOOL_RULE }`). Written with the `mode:<id>` strings directly (equal to
 * `modeContext()`, pinned by a test) to keep this module dependency-free.
 */
export const AUTHORING_TOOL_RULE: Readonly<UIVisibilityRule> = {
  shownOnlyIn: [AUTHORING_LIVE_CONTEXT],
  shownOnlyInAny: AUTHORING_MODES.map((m) => `mode:${m}`),
};

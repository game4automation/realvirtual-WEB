// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * help-context — derives the documentation topic for the current application
 * state and opens it (plan-370).
 *
 * DERIVED, NOT MIRRORED. The signals that decide the context are already
 * reactive and already owned by someone: `viewer.leftPanelManager` knows which
 * window was opened last, `viewer.modes` knows the workspace mode. Copying them
 * into a second store would add a registration lifecycle whose entries can go
 * stale, and a reset on model switch would delete registrations that are still
 * valid. So the core context is READ at call time; only plugin contributions —
 * which cannot be derived from anything — live in a registry.
 *
 * Consequence for F11: the core context cannot go stale, because it is never
 * stored. It also does not "reset" on a model switch — `rv-viewer` deliberately
 * preserves the active workspace mode and `leftPanelManager` lives on the
 * viewer, so an unchanged window/mode after a model switch keeps producing the
 * same, still correct, help target.
 *
 * SYNCHRONY: `openCurrentHelp()` is strictly synchronous from click / keydown
 * to `window.open()` — see the construction rule in help-url.ts.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useViewer } from '../../hooks/use-viewer';
import { getAppConfig } from '../rv-app-config';
import type { LeftPanelSnapshot, PanelId } from './left-panel-manager';
import { buildHelpUrl, openExternal } from './help-url';
import { getHelpTopicsSnapshot, readPluginTopic, subscribeHelpTopics } from './help-topic-registry';
import { isEditableTarget } from './search-shortcut';
import { useUIVisible, type UIVisibilityRule } from './ui-context-store';
import {
  HELP_FALLBACK, MODE_TOPICS, PANEL_TOPICS, helpTopicLabel, type HelpTopic,
} from './help-topics';

// ─── Priorities ─────────────────────────────────────────────────────────

/**
 * Fixed ranking. Plugin contributions ALWAYS sit on the top rank — the registry
 * takes no priority argument from the caller (see help-topic-registry.ts).
 */
export const HELP_PRIORITY = {
  plugin: 40, // plugin contribution (registry)
  panel: 30,  // most recently opened window
  mode: 20,   // active workspace mode
} as const;

/**
 * The `help` element's default visibility rule. Shared by the button and the F1
 * listener so the two can never drift apart — kiosk hides both. FPV hides the
 * element `activity-bar`, NOT `help`, so F1 stays alive there.
 *
 * A deployment can override this through `ui.visibilityOverrides` in
 * settings.json, which main.ts registers before React mounts.
 */
export const HELP_VISIBILITY_RULE: UIVisibilityRule = { hiddenIn: ['kiosk'] };

/** The id under which the help entry is registered in the UI context store. */
export const HELP_UI_ELEMENT_ID = 'help';

// ─── Derivation ─────────────────────────────────────────────────────────

/** The three inputs the derivation consumes. Pure data, no viewer, no React. */
export interface HelpContextInput {
  /** Panel id of the most recently opened side, or null when nothing is open. */
  readonly panel: PanelId | null;
  /** Active workspace mode ('hmi' | 'des' | 'planner' | 'editor'), or null. */
  readonly mode: string | null;
  /** Winning plugin contribution, or null. */
  readonly pluginTopic: HelpTopic | null;
}

/**
 * Resolve the topic for a context. Pure — no React, no viewer, no I/O.
 * An unknown panel id or mode is not an error: it falls through to the next
 * rank and finally to {@link HELP_FALLBACK}.
 */
export function deriveHelpTopic(input: HelpContextInput): HelpTopic {
  if (input.pluginTopic) return input.pluginTopic;
  if (input.panel) {
    const byPanel = PANEL_TOPICS[input.panel];
    if (byPanel) return byPanel;
  }
  if (input.mode) {
    const byMode = MODE_TOPICS[input.mode];
    if (byMode) return byMode;
  }
  return HELP_FALLBACK;
}

/**
 * The panel that decides the context: the one on the side that was opened last
 * (F10). Left and right can be open at the same time, so "the active panel"
 * does not exist — the most recent one wins.
 */
export function readPanelFromSnapshot(snapshot: LeftPanelSnapshot | null | undefined): PanelId | null {
  if (!snapshot) return null;
  const side = snapshot.lastOpenedSide;
  if (!side) return null;
  return (side === 'right' ? snapshot.right : snapshot.left).activePanel;
}

/** Assemble the derivation input from the raw reactive values. */
export function toHelpContextInput(
  panels: LeftPanelSnapshot | null | undefined,
  activeMode: string | null,
  pluginTopic: HelpTopic | null,
): HelpContextInput {
  return { panel: readPanelFromSnapshot(panels), mode: activeMode, pluginTopic };
}

// ─── Viewer access ──────────────────────────────────────────────────────

/**
 * The slice of RVViewer this module needs. Structural on purpose: RVViewer
 * satisfies it, and tests can pass a two-field stub. Both members are optional
 * so a constrained shell whose viewer lacks one of the managers degrades to the
 * fallback instead of throwing.
 */
export interface HelpContextHost {
  readonly leftPanelManager?: { getSnapshot: () => LeftPanelSnapshot } | null;
  readonly modes?: { readonly activeMode: string | null } | null;
}

/** Collect the triple from the viewer-bound managers and the plugin registry. */
export function readHelpContextInput(viewer: HelpContextHost | null | undefined): HelpContextInput {
  const panels = viewer?.leftPanelManager?.getSnapshot() ?? null;
  const mode = viewer?.modes?.activeMode ?? null;
  return toHelpContextInput(panels, mode, readPluginTopic());
}

/**
 * THE single entry point. Click and F1 both call exactly this, so the two can
 * never diverge and a configured `docs.baseUrl` cannot apply to only one of
 * them. Strictly synchronous — see help-url.ts.
 */
export function openCurrentHelp(viewer: HelpContextHost | null | undefined): void {
  const topic = deriveHelpTopic(readHelpContextInput(viewer));
  openExternal(buildHelpUrl(topic, getAppConfig().docs?.baseUrl));
}

// ─── React bindings ─────────────────────────────────────────────────────

const EMPTY_PANEL_SNAPSHOT: LeftPanelSnapshot = {
  activePanel: null,
  activePanelWidth: 0,
  left: { activePanel: null, activePanelWidth: 0 },
  right: { activePanel: null, activePanelWidth: 0 },
  lastOpenedSide: null,
};

const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const EMPTY_PANEL_GETTER = (): LeftPanelSnapshot => EMPTY_PANEL_SNAPSHOT;
const ZERO_VERSION = (): number => 0;

/**
 * The derived topic, reactive on ALL THREE sources: the panel snapshot, the
 * workspace mode and the plugin registry. Subscribing to all three is what
 * makes the hook self-contained — relying on the parent re-rendering for other
 * reasons would leave a stale tooltip and a stale accessible name behind.
 */
export function useHelpTopic(): HelpTopic {
  const viewer = useViewer() as unknown as HelpContextHost & {
    modes?: { activeMode: string | null; subscribe: (cb: () => void) => () => void; getSnapshot: () => number };
    leftPanelManager?: {
      getSnapshot: () => LeftPanelSnapshot;
      subscribe: (cb: () => void) => () => void;
    };
  };
  const lpm = viewer?.leftPanelManager;
  const modes = viewer?.modes;

  const panels = useSyncExternalStore(
    lpm?.subscribe ?? NOOP_SUBSCRIBE,
    lpm?.getSnapshot ?? EMPTY_PANEL_GETTER,
  );
  useSyncExternalStore(modes?.subscribe ?? NOOP_SUBSCRIBE, modes?.getSnapshot ?? ZERO_VERSION);
  useSyncExternalStore(subscribeHelpTopics, getHelpTopicsSnapshot);

  return deriveHelpTopic(toHelpContextInput(panels, modes?.activeMode ?? null, readPluginTopic()));
}

/** Tooltip text, e.g. "Help: Layout Planner". */
export function helpTooltip(topic: HelpTopic): string {
  return `Help: ${helpTopicLabel(topic)}`;
}

/**
 * Accessible name. Names the target AND the tab change — `target="_blank"`
 * alone is not reliably announced by screen readers.
 */
export function helpAriaLabel(topic: HelpTopic): string {
  return `Open help for ${helpTopicLabel(topic)} (new tab)`;
}

/**
 * Global F1 route. Registered once on the app shell, NOT on the button mount —
 * the activity bar is hidden in FPV, and F1 has to keep working there.
 *
 * Bound to the same `help` visibility as the button: silent in kiosk, and
 * silent means silent — no `preventDefault()` when we do not act, so the
 * browser's own F1 handling is left untouched. Same rule while typing.
 */
export function useHelpShortcut(): void {
  const viewer = useViewer();
  const helpVisible = useUIVisible(HELP_UI_ELEMENT_ID, HELP_VISIBILITY_RULE);

  useEffect(() => {
    if (!helpVisible) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F1') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      openCurrentHelp(viewer as unknown as HelpContextHost);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [viewer, helpVisible]);
}

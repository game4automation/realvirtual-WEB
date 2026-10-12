// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-command-view — the ONE hook every button primitive uses to become a view
 * of a command (plan-499 F17).
 *
 * Label, disabled + reason, click (always `execute(..., {origin:'ui'})`, never
 * `run()`), the simulated/afterglow phase and the data attributes the MCP
 * choreography scrolls to all come from here, so `ActionButton` (private),
 * `ActionSegment` (open) and plain icon buttons cannot drift apart.
 *
 * The implementation is loaded on mount (`preload`) so `enabled()` answers
 * synchronously after the first frames; until then the view shows
 * `COMMAND_LOADING_REASON`, never the community "not available" text.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { RVViewer } from '../rv-viewer';
import { commandRegistry, type CommandRegistry } from './rv-command-registry';
import {
  useAiTouch,
  useButtonSimState,
  type AiTouchView,
  type ButtonSimPhase,
} from './button-sim-state';

export interface CommandRef {
  readonly id: string;
  /** Args factory — evaluated at render (enabled) and at click (execute). */
  readonly args?: () => unknown;
  /** Explicit button key; default: descriptor.buttonKey(args) ?? id. */
  readonly buttonKey?: string;
  /**
   * Interactive views only (a picker that dispatches LATER, e.g. "Pivot to
   * Object" waits for the second click): the click calls this instead of
   * `execute`. Enabled state, reason, sim phase and afterglow still come from
   * the command — the dispatch happens when the picker completes.
   */
  readonly invoke?: () => void;
  /**
   * The viewer the command runs against (views outside the editor know theirs:
   * sim toolbar, inspector, planner). Default: the registry's attached viewer,
   * then the active asset context's.
   */
  readonly viewer?: RVViewer;
}

export interface CommandView {
  readonly label: string;
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly onClick: () => void;
  readonly simPhase: ButtonSimPhase | null;
  /** True while the AI afterglow is on this button. */
  readonly touch: boolean;
  /** Afterglow detail (seq restarts the CSS fade on a repeat trigger). */
  readonly aiTouch: AiTouchView;
  readonly buttonKey: string;
  readonly dataAttrs: Record<string, string>;
}

const INERT_TOUCH: AiTouchView = { active: false, seq: 0, progress: 1 };
const INERT: CommandView = {
  label: '', disabled: false, reason: null, onClick: () => {}, simPhase: null, touch: false,
  aiTouch: INERT_TOUCH, buttonKey: '', dataAttrs: {},
};

const noArgs = (): unknown => undefined;

/**
 * Bind a button to a command. `ref === null` returns an inert view so the hook
 * can be called unconditionally by primitives that also accept `onClick`.
 */
export function useCommandView(ref: CommandRef | null, registry: CommandRegistry = commandRegistry): CommandView {
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const argsOf = ref?.args ?? noArgs;
  const refId = ref?.id ?? '';
  const buttonKey = ref ? (ref.buttonKey ?? registry.buttonKeyOf(ref.id, argsOf())) : '';
  const simPhase = useButtonSimState(buttonKey);
  const aiTouch = useAiTouch(buttonKey);
  // Lazy impl: load on first mount so enabled() becomes synchronous (bumps the snapshot).
  useEffect(() => { if (refId) void registry.preload([refId]); }, [refId, registry]);
  if (!ref) return INERT;
  const args = argsOf();
  const viewer = ref.viewer;
  const en = registry.enabled(ref.id, args, viewer);
  const reason = en === true ? null : en.reason;
  const invoke = ref.invoke;
  return {
    label: registry.labelOf(ref.id, args),
    disabled: en !== true,
    reason,
    onClick: invoke
      ? () => invoke()
      : () => { void registry.execute(ref.id, argsOf(), { origin: 'ui', buttonKey, ...(viewer ? { viewer } : {}) }); },
    simPhase,
    touch: aiTouch.active,
    aiTouch,
    buttonKey,
    dataAttrs: {
      'data-rv-command-id': ref.id,
      'data-rv-button-id': buttonKey,
      ...(simPhase ? { 'data-rv-sim-phase': simPhase } : {}),
    },
  };
}

/**
 * The afterglow as sx (open primitives; the private `buttonSimSx` has its own
 * accent). Colour + opacity only — no transform, so `prefers-reduced-motion`
 * needs no special case; the fade is a CSS animation whose name alternates
 * with `seq`, which is what restarts it on a repeat trigger.
 */
export function aiTouchSx(touch: AiTouchView, durationMs: number, accentRgb = '79,195,247'): Record<string, unknown> {
  if (!touch.active) return {};
  const name = touch.seq % 2 === 0 ? 'rvAiGlowA' : 'rvAiGlowB';
  const frames = {
    from: { backgroundColor: `rgba(${accentRgb},0.28)` },
    to: { backgroundColor: `rgba(${accentRgb},0)` },
  };
  return {
    [`@keyframes ${name}`]: frames,
    animation: `${name} ${durationMs}ms linear forwards`,
    boxShadow: `inset 0 0 0 1px rgba(${accentRgb},0.9)`,
    position: 'relative',
    // AI marker: a tiny "AI" tag in the top-right corner while the afterglow runs.
    '&::after': {
      content: '"AI"', position: 'absolute', top: 1, right: 2,
      fontSize: 7, fontWeight: 700, lineHeight: 1, letterSpacing: 0.2,
      color: `rgb(${accentRgb})`, pointerEvents: 'none',
    },
  };
}

/**
 * Hover / press of the MCP choreography as sx, for targets that have no
 * button look of their own to act with (an Inspector field row): the same
 * accent as {@link aiTouchSx}, light while hovering, strong while pressed.
 */
export function aiSimPhaseSx(phase: 'hover' | 'pressed' | 'afterglow', accentRgb = '79,195,247'): Record<string, unknown> {
  if (phase === 'afterglow') return {};
  const strong = phase === 'pressed';
  return {
    bgcolor: `rgba(${accentRgb},${strong ? 0.3 : 0.14})`,
    boxShadow: `inset 0 0 0 1px rgba(${accentRgb},${strong ? 1 : 0.6})`,
  };
}

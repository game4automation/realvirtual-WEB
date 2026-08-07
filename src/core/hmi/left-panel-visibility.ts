// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The pairings of "UI visibility gate" ↔ "leftPanelManager slot" for every
 * left-docked panel a workspace can hide.
 *
 * They live together, away from the panels themselves, because TWO places have
 * to agree on each pairing and repeatedly did not:
 *
 * - the **mount site** (`App.tsx`, `TopBar.tsx`) renders the panel behind the
 *   gate — plan-387 added those gates for the viewer workspace;
 * - **TopBar's reconciliation** (`orphanedLeftSlot`) must drop the panel's lpm
 *   slot whenever the gate is shut.
 *
 * Miss the second half and the slot outlives the panel: `useLeftWindowWidth`
 * keeps reporting its width, so the canvas inset and the floating toolbars go on
 * reserving space for something that renders nothing — the empty grey strip.
 * plan-387 shipped that for the Hierarchy browser, the Annotations panel, the
 * CONNECT panel, the Order panel and the Machine Control panel alike; they are
 * one defect, not five.
 *
 * **Adding a gated left panel? Add its pairing HERE** rather than writing the id
 * and rule as literals at the mount site. That is what keeps the two halves from
 * drifting, and it is the list TopBar reconciles against.
 *
 * Not listed on purpose:
 * - `settings` — the viewer keeps it, so it is never gated.
 * - `measurements`, `clipping` — deliberately ungated (they are what the viewer
 *   is for, see App.tsx).
 * - `layout-planner`, `kinematics`, `materials` — right-side slots owned by
 *   mode-scoped plugins that close them in their own `onModeDeactivate`.
 * - `scene` — the window was deleted (plan-372 Phase 13); `orphanedLeftSlot`
 *   treats a persisted slot as unconditionally orphaned instead.
 */

import type { UIVisibilityRule } from './ui-context-store';

/** One panel's gate and the left-panel slot it occupies. */
export interface LeftPanelGate {
  /** `useUIVisible` id — stable, so `ui.visibilityOverrides` can redefine it. */
  readonly id: string;
  /** Code-declared default rule (a deployment override wins over it). */
  readonly rule: UIVisibilityRule;
  /** The `leftPanelManager` panel id this gate's panel renders into. */
  readonly slot: string;
}

export const HIERARCHY_BROWSER_GATE: LeftPanelGate = {
  id: 'hierarchy-browser', rule: { hiddenIn: ['mode:viewer'] }, slot: 'hierarchy',
};

export const ANNOTATION_PANEL_GATE: LeftPanelGate = {
  id: 'annotation-panel', rule: { hiddenIn: ['mode:viewer'] }, slot: 'annotations',
};

export const CONNECT_PANEL_GATE: LeftPanelGate = {
  id: 'connect-panel', rule: { hiddenIn: ['mode:viewer'] }, slot: 'connect',
};

export const ORDER_PANEL_GATE: LeftPanelGate = {
  id: 'order-panel', rule: { hiddenIn: ['mode:viewer'] }, slot: 'order-manager',
};

export const MACHINE_CONTROL_PANEL_GATE: LeftPanelGate = {
  id: 'machine-control-panel', rule: { hiddenIn: ['mode:viewer'] }, slot: 'machine-control',
};

/** Every gated left panel, in one list — what TopBar reconciles against. */
export const LEFT_PANEL_GATES: readonly LeftPanelGate[] = [
  HIERARCHY_BROWSER_GATE,
  ANNOTATION_PANEL_GATE,
  CONNECT_PANEL_GATE,
  ORDER_PANEL_GATE,
  MACHINE_CONTROL_PANEL_GATE,
];

/**
 * The slots whose panel cannot render right now, given each gate's evaluated
 * visibility (as returned by `useUIVisible`, so deployment overrides are already
 * applied by the caller).
 *
 * Fails OPEN: a gate missing from `visibleById` is treated as visible, so a host
 * that evaluates only some of them never closes a slot it knows nothing about.
 */
export function hiddenLeftPanelSlots(
  visibleById: Readonly<Record<string, boolean>>,
): Set<string> {
  return new Set(
    LEFT_PANEL_GATES.filter((g) => visibleById[g.id] === false).map((g) => g.slot),
  );
}

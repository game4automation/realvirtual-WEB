// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RenderModeBar — the render-mode segment of the bottom-right view cluster
 * (plan-761, compacted by plan-578), modelled on Unity's Draw Modes bar.
 *
 * ONE segment, not four: it shows the icon of the ACTIVE mode and opens a menu
 * upwards (`ActionDropdownSegment`) listing the three exclusive shading modes —
 * Unlit / Shaded / Toon, labels and order straight from `RENDER_MODES` — plus
 * Wireframe, which only exists in the editor workspace. Every row is a VIEW of
 * a command (plan-499): the shading rows of `view.renderMode {mode}`, the
 * wireframe row of `editor.wireframe {on:true}` (same command as Shift+Z and
 * `web_editor_shortcut`). The bar wires nothing itself; `useCommandView` gives
 * each row its enabled state, the reason tooltip and the MCP afterglow
 * (button key `view.renderMode:<mode>`).
 *
 * Since plan-591 the menu carries a SECOND axis: two action rows for the
 * quality preset ("Max Quality" / "Fast", views of `view.visualPreset`). No new
 * segment and no new pill — a user decision. The trigger keeps showing only the
 * MODE, because that is the axis its icon can honestly represent.
 *
 * Because the rows are not mounted while the menu is collapsed, the trigger
 * carries `data-rv-button-proxy` with all six button keys: that is what keeps
 * the MCP pre-choreography (hover → press, `simulateButtonClick`) and the
 * afterglow visible for an agent-driven mode switch (plan-578 §2.5). The keys
 * come from the registry, not from a hardcoded string, and the list has a fixed
 * length so the trigger's hook order never changes between workspaces.
 *
 * The active value is a UI single axis over TWO viewer fields — the persisted
 * `renderMode` and the transient editor wireframe — folded by the one rule in
 * `render-mode-controller`: `wireframeActive ? 'wireframe' : renderMode`. It
 * re-renders on the three events that can change that rule (`render-mode-
 * changed`, `wireframe-changed`, `mode-changed`) through a primitive string
 * snapshot, so a re-render never loops. The trigger ICON follows that same
 * value, which is why `ICONS` must cover `RenderModeValue` — including
 * `wireframe` — and not just `RenderMode`.
 *
 * A deployment that locks the Visual settings (`lockSettings` or
 * `lockedTabs: ['visual']`) gets no segment at all — the command and the MCP
 * tool refuse with the same reason, the segment simply is not there.
 */

import { useMemo, useSyncExternalStore, type ReactElement } from 'react';
import { AutoAwesome, Brush, Grid4x4, Lens, PanoramaFishEye, Speed } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { isTabLocked } from '../rv-app-config';
import { RENDER_MODES, type RenderMode } from '../rv-render-modes';
import { ActionDropdownSegment, ActionGroupPill, type ActionDropdownItem } from './action-group';
import { ensureEditorCommandsRegistered } from './editor-command-descriptors';
import { commandRegistry } from './rv-command-registry';
import { subscribeRenderModeValue, type RenderModeValue } from './render-mode-controller';
import {
  ensureViewCommandsRegistered, VIEW_RENDER_MODE_COMMAND, VIEW_VISUAL_PRESET_COMMAND,
} from './view-commands';
import { listShippedPresets, matchPreset } from './visual-presets';
import { subscribeVisualSettings, useToolbarShowLabels } from './visual-settings-store';

const EDITOR_WIREFRAME_COMMAND = 'editor.wireframe';

/**
 * The quality axis as two action rows (plan-591) — no second segment, no new
 * pill (user decision, §Entscheidungs-Log).
 *
 * They apply the SHIPPED presets (`source: 'shipped'`): "Max Quality" means the
 * Default that ships with the product, and a browser-local preset of the same
 * name must not hijack it (F12). "Fast" is the way back — the whole reason a
 * one-click maximum is safe on a weak GPU.
 *
 * `kind: 'action'`, deliberately not part of the exclusive mode group: quality
 * is a different axis from shading, and a screen reader must not hear five
 * radio buttons in one set.
 */
const QUALITY_ROWS = [
  {
    key: 'visual-preset-default',
    preset: 'Default',
    label: 'Max Quality',
    description: 'Shadows, reflections, native resolution',
    icon: <AutoAwesome />,
  },
  {
    key: 'visual-preset-fast',
    preset: 'Fast',
    label: 'Fast',
    description: 'Lower resolution, no shadows — best framerate',
    icon: <Speed />,
  },
] as const;

/** One icon per mode value — a plain signifier each, swappable. Covers
 *  `RenderModeValue`, so the trigger icon is never `undefined` on wireframe. */
const ICONS: Readonly<Record<RenderModeValue, ReactElement>> = {
  simple: <PanoramaFishEye />,
  default: <Lens />,
  toon: <Brush />,
  wireframe: <Grid4x4 />,
};

/**
 * The render-mode trigger as ONE segment, or `null` when the Visual settings are
 * locked — a hook, so the cluster host can drop the whole group (and its seam)
 * when there is nothing to show, like `useCameraSegments`.
 */
export function useRenderModeSegment(): ReactElement | null {
  const viewer = useViewer();
  // Both WeakSet-idempotent and cheap. Called in the render path on purpose —
  // a registration that only happens as an import side effect is invisible to
  // a test with its own registry (review A3 / A6).
  ensureViewCommandsRegistered();
  ensureEditorCommandsRegistered();
  const showLabels = useToolbarShowLabels();
  // plan-591: the quality marking needs NO new event. `applyVisualSettings`
  // emits `render-mode-changed` unconditionally (even without an actual mode
  // change), which `subscribeRenderModeValue` already listens to, so every
  // preset apply — UI, dialog or MCP — refreshes this of its own accord. What it
  // does NOT cover is a SINGLE slider move in the Visual tab: that walks the
  // state to "Custom" while persisting only, hence the settings channel on top.
  const subscribe = useMemo(
    () => (cb: () => void) => {
      const offMode = subscribeRenderModeValue(viewer, cb);
      const offSettings = subscribeVisualSettings(cb);
      return () => { offMode(); offSettings(); };
    },
    [viewer],
  );
  // Primitive snapshot, and it MUST stay primitive — `matchPreset` returning an
  // object here would tear `useSyncExternalStore` into a re-render loop.
  const value = useSyncExternalStore(
    subscribe,
    () => `${viewer.renderMode}|${viewer.wireframeActive}|${viewer.modes.activeMode}`
      + `|${matchPreset(listShippedPresets()) ?? ''}`,
  );
  // After the hooks: a locked deployment renders nothing at all.
  if (isTabLocked('visual')) return null;
  const [renderMode, wireActive, activeMode, activePreset] = value.split('|');
  const current: RenderModeValue = wireActive === 'true' ? 'wireframe' : (renderMode as RenderMode);
  const items: ActionDropdownItem[] = RENDER_MODES.map((m) => ({
    key: m.id,
    icon: ICONS[m.id],
    label: m.label,
    active: current === m.id,
    command: { id: VIEW_RENDER_MODE_COMMAND, args: () => ({ mode: m.id }), viewer },
    testId: `render-mode-${m.id}`,
  }));
  if (activeMode === 'editor') {
    items.push({
      key: 'wireframe',
      icon: ICONS.wireframe,
      label: 'Wireframe',
      shortcut: 'Shift+Z',
      active: current === 'wireframe',
      command: { id: EDITOR_WIREFRAME_COMMAND, args: () => ({ on: true }), viewer },
      testId: 'render-mode-wireframe',
    });
  }
  // The trigger names the active MODE — read before the quality rows join the
  // list, so the trigger can never end up labelled "Max Quality". Quality is a
  // different axis and is deliberately absent from the trigger (no new ICONS
  // entry). Falls back through the descriptor list so an unknown persisted id
  // still produces a label, never `undefined`.
  const activeItemLabel = items.find((i) => i.active)?.label
    ?? RENDER_MODES.find((m) => m.id === current)?.label
    ?? 'Shaded';
  // The quality rows, AFTER the modes and the wireframe row (plan-591). Same
  // lock rule as everything else here — `isTabLocked('visual')` above already
  // dropped the whole segment, so "locked stays locked" needs no second notion.
  for (const row of QUALITY_ROWS) {
    items.push({
      key: row.key,
      icon: row.icon,
      label: row.label,
      description: row.description,
      kind: 'action',
      // Checked against the same list the row resolves against
      // (`listShippedPresets`): with two lists a row could mark a preset active
      // that it would never apply (F12).
      active: activePreset === row.preset,
      command: {
        id: VIEW_VISUAL_PRESET_COMMAND,
        args: () => ({ name: row.preset, source: 'shipped' }),
        viewer,
      },
      testId: row.key,
    });
  }
  // Fixed-length proxy list: the three shading keys, the wireframe key and the
  // two quality keys, in EVERY workspace. The wireframe key simply never
  // receives a touch outside the editor, and the trigger's hook order stays
  // stable (§2.5). Six keys is exactly `PROXY_KEY_SLOTS` — a seventh would be
  // ignored, so that constant has to grow with the list.
  const proxyKeys = [
    ...RENDER_MODES.map((m) => commandRegistry.buttonKeyOf(VIEW_RENDER_MODE_COMMAND, { mode: m.id })),
    commandRegistry.buttonKeyOf(EDITOR_WIREFRAME_COMMAND, { on: true }),
    ...QUALITY_ROWS.map((r) => commandRegistry.buttonKeyOf(
      VIEW_VISUAL_PRESET_COMMAND, { name: r.preset, source: 'shipped' },
    )),
  ];
  return (
    <ActionDropdownSegment
      key="render-mode"
      title={`Render mode: ${activeItemLabel}`}
      menuLabel="Render mode"
      icon={ICONS[current] ?? ICONS.default}
      label={showLabels ? activeItemLabel : undefined}
      items={items}
      proxyKeys={proxyKeys}
      buttonProps={{
        // The NAME of the control plus its value — "Shaded" alone does not say
        // what a screen-reader user would be changing.
        'aria-label': `Render mode: ${activeItemLabel}`,
        'data-testid': 'render-mode-trigger',
      }}
    />
  );
}

/** The render-mode segment in its own pill — for a host that is not the view cluster. */
export function RenderModeGroup() {
  const segment = useRenderModeSegment();
  if (!segment) return null;
  return <ActionGroupPill>{segment}</ActionGroupPill>;
}

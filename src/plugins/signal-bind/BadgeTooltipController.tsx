// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * BadgeTooltipController — turns a hover over a 3D link badge into its hover
 * card (plan-422 F5). Headless; renders null.
 *
 * ## Why this is not the generic controller's job
 *
 * `GenericTooltipController` answers "what is this OBJECT", keyed off the
 * hovered node's `rv_extras`. A badge is not an object in that sense: it is a
 * gizmo sprite registered as an AUXILIARY raycast target owned by the node it
 * sits on, so hovering it reports the owner node and the generic controller
 * would show the drive/lamp/sensor card of the thing behind the plug — which is
 * precisely the question the user did NOT ask.
 *
 * The pick is distinguishable through `hover.mesh`, so this controller watches
 * the same hover stream and speaks up only when the hit mesh belongs to a
 * badge, at a priority that outranks the object's own sections.
 *
 * ## Suppressed during a drag
 *
 * While a signal drag is in flight the badges are drop TARGETS and the drop
 * overlay is already naming the candidate under the cursor. A second floating
 * card explaining the same badge would fight it for the same pixels, so the
 * hover card stands down until the drag ends.
 */

import { useEffect, useRef } from 'react';
import { useHoveredObject } from '../../hooks/use-hover';
import { useViewer } from '../../hooks/use-viewer';
import { tooltipStore } from '../../core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../../core/hmi/tooltip/tooltip-registry';
import { useSignalDragActive } from '../../core/hmi/signal-drag-store';
import { SIGNAL_BADGE_STATE_LABEL } from './SignalBadgeController';
import { badgeRootOf, buildBadgeTooltipData } from './badge-tooltip-model';
import { findSignalBindTarget } from './signal-bind-target';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import type { TooltipData } from '../../core/hmi/tooltip/tooltip-store';
import type { ElementBindingState } from '../../core/engine/rv-signal-binding-manager';
import '../../core/hmi/tooltip/SignalBadgeTooltipContent';

const HOVER_ID = 'tooltip-hover:signal-badge';

export function BadgeTooltipController() {
  const viewer = useViewer();
  const hover = useHoveredObject();
  const dragActive = useSignalDragActive();
  const shown = useRef(false);

  const badge = dragActive ? null : badgeRootOf(hover?.mesh);

  useEffect(() => {
    const hide = () => {
      if (!shown.current) return;
      tooltipStore.hide(HOVER_ID);
      shown.current = false;
    };

    if (!badge || !hover) { hide(); return; }
    const mgr = viewer?.signalBindingManager;
    if (!mgr) { hide(); return; }

    const target = findSignalBindTarget(viewer, hover.node);
    if (!target) { hide(); return; }

    // The badge's own colour-state, so the card's header agrees with the sprite.
    const state = (badge.userData.rvSignalBadgeState ?? 'unbound') as ElementBindingState;
    const mappings = createSignalBindingPersistence(viewer, target).read();

    tooltipStore.show({
      id: HOVER_ID,
      lifecycle: 'hover',
      targetPath: hover.nodePath,
      data: buildBadgeTooltipData(
        viewer, mgr, target,
        badge.userData.rvSignalBadgeLabel ?? SIGNAL_BADGE_STATE_LABEL[state],
        mappings,
      ) as TooltipData,
      mode: 'cursor',
      cursorPos: { x: hover.pointer.x, y: hover.pointer.y },
      // Above every component section of the object the badge sits on: the
      // pointer is on the plug, so the plug answers first.
      priority: 50,
    });
    shown.current = true;

    return hide;
  }, [badge, hover?.nodePath, hover?.pointer?.x, hover?.pointer?.y, viewer]);

  return null;
}

tooltipRegistry.registerController({
  types: ['SignalBadge'],
  component: BadgeTooltipController,
});

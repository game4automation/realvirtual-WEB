// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { EventParticipant } from '../../core/sim-event-facade';
import type { SceneButtonManager } from '../../core/engine/rv-scene-button-manager';
import { NodeRegistry } from '../../core/engine/rv-node-registry';

export function sceneButtonsParticipant(manager: SceneButtonManager): EventParticipant & { readonly startPass: false; pulseBlocker(): string | null } {
  return {
    // Only pulse deadlines matter: no start pass, so scenes with idle buttons get no Core.Settle.
    startPass: false,
    readSet: () => [],
    settle(now) {
      let changed = false;
      for (const member of manager.members()) if (member.releasePulse?.(now)) changed = true;
      return changed;
    },
    dueTime(now) {
      let earliest = Infinity;
      for (const member of manager.members()) {
        const due = member.pulseDeadline?.(now);
        if (due != null) earliest = Math.min(earliest, due);
      }
      return earliest === Infinity ? null : earliest;
    },
    pulseBlocker() {
      if (!manager.eventClock) return null;
      const now = manager.eventClock.now;
      const running = [...manager.members()].filter(m => m.pulseDeadline?.(now) != null);
      return running.length ? running.map(m =>
        `scene button pulse running: ${m.node ? NodeRegistry.computeNodePath(m.node) : undefined}`).join('; ') : null;
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ConnectPlugin } from '../src/plugins/connect-plugin';

describe('ConnectPlugin', () => {
  it('should have correct id', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.id).toBe('connect');
  });

  it('should register an activity-bar slot', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.slots).toBeDefined();
    // CONNECT opens a left-docked window, so its button lives in the left
    // ACTIVITY BAR (activity-bar slot) — see ActivityBar.tsx. Earlier revisions
    // used 'toolbar-button' (TopBar) and 'button-group'.
    const bar = plugin.slots.filter((s) => s.slot === 'activity-bar');
    expect(bar).toHaveLength(1);
    expect(bar[0].order).toBe(60);
    expect(typeof bar[0].component).toBe('function');
  });

  it('registers the two plan-562 notices in the overlay slot', () => {
    const plugin = new ConnectPlugin();
    // Both sit OVER the 3D view, because that is where the operator is when a
    // PLC silently drops his inputs or stops sending outputs. Each carries a
    // visibility id (and no rule) so a deploy can switch it off without a code
    // change, and renders nothing until the gateway actually reports the fault.
    const overlays = plugin.slots.filter((s) => s.slot === 'overlay');
    expect(overlays.map((s) => s.visibilityId)).toEqual([
      'connect-write-gate-notice',
      'connect-no-data-notice',
    ]);
    for (const overlay of overlays) {
      expect(typeof overlay.component).toBe('function');
      expect(overlay.visibilityRule).toBeUndefined();
    }
  });

  it('should have order 55 for plugin priority', () => {
    const plugin = new ConnectPlugin();
    expect(plugin.order).toBe(55);
  });
});

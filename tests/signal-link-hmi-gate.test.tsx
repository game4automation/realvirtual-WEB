// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Thomas, 2026-10-24: "Im HMI-Modus hat Signal-Linking nichts zu suchen."
 *
 * Pins the central gate (signal-link-gate.ts) and its surfaces: the inspector
 * slot rows and the "Link signal…" context entry are absent in the operator
 * workspaces (hmi, viewer) and present in commissioning — and a live mode
 * switch flips the inspector without a remount.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ComponentSignalSlots } from '../src/plugins/signal-bind/InlineSignalSlots';
import {
  SIGNAL_LINK_MODES,
  isSignalLinkingAllowed,
  isSignalLinkingAllowedInMode,
} from '../src/plugins/signal-bind/signal-link-gate';
import { signalBindContextMenuItems } from '../src/plugins/signal-bind/plc-signal-context-menu';
import type { RVViewer } from '../src/core/rv-viewer';
import { makeInlineSlotFixture } from './_inline-slot-fixture';

afterEach(cleanup);

/** A minimal ModeManager surface: activeMode + subscribe/getSnapshot. */
function makeModes(initial: string | null) {
  const listeners = new Set<() => void>();
  let version = 0;
  const modes = {
    activeMode: initial,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: () => version,
    set(mode: string | null) {
      modes.activeMode = mode;
      version++;
      for (const l of listeners) l();
    },
  };
  return modes;
}

function renderSlots(mode: string | null) {
  const f = makeInlineSlotFixture({ withManager: false });
  const modes = makeModes(mode);
  (f.viewer as unknown as { modes: unknown }).modes = modes;
  const view = render(<ComponentSignalSlots
    viewer={f.viewer}
    signalStore={f.store}
    nodePath={f.nodePath}
    componentType="Drive_Simple"
    data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
  />);
  return { ...view, modes, f };
}

describe('signal-link gate — the mode decision', () => {
  it('offers linking in the engineering modes only', () => {
    for (const m of ['commissioning', 'editor', 'planner', 'des']) {
      expect(isSignalLinkingAllowedInMode(m), m).toBe(true);
    }
    expect(isSignalLinkingAllowedInMode('hmi')).toBe(false);
    expect(isSignalLinkingAllowedInMode('viewer')).toBe(false);
    expect(SIGNAL_LINK_MODES).not.toContain('hmi');
  });

  it('does not restrict before a mode is chosen or without a mode system', () => {
    expect(isSignalLinkingAllowedInMode(null)).toBe(true);
    expect(isSignalLinkingAllowed({})).toBe(true);
    expect(isSignalLinkingAllowed(null)).toBe(true);
  });
});

describe('signal-link gate — inspector slot rows', () => {
  it('renders no slot rows in HMI', () => {
    const { container } = renderSlots('hmi');
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('slot-row-.-mapped-signal-Forward')).toBeNull();
  });

  it('renders the slot rows in commissioning', () => {
    renderSlots('commissioning');
    expect(screen.getByTestId('slot-row-.-mapped-signal-Forward').textContent).toContain('Axis.Forward');
  });

  it('follows a live mode switch', () => {
    const { modes } = renderSlots('commissioning');
    expect(screen.queryByTestId('slot-row-.-mapped-signal-Forward')).not.toBeNull();
    act(() => modes.set('hmi'));
    expect(screen.queryByTestId('slot-row-.-mapped-signal-Forward')).toBeNull();
    act(() => modes.set('commissioning'));
    expect(screen.queryByTestId('slot-row-.-mapped-signal-Forward')).not.toBeNull();
  });
});

describe('signal-link gate — "Link signal…" context entry', () => {
  it('is refused in HMI before any target resolution', () => {
    const viewer = { modes: makeModes('hmi') } as unknown as RVViewer;
    const [item] = signalBindContextMenuItems(viewer);
    // No registry on this stub: reaching the resolver would throw — the gate
    // must answer first.
    expect(item.condition!({ node: {} } as never)).toBe(false);
  });
});

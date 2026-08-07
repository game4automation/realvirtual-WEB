// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.10 — the core promise: the 3D badge popover and the inline
 * inspector rows show IDENTICAL slot sets and IDENTICAL states for the same
 * element, because both derive their rows from the SHARED buildSlotRowModels
 * (same resolver, same mapping match, same authority/liveness derivation).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SignalBindPopover } from '../src/plugins/signal-bind/SignalBindPopover';
import { ComponentSignalSlots } from '../src/plugins/signal-bind/InlineSignalSlots';
import { buildSlotRowModels } from '../src/plugins/signal-bind/slot-row-models';
import { makeInlineSlotFixture } from './_inline-slot-fixture';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(cleanup);

const MAPPINGS: SignalMapping[] = [{
  kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
  sourceKind: 'internal', signal: 'ModelSig', direction: 'plcOutput', enabled: true,
}];

function slotRowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="slot-row-"]')]
    .map((el) => el.getAttribute('data-testid')!)
    .sort();
}

/**
 * The rendered status state of every slot, as `<testid>=<level>`.
 *
 * Keyed on the status LEVEL rather than the label: since plan-341 §2.8 c (user
 * decision 30.07.2026) a plainly live binding renders NO status token at all —
 * the row's own chips already show the live value, so the word would only
 * restate them. Comparing the levels keeps the §9.10 promise ("identical
 * states") verifiable across both surfaces including the case where the design
 * deliberately shows nothing, which asserting the literal 'live' label did not.
 */
function slotStatusStates(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-rv-status-level]')]
    .map((el) => `${el.getAttribute('data-testid')}=${el.getAttribute('data-rv-status-level')}`)
    .sort();
}

describe('popover ⇄ inline consistency (plan-325 9.10)', () => {
  it('both surfaces render identical slot sets and states from the shared row models', () => {
    const f = makeInlineSlotFixture();
    // Bind one slot so states (mapping + liveness) are part of the comparison.
    const applied = f.mgr.applyMappings(f.nodePath, f.node, MAPPINGS);
    f.node.userData.realvirtual.SignalLinks = { Mappings: applied };
    f.mgr.tick(0.02);

    const rows = buildSlotRowModels(f.viewer, f.mgr, f.nodePath, f.node, applied);

    // Popover surface (rows fed exactly as the connected wrapper does).
    const popover = render(<SignalBindPopover
      label="Axis" slots={rows} signals={[]} state={f.mgr.getElementState(f.nodePath)}
      onBind={() => {}} onUnbind={() => {}} onClose={() => {}}
    />);
    const popoverIds = slotRowIds(popover.container);
    const popoverLive = slotStatusStates(popover.container);
    popover.unmount();

    // Inline surface (builds its rows through the SAME shared builder).
    const inline = render(<ComponentSignalSlots
      viewer={f.viewer}
      signalStore={f.store}
      nodePath={f.nodePath}
      componentType="Drive_Simple"
      data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
    />);
    const inlineIds = slotRowIds(inline.container);
    const inlineLive = slotStatusStates(inline.container);

    expect(inlineIds).toEqual(popoverIds);
    expect(inlineIds.length).toBeGreaterThan(0);
    expect(inlineLive).toEqual(popoverLive);
    // The bound slot is plainly live, which under plan-341 §2.8 c is exactly the
    // state that shows no token. Pinning that here keeps the assertion honest:
    // should a token reappear for a live binding, both surfaces must gain it
    // together — and this line is where that design change gets acknowledged.
    expect(popoverLive).toEqual([]);
  });
});

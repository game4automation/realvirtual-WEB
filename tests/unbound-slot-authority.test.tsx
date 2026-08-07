// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-320 Phase 5 follow-up — write authority on slots WITHOUT an active
 * binding.
 *
 * A SlotId, its claim entry and its slot↔channel index entry only exist while a
 * binding is live, so the claim registry and `canWriteSlot()` cannot answer for
 * an unbound slot. Authority was therefore shown on bound slots only — and an
 * operator force, which needs no binding at all, stayed invisible on every
 * other slot. The shared row builder now derives the unbound case from raw
 * state via the pure `deriveSlotAuthority()`.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildSlotRowModels } from '../src/plugins/signal-bind/slot-row-models';
import { ComponentSignalSlots } from '../src/plugins/signal-bind/InlineSignalSlots';
import {
  resetSlotAuthority,
  setRemoteOwnershipActive,
} from '../src/core/engine/rv-slot-authority';
import { makeInlineSlotFixture } from './_inline-slot-fixture';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => {
  cleanup();
  resetSlotAuthority();
});

/** The GLB-wired Forward slot: an assignment (`Axis.Forward`), but no binding. */
function forwardRow(f: ReturnType<typeof makeInlineSlotFixture>, mappings: SignalMapping[] = []) {
  return buildSlotRowModels(f.viewer, f.mgr, f.nodePath, f.node, mappings)
    .find((r) => r.slot === 'Forward');
}

function renderInline(f: ReturnType<typeof makeInlineSlotFixture>) {
  return render(<ComponentSignalSlots
    viewer={f.viewer}
    signalStore={f.store}
    nodePath={f.nodePath}
    componentType="Drive_Simple"
    data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
  />);
}

describe('unbound slot authority (plan-320 Phase 5)', () => {
  it('reports the claimless default on an unbound slot that carries an assignment', () => {
    const f = makeInlineSlotFixture();
    const row = forwardRow(f);
    // No binding claimed this slot — the component stands in for the missing PLC.
    expect(row?.authority).toBe('component');
    expect(row?.authorityReason).toBe('ok');
  });

  it('surfaces an operator force on an unbound slot (a force needs no binding)', () => {
    const f = makeInlineSlotFixture();
    f.store.forceSignal('Axis.Forward', true);

    const row = forwardRow(f);
    expect(row?.authority).toBe('forced');
    // Same vocabulary canWriteSlot() uses for a local-simulation writer.
    expect(row?.authorityReason).toBe('authority-forced');
  });

  it('stays silent on an unbound slot without any assignment', () => {
    const f = makeInlineSlotFixture();
    // Backward is a direct command sink: no model signal, no mapping. A bare
    // "component" there would only restate "– not linked".
    const backward = buildSlotRowModels(f.viewer, f.mgr, f.nodePath, f.node, [])
      .find((r) => r.slot === 'Backward');
    expect(backward).toBeDefined();
    expect(backward?.targetName).toBeUndefined();
    expect(backward?.authority).toBeUndefined();
  });

  it('keeps the claim path authoritative once a binding is live', () => {
    const f = makeInlineSlotFixture();
    const applied = f.mgr.applyMappings(f.nodePath, f.node, [{
      kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
      sourceKind: 'internal', signal: 'ModelSig', direction: 'plcOutput', enabled: true,
    }]);
    f.mgr.tick(0.02);

    expect(forwardRow(f, applied)?.authority).toBe('bound');
  });

  it('carries the remote-ownership layer onto unbound rows', () => {
    const f = makeInlineSlotFixture();
    setRemoteOwnershipActive(true);

    const row = forwardRow(f);
    expect(row?.authority).toBe('component');
    expect(row?.remoteOwned).toBe(true);
  });

  // The row marker is the plan-341 §2.8 (c) STATUS token (`slot-status-<slot>`,
  // which merged the former `slot-liveness-*`/`slot-authority-*` pair). The
  // assertion below is unchanged in substance: a force on an UNBOUND inline row
  // must be visible, because it holds incoming writes off regardless of any
  // binding — see status-token-matrix.test.tsx for the level split.
  it('renders the force label on the inline row of an unbound slot', () => {
    const f = makeInlineSlotFixture();
    f.store.forceSignal('Axis.Forward', true);

    renderInline(f);
    const token = screen.getByTestId('slot-status-Forward');
    expect(token.textContent).toBe('forced');
    expect(token.getAttribute('data-rv-status-level')).toBe('3');
  });

  it('renders no authority label on an unassigned inline row', () => {
    const f = makeInlineSlotFixture();

    renderInline(f);
    expect(screen.queryByTestId('slot-status-Backward')).toBeNull();
  });
});

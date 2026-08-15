// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-comment-display — Unity's `Signal.Comment` reaches the surfaces that
 * should show it (plan-425 F1, test 9.1).
 *
 * The plan review corrected the premise this feature started from. "The comment
 * is nowhere in the web viewer" was wrong: the exporter has always written the
 * field generically, `registerSignal()` has always indexed it on the store, and
 * both the badge tooltip and the signal picker have always read it back. Only
 * ONE surface dropped it — the Inspector's signal card.
 *
 * So the tests come in two parts, and the first part is the more important one.
 *
 * Part 1 is a BASELINE: it pins, per surface, what the comment pipeline already
 * does. Its job is not to catch a regression in the new code but to stop the
 * new code from being written at all where it is not needed — a second
 * comment pipeline reading `userData.realvirtual` directly would pass every
 * part-2 assertion below while quietly being free to disagree with the store on
 * every one of these.
 *
 * Part 2 is the actual gap: the Inspector card now renders the comment, takes
 * it from the same store metadata as everyone else, and renders no row at all
 * when there is none.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Object3D } from 'three';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import { collectInternalSignals } from '../src/plugins/signal-bind/slot-row-models';

afterEach(() => cleanup());

const COMMENT = 'Conveyor motor run command from the line PLC';

/** A store carrying one signal registered exactly the way the loader does it. */
function storeWithSignal(name: string, comment?: string) {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = name;
  registerSignal(
    node,
    'PLCOutputBool',
    { Name: name, Status: { Value: false }, ...(comment ? { Comment: comment } : {}) },
    `Cell/Signals/${name}`,
    store,
    registry,
  );
  return store;
}

function renderSignalCard(store: SignalStore | null, name: string) {
  return render(
    <ComponentSection
      nodePath={`Cell/Signals/${name}`}
      componentType="PLCOutputBool"
      data={{ Name: name, Status: { Value: false } }}
      overriddenFields={new Set()}
      consumedOnly={false}
      signalValue="false"
      onFieldEdit={() => {}}
      onFieldReset={() => {}}
      onResetComponent={() => {}}
      viewer={null}
      signalStore={store}
    />,
  );
}

// ── Part 1: baseline — what the comment pipeline ALREADY does ─────────────

describe('signal comment baseline (pre-existing pipeline)', () => {
  it('registerSignal indexes the rv_extras Comment on the store', () => {
    // This is the SSOT. Everything below reads it; nothing may re-derive it.
    const store = storeWithSignal('Motor.Run', COMMENT);
    expect(store.getSignalMeta('Motor.Run')?.comment).toBe(COMMENT);
  });

  it('a signal without a Comment gets no comment metadata (not an empty string)', () => {
    const store = storeWithSignal('Motor.Stop');
    expect(store.getSignalMeta('Motor.Stop')?.comment).toBeUndefined();
  });

  it('the picker source list already carries the comment as its subtitle', () => {
    const store = storeWithSignal('Motor.Run', COMMENT);
    const picked = collectInternalSignals(store).find((s) => s.name === 'Motor.Run');
    expect(picked?.comment).toBe(COMMENT);
  });
});

// ── Part 2: the one surface that dropped it ───────────────────────────────

describe('Inspector signal card', () => {
  it('shows the comment of the signal it is describing', () => {
    renderSignalCard(storeWithSignal('Motor.Run', COMMENT), 'Motor.Run');
    expect(screen.getByText('Comment')).toBeTruthy();
    expect(screen.getByText(COMMENT)).toBeTruthy();
  });

  it('renders NO comment row when the signal has none — no empty line', () => {
    renderSignalCard(storeWithSignal('Motor.Stop'), 'Motor.Stop');
    expect(screen.queryByText('Comment')).toBeNull();
    // The card itself still renders — this is a missing row, not a missing card.
    expect(screen.getByText('Symbol')).toBeTruthy();
  });

  it('reads the STORE, not the node extras — no second pipeline', () => {
    // The card is handed a store that knows nothing about this signal while the
    // component data would happily supply a `Comment` of its own. A surface that
    // grew its own extras reader would print it; this one must stay silent,
    // because a second reader is a second thing that can disagree with the
    // tooltip and the picker.
    render(
      <ComponentSection
        nodePath="Cell/Signals/Motor.Run"
        componentType="PLCOutputBool"
        data={{ Name: 'Motor.Run', Status: { Value: false }, Comment: 'extras-only text' }}
        overriddenFields={new Set()}
        consumedOnly={false}
        signalValue="false"
        onFieldEdit={() => {}}
        onFieldReset={() => {}}
        onResetComponent={() => {}}
        viewer={null}
        signalStore={new SignalStore()}
      />,
    );
    expect(screen.queryByText('extras-only text')).toBeNull();
  });

  it('survives a card rendered without any store at all', () => {
    renderSignalCard(null, 'Motor.Run');
    expect(screen.queryByText('Comment')).toBeNull();
  });
});

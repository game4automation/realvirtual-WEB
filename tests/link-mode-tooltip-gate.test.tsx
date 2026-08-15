// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * link-mode-tooltip-gate — while signal linking is on, the generic object
 * tooltips stand down (plan-425 F9, test 9.10).
 *
 * Signal linking is an EXCLUSIVE mode: the user is dragging a plug and the only
 * question they are asking is about the socket under the cursor. Every other
 * card the tooltip system would produce — the drive card, the metadata card,
 * the PDF stack — is answering a question nobody asked, over the top of the
 * drop target they are aiming at.
 *
 * The decision that shapes this test is that the suppression is ONE gate at the
 * controller, not a flag threaded through each tooltip provider. So the
 * assertions are about what the controller PUBLISHES, not about what any
 * individual provider renders: a provider-by-provider fix would satisfy a
 * rendering assertion while leaving the next provider someone adds unguarded.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
import { cleanup, render } from '@testing-library/react';
// Side effect: registers the Drive component's `tooltipType: 'drive'`
// capability, without which the controller has nothing to suppress.
import '../src/core/engine/rv-drive';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import {
  _resetSignalLinkModeStoreForTests,
  setSignalLinkModeExplicit,
} from '../src/plugins/signal-bind/signal-link-mode-store';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

const NODE = new Object3D();
NODE.name = 'Conveyor';
NODE.userData.realvirtual = { Drive: { Speed: 100 } };

// The hover feed is mocked because the controller's INPUT is not what is under
// test — its output is. Focus and selection stay empty so the only thing that
// could produce a card is the hover path.
vi.mock('../src/hooks/use-hover', () => ({
  useHoveredObject: () => ({
    node: NODE,
    nodePath: 'Cell/Conveyor',
    pointer: { x: 10, y: 20 },
  }),
}));
vi.mock('../src/hooks/use-drives', () => ({ useFocusedDrive: () => ({ drive: null, node: null }) }));
vi.mock('../src/hooks/use-selection', () => ({ useSelection: () => ({ selectedPaths: [] }) }));

const { GenericTooltipController } = await import(
  '../src/core/hmi/tooltip/GenericTooltipController');

const viewer = {
  registry: { getNode: () => NODE, getPathForNode: () => 'Cell/Conveyor' },
  selectionManager: { lastHitPoint: null },
} as unknown as RVViewer;

function renderController() {
  return render(
    <RVViewerProvider value={viewer}>
      <GenericTooltipController />
    </RVViewerProvider>,
  );
}

/** Ids the controller currently has on screen, across all bubbles. */
function shownIds(): string[] {
  return tooltipStore.getSnapshot().visible
    .flatMap((bubble) => bubble.contentEntries.map((entry) => entry.id));
}

beforeEach(() => {
  localStorage.clear();
  _resetSignalLinkModeStoreForTests();
  // A resolver for the hovered node's component, so there is genuinely
  // something for the controller to suppress.
  tooltipRegistry.registerDataResolver('drive', () => ({ type: 'drive', driveName: 'Conveyor' }));
});

afterEach(() => {
  cleanup();
  setSignalLinkModeExplicit(false);
  for (const id of shownIds()) tooltipStore.hide(id);
});

describe('generic tooltips under signal-link mode', () => {
  it('shows the object card normally', () => {
    renderController();
    expect(shownIds().some((id) => id.startsWith('tooltip-hover:'))).toBe(true);
  });

  it('shows NOTHING while link mode is on', () => {
    setSignalLinkModeExplicit(true);
    renderController();
    expect(shownIds().filter((id) => id.startsWith('tooltip-hover:'))).toEqual([]);
  });

  it('takes an already-visible card DOWN when link mode turns on', () => {
    // Entering the mode with a card on screen is the common case — the user
    // hovers a machine, then starts dragging a signal.
    const view = renderController();
    expect(shownIds().some((id) => id.startsWith('tooltip-hover:'))).toBe(true);

    setSignalLinkModeExplicit(true);
    view.rerender(
      <RVViewerProvider value={viewer}>
        <GenericTooltipController />
      </RVViewerProvider>,
    );
    expect(shownIds().filter((id) => id.startsWith('tooltip-hover:'))).toEqual([]);
  });

  it('restores normal behaviour when the mode is left', () => {
    setSignalLinkModeExplicit(true);
    const view = renderController();
    expect(shownIds().filter((id) => id.startsWith('tooltip-hover:'))).toEqual([]);

    setSignalLinkModeExplicit(false);
    view.rerender(
      <RVViewerProvider value={viewer}>
        <GenericTooltipController />
      </RVViewerProvider>,
    );
    expect(shownIds().some((id) => id.startsWith('tooltip-hover:'))).toBe(true);
  });

  it('gates at the CONTROLLER — no resolver is consulted at all', () => {
    // The structural half of the decision. A per-provider suppression would
    // still call this and throw away the answer; one gate never asks.
    let consulted = 0;
    tooltipRegistry.registerDataResolver('drive', () => {
      consulted++;
      return { type: 'drive', driveName: 'Conveyor' };
    });
    setSignalLinkModeExplicit(true);
    renderController();
    expect(consulted).toBe(0);
  });
});

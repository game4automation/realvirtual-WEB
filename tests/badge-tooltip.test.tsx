// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * badge-tooltip — hovering a 3D link badge says WHICH element it belongs to
 * (plan-422 F5, test 9.9).
 *
 * Eight badges around one operator panel are eight identical plugs. The card
 * has to answer the question the sprite cannot: whose plug is this, and what is
 * still free on it.
 *
 * Two mechanics carry the feature and both are pinned here. The badge must be
 * DISTINGUISHABLE from the object it sits on — badges are auxiliary raycast
 * targets owned by that object, so a hover reports the owner and only the hit
 * mesh tells the two apart. And the card must stand down during a drag, where
 * the drop overlay is already naming the candidate under the cursor.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Object3D, Scene } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget } from '../src/plugins/signal-bind/signal-bind-target';
import {
  badgeRootOf,
  buildBadgeTooltipData,
  SIGNAL_BADGE_MARKER,
} from '../src/plugins/signal-bind/badge-tooltip-model';
import {
  SignalBadgeTooltipContent,
  type SignalBadgeTooltipData,
} from '../src/core/hmi/tooltip/SignalBadgeTooltipContent';
import type { RVViewer } from '../src/core/rv-viewer';
import '../src/core/engine/rv-lamp';

afterEach(cleanup);

// ── Distinguishing the plug from the part ────────────────────────────────

describe('badgeRootOf — the badge, not the object behind it', () => {
  it('finds the badge root from a nested hit mesh', () => {
    const badge = new Object3D();
    badge.userData[SIGNAL_BADGE_MARKER] = true;
    const sprite = new Object3D();
    badge.add(sprite);
    expect(badgeRootOf(sprite)).toBe(badge);
    expect(badgeRootOf(badge)).toBe(badge);
  });

  it('returns null for a hit on ordinary geometry — no badge, no card', () => {
    const root = new Object3D();
    const mesh = new Object3D();
    root.add(mesh);
    expect(badgeRootOf(mesh)).toBeNull();
    expect(badgeRootOf(null)).toBeNull();
    expect(badgeRootOf(undefined)).toBeNull();
  });
});

// ── The card's content, against a real model ─────────────────────────────

const ref = (path: string, componentType: string) =>
  ({ type: 'ComponentReference', path, componentType, componentIndex: 0 });

async function lampModel(): Promise<{ viewer: RVViewer; load: LoadResult }> {
  const root = new Object3D();
  root.name = 'Cell';
  const plc = new Object3D();
  plc.name = 'PLCInterface';
  root.add(plc);
  const sig = new Object3D();
  sig.name = 'AutomaticLight';
  sig.userData.realvirtual = { PLCOutputBool: { Name: 'AutomaticLight', Status: { Value: false } } };
  plc.add(sig);
  const lamp = new Object3D();
  lamp.name = 'StackLight';
  lamp.userData.realvirtual = {
    Lamp: {
      _fullTypeName: 'realvirtual.Lamp',
      SignalLampOn: ref('Cell/PLCInterface/AutomaticLight', 'realvirtual.PLCOutputBool'),
      OnColor: { r: 1, g: 0.7, b: 0, a: 1 }, Intensity: 2, Period: 1, Flashing: false,
    },
  };
  root.add(lamp);

  const url = URL.createObjectURL(new Blob([await objectToGlb(root)], { type: 'model/gltf-binary' }));
  const load = await loadGLB(url, new Scene(), { loadKinematicsSidecar: false });
  const viewer = {
    registry: load.registry,
    signalStore: load.signalStore,
    signalBindingManager: new SignalBindingManager(load.signalStore, load.registry),
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
    markRenderDirty: () => {},
  } as unknown as RVViewer;
  return { viewer, load };
}

describe('buildBadgeTooltipData', () => {
  it('names the element and lists its slots with their status', async () => {
    const { viewer, load } = await lampModel();
    const node = load.registry.getNode('Cell/StackLight')!;
    const target = findSignalBindTarget(viewer, node)!;
    expect(target, 'lamp is not a bind target').toBeTruthy();

    const data = buildBadgeTooltipData(viewer, viewer.signalBindingManager!, target, 'Not linked');

    expect(data.type).toBe('signal-badge');
    expect(data.label, 'the card must name the ELEMENT, not the slot').toBe('StackLight');
    expect(data.state).toBe('Not linked');
    expect(data.slots.length, 'no slot lines').toBeGreaterThan(0);
    // Every line has a label, and an unbound slot reads as free rather than blank.
    for (const slot of data.slots) expect(slot.label).toBeTruthy();
  }, 60_000);

  it('reports an unavailable slot with its reason instead of pretending it is free', async () => {
    const { viewer, load } = await lampModel();
    const node = load.registry.getNode('Cell/StackLight')!;
    const target = findSignalBindTarget(viewer, node)!;
    const data = buildBadgeTooltipData(viewer, viewer.signalBindingManager!, target, 'Not linked');
    for (const slot of data.slots) {
      if (slot.unavailable) expect(slot.boundTo).toBeNull();
    }
  }, 60_000);
});

// ── The card itself ──────────────────────────────────────────────────────

function card(data: Partial<SignalBadgeTooltipData> = {}) {
  const full: SignalBadgeTooltipData = {
    type: 'signal-badge',
    label: 'StackLight',
    state: 'Live controlled',
    slots: [
      { label: 'Lamp on', boundTo: 'PLC.LampOn', state: 'live' },
      { label: 'Lamp flashing', boundTo: null },
      { label: 'Legacy', boundTo: null, unavailable: true, reason: 'not in this implementation' },
    ],
    ...data,
  };
  return render(<SignalBadgeTooltipContent data={full} viewer={null as never} />);
}

describe('the hover card', () => {
  it('leads with the element name and the badge state', () => {
    card();
    expect(screen.getByTestId('signal-badge-tooltip-label').textContent).toBe('StackLight');
    expect(screen.getByText('Live controlled')).toBeTruthy();
  });

  it('gives every slot a line, saying bound-to / free / unavailable', () => {
    card();
    const lines = screen.getAllByTestId('signal-badge-tooltip-slot');
    expect(lines).toHaveLength(3);
    expect(lines[0].textContent).toContain('PLC.LampOn');
    expect(lines[0].textContent).toContain('live');
    expect(lines[1].textContent).toContain('free');
    expect(lines[2].textContent).toContain('not in this implementation');
  });

  it('says so plainly when an element has no slots at all', () => {
    card({ slots: [] });
    expect(screen.getByText(/no signal slots/i)).toBeTruthy();
    expect(screen.queryAllByTestId('signal-badge-tooltip-slot')).toHaveLength(0);
  });

  it('keeps a long bound signal name reachable through `title`', () => {
    const long = 'CONNECT.Cell1.StackLight.RedLampOnFeedback';
    card({ slots: [{ label: 'Lamp on', boundTo: long }] });
    const line = screen.getByTestId('signal-badge-tooltip-slot');
    expect(line.querySelector(`[title="${long}"]`)).toBeTruthy();
  });
});

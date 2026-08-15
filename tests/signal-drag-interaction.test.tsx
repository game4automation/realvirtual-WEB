// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drag-interaction.test.tsx — plan-246 F4/F8/F9 end-to-end interaction wiring.
 *
 * Mounts the REAL SignalBadge and drives the full gesture with real DOM pointer
 * events (React onPointerDown on the chip → window-capture pointermove/pointerup
 * in the drag store → drop-target registry hit-test):
 *   Shift+pointerdown on the chip → move past threshold → pointerup over a
 *   registered drop target → onDrop receives the full payload.
 * Also covers the Shift+Click guard (no movement → no drag, click suppressed)
 * and the rect-union fallback (drop in the gap BETWEEN two cells of one target,
 * e.g. the display:contents slot rows of the SignalBindPopover).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { SignalBadge } from '../src/core/hmi/rv-signal-badge';
import {
  getSignalDragPhase,
  cancelSignalDrag,
  consumeSignalDragClick,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import { createSignalDropTarget } from '../src/core/hmi/signal-drop-target';

function makeZone(left: number, top: number, w: number, h: number): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${w}px;height:${h}px;z-index:99999;background:rgba(0,0,0,0.01)`;
  document.body.appendChild(el);
  return el;
}

function winPointer(type: 'pointermove' | 'pointerup', x: number, y: number): void {
  window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

afterEach(() => {
  cancelSignalDrag();
  consumeSignalDragClick();
  cleanup();
});

describe('SignalBadge — Shift+Drag interaction wiring (real DOM events)', () => {
  it('drags from a chip and drops onto a registered target with the full payload', () => {
    const { container } = render(
      <SignalBadge
        direction="output"
        plcType="PLCOutputBool"
        raw={true}
        signalName="MC07_Start"
        address="%Q0.1"
        comment="Start conveyor"
      />,
    );
    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    expect(chip).toBeTruthy();

    const zone = makeZone(10, 10, 120, 60);
    const dropped: SignalDragPayload[] = [];
    const handle = createSignalDropTarget({ accepts: () => true, onDrop: (p) => dropped.push(p) });
    handle.attach(zone);
    try {
      // Shift+pointerdown on the chip (React handler) → armed.
      fireEvent.pointerDown(chip, { shiftKey: true, button: 0, clientX: 300, clientY: 300 });
      expect(getSignalDragPhase()).toBe('armed');

      // Window-level pointermove (store capture listener) past the threshold → dragging.
      winPointer('pointermove', 280, 280);
      expect(getSignalDragPhase()).toBe('dragging');

      // Move over the zone, release → drop.
      winPointer('pointermove', 50, 30);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('valid');
      winPointer('pointerup', 50, 30);

      expect(getSignalDragPhase()).toBe('idle');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        name: 'MC07_Start',
        direction: 'output',
        plcType: 'PLCOutputBool',
        address: '%Q0.1',
        comment: 'Start conveyor',
      });
    } finally {
      handle.dispose();
      zone.remove();
    }
  });

  it('Shift+Click on a chip (no movement) neither drags nor leaves the machine armed', () => {
    const { container } = render(
      <SignalBadge direction="input" plcType="PLCInputBool" raw={false} signalName="MC07_Occupied" />,
    );
    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    fireEvent.pointerDown(chip, { shiftKey: true, button: 0, clientX: 200, clientY: 200 });
    expect(getSignalDragPhase()).toBe('armed');
    winPointer('pointerup', 201, 200); // < 4 px
    expect(getSignalDragPhase()).toBe('idle');
    // The trailing click is suppressed → never forces (F4).
    expect(consumeSignalDragClick()).toBe(true);
  });

  /**
   * plan-422 F6 replaced the contract this used to pin ("without Shift, never
   * a drag"). Requiring Shift made the gesture undiscoverable, and it was never
   * needed: the machine already separates a press from a drag by MOVEMENT, so a
   * plain press can arm and the release decides.
   *
   * The property that had to survive is the force click, and that is what is
   * asserted here — a plain press arms, and letting go without moving leaves
   * the click alone so the chip forces exactly as before.
   */
  it('pointerdown WITHOUT Shift arms too, and a release under the threshold still clicks', () => {
    const { container } = render(
      <SignalBadge direction="output" plcType="PLCOutputBool" raw={true} signalName="MC07_Start" />,
    );
    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    fireEvent.pointerDown(chip, { shiftKey: false, button: 0, clientX: 200, clientY: 200 });
    expect(getSignalDragPhase()).toBe('armed');
    winPointer('pointerup', 201, 200); // < 4 px
    expect(getSignalDragPhase()).toBe('idle');
    // NOT suppressed — unlike the Shift path, this click is the force gesture.
    expect(consumeSignalDragClick()).toBe(false);
  });

  it('rect-union fallback: drop lands in the GAP between two cells of one target (slot-row case)', () => {
    // Two cells with a horizontal gap — like the internal-chip and mapped-chip
    // cells of one display:contents BindRow. The drop happens in the gap.
    const left = makeZone(10, 10, 60, 24);
    const right = makeZone(130, 10, 60, 24);
    const dropped: string[] = [];
    const handle = createSignalDropTarget({ accepts: () => true, onDrop: (p) => dropped.push(p.name) });
    handle.attach(left);
    handle.attach(right);

    const { container } = render(
      <SignalBadge direction="output" plcType="PLCOutputBool" raw={true} signalName="Turntable_Start" />,
    );
    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    try {
      fireEvent.pointerDown(chip, { shiftKey: true, button: 0, clientX: 300, clientY: 300 });
      winPointer('pointermove', 100, 22); // in the gap between the two cells
      expect(getSignalDragPhase()).toBe('dragging');
      // Hover feedback marks BOTH cells of the entry.
      expect(left.getAttribute('data-rv-drop-state')).toBe('valid');
      expect(right.getAttribute('data-rv-drop-state')).toBe('valid');
      winPointer('pointerup', 100, 22);
      expect(dropped).toEqual(['Turntable_Start']);
    } finally {
      handle.dispose();
      left.remove();
      right.remove();
    }
  });
});

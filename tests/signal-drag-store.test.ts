// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drag-store.test.ts — plan-246 Phase 3.
 *
 * Drives the drag state machine directly (arm/update/end/cancel) in browser
 * mode and verifies:
 *  - armed → dragging promotion only past the 4 px threshold
 *  - a Shift+Click (armed release without movement) neither forces nor drags
 *    (click suppression flag) — F4
 *  - ESC cancels a drag and suppresses the trailing click
 *  - body drag class / payload / position bookkeeping
 *  - drop-target registry integration: hover feedback attributes, accepted
 *    drop invokes onDrop with the payload, rejected drop cancels — F9/F11
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  armSignalDrag,
  updateSignalDrag,
  endSignalDrag,
  cancelSignalDrag,
  getSignalDragPhase,
  getSignalDragPayload,
  getSignalDragPosition,
  getLastSignalDragResult,
  consumeSignalDragClick,
  SIGNAL_DRAG_THRESHOLD_PX,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import { createSignalDropTarget } from '../src/core/hmi/signal-drop-target';
import {
  armNodeLinkDrag,
  updateNodeLinkDrag,
  cancelNodeLinkDrag,
  NODE_LINK_DRAG_THRESHOLD_PX,
} from '../src/core/hmi/node-link-drag-store';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';

const PAYLOAD: SignalDragPayload = {
  name: 'MC07_Start',
  direction: 'output',
  plcType: 'PLCOutputBool',
  address: '%Q0.1',
  origin: 'connect',
  interfaceId: 'iface-1',
  comment: 'Start conveyor',
  source: 'MQTT · Data_O_1',
};

/** Fixed-position drop zone so document.elementFromPoint resolves it. */
function makeDropZone(left: number, top: number, w = 120, h = 60): HTMLDivElement {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.zIndex = '99999';
  el.style.background = 'rgba(0,0,0,0.01)';
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  cancelSignalDrag();
  consumeSignalDragClick(); // clear any suppression window from a previous test
});

afterEach(() => {
  cancelSignalDrag();
  consumeSignalDragClick();
});

describe('signal-drag-store — state machine', () => {
  it('starts idle and arms on armSignalDrag', () => {
    expect(getSignalDragPhase()).toBe('idle');
    armSignalDrag(PAYLOAD, 100, 100);
    expect(getSignalDragPhase()).toBe('armed');
    expect(getSignalDragPayload()).toEqual(PAYLOAD);
  });

  it('stays armed below the movement threshold', () => {
    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(102, 101); // ~2.2 px < 4 px
    expect(getSignalDragPhase()).toBe('armed');
    expect(document.body.classList.contains('rv-signal-dragging')).toBe(false);
  });

  it('promotes to dragging at/past the threshold and tags the body', () => {
    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(100 + SIGNAL_DRAG_THRESHOLD_PX, 100);
    expect(getSignalDragPhase()).toBe('dragging');
    expect(document.body.classList.contains('rv-signal-dragging')).toBe(true);
    expect(getSignalDragPosition()).toEqual({ x: 100 + SIGNAL_DRAG_THRESHOLD_PX, y: 100 });
    cancelSignalDrag();
    expect(document.body.classList.contains('rv-signal-dragging')).toBe(false);
  });

  it('Shift+Click (armed release without movement) is a suppressed click — no force, no drag', () => {
    armSignalDrag(PAYLOAD, 100, 100);
    const result = endSignalDrag(101, 100);
    expect(result).toBe('click');
    expect(getSignalDragPhase()).toBe('idle');
    // The chip's click handler must consume the suppression and skip forcing (F4).
    expect(consumeSignalDragClick()).toBe(true);
    // One-shot: consumed.
    expect(consumeSignalDragClick()).toBe(false);
  });

  it('ESC-style cancel resets to idle and suppresses the trailing click', () => {
    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(140, 140);
    expect(getSignalDragPhase()).toBe('dragging');
    cancelSignalDrag();
    expect(getSignalDragPhase()).toBe('idle');
    expect(getSignalDragPayload()).toBeNull();
    expect(getLastSignalDragResult()).toBe('cancelled');
    expect(consumeSignalDragClick()).toBe(true);
  });

  it('a drag ending without a target cancels', () => {
    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(300, 300);
    const result = endSignalDrag(300, 300);
    expect(result).toBe('cancelled');
    expect(getLastSignalDragResult()).toBe('cancelled');
  });

  it('no suppression without a preceding drag interaction', () => {
    expect(consumeSignalDragClick()).toBe(false);
  });
});

describe('signal-drag-store — drop-target integration', () => {
  it('drops onto an accepting registered target with the full payload', () => {
    const zone = makeDropZone(10, 10);
    const dropped: SignalDragPayload[] = [];
    const handle = createSignalDropTarget({
      accepts: () => true,
      onDrop: (p) => dropped.push(p),
    });
    const detach = handle.attach(zone);
    try {
      armSignalDrag(PAYLOAD, 300, 300);
      updateSignalDrag(50, 30); // move over the zone (also past threshold)
      // Hover feedback: valid target marked on ALL registered elements.
      expect(zone.getAttribute('data-rv-drop-state')).toBe('valid');
      const result = endSignalDrag(50, 30);
      expect(result).toBe('dropped');
      expect(getLastSignalDragResult()).toBe('dropped');
      expect(dropped).toEqual([PAYLOAD]);
      // Feedback cleared after the drop.
      expect(zone.getAttribute('data-rv-drop-state')).toBeNull();
    } finally {
      detach();
      handle.dispose();
      zone.remove();
    }
  });

  it('rejecting target shows invalid feedback and the drop cancels (onDrop never called)', () => {
    const zone = makeDropZone(10, 10);
    let calls = 0;
    const handle = createSignalDropTarget({
      accepts: () => false,
      onDrop: () => { calls++; },
    });
    handle.attach(zone);
    try {
      armSignalDrag(PAYLOAD, 300, 300);
      updateSignalDrag(50, 30);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('invalid');
      const result = endSignalDrag(50, 30);
      expect(result).toBe('cancelled');
      expect(calls).toBe(0);
      expect(zone.getAttribute('data-rv-drop-state')).toBeNull();
    } finally {
      handle.dispose();
      zone.remove();
    }
  });

  it('leaving the target falls back to the candidate base state, and the drag end clears it', () => {
    // plan-341 §2.4: leaving a hovered row no longer returns to "nothing". A
    // compatible row stays marked as a CANDIDATE for the whole drag — that is
    // the affordance; only the end of the drag clears it.
    const zone = makeDropZone(10, 10);
    const handle = createSignalDropTarget({ accepts: () => true, onDrop: () => {} });
    handle.attach(zone);
    try {
      armSignalDrag(PAYLOAD, 300, 300);
      updateSignalDrag(50, 30);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('valid');
      updateSignalDrag(500, 400); // off the zone
      expect(zone.getAttribute('data-rv-drop-state')).toBe('candidate');
      cancelSignalDrag();
      expect(zone.getAttribute('data-rv-drop-state')).toBeNull();
    } finally {
      handle.dispose();
      zone.remove();
    }
  });

  it('drop resolves through nested children of a registered element (ancestor walk)', () => {
    const zone = makeDropZone(10, 10);
    const child = document.createElement('span');
    child.style.display = 'block';
    child.style.width = '100%';
    child.style.height = '100%';
    zone.appendChild(child);
    const dropped: string[] = [];
    const handle = createSignalDropTarget({
      accepts: () => true,
      onDrop: (p) => dropped.push(p.name),
    });
    handle.attach(zone);
    try {
      armSignalDrag(PAYLOAD, 300, 300);
      updateSignalDrag(50, 30);
      expect(endSignalDrag(50, 30)).toBe('dropped');
      expect(dropped).toEqual(['MC07_Start']);
    } finally {
      handle.dispose();
      zone.remove();
    }
  });

  it('rect fallback: drop just OUTSIDE the cells but within the horizontal row band still hits', () => {
    // Cell rect [10..130]x[10..70]; drop at x=160 (inside +40 px horizontal pad, no element there).
    const zone = makeDropZone(10, 10);
    const dropped: string[] = [];
    const handle = createSignalDropTarget({ accepts: () => true, onDrop: (p) => dropped.push(p.name) });
    handle.attach(zone);
    try {
      armSignalDrag(PAYLOAD, 300, 300);
      updateSignalDrag(160, 40);
      // Hover feedback works through the same fallback.
      expect(zone.getAttribute('data-rv-drop-state')).toBe('valid');
      expect(endSignalDrag(160, 40)).toBe('dropped');
      expect(dropped).toEqual(['MC07_Start']);
    } finally {
      handle.dispose();
      zone.remove();
    }
  });

  it('rect fallback: with two adjacent rows the nearest center wins', () => {
    const rowA = makeDropZone(10, 10, 120, 20);   // band [6..34] (pad 4), center y = 20
    const rowB = makeDropZone(10, 32, 120, 20);   // band [28..56] (pad 4), center y = 42
    const hits: string[] = [];
    const hA = createSignalDropTarget({ accepts: () => true, onDrop: () => hits.push('A') });
    const hB = createSignalDropTarget({ accepts: () => true, onDrop: () => hits.push('B') });
    hA.attach(rowA);
    hB.attach(rowB);
    try {
      // x=160 is right of both rows (fallback region); y=33 lies in BOTH padded
      // bands but is nearer to row B's center (dist 9 vs 13).
      armSignalDrag(PAYLOAD, 300, 300);
      updateSignalDrag(160, 33);
      expect(endSignalDrag(160, 33)).toBe('dropped');
      expect(hits).toEqual(['B']);
    } finally {
      hA.dispose();
      hB.dispose();
      rowA.remove();
      rowB.remove();
    }
  });
});

describe('drag stores — central hover-tooltip suppression', () => {
  afterEach(() => {
    cancelSignalDrag();
    cancelNodeLinkDrag();
    tooltipStore.hideAll();
  });

  it('signal drag hides hover tooltips while dragging, keeps pinned, restores after', () => {
    tooltipStore.show({ id: 'aas-hover', data: { type: 'aas' }, mode: 'cursor', targetPath: '/A' });
    tooltipStore.show({
      id: 'drive-pin', data: { type: 'drive' }, mode: 'fixed',
      lifecycle: 'pinned', targetPath: '/B',
    });
    expect(tooltipStore.getSnapshot().visible).toHaveLength(2);

    armSignalDrag(PAYLOAD, 100, 100);
    // Armed (below threshold) must not suppress yet — a Shift+Click is no drag.
    expect(tooltipStore.getSnapshot().visible).toHaveLength(2);
    updateSignalDrag(100 + SIGNAL_DRAG_THRESHOLD_PX, 100);
    const during = tooltipStore.getSnapshot().visible;
    expect(during).toHaveLength(1);
    expect(during[0].primary.id).toBe('drive-pin');

    cancelSignalDrag();
    expect(tooltipStore.getSnapshot().visible).toHaveLength(2);
  });

  it('node-link drag suppresses hover tooltips the same way', () => {
    tooltipStore.show({ id: 'sensor-hover', data: { type: 'sensor' }, mode: 'cursor', targetPath: '/C' });
    expect(tooltipStore.getSnapshot().visible).toHaveLength(1);

    armNodeLinkDrag({ sourcePath: '/C', linkType: 'StopOnExit' }, 100, 100);
    updateNodeLinkDrag(100 + NODE_LINK_DRAG_THRESHOLD_PX, 100);
    expect(tooltipStore.getSnapshot().visible).toHaveLength(0);

    cancelNodeLinkDrag();
    expect(tooltipStore.getSnapshot().visible).toHaveLength(1);
  });

  it('hover entries keep updating underneath and re-resolve on release', () => {
    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(200, 200);
    // A controller shows a hover DURING the drag (e.g. raycast hover in 3D).
    tooltipStore.show({ id: 'late-hover', data: { type: 'aas' }, mode: 'cursor', targetPath: '/D' });
    expect(tooltipStore.getSnapshot().visible).toHaveLength(0);
    endSignalDrag(200, 200);
    expect(tooltipStore.getSnapshot().visible).toHaveLength(1);
  });
});

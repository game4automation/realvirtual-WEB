// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drag-regression.test.ts — plan-259 §9.12 (regression guard).
 *
 * After generalizing `signal-drop-target.ts` onto the shared
 * `createDropTargetRegistry<T>()`, the plan-246 signal linking must work
 * UNCHANGED: same exports, same drop/hover semantics, same sx hook — and the
 * signal domain must stay fully ISOLATED from the node-link domain.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  armSignalDrag,
  updateSignalDrag,
  endSignalDrag,
  cancelSignalDrag,
  consumeSignalDragClick,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import {
  createSignalDropTarget,
  updateSignalDropHover,
  clearSignalDropHover,
  dropSignalAt,
  SIGNAL_DROP_SX,
} from '../src/core/hmi/signal-drop-target';
import {
  armNodeLinkDrag,
  cancelNodeLinkDrag,
  createNodeLinkDropTarget,
  updateNodeLinkDrag,
  endNodeLinkDrag,
} from '../src/core/hmi/node-link-drag-store';

const PAYLOAD: SignalDragPayload = {
  name: 'MC07_Start',
  direction: 'output',
  plcType: 'PLCOutputBool',
  address: '%Q0.1',
  origin: 'connect',
  interfaceId: 'iface-1',
};

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
  cancelNodeLinkDrag();
  consumeSignalDragClick();
});

afterEach(() => {
  cancelSignalDrag();
  cancelNodeLinkDrag();
  clearSignalDropHover();
});

describe('plan-246 signal linking regression (after drop-target generalization)', () => {
  it('full drag → hover feedback → accepted drop (SignalBindPopover codepath)', () => {
    const zone = makeDropZone(300, 300);
    const dropped: SignalDragPayload[] = [];
    const handle = createSignalDropTarget({
      accepts: (p) => p.direction === 'output',
      onDrop: (p) => dropped.push(p),
    });
    const detach = handle.attach(zone);
    try {
      armSignalDrag(PAYLOAD, 50, 50);
      updateSignalDrag(360, 330);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('valid');
      expect(endSignalDrag(360, 330)).toBe('dropped');
      expect(dropped).toEqual([PAYLOAD]);
    } finally {
      detach();
      handle.dispose();
      zone.remove();
    }
  });

  it('direction-rejecting slot shows invalid and refuses the drop (F11)', () => {
    const zone = makeDropZone(300, 300);
    const handle = createSignalDropTarget({
      accepts: (p) => p.direction === 'input', // slot wants inputs only
      onDrop: () => { throw new Error('must not drop'); },
    });
    const detach = handle.attach(zone);
    try {
      updateSignalDropHover(360, 330, PAYLOAD);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('invalid');
      expect(dropSignalAt(360, 330, PAYLOAD)).toBe(false);
    } finally {
      detach();
      handle.dispose();
      zone.remove();
    }
  });

  it('signal and node-link domains are ISOLATED — a node-link drop never hits a signal slot', () => {
    const zone = makeDropZone(300, 300);
    const signalDrops: unknown[] = [];
    const signalHandle = createSignalDropTarget({
      accepts: () => true,
      onDrop: (p) => signalDrops.push(p),
    });
    const detachSignal = signalHandle.attach(zone);
    try {
      // A NODE-LINK drag dropped over the signal slot: must NOT trigger it.
      armNodeLinkDrag({ sourcePath: 'A', linkType: 'StopOnExit' }, 10, 10);
      updateNodeLinkDrag(360, 330);
      expect(zone.getAttribute('data-rv-drop-state')).toBeNull(); // no cross-domain hover
      expect(endNodeLinkDrag(360, 330)).toBe('cancelled');
      expect(signalDrops).toHaveLength(0);

      // And the other direction: a signal drag ignores node-link targets.
      const nlDrops: unknown[] = [];
      const nlHandle = createNodeLinkDropTarget({ accepts: () => true, onDrop: (p) => nlDrops.push(p) });
      const detachNl = nlHandle.attach(zone);
      // Zone is now BOTH a node-link target and a signal target — the signal
      // drag must land on the signal one only.
      armSignalDrag(PAYLOAD, 10, 10);
      updateSignalDrag(360, 330);
      expect(endSignalDrag(360, 330)).toBe('dropped');
      expect(signalDrops).toHaveLength(1);
      expect(nlDrops).toHaveLength(0);
      detachNl();
      nlHandle.dispose();
    } finally {
      detachSignal();
      signalHandle.dispose();
      zone.remove();
    }
  });

  it('SIGNAL_DROP_SX keeps the plan-246 hover-state selectors', () => {
    expect(SIGNAL_DROP_SX['&[data-rv-drop-state="valid"]']).toBeDefined();
    expect(SIGNAL_DROP_SX['&[data-rv-drop-state="invalid"]']).toBeDefined();
  });
});

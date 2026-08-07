// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * node-link-drag-store.test.ts — plan-259 §9.2.
 *
 * Node-link drag state machine (`idle→armed→dragging→drop/cancel`), threshold
 * promotion, ESC cancel, click suppression, payload bookkeeping, isolated
 * drop-target domain and the 3D drop fallback hook.
 * Template: tests/signal-drag-store.test.ts (plan-246).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  armNodeLinkDrag,
  updateNodeLinkDrag,
  endNodeLinkDrag,
  cancelNodeLinkDrag,
  getNodeLinkDragPhase,
  getNodeLinkDragPayload,
  getNodeLinkDragPosition,
  getLastNodeLinkDragResult,
  consumeNodeLinkDragClick,
  createNodeLinkDropTarget,
  setNodeLinkDropFallback,
  NODE_LINK_DRAG_THRESHOLD_PX,
  type NodeLinkDragPayload,
} from '../src/core/hmi/node-link-drag-store';

const PAYLOAD: NodeLinkDragPayload = { sourcePath: 'Line/Sensor-In', linkType: 'StopOnExit' };

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
  cancelNodeLinkDrag();
  consumeNodeLinkDragClick();
  setNodeLinkDropFallback(null);
});

afterEach(() => {
  cancelNodeLinkDrag();
  consumeNodeLinkDragClick();
  setNodeLinkDropFallback(null);
});

describe('node-link-drag-store — state machine', () => {
  it('starts idle and arms with the payload', () => {
    expect(getNodeLinkDragPhase()).toBe('idle');
    armNodeLinkDrag(PAYLOAD, 100, 100);
    expect(getNodeLinkDragPhase()).toBe('armed');
    expect(getNodeLinkDragPayload()).toEqual(PAYLOAD);
  });

  it('stays armed below the threshold, promotes at/past it', () => {
    armNodeLinkDrag(PAYLOAD, 100, 100);
    updateNodeLinkDrag(102, 101);
    expect(getNodeLinkDragPhase()).toBe('armed');
    updateNodeLinkDrag(100 + NODE_LINK_DRAG_THRESHOLD_PX, 100);
    expect(getNodeLinkDragPhase()).toBe('dragging');
    expect(document.body.classList.contains('rv-node-link-dragging')).toBe(true);
    expect(getNodeLinkDragPosition()).toEqual({ x: 100 + NODE_LINK_DRAG_THRESHOLD_PX, y: 100 });
    cancelNodeLinkDrag();
    expect(document.body.classList.contains('rv-node-link-dragging')).toBe(false);
  });

  it('armed release without movement is a suppressed click', () => {
    armNodeLinkDrag(PAYLOAD, 100, 100);
    expect(endNodeLinkDrag(101, 100)).toBe('click');
    expect(getNodeLinkDragPhase()).toBe('idle');
    expect(consumeNodeLinkDragClick()).toBe(true);
    expect(consumeNodeLinkDragClick()).toBe(false); // one-shot
  });

  it('ESC-style cancel resets and suppresses the trailing click', () => {
    armNodeLinkDrag(PAYLOAD, 100, 100);
    updateNodeLinkDrag(150, 150);
    cancelNodeLinkDrag();
    expect(getNodeLinkDragPhase()).toBe('idle');
    expect(getNodeLinkDragPayload()).toBeNull();
    expect(getLastNodeLinkDragResult()).toBe('cancelled');
    expect(consumeNodeLinkDragClick()).toBe(true);
  });

  it('a drag ending without any target cancels', () => {
    armNodeLinkDrag(PAYLOAD, 100, 100);
    updateNodeLinkDrag(400, 400);
    expect(endNodeLinkDrag(400, 400)).toBe('cancelled');
  });
});

describe('node-link-drag-store — drop targets', () => {
  it('accepted drop invokes onDrop with the payload', () => {
    const zone = makeDropZone(200, 200);
    const dropped: NodeLinkDragPayload[] = [];
    const handle = createNodeLinkDropTarget({
      accepts: () => true,
      onDrop: (p) => dropped.push(p),
    });
    const detach = handle.attach(zone);
    try {
      armNodeLinkDrag(PAYLOAD, 50, 50);
      updateNodeLinkDrag(260, 230);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('valid');
      expect(endNodeLinkDrag(260, 230)).toBe('dropped');
      expect(dropped).toEqual([PAYLOAD]);
    } finally {
      detach();
      handle.dispose();
      zone.remove();
    }
  });

  it('rejecting target shows invalid state and the drop cancels', () => {
    const zone = makeDropZone(200, 200);
    const handle = createNodeLinkDropTarget({
      accepts: (p) => p.sourcePath !== PAYLOAD.sourcePath, // reject self
      onDrop: () => { throw new Error('must not be called'); },
    });
    const detach = handle.attach(zone);
    try {
      armNodeLinkDrag(PAYLOAD, 50, 50);
      updateNodeLinkDrag(260, 230);
      expect(zone.getAttribute('data-rv-drop-state')).toBe('invalid');
      expect(endNodeLinkDrag(260, 230)).toBe('cancelled');
    } finally {
      detach();
      handle.dispose();
      zone.remove();
    }
  });

  it('3D drop fallback is consulted only when no DOM target accepted', () => {
    const calls: Array<[number, number, NodeLinkDragPayload]> = [];
    setNodeLinkDropFallback((x, y, p) => { calls.push([x, y, p]); return true; });
    armNodeLinkDrag(PAYLOAD, 50, 50);
    updateNodeLinkDrag(400, 400);
    expect(endNodeLinkDrag(400, 400)).toBe('dropped');
    expect(calls).toEqual([[400, 400, PAYLOAD]]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * bake-undefined-hardening — where `undefined` sits decides whether JSON loses
 * it or changes it, and only the second earns a refusal (plan-422 F1, test 9.2).
 *
 * The blanket rule this replaces was not wrong about JSON, it was wrong about
 * the cost. `{ topic: undefined }` serialises to `{}` and reads back as
 * `undefined` — an exact round-trip — yet refusing it aborted the WHOLE draft
 * write, so one topic-less CONNECT binding silently discarded every unsaved
 * edit of the session. `[1, undefined]` is the opposite case: it serialises to
 * `[1, null]`, a different value of a different type at the same index, and
 * that refusal is worth keeping.
 *
 * The matrix below pins both halves plus the neighbours that must not shift:
 * `null` (a delete, always fine), a top-level `undefined` (nothing left to
 * write) and a function (genuinely unserialisable).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  writeSettingsIntoModel,
  UnrepresentableValueError,
  unrepresentableReason,
} from '../src/core/hmi/scene/rv-scene-settings-into-model';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function makeGlb(json: unknown, bin = new Uint8Array([9, 8, 7, 6])): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.byteLength + 3) & ~3;
  const binPadded = (bin.byteLength + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jsonPadded + 8 + binPadded);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.fill(0x20, 20, 20 + jsonPadded);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonPadded, binPadded, true);
  view.setUint32(24 + jsonPadded, BIN_CHUNK, true);
  out.set(bin, 28 + jsonPadded);
  return out;
}

function overlayOf(nodes: RVExtrasOverlay['nodes']): RVExtrasOverlay {
  return { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes };
}

/** Bake one component field onto a one-node GLB and read the result back. */
function bakeField(componentType: string, fieldName: string, value: unknown) {
  const source = makeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Machine' }],
  });
  const result = writeSettingsIntoModel(
    source,
    overlayOf({ Machine: { [componentType]: { [fieldName]: value } } }),
    (path) => (path === 'Machine' ? 0 : null),
  );
  const json = parseGlbChunks(result.glb).json as {
    nodes: { extras?: { realvirtual?: Record<string, Record<string, unknown>> } }[];
  };
  return json.nodes[0].extras!.realvirtual![componentType];
}

// ── The rule, at the level it is decided ─────────────────────────────────

describe('unrepresentableReason — position decides the verdict for undefined', () => {
  it('records an undefined OBJECT PROPERTY instead of failing, when asked to', () => {
    const dropped: string[] = [];
    const why = unrepresentableReason({ signal: 'A', topic: undefined }, new Set(), dropped);
    expect(why, 'a droppable property must not be a refusal').toBeNull();
    expect(dropped).toEqual(['.topic']);
  });

  it('reports the full path of a NESTED dropped property', () => {
    const dropped: string[] = [];
    unrepresentableReason([{ a: { b: undefined } }], new Set(), dropped);
    expect(dropped).toEqual(['[0].a.b']);
  });

  it('still fails an undefined ARRAY ELEMENT — JSON turns it into null', () => {
    const dropped: string[] = [];
    const why = unrepresentableReason({ list: [1, undefined] }, new Set(), dropped);
    expect(why).toContain('undefined would be dropped');
    expect(dropped, 'an array hole is not a droppable property').toEqual([]);
  });

  it('still fails a TOP-LEVEL undefined — nothing is left to write', () => {
    expect(unrepresentableReason(undefined, new Set(), [])).toContain('undefined would be dropped');
  });

  it('keeps the strict verdict when no collector is supplied (unchanged callers)', () => {
    expect(unrepresentableReason({ topic: undefined })).toContain('undefined would be dropped');
  });

  it('leaves null, finite numbers, functions and cycles exactly as they were', () => {
    const dropped: string[] = [];
    expect(unrepresentableReason({ a: null, b: [null], c: 0 }, new Set(), dropped)).toBeNull();
    expect(dropped).toEqual([]);
    expect(unrepresentableReason({ f: () => 0 }, new Set(), dropped)).toContain('function');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(unrepresentableReason(cyclic, new Set(), dropped)).toContain('cycle');
  });
});

// ── The same rule, observed through a real bake ──────────────────────────

describe('bake — an undefined property costs the property, not the file', () => {
  it('writes the file and warns, dropping only the undefined key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const written = bakeField('SignalLinks', 'Mappings', [
        { slot: 'Lamp.lightSignal', signal: 'PLC.LampOn', interfaceId: 'mqtt', topic: undefined },
      ]);
      expect(written).toEqual({
        Mappings: [{ slot: 'Lamp.lightSignal', signal: 'PLC.LampOn', interfaceId: 'mqtt' }],
      });
      expect(warn, 'a dropped property must still be said out loud').toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('SignalLinks.Mappings[0].topic');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when there is nothing to drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bakeField('Drive', 'TargetSpeed', 250);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still refuses the file for an undefined ARRAY ELEMENT', () => {
    expect(() => bakeField('Drive', 'Waypoints', [1, undefined, 3]))
      .toThrow(UnrepresentableValueError);
  });

  it('still refuses the file for a top-level undefined field value', () => {
    expect(() => bakeField('Drive', 'TargetSpeed', undefined))
      .toThrow(UnrepresentableValueError);
  });

  it('keeps null as a value in both positions — it is a delete, not a loss', () => {
    expect(bakeField('Drive', 'Direction', { x: 1, y: null }))
      .toEqual({ Direction: { x: 1, y: null } });
    expect(bakeField('Drive', 'Waypoints', [1, null, 3]))
      .toEqual({ Waypoints: [1, null, 3] });
  });
});

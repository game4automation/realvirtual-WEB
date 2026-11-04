// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * debug-endpoint-serialize.test.ts — crash-safe console-argument
 * serialization of the diagnostics console buffer behind /__api/debug/errors.
 *
 * Regression for the live crash: the console.error monkey-patch ran
 * `JSON.stringify` over a Three.js BufferGeometry argument; its
 * `BufferAttribute.toJSON` → `Array.from` walked a typed array whose
 * ArrayBuffer was DETACHED (worker transfer) and threw
 * "Cannot perform %TypedArray%.prototype.values on a detached ArrayBuffer" —
 * swallowing the ORIGINAL error and crashing the hook. Serialization must
 * NEVER throw; Three.js objects render as a short tag instead of JSON.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import {
  getDiagnosticsEntries, installDiagnosticsCollector,
} from '../src/core/diagnostics/rv-diagnostics-collector';
// Through the plugin's own re-export, so the surface the endpoint offers stays pinned.
import { serializeConsoleArg } from '../src/plugins/debug-endpoint-plugin';

describe('serializeConsoleArg — never throws', () => {
  it('object whose toJSON throws (simulated detached buffer) → String fallback, no throw', () => {
    const bomb = {
      toJSON(): never {
        throw new TypeError(
          'Cannot perform %TypedArray%.prototype.values on a detached ArrayBuffer',
        );
      },
    };
    let out = '';
    expect(() => { out = serializeConsoleArg(bomb); }).not.toThrow();
    expect(out).toBe('[object Object]'); // String(arg) fallback
  });

  it('Three.js BufferGeometry → short tag, toJSON is NEVER invoked', () => {
    const geo = new BufferGeometry();
    geo.name = 'BeltMesh';
    // Prove the tag path never touches toJSON (which would throw on a
    // detached buffer): make it a bomb.
    (geo as unknown as { toJSON(): never }).toJSON = () => {
      throw new TypeError('detached');
    };
    const out = serializeConsoleArg(geo);
    expect(out).toMatch(/^\[BufferGeometry name=BeltMesh uuid=[0-9a-f-]+\]$/);
  });

  it('real BufferGeometry with a DETACHED position buffer serializes without throwing', () => {
    const geo = new BufferGeometry();
    const data = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    geo.setAttribute('position', new BufferAttribute(data, 3));
    // Detach the underlying ArrayBuffer like a worker transfer does.
    const buf = data.buffer as ArrayBuffer & { transfer?: () => ArrayBuffer };
    if (typeof buf.transfer === 'function') {
      buf.transfer();
      // Sanity: JSON.stringify on the raw geometry DOES throw now — the exact
      // production crash this fix guards against.
      expect(() => JSON.stringify(geo)).toThrow();
    }
    expect(() => serializeConsoleArg(geo)).not.toThrow();
    expect(serializeConsoleArg(geo)).toContain('[BufferGeometry');
  });

  it('BufferAttribute / Object3D-like / Material-like objects → short tags', () => {
    const attr = new BufferAttribute(new Float32Array(3), 3);
    expect(serializeConsoleArg(attr)).toContain('[BufferAttribute');
    expect(serializeConsoleArg({ isObject3D: true, name: 'Root', uuid: 'u1' }))
      .toBe('[Object3D name=Root uuid=u1]');
    expect(serializeConsoleArg({ isMaterial: true, type: 'MeshStandardMaterial', uuid: 'u2' }))
      .toBe('[Material type=MeshStandardMaterial uuid=u2]');
  });

  it('cyclic object → String fallback, no throw', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => serializeConsoleArg(cyc)).not.toThrow();
    expect(serializeConsoleArg(cyc)).toBe('[object Object]');
  });

  it('primitives and errors keep their existing rendering', () => {
    expect(serializeConsoleArg('plain')).toBe('plain');
    expect(serializeConsoleArg(42)).toBe('42');
    expect(serializeConsoleArg(undefined)).toBe('undefined');
    expect(serializeConsoleArg(null)).toBe('null');
    expect(serializeConsoleArg({ a: 1 })).toBe('{"a":1}');
    const err = new Error('boom');
    expect(serializeConsoleArg(err)).toContain('boom');
  });

  it('oversized JSON payloads are capped', () => {
    const big = { blob: 'x'.repeat(50_000) };
    expect(serializeConsoleArg(big).length).toBeLessThanOrEqual(2000);
  });
});

/**
 * The console hook no longer lives in the plugin. `installDiagnosticsCollector()`
 * wraps `console.error` / `console.warn` once, globally, and buffers the entries
 * under `cat: 'console'`; the plugin only READS them back through
 * `getDiagnosticsEntries()` for its `/__api/debug/errors` endpoint, and
 * re-exports `serializeConsoleArg` for this very regression. The old
 * `_setupErrorCapture` / `_restoreConsole` pair went with that move, so the
 * regression is pinned where the hook actually is. The install is once-only and
 * has no uninstall, so the console originals are restored by hand here.
 */
describe('diagnostics console hook — buffers a short form, never crashes', () => {
  const originalError = console.error;
  const originalWarn = console.warn;

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
  });

  it('console.error with a throwing-toJSON object does not throw and buffers a short form', () => {
    installDiagnosticsCollector();

    const geo = new BufferGeometry();
    geo.name = 'Detached';
    (geo as unknown as { toJSON(): never }).toJSON = () => {
      throw new TypeError('detached ArrayBuffer');
    };

    const before = getDiagnosticsEntries().length;
    expect(() => console.error('THREE.GLTFLoader: mesh failed', geo)).not.toThrow();

    const added = getDiagnosticsEntries().slice(before);
    const consoleEntries = added.filter(e => e.cat === 'console');
    expect(consoleEntries).toHaveLength(1);
    expect(consoleEntries[0].lvl).toBe('error');
    expect(consoleEntries[0].msg).toContain('THREE.GLTFLoader: mesh failed');
    expect(consoleEntries[0].msg).toContain('[BufferGeometry name=Detached');
    expect(consoleEntries[0].msg.length).toBeLessThanOrEqual(8000);
  });
});

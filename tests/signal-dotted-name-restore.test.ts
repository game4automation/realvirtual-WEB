// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-dotted-name-restore.test.ts — regression for the dotted PLC signal
 * name mapping bug.
 *
 * Three.js' GLTFLoader sanitizes node names (strips reserved chars `[ ] . : /`,
 * whitespace → `_`). A Siemens signal node `MC04.01I00W` with an EMPTY signal
 * `Name` field would therefore register in the SignalStore as `MC0401I00W`
 * (dot lost), so live interface writes (MQTT / realvirtual CONNECT) addressing
 * the original dotted name `MC04.01I00W` missed the signal entirely.
 *
 * `detectRenamedNodes` now restores the exact original glTF name on the
 * `Object3D` when the difference is pure sanitization (no dedup suffix), so:
 *   - the signal registers under the EXACT original name (with dot),
 *   - the node path uses the original name,
 *   - `setMany({ 'MC04.01I00W': true })` (the interface side) reaches a
 *     `subscribeByPath` on that node's original path,
 *   - genuine dedup (two equally-named nodes) is left untouched (no collision).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  detectRenamedNodes,
  traverseAndRegister,
  registerNodeAliases,
} from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

/**
 * Build a minimal fake `gltfParser` whose `associations` map mirrors what
 * Three.js' GLTFLoader produces: Object3D → { nodes: <index> }, with the
 * ORIGINAL (un-sanitized) names available in `json.nodes[i].name`.
 *
 * Each spec entry pairs an Object3D (already carrying the *sanitized* name that
 * Three.js would have assigned) with the original glTF name it came from.
 */
function makeFakeParser(specs: Array<{ obj: Object3D; origName: string }>) {
  const associations = new Map<Object3D, { nodes: number }>();
  const nodes: Array<{ name: string }> = [];
  specs.forEach((s, i) => {
    associations.set(s.obj, { nodes: i });
    nodes.push({ name: s.origName });
  });
  return { associations, json: { nodes } } as unknown as Parameters<typeof detectRenamedNodes>[0];
}

/** Wrap a node in a scene-root parent so computeNodePath() produces a path. */
function underRoot(node: Object3D): Object3D {
  const root = new Object3D();
  root.name = 'Root';
  root.add(node);
  return root;
}

describe('dotted PLC signal name — pure-sanitization restore', () => {
  it('restores the exact original dotted name on the Object3D', () => {
    const node = new Object3D();
    node.name = 'MC0401I00W'; // Three.js stripped the dot
    const parser = makeFakeParser([{ obj: node, origName: 'MC04.01I00W' }]);

    const renamed = detectRenamedNodes(parser);

    expect(node.name).toBe('MC04.01I00W'); // restored verbatim
    expect(renamed.size).toBe(0);          // no alias needed for a pure restore
  });

  it('registers the signal under the EXACT original name (with dot)', () => {
    const node = new Object3D();
    node.name = 'MC0401I00W';
    node.userData.realvirtual = {
      PLCOutputBool: { Name: '', Status: { Value: false } }, // empty Name → node.name fallback
    };
    const root = underRoot(node);
    const parser = makeFakeParser([{ obj: node, origName: 'MC04.01I00W' }]);

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);

    // Registered under the dotted name — matches the interface symbol verbatim.
    expect(signalStore.get('MC04.01I00W')).toBe(false);
    // The sanitized name must NOT be a key (would silently shadow the match).
    expect(signalStore.get('MC0401I00W')).toBeUndefined();
  });

  it('lets an interface write (setMany with the dotted name) reach a path subscriber', () => {
    const node = new Object3D();
    node.name = 'MC0401I00W';
    node.userData.realvirtual = {
      PLCOutputBool: { Name: '', Status: { Value: false } },
    };
    const root = underRoot(node);
    const parser = makeFakeParser([{ obj: node, origName: 'MC04.01I00W' }]);

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);

    // The original node path now carries the dot.
    const path = NodeRegistry.computeNodePath(node);
    expect(path).toBe('MC04.01I00W');

    let received: boolean | number | undefined;
    signalStore.subscribeByPath(path, (v) => { received = v; });

    // Interface side addresses the signal by its ORIGINAL dotted name.
    signalStore.setMany({ 'MC04.01I00W': true });

    expect(received).toBe(true);
    expect(signalStore.getBoolByPath(path)).toBe(true);
  });

  it('honors an explicit signal Name field over the node name', () => {
    // When the Name field IS set, it always wins — restoration only affects the
    // node-name fallback path. Sanity-check we did not regress that.
    const node = new Object3D();
    node.name = 'MC0401I00W';
    node.userData.realvirtual = {
      PLCInputBool: { Name: 'ExplicitSym', Status: { Value: true } },
    };
    const root = underRoot(node);
    const parser = makeFakeParser([{ obj: node, origName: 'MC04.01I00W' }]);

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);

    expect(signalStore.get('ExplicitSym')).toBe(true);
    // node name still restored for path purposes
    expect(node.name).toBe('MC04.01I00W');
  });
});

describe('dotted PLC signal name — regressions', () => {
  it('whitespace-only sanitization still restores the original (with space)', () => {
    const node = new Object3D();
    node.name = 'Foo_Bar'; // Three.js mapped the space to underscore
    const parser = makeFakeParser([{ obj: node, origName: 'Foo Bar' }]);

    const renamed = detectRenamedNodes(parser);

    expect(node.name).toBe('Foo Bar');
    expect(renamed.size).toBe(0);
  });

  it('genuine dedup of two equally-named dotted nodes does NOT collide', () => {
    // Two distinct nodes both authored as 'MC04.01I00W'. Three.js names the
    // first 'MC0401I00W' and the second 'MC0401I00W_1' (collision suffix).
    const first = new Object3D();
    first.name = 'MC0401I00W';
    const second = new Object3D();
    second.name = 'MC0401I00W_1';

    const root = new Object3D();
    root.name = 'Root';
    root.add(first);
    root.add(second);

    const parser = makeFakeParser([
      { obj: first, origName: 'MC04.01I00W' },
      { obj: second, origName: 'MC04.01I00W' },
    ]);

    const renamed = detectRenamedNodes(parser);

    // First is a pure sanitization → restored to the dotted original.
    expect(first.name).toBe('MC04.01I00W');
    // Second carries a real dedup suffix → left untouched, recorded as alias.
    expect(second.name).toBe('MC0401I00W_1');
    expect(renamed.get(second)).toBe('MC0401I00W');
    // No name collision between the two siblings.
    expect(first.name).not.toBe(second.name);

    // registerNodeAliases must run cleanly for the dedup node (no throw, alias path created).
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    traverseAndRegister(root, registry, signalStore, renamed);
    expect(() => registerNodeAliases(renamed, registry, signalStore)).not.toThrow();
  });

  it('an already-clean name (no sanitization) is left completely untouched', () => {
    const node = new Object3D();
    node.name = 'PlainSignal';
    const parser = makeFakeParser([{ obj: node, origName: 'PlainSignal' }]);

    const renamed = detectRenamedNodes(parser);

    expect(node.name).toBe('PlainSignal');
    expect(renamed.size).toBe(0);
  });

  it('survives an UNDEFINED association value (material-less CAD GLB)', () => {
    // GLTFLoader clones a material for flat-shading / vertex-colors and copies
    // the ORIGINAL material's association onto the clone. For the built-in
    // DEFAULT material there is none, so `associations` ends up holding an
    // undefined value. Every GLB without a `materials` array hits this — which
    // is EVERY OCCT/CONNECT STEP conversion. Reading `.nodes` off it used to
    // throw "Cannot read properties of undefined (reading 'nodes')" and failed
    // the whole CAD import.
    const node = new Object3D();
    node.name = 'MC0401I00W';
    const parser = makeFakeParser([{ obj: node, origName: 'MC04.01I00W' }]);
    (parser as unknown as { associations: Map<Object3D, unknown> })
      .associations.set(new Object3D(), undefined);

    let renamed!: ReturnType<typeof detectRenamedNodes>;
    expect(() => { renamed = detectRenamedNodes(parser); }).not.toThrow();

    // The real node is still processed — the bad entry is skipped, not fatal.
    expect(node.name).toBe('MC04.01I00W');
    expect(renamed.size).toBe(0);
  });
});

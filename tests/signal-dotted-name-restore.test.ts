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
    // Second carries a real dedup suffix → left untouched, and the RAW dotted
    // original is what gets remembered (plan-734).
    //
    // This assertion used to read 'MC0401I00W' and was the one place in the
    // suite where the bug was written down as intended behaviour — the comment
    // beside it always said "recorded as alias", meaning the dotted original.
    // The sanitized spelling made the reconstructed alias path unusable and
    // handed `signalNameOverride` the wrong signal name.
    expect(renamed.get(second)).toBe('MC04.01I00W');
    // No name collision between the two siblings.
    expect(first.name).not.toBe(second.name);

    // registerNodeAliases must run cleanly for the dedup node (no throw, alias path created).
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    traverseAndRegister(root, registry, signalStore, renamed);
    expect(() => registerNodeAliases(renamed, registry, signalStore)).not.toThrow();
  });

  /**
   * The realistic shape of the bug: the two colliding symbols sit in DIFFERENT
   * branches, so the deduped one's alias paths are free. Two siblings under one
   * parent cannot both own the raw spelling — the first node's canonical path
   * already is it — which is correct fail-closed behaviour, but it hides what
   * these two tests are about.
   */
  function twoBranches(): {
    root: Object3D; first: Object3D; second: Object3D;
    parser: ReturnType<typeof makeFakeParser>;
  } {
    const root = new Object3D();
    root.name = 'Root';
    const b1 = new Object3D(); b1.name = 'Zweig1'; root.add(b1);
    const b2 = new Object3D(); b2.name = 'Zweig2'; root.add(b2);

    const first = new Object3D();
    first.name = 'MC0401I00W';   // Three sanitized it; nothing collided yet
    b1.add(first);
    const second = new Object3D();
    second.name = 'MC0401I00W_1'; // …and this one collided → dedup suffix
    b2.add(second);

    return {
      root, first, second,
      parser: makeFakeParser([
        { obj: first, origName: 'MC04.01I00W' },
        { obj: second, origName: 'MC04.01I00W' },
      ]),
    };
  }

  // plan-734 F2 — the second, previously unnoticed half of the same bug.
  it('a DEDUPED signal node registers under the raw dotted name', () => {
    const { root, first, second, parser } = twoBranches();
    first.userData.realvirtual = { PLCOutputBool: { Name: '', Status: { Value: false } } };
    second.userData.realvirtual = { PLCOutputBool: { Name: '', Status: { Value: true } } };

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);

    // The dedup node's signal takes its name from `renamedNodes` — the raw
    // dotted symbol the PLC actually addresses, not `MC0401I00W`.
    const names = [...signalStore.getAll().keys()];
    expect(names).toContain('MC04.01I00W');
    // The stripped spelling must not appear at all: it is the one name no live
    // interface can ever address, and before the fix it was the ONLY name this
    // second node was reachable under.
    expect(names.every((n) => !n.startsWith('MC0401I00W'))).toBe(true);
  });

  // plan-734 — both spellings become node aliases, and the signal path alias
  // follows the node alias (F3).
  it('registers BOTH spellings as node aliases for a deduped node', () => {
    const { root, second, parser } = twoBranches();

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);
    const stats = registerNodeAliases(renamed, registry, signalStore);

    // Raw spelling — the one the GLB authored and nothing could resolve before…
    expect(registry.getNode('Zweig2/MC04.01I00W')).toBe(second);
    // …and the sanitized one, which is what the pre-fix loader published alone.
    expect(registry.getNode('Zweig2/MC0401I00W')).toBe(second);
    expect(stats.nodeAliases).toBe(2);
    expect(stats.droppedAliases).toBe(0);
  });

  // plan-734 F3 — the signal path alias is published for BOTH spellings, so an
  // interface addressing either historical path reaches the same signal.
  it('registers BOTH spellings as signal path aliases', () => {
    const { root, second, parser } = twoBranches();
    second.userData.realvirtual = { PLCOutputBool: { Name: '', Status: { Value: true } } };

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);
    const stats = registerNodeAliases(renamed, registry, signalStore);

    expect(signalStore.getBoolByPath('Zweig2/MC04.01I00W')).toBe(true);
    expect(signalStore.getBoolByPath('Zweig2/MC0401I00W')).toBe(true);
    expect(stats.signalAliases).toBe(2);
  });

  // A node whose raw name survives sanitization unchanged must NOT pay for the
  // second spelling — the de-duplication in registerNodeAliases handles it.
  it('does not register a duplicate alias when raw and sanitized agree', () => {
    const first = new Object3D();
    first.name = 'Pusher';
    const second = new Object3D();
    second.name = 'Pusher_1';

    const root = new Object3D();
    root.name = 'Root';
    root.add(first);
    root.add(second);

    const parser = makeFakeParser([
      { obj: first, origName: 'Pusher' },
      { obj: second, origName: 'Pusher' },
    ]);

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const renamed = detectRenamedNodes(parser);
    traverseAndRegister(root, registry, signalStore, renamed);
    const stats = registerNodeAliases(renamed, registry, signalStore);

    // 'Pusher' is already the FIRST node's canonical path, so the alias is
    // discarded — and that discard is now counted instead of vanishing.
    expect(stats.nodeAliases).toBe(0);
    expect(stats.droppedAliases).toBe(1);
    expect(registry.getNode('Pusher')).toBe(first);
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

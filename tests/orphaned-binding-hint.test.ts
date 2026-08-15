// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * orphaned-binding-hint — a saved link whose object is gone says so
 * (plan-422 F9, test 9.7).
 *
 * The first design of this check put it in the replay traverse, and the review
 * caught it as a BLOCKER: that traverse walks the nodes of the loaded model and
 * can only ever find mappings that are present. A carrier node that no longer
 * exists is invisible to it — which is the entire finding. So the check runs
 * from the op side, against the registry, and the fixture below therefore uses
 * a carrier that is GENUINELY absent rather than merely renamed.
 *
 * Why it matters: node bindings persist by PATH, and phase 6 of this very plan
 * re-parents the demo's signal groups. Without a word said, a user's broken
 * bindings look exactly like the reload defect phase 1 just fixed.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { findOrphanedBindingPaths } from '../src/plugins/signal-bind/orphaned-bindings';
import {
  reportOrphanedBindings,
  clearSceneSyncNotices,
  onSceneSyncNotice,
  type SceneSyncNotice,
} from '../src/core/hmi/scene/rv-scene-live-sync';

afterEach(() => clearSceneSyncNotices());

/** A registry that knows exactly the paths it was given. */
function registryWith(paths: readonly string[]) {
  const set = new Set(paths);
  return { getNode: (path: string) => (set.has(path) ? {} : undefined) };
}

function overlayWith(nodes: Record<string, Record<string, unknown>>) {
  return { nodes } as Parameters<typeof findOrphanedBindingPaths>[0];
}

const MAPPING = { kind: 'mapped-signal', slot: 'Value', signal: 'PLC.Run', enabled: true };

describe('findOrphanedBindingPaths', () => {
  it('reports a carrier that is genuinely ABSENT from the loaded model', () => {
    const overlay = overlayWith({
      'Cell/Old/Lamp': { SignalLinks: { Mappings: [MAPPING] } },
    });
    // The model has other nodes — just not this one. This is the re-parenting case.
    const registry = registryWith(['Cell/Machine/Lamp', 'Cell/Machine']);
    expect(findOrphanedBindingPaths(overlay, registry)).toEqual(['Cell/Old/Lamp']);
  });

  it('says nothing when the carrier resolves — the binding simply works', () => {
    const overlay = overlayWith({
      'Cell/Machine/Lamp': { SignalLinks: { Mappings: [MAPPING] } },
    });
    expect(findOrphanedBindingPaths(overlay, registryWith(['Cell/Machine/Lamp']))).toEqual([]);
  });

  it('reports every missing carrier, in overlay order, without duplicates', () => {
    const overlay = overlayWith({
      'Cell/Gone/A': { SignalLinks: { Mappings: [MAPPING] } },
      'Cell/Here/B': { SignalLinks: { Mappings: [MAPPING] } },
      'Cell/Gone/C': { SignalLinks: { Mappings: [MAPPING, MAPPING] } },
    });
    expect(findOrphanedBindingPaths(overlay, registryWith(['Cell/Here/B'])))
      .toEqual(['Cell/Gone/A', 'Cell/Gone/C']);
  });

  it('ignores overlay entries that carry no signal links at all', () => {
    const overlay = overlayWith({
      'Cell/Gone/Drive': { Drive: { TargetSpeed: 250 } },
    });
    expect(findOrphanedBindingPaths(overlay, registryWith([]))).toEqual([]);
  });

  it('does not treat "everything unlinked" as an orphan', () => {
    // An empty mapping list means the user removed the links. Warning about it
    // would turn a deliberate action into an alarm.
    const overlay = overlayWith({
      'Cell/Gone/Lamp': { SignalLinks: { Mappings: [] } },
    });
    expect(findOrphanedBindingPaths(overlay, registryWith([]))).toEqual([]);
  });

  it('is inert without an overlay or without a registry', () => {
    expect(findOrphanedBindingPaths(null, registryWith([]))).toEqual([]);
    expect(findOrphanedBindingPaths(undefined, registryWith([]))).toEqual([]);
    expect(findOrphanedBindingPaths(overlayWith({ a: { SignalLinks: { Mappings: [MAPPING] } } }), null))
      .toEqual([]);
  });

  it('survives a malformed SignalLinks block instead of failing the load', () => {
    const overlay = overlayWith({
      'Cell/Gone/A': { SignalLinks: { Mappings: 'not an array' } },
      'Cell/Gone/B': { SignalLinks: null as unknown as Record<string, unknown> },
    });
    expect(findOrphanedBindingPaths(overlay, registryWith([]))).toEqual([]);
  });
});

describe('the notice it produces', () => {
  it('is ONE warning naming the count and the paths', () => {
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    try {
      reportOrphanedBindings('demo.glb', ['Cell/Old/Lamp', 'Cell/Old/Button']);
      expect(seen).toHaveLength(1);
      const notice = seen[0];
      expect(notice.kind).toBe('orphaned-bindings');
      if (notice.kind !== 'orphaned-bindings') throw new Error('wrong kind');
      expect(notice.count).toBe(2);
      expect(notice.paths).toEqual(['Cell/Old/Lamp', 'Cell/Old/Button']);
      expect(notice.message).toContain('Cell/Old/Lamp');
      // The ops are KEPT, and the wording has to promise that.
      expect(notice.message).toMatch(/kept/i);
    } finally {
      off();
    }
  });

  it('stays silent for an empty finding', () => {
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    try {
      reportOrphanedBindings('demo.glb', []);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('collapses onto one notice per model, however often it is reported', () => {
    reportOrphanedBindings('demo.glb', ['Cell/Old/Lamp']);
    reportOrphanedBindings('demo.glb', ['Cell/Old/Lamp', 'Cell/Old/Button']);
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    off();
    // A late subscriber sees the ONE current notice, carrying the latest finding.
    expect(seen).toHaveLength(1);
    expect(seen[0].kind === 'orphaned-bindings' && seen[0].count).toBe(2);
  });

  it('keeps findings of DIFFERENT models apart', () => {
    reportOrphanedBindings('a.glb', ['Cell/Old/Lamp']);
    reportOrphanedBindings('b.glb', ['Other/Gone']);
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    off();
    expect(seen).toHaveLength(2);
  });
});

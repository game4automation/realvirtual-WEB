// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Codex review round 3 (branch fix/nodeid-no-name-fallback): `mergeAppliedMappings`
 * matches an address-bound internal source by its ADDRESS. Its `signal` is a cache
 * that a rename moves on, so the applied copy carries the new name — matching on the
 * name stalled the merge there, and every later CONNECT mapping lost the provider
 * `applyMappings` had just resolved (the load-time write-back then wrote nothing).
 */

import { describe, expect, it } from 'vitest';
import { mergeAppliedMappings } from '../src/plugins/signal-bind/binding-inventory';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

const internal: SignalMapping = {
  slot: 'Value', componentPath: 'A', sourceKind: 'internal', signal: 'Old.Name',
  sourceAddress: '#a0000000-0000-5000-8000-00000000000a', direction: 'plcOutput', enabled: true,
};
const connect: SignalMapping = { slot: 'Value', componentPath: 'B', signal: 'Ext.Run', direction: 'plcOutput', enabled: true };

describe('mergeAppliedMappings — address-bound source after a rename', () => {
  it('advances past the renamed source and keeps the provider of the next mapping', () => {
    const applied: SignalMapping[] = [
      { ...internal, signal: 'New.Name', kind: 'mapped-signal' },
      { ...connect, interfaceId: 'if-a', kind: 'mapped-signal' },
    ];
    const merged = mergeAppliedMappings([internal, connect], applied);
    expect(merged[0].signal).toBe('New.Name');
    expect(merged[0].sourceAddress).toBe(internal.sourceAddress);
    expect(merged[1].interfaceId).toBe('if-a');
  });

  it('keeps an unresolved address-bound source verbatim', () => {
    const merged = mergeAppliedMappings([internal, connect], [{ ...connect, interfaceId: 'if-a' }]);
    expect(merged[0]).toEqual(internal);
    expect(merged[1].interfaceId).toBe('if-a');
  });

  it('an unresolved component-addressed mapping never consumes a different component (Codex r4 P1)', () => {
    const broken: SignalMapping = { slot: 'Value', componentAddress: '#gone', signal: 'Ext.Run', direction: 'plcOutput', enabled: true };
    const other: SignalMapping = { slot: 'Value', componentAddress: '#b', signal: 'Ext.Run', direction: 'plcOutput', enabled: true };
    const merged = mergeAppliedMappings([broken, other], [{ ...other, componentPath: 'B', interfaceId: 'if-a' }]);
    expect(merged[0]).toEqual(broken);
    expect(merged[1].interfaceId).toBe('if-a');
  });
});

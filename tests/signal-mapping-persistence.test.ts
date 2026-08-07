// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.1 signal-mapping-persistence — round-trip serialize/deserialize of
 * PlacedComponent.signalMappings, incl. backward compatibility (missing field).
 */
import { describe, it, expect } from 'vitest';
import {
  serializeLayout,
  deserializeLayout,
  type PlacedComponent,
  type SignalMapping,
} from '../src/plugins/layout-planner/rv-layout-store';

function makePlaced(id: string, signalMappings?: SignalMapping[]): PlacedComponent {
  return {
    id,
    catalogId: 'conveyor',
    glbUrl: 'models/conv.glb',
    label: 'Conveyor',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...(signalMappings ? { signalMappings } : {}),
  };
}

describe('signal-mapping persistence', () => {
  it('round-trips signalMappings through serialize → deserialize', () => {
    const mappings: SignalMapping[] = [
      { kind: 'mapped-signal', slot: 'Flow.Run', signal: 'Motor.Run', direction: 'plcInput', enabled: true },
      {
        kind: 'direct-property', componentPath: 'Axis', slot: 'Forward',
        signal: 'Motor.Forward', direction: 'plcOutput', enabled: true,
      },
      {
        kind: 'direct-feedback', componentPath: 'Axis', slot: 'IsDriving',
        signal: 'Motor.Running', direction: 'plcInput', enabled: false,
      },
    ];
    const withMappings = makePlaced('a', mappings);
    const withoutMappings = makePlaced('b');

    const file = serializeLayout('test', [withMappings, withoutMappings], ['cat'], 500);
    const json = JSON.stringify(file);
    const restored = deserializeLayout(json);

    expect(restored.components).toHaveLength(2);
    const a = restored.components.find(c => c.id === 'a')!;
    const b = restored.components.find(c => c.id === 'b')!;
    expect(a.signalMappings).toEqual(mappings);
    expect(a.signalMappings?.map((mapping) => mapping.kind)).toEqual([
      'mapped-signal',
      'direct-property',
      'direct-feedback',
    ]);
    // Component without the field stays undefined (backward compatible).
    expect(b.signalMappings).toBeUndefined();
  });

  it('preserves the enabled flag and direction across a round-trip', () => {
    const mappings: SignalMapping[] = [
      { slot: 'Forward', signal: 'Drive.Fwd', direction: 'plcInput', enabled: false },
    ];
    const file = serializeLayout('t', [makePlaced('c', mappings)], [], 0);
    const restored = deserializeLayout(JSON.stringify(file));
    expect(restored.components[0].signalMappings![0].enabled).toBe(false);
    expect(restored.components[0].signalMappings![0].direction).toBe('plcInput');
  });

  it('loads a legacy layout without signalMappings unchanged', () => {
    // Simulate a layout saved before the feature existed.
    const legacyJson = JSON.stringify({
      version: '1.0',
      name: 'legacy',
      createdAt: '2025-01-01T00:00:00.000Z',
      catalogUrls: [],
      gridSizeMm: 500,
      components: [makePlaced('legacy')],
    });
    const restored = deserializeLayout(legacyJson);
    expect(restored.components[0].signalMappings).toBeUndefined();
  });

  it('keeps a legacy mapped-signal entry without a kind unchanged', () => {
    const legacy: SignalMapping = {
      slot: 'Flow.Run',
      signal: 'Motor.Run',
      direction: 'plcOutput',
      enabled: true,
    };
    const restored = deserializeLayout(JSON.stringify(
      serializeLayout('legacy-mapping', [makePlaced('legacy', [legacy])], [], 0),
    ));
    expect(restored.components[0].signalMappings).toEqual([legacy]);
    expect(restored.components[0].signalMappings?.[0].kind).toBeUndefined();
  });
});

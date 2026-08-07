// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for rv-value-resolver — the single source-of-truth for displayed
 * property values. Verifies the precedence rule (static < live), the unified
 * formatter, signal path→name fallback, and the live-edit push.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive } from '../src/core/engine/rv-drive';
import { applySchema } from '../src/core/engine/rv-component-registry';
import type { RVComponent } from '../src/core/engine/rv-component-registry';
import {
  formatValue,
  readSignalValue,
  getDisplayState,
  getPrimaryDisplayValue,
  applyLiveEdit,
  isSignalComponentType,
  getLiveStateFor,
  isEphemeralField,
  type ResolverViewer,
} from '../src/core/hmi/rv-value-resolver';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a registry + signalStore with a Drive registered at `drivePath`. */
function makeViewerWithDrive(drivePath = 'Root/Conveyor'): {
  viewer: ResolverViewer;
  drive: RVDrive;
} {
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const node = new Object3D();
  node.name = 'Conveyor';
  registry.registerNode(drivePath, node);

  const drive = new RVDrive(node);
  applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, {
    Direction: 'LinearX',
    TargetSpeed: 200,
    Acceleration: 100,
  });
  drive.initDrive();
  registry.register('Drive', drivePath, drive);

  return { viewer: { registry, signalStore }, drive };
}

// ── formatValue ─────────────────────────────────────────────────────────

describe('formatValue', () => {
  it('renders booleans as words by default and glyphs on request', () => {
    expect(formatValue(true)).toBe('true');
    expect(formatValue(false)).toBe('false');
    expect(formatValue(true, { boolStyle: 'glyph' })).toBe('●');
    expect(formatValue(false, { boolStyle: 'glyph' })).toBe('○');
  });

  it('uses 1 decimal for floats and truncates ints', () => {
    expect(formatValue(3.456)).toBe('3.5');
    expect(formatValue(3.456, { intLike: true })).toBe('3');
    expect(formatValue(3.456, { floatDigits: 2 })).toBe('3.46');
  });

  it('returns an em dash for null/undefined/NaN', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(NaN)).toBe('—');
  });

  it('passes strings through', () => {
    expect(formatValue('LinearX')).toBe('LinearX');
  });
});

// ── isSignalComponentType ─────────────────────────────────────────────────

describe('isSignalComponentType', () => {
  it('detects PLC signal types only', () => {
    expect(isSignalComponentType('PLCOutputBool')).toBe(true);
    expect(isSignalComponentType('PLCInputFloat')).toBe(true);
    expect(isSignalComponentType('Drive')).toBe(false);
    expect(isSignalComponentType('Sensor')).toBe(false);
  });
});

// ── readSignalValue ───────────────────────────────────────────────────────

describe('readSignalValue', () => {
  it('reads by path', () => {
    const store = new SignalStore();
    store.register('ConveyorRun', 'Root/Signals/ConveyorRun', true);
    expect(readSignalValue(store, 'Root/Signals/ConveyorRun')).toBe(true);
  });

  it('falls back to name lookup when path is not registered', () => {
    const store = new SignalStore();
    // Registered under a different path; name fallback should still resolve.
    store.register('SpeedSig', 'A/B/SpeedSig', 42);
    // Unknown path, but staticData.Name matches the signal name.
    expect(readSignalValue(store, 'X/Y/Unknown', { Name: 'SpeedSig' })).toBe(42);
  });

  it('returns undefined without a store', () => {
    expect(readSignalValue(null, 'anything')).toBeUndefined();
  });
});

// ── getDisplayState (precedence) ──────────────────────────────────────────

describe('getDisplayState', () => {
  it('layers live runtime state over static config (live wins)', () => {
    const { viewer, drive } = makeViewerWithDrive();
    drive.currentPosition = 12.5;
    drive.currentSpeed = 3;
    drive.isRunning = true;

    const staticData = { TargetSpeed: 200, Acceleration: 100 };
    const merged = getDisplayState(viewer, 'Root/Conveyor', 'Drive', staticData);

    // Static config preserved …
    expect(merged.Acceleration).toBe(100);
    // … live runtime overlaid on top.
    expect(merged.CurrentPosition).toBe(12.5);
    expect(merged.CurrentSpeed).toBe(3);
    expect(merged.IsRunning).toBe(true);
  });

  it('returns static data unchanged when no live component is registered', () => {
    const { viewer } = makeViewerWithDrive();
    const staticData = { Foo: 1 };
    const merged = getDisplayState(viewer, 'Root/Conveyor', 'UnknownType', staticData);
    expect(merged).toEqual(staticData);
  });

  it('falls back to static data when getLiveState throws', () => {
    const registry = new NodeRegistry();
    const node = new Object3D();
    registry.registerNode('N', node);
    const throwing: RVComponent = {
      node,
      isOwner: true,
      init() {},
      getLiveState() {
        throw new Error('boom');
      },
    };
    registry.register('Boomer', 'N', throwing);
    const viewer: ResolverViewer = { registry, signalStore: new SignalStore() };
    const staticData = { Keep: 7 };
    expect(getDisplayState(viewer, 'N', 'Boomer', staticData)).toEqual(staticData);
  });
});

// ── getPrimaryDisplayValue ────────────────────────────────────────────────

describe('getPrimaryDisplayValue', () => {
  it('returns the live signal value as a word for bools', () => {
    const { viewer } = makeViewerWithDrive();
    viewer.signalStore!.register('Run', 'Root/Run', true);
    const res = getPrimaryDisplayValue(viewer, 'Root/Run', 'PLCOutputBool', {});
    expect(res.text).toBe('true');
    expect(res.raw).toBe(true);
  });

  it('truncates int signals', () => {
    const { viewer } = makeViewerWithDrive();
    viewer.signalStore!.register('Count', 'Root/Count', 3.9);
    expect(getPrimaryDisplayValue(viewer, 'Root/Count', 'PLCOutputInt', {}).text).toBe('3');
  });

  it('returns the live drive position with a unit', () => {
    const { viewer, drive } = makeViewerWithDrive();
    drive.currentPosition = 7.25;
    const res = getPrimaryDisplayValue(viewer, 'Root/Conveyor', 'Drive', {});
    expect(res.text).toBe('7.3 mm');
  });

  it('returns null text for non-signal, non-drive types', () => {
    const { viewer } = makeViewerWithDrive();
    expect(getPrimaryDisplayValue(viewer, 'Root/Conveyor', 'Metadata', {}).text).toBeNull();
  });
});

// ── applyLiveEdit ─────────────────────────────────────────────────────────

describe('applyLiveEdit', () => {
  it('updates both the config and runtime field for Drive.TargetSpeed', () => {
    const { viewer, drive } = makeViewerWithDrive();
    expect(drive.targetSpeed).toBe(200); // copied from TargetSpeed at initDrive
    applyLiveEdit(viewer, 'Root/Conveyor', 'Drive', 'TargetSpeed', 75);
    expect(drive.TargetSpeed).toBe(75);
    expect(drive.targetSpeed).toBe(75);
  });

  it('assigns same-named scalar fields generically (Acceleration)', () => {
    const { viewer, drive } = makeViewerWithDrive();
    applyLiveEdit(viewer, 'Root/Conveyor', 'Drive', 'Acceleration', 250);
    expect(drive.Acceleration).toBe(250);
  });

  it('skips non-scalar fields (enum Direction)', () => {
    const { viewer, drive } = makeViewerWithDrive();
    const before = drive.Direction;
    applyLiveEdit(viewer, 'Root/Conveyor', 'Drive', 'Direction', 'LinearY');
    expect(drive.Direction).toBe(before);
  });

  it('does nothing when the component is not the local owner', () => {
    const { viewer, drive } = makeViewerWithDrive();
    drive.isOwner = false;
    applyLiveEdit(viewer, 'Root/Conveyor', 'Drive', 'TargetSpeed', 999);
    expect(drive.TargetSpeed).toBe(200);
    expect(drive.targetSpeed).toBe(200);
  });
});

// ── getLiveStateFor ───────────────────────────────────────────────────────

describe('getLiveStateFor', () => {
  it('returns the live fields for a registered live component', () => {
    const { viewer, drive } = makeViewerWithDrive();
    drive.currentPosition = 9;
    const live = getLiveStateFor(viewer, 'Root/Conveyor', 'Drive');
    expect(live?.CurrentPosition).toBe(9);
  });

  it('returns null for a type with no live component', () => {
    const { viewer } = makeViewerWithDrive();
    expect(getLiveStateFor(viewer, 'Root/Conveyor', 'Metadata')).toBeNull();
  });
});

// ── isEphemeralField (the persistence guard classifier) ───────────────────

describe('isEphemeralField', () => {
  it('is true for live-only runtime fields (never persistable)', () => {
    const { viewer } = makeViewerWithDrive();
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'CurrentPosition')).toBe(true);
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'IsRunning')).toBe(true);
  });

  it('is false for JogForward — it is an authored, persistable config setpoint', () => {
    const { viewer } = makeViewerWithDrive();
    // JogForward is live AND in the schema: GLBs really do author `JogForward: true`
    // (Unity serializes it), so an edit to it is a meaningful persistable override —
    // same class as TargetSpeed, NOT an ephemeral readout like CurrentPosition.
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'JogForward')).toBe(false);
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'JogBackward')).toBe(false);
  });

  it('is false for a field that is both live AND schema (config setpoint)', () => {
    const { viewer } = makeViewerWithDrive();
    // TargetSpeed is live (shown as actual) but also a schema/config field, so
    // editing it IS a meaningful, persistable override.
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'TargetSpeed')).toBe(false);
  });

  it('is false for config-only schema fields', () => {
    const { viewer } = makeViewerWithDrive();
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'Acceleration')).toBe(false);
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Drive', 'Direction')).toBe(false);
  });

  it('is false for components/types with no live state', () => {
    const { viewer } = makeViewerWithDrive();
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'LayoutObject', 'Locked')).toBe(false);
    expect(isEphemeralField(viewer, 'Root/Conveyor', 'Metadata', 'Anything')).toBe(false);
  });
});

// ── RVDrive.getLiveState ──────────────────────────────────────────────────

describe('RVDrive.getLiveState', () => {
  it('exposes runtime values under PascalCase keys (no fictional IsPosition)', () => {
    const { drive } = makeViewerWithDrive();
    drive.currentPosition = 4;
    drive.currentSpeed = 1.5;
    drive.isRunning = true;
    const live = drive.getLiveState();
    expect(live.CurrentPosition).toBe(4);
    expect(live.CurrentSpeed).toBe(1.5);
    expect(live.IsRunning).toBe(true);
    expect('IsPosition' in live).toBe(false);
    expect('IsSpeed' in live).toBe(false);
  });
});

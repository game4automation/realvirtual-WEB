// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * spec-loading.test.ts — rv-ODT specification loading (plan-187).
 *
 * Proves that `loadSchemaFromSpec()` reproduces the exact pre-migration inline
 * component schemas from schema/v1/rv-odt.json (determinism, per component,
 * against the frozen baseline in tests/fixtures/inline-schemas-baseline.ts),
 * and that every in-scope registered component has a spec entry (coverage over
 * all three registry mechanisms).
 */

import { describe, it, expect } from 'vitest';
import {
  loadSchemaFromSpec,
  getRegisteredFactories,
  getRegisteredSchemaTypes,
} from '../src/core/engine/rv-component-registry';
// CRITICAL: side-effect imports populate the registries via registerComponent /
// registerComponentSchema at module load. Without these, the registries are
// empty at test start and the coverage test would trivially pass.
import '../src/core/engine/rv-scene-loader';
import '../src/core/engine/rv-drive';
import '../src/core/engine/rv-drive-simple';
import '../src/core/engine/rv-drive-cylinder';
import '../src/core/engine/rv-drive-gear';
import '../src/core/engine/rv-drive-speed';
import '../src/core/engine/rv-drive-follow-position';
import '../src/core/engine/rv-drive-destination-motor';
import '../src/core/engine/rv-drive-position-switch';
import '../src/core/engine/rv-erratic';
import '../src/core/editor/rv-cadlink';
import '../src/core/editor/rv-jt-data';
import { getValidatorConsumedTypes } from '../src/core/engine/rv-extras-validator';
import { INLINE_SCHEMA_BASELINE, ODT_V1_COMPONENT_KEYS } from './fixtures/inline-schemas-baseline';
import rvOdt from '../schema/v1/rv-odt.json';

/**
 * Registry entries that are OUT OF SCOPE for rv-ODT v1 (see
 * schema/v1/specification.md, "Out of Scope"):
 *  - DES plugin components (`DES*`) — private tier, own future schema.
 *  - Library behavior marker schemas (`*Behavior`) registered dynamically by
 *    define-library-component.ts (ConveyorBehavior, TurntableBehavior,
 *    SourceBehavior, SinkBehavior, ChainTransferBehavior, ...).
 *  - Material-flow dynamic schemas registered by material-flow/registry.ts for
 *    library types without an engine factory (Conveyor, Turntable, ChainTransfer).
 *  - `NodeKnowledge` (plan-394) — a WEB-ONLY entry with no Unity counterpart. rv-ODT
 *    describes the types that exist on BOTH sides, so adding it there would assert an
 *    interchange contract that does not exist; the plan's decision is explicitly that
 *    `schema/v1/rv-odt.json` stays untouched. Its inline schema lives in
 *    `src/core/engine/rv-node-knowledge.ts`, which `doc-extending-webviewer.md`
 *    sanctions for exactly this case.
 */
const OUT_OF_SCOPE_EXACT = new Set([
  'Conveyor', 'Turntable', 'ChainTransfer',
  'NodeKnowledge',
]);
function isInScope(name: string): boolean {
  if (name.startsWith('DES')) return false;
  if (name.endsWith('Behavior')) return false;
  if (OUT_OF_SCOPE_EXACT.has(name)) return false;
  return true;
}

describe('rv-ODT spec loading', () => {
  // ----- Snapshot completeness -----
  // Bidirectional, so it cannot drift silently: the previous hard count (`toHaveLength(35)`)
  // only ever saw ONE side, and the index test below only checks "index -> $defs". Comparing
  // both key sets catches an entry that reaches the baseline without an index entry AND one
  // that reaches the index without a baseline entry.
  //
  // The baseline spans several index groups (e.g. `Group` is indexed under `structure`, not
  // `components`), so the two directions are checked against different sets.
  //
  // KNOWN GAP: `WebComponent` sits in the `components` index with a full $def but was never
  // added to the baseline — pre-existing drift, surfaced by this test when it was introduced
  // (plan-335). It is listed here rather than silently fixed because it belongs to another
  // feature; adding it to the baseline is that feature's call. Remove once reconciled.
  const BASELINE_GAP = new Set(['WebComponent']);
  it('every baseline type is indexed, and every indexed component is in the baseline', () => {
    const doc = rvOdt as unknown as Record<string, Record<string, unknown>>;
    const allIndexed = new Set(
      ['components', 'signals', 'logicSteps', 'structure', 'recording', 'connections']
        .flatMap((g) => Object.keys(doc[g] ?? {})),
    );
    // Direction 1: nothing in the baseline is missing from the rv-ODT index.
    const unindexed = ODT_V1_COMPONENT_KEYS.filter((k) => !allIndexed.has(k));
    expect(unindexed, 'baseline types without an rv-odt.json index entry').toEqual([]);

    // Direction 2: nothing in the components index is missing from the baseline.
    const missingFromBaseline = Object.keys(doc.components)
      .filter((k) => !BASELINE_GAP.has(k) && !ODT_V1_COMPONENT_KEYS.includes(k));
    expect(missingFromBaseline, 'indexed components missing from the baseline').toEqual([]);
  });

  // ----- Determinism (frozen baseline, NOT RV*.schema — that is spec-loaded after migration) -----
  const allComponents = Object.entries(INLINE_SCHEMA_BASELINE);

  it.each(allComponents)('loadSchemaFromSpec(%s) equals baseline snapshot', (name, baseline) => {
    expect(loadSchemaFromSpec(name)).toEqual(baseline);
  });

  // ----- enum coverage -----
  it('Drive.Direction enumMap covers all seven values incl. Virtual', () => {
    const s = loadSchemaFromSpec('Drive');
    expect(Object.keys(s.Direction.enumMap!)).toEqual(
      expect.arrayContaining(['LinearX', 'LinearY', 'LinearZ', 'RotationX', 'RotationY', 'RotationZ', 'Virtual']),
    );
    expect(Object.keys(s.Direction.enumMap!)).toHaveLength(7);
  });

  it('Grip.PlaceMode enumMap covers all values', () => {
    const s = loadSchemaFromSpec('Grip');
    expect(Object.keys(s.PlaceMode.enumMap!)).toEqual(
      expect.arrayContaining(['Auto', 'Static', 'Physics']),
    );
  });

  it('CustomRuntimeInstruction.type enumMap maps wire names AND legacy int indices to internal values', () => {
    const s = loadSchemaFromSpec('CustomRuntimeInstruction');
    expect(s.type.enumMap!['Error']).toBe('error');
    expect(s.type.enumMap!['3']).toBe('error');
    expect(s.type.default).toBe('info');
  });

  it('WebError.HighlightStyle enumMap accepts legacy int indices', () => {
    const s = loadSchemaFromSpec('WebError');
    expect(s.HighlightStyle.enumMap!['1']).toBe('FlashObject');
    expect(s.HighlightStyle.enumMap!['FlashObject']).toBe('FlashObject');
  });

  // ----- unityCoords -----
  it('TransportSurface.TransportDirection has unityCoords flag', () => {
    const s = loadSchemaFromSpec('TransportSurface');
    expect(s.TransportDirection.unityCoords).toBe(true);
  });

  it('Sensor.RayCastDirection has unityCoords flag', () => {
    const s = loadSchemaFromSpec('Sensor');
    expect(s.RayCastDirection.unityCoords).toBe(true);
  });

  // ----- componentRef + signal keyword -----
  it('Drive_Simple signal slots map to componentRef with PLC signal types', () => {
    const s = loadSchemaFromSpec('Drive_Simple');
    expect(s.Forward).toEqual({ type: 'componentRef', signal: 'PLCOutputBool' });
    expect(s.IsAtPosition).toEqual({ type: 'componentRef', signal: 'PLCInputFloat' });
  });

  it('Lamp keeps OnColor raw and exposes signal fields as component references', () => {
    const s = loadSchemaFromSpec('Lamp');
    expect(s.SignalLampOn).toEqual({ type: 'componentRef', signal: 'PLCOutputBool' });
    expect(s.SingalLampFlashing).toEqual({
      type: 'componentRef',
      signal: 'PLCOutputBool',
      aliases: ['SignalLampFlashing'],
    });
    expect(s).not.toHaveProperty('OnColor');
  });

  // ----- readonly keyword -----
  it('CADLink fields are readonly', () => {
    const s = loadSchemaFromSpec('CADLink');
    for (const desc of Object.values(s)) expect(desc.readonly).toBe(true);
  });

  // ----- Multi-aliases -----
  it('Source has aliases for Interval and GenerateIfDistance', () => {
    const s = loadSchemaFromSpec('Source');
    expect(s.Interval.aliases).toContain('SpawnInterval');
    expect(s.GenerateIfDistance.aliases).toContain('SpawnDistance');
  });

  // ----- Empty schema (Sink edge case) -----
  it('Sink returns empty schema without throwing', () => {
    expect(() => loadSchemaFromSpec('Sink')).not.toThrow();
    expect(loadSchemaFromSpec('Sink')).toEqual({});
  });

  // ----- Unknown component -----
  it('unknown component name throws', () => {
    expect(() => loadSchemaFromSpec('NotARealComponent')).toThrow(/no \$def/);
  });

  // ----- Coverage over the FULL consumed rv_extras surface (validator anchor) -----
  it('every CONSUMED type in rv-extras-validator.ts has a $def in rv-odt.json', () => {
    const defs = (rvOdt as unknown as { $defs: Record<string, unknown> }).$defs;
    for (const type of getValidatorConsumedTypes()) {
      expect(defs[type],
        `validator CONSUMED type '${type}' has no $def in schema/v1/rv-odt.json — add it or put it on the documented out-of-scope list`,
      ).toBeDefined();
    }
  });

  it('rv-odt.json index groups reference existing $defs', () => {
    const doc = rvOdt as unknown as Record<string, Record<string, { $ref?: string }>> & { $defs: Record<string, unknown> };
    for (const group of ['components', 'signals', 'logicSteps', 'structure', 'recording', 'connections'] as const) {
      for (const [name, entry] of Object.entries(doc[group])) {
        expect(entry.$ref).toBe(`#/$defs/${name}`);
        expect(doc.$defs[name], `index group '${group}' references missing $def '${name}'`).toBeDefined();
      }
    }
  });

  // ----- Coverage over all three registry mechanisms -----
  it('every in-scope component with a registered schema has a spec entry', () => {
    const all = new Set([
      ...[...getRegisteredFactories().keys()].filter(isInScope),
      ...getRegisteredSchemaTypes().filter(isInScope),
      // Tooltip-only / schema-bearing-without-registry-entry — hardcoded:
      'Pipe', 'Pump', 'ResourceTank', 'ProcessingUnit',
    ]);
    for (const name of all) {
      expect(ODT_V1_COMPONENT_KEYS, `component '${name}' is registered but missing from rv-ODT v1 — add it to rv-odt.json + baseline or declare it out of scope`).toContain(name);
      expect(() => loadSchemaFromSpec(name), `missing spec for ${name}`).not.toThrow();
    }
  });
});

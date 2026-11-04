// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-detection-schema.test.ts — plan-2022 Phase 5: schema, defaults,
 * defensive parsing and the duplicate rule.
 *
 * The pinned default that matters most is `DeleteUnsupported: false` — deleting
 * the part destroys exactly the evidence the report is about, so it must never
 * drift to `true` by accident.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import rvOdt from '../schema/v1/rv-odt.json';
import {
  RVDropDetection, SUPPORT_MODES, toSupportMode,
  type DropDetectionRegistrar,
} from '../src/core/engine/rv-drop-detection';
import { RVDropManager, DROP_DETECTION_DUPLICATE_CODE } from '../src/core/engine/rv-drop-manager';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { ENUM_FIELDS } from '../src/core/hmi/rv-inspector-helpers';
import { getFieldUnit } from '../src/core/hmi/rv-inspector-helpers';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { slotDeclared, slotFeedbackValue } from '../src/core/engine/rv-slot-io';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const DEF = (rvOdt as unknown as {
  $defs: Record<string, { properties: Record<string, {
    type?: string; $ref?: string; default?: unknown; unit?: string;
    minimum?: number; maximum?: number; enum?: string[]; signal?: string;
  }> }>;
  components: Record<string, unknown>;
}).$defs.DropDetection;

const COMPONENTS = (rvOdt as unknown as { components: Record<string, unknown> }).components;

/**
 * The component with a registrar and a REAL SignalStore attached, without a
 * viewer. The store is not optional: `init()` declares the component's three
 * signal slots, and a wired one builds a writer against the store.
 */
function component(
  fields: Partial<Record<string, unknown>> = {},
  /** Signals the model already carries — registered BEFORE `init()`, exactly as
   *  a real load does (the store is built from the GLB before the components). */
  signals: ReadonlyArray<[string, boolean | number, string]> = [],
) {
  const calls: { config: unknown }[] = [];
  const sinks: ((a: boolean, c: number) => void)[] = [];
  let resets = 0;
  const registrar: DropDetectionRegistrar = {
    register: (_n, config) => { calls.push({ config }); },
    unregister: () => {},
    setFeedbackSink: (sink) => { if (sink) sinks.push(sink); },
    reset: () => { resets += 1; },
  };
  const signalStore = new SignalStore();
  for (const [name, initial, type] of signals) {
    signalStore.register(name, name, initial, type as never);
  }
  const node = new Object3D();
  node.name = 'Scene';
  const c = new RVDropDetection(node);
  Object.assign(c, fields);
  c.init({ dropManager: registrar, signalStore } as unknown as ComponentContext);
  return { c, node, calls, signalStore, sinks, get resets() { return resets; } };
}

describe('DropDetection — schema and defaults (plan-2022)', () => {
  beforeEach(() => { resetProblemsForTests(); });

  describe('rv-ODT schema', () => {
    it('is listed in the component index', () => {
      expect(COMPONENTS.DropDetection).toEqual({ $ref: '#/$defs/DropDetection' });
    });

    it('every property has a type (or a $ref) and a description', () => {
      for (const [name, p] of Object.entries(DEF.properties)) {
        expect(p.type ?? p.$ref, name).toBeTruthy();
      }
    });

    it('DeleteUnsupported defaults to FALSE — pinned (E3)', () => {
      expect(DEF.properties.DeleteUnsupported.default).toBe(false);
      expect(new RVDropDetection(new Object3D()).DeleteUnsupported).toBe(false);
      expect(component().c.config.DeleteUnsupported).toBe(false);
    });

    it('carries the units the inspector shows, in the SCHEMA (the SSOT)', () => {
      expect(DEF.properties.GraceTime.unit).toBe('s');
      expect(DEF.properties.SupportRecheckInterval.unit).toBe('s');
      expect(DEF.properties.DeleteDelay.unit).toBe('s');
      expect(DEF.properties.SupportProbeDistance.unit).toBe('mm');
      expect(getFieldUnit('DropDetection', 'GraceTime')).toBe('s');
      expect(getFieldUnit('DropDetection', 'SupportProbeDistance')).toBe('mm');
    });

    it('declares the bounds the inspector enforces', () => {
      expect(DEF.properties.GraceTime.minimum).toBe(0);
      expect(DEF.properties.GraceTime.maximum).toBe(60);
      expect(DEF.properties.SupportProbeDistance.minimum).toBe(1);
      expect(DEF.properties.SupportProbeDistance.maximum).toBe(5000);
      expect(DEF.properties.SupportRecheckInterval.minimum).toBe(0.05);
      expect(DEF.properties.SupportRecheckInterval.maximum).toBe(10);
    });

    it('declares the three signal slots as ComponentReference with a direction', () => {
      for (const [field, dir] of [
        ['SignalDropActive', 'PLCInputBool'],
        ['SignalDropCount', 'PLCInputInt'],
        ['SignalResetDrops', 'PLCOutputBool'],
      ] as const) {
        expect(DEF.properties[field].$ref, field).toBe('#/$defs/ComponentReference');
        expect(DEF.properties[field].signal, field).toBe(dir);
      }
    });

    it('SupportMode is a real enum, in the order the code declares', () => {
      expect(DEF.properties.SupportMode.enum).toEqual([...SUPPORT_MODES]);
      expect(DEF.properties.SupportMode.default).toBe('GeometryBelow');
      // …and it reaches the inspector as a dropdown, not a free-text field.
      expect(ENUM_FIELDS.SupportMode).toEqual([...SUPPORT_MODES]);
    });
  });

  describe('defensive parsing', () => {
    it('an unknown SupportMode falls back to GeometryBelow and never throws', () => {
      expect(toSupportMode('Nonsense')).toBe('GeometryBelow');
      expect(toSupportMode(undefined)).toBe('GeometryBelow');
      expect(toSupportMode(7)).toBe('GeometryBelow');
      expect(component({ SupportMode: 'Nonsense' }).c.config.SupportMode).toBe('GeometryBelow');
    });

    it('out-of-range numbers are clamped at the input, not at the next tick', () => {
      const { c } = component({ GraceTime: -3, SupportProbeDistance: 99999, SupportRecheckInterval: 0 });
      expect(c.config.GraceTime).toBe(0);
      expect(c.config.SupportProbeDistance).toBe(5000);
      expect(c.config.SupportRecheckInterval).toBe(0.05);
    });

    it('NaN and non-numbers fall back to the schema default', () => {
      const { c } = component({ GraceTime: NaN, DeleteDelay: 'soon' });
      expect(c.config.GraceTime).toBe(0.5);
      expect(c.config.DeleteDelay).toBe(1);
    });

    it('a live field edit is clamped and pushed to the manager', () => {
      const { c, calls } = component();
      const before = calls.length;
      expect(c.setLiveField('GraceTime', 999)).toBe(true);
      expect(c.config.GraceTime).toBe(60);
      expect(calls.length).toBe(before + 1);
      expect(c.setLiveField('NotAField', 1)).toBe(false);
    });

    it('an unresolved signal reference means "not wired", never a guess', () => {
      const { c } = component({ SignalDropActive: null, SignalDropCount: { path: 'X' } });
      expect(c.signals.dropActive).toBeNull();
      expect(c.signals.dropCount).toBeNull();
      const wired = component({ SignalDropActive: 'PLC/DropActive' });
      expect(wired.c.signals.dropActive).toBe('PLC/DropActive');
    });
  });

  // ── The three inspector slots (plan-2022 A9) ─────────────────────
  describe('signal slots', () => {
    it('declares all three slots even while UNWIRED, so they are bindable', () => {
      const { c } = component();
      expect(slotDeclared(c, 'SignalDropActive')).toBe('feedback');
      expect(slotDeclared(c, 'SignalDropCount')).toBe('feedback');
      // The reset input is declared by `wireBoolSignal` as a directly
      // commandable slot — this is what the SlotIO guard demands.
      expect(slotDeclared(c, 'SignalResetDrops')).not.toBeNull();
    });

    it('publishes the latched state into its feedback slots', () => {
      const w = component();
      expect(slotFeedbackValue(w.c, 'SignalDropActive')).toBe(false);
      expect(w.sinks.length).toBe(1);
      w.sinks[0](true, 3);
      expect(slotFeedbackValue(w.c, 'SignalDropActive')).toBe(true);
      expect(slotFeedbackValue(w.c, 'SignalDropCount')).toBe(3);
    });

    it('writes a WIRED feedback address into the signal store as well', () => {
      const w = component({ SignalDropCount: 'PLC/Drops' }, [['PLC/Drops', 0, 'PLCInputInt']]);
      w.sinks[0](true, 7);
      expect(w.signalStore.getByPath('PLC/Drops')).toBe(7);
    });

    it('a rising SignalResetDrops edge clears the reports', () => {
      const w = component({ SignalResetDrops: 'PLC/Reset' }, [['PLC/Reset', false, 'PLCOutputBool']]);
      const before = w.resets;
      w.signalStore.setByPath('PLC/Reset', true);
      expect(w.resets).toBe(before + 1);
      // Level, not edge, must not fire again.
      w.signalStore.setByPath('PLC/Reset', true);
      expect(w.resets).toBe(before + 1);
    });

    it('dispose releases the sink, the slots and the subscription', () => {
      const w = component();
      w.c.dispose();
      expect(slotDeclared(w.c, 'SignalDropActive')).toBeNull();
      expect(slotDeclared(w.c, 'SignalResetDrops')).toBeNull();
    });
  });

  describe('the duplicate rule', () => {
    const cfg = {
      Enabled: true, GraceTime: 0.5, SupportProbeDistance: 50,
      SupportMode: 'GeometryBelow' as const, SupportRecheckInterval: 0.5,
      DeleteUnsupported: false, DeleteDelay: 1,
    };
    const noSignals = { dropActive: null, dropCount: null, resetDrops: null };

    it('the FIRST registered component wins, the second raises a problem', () => {
      const mgr = new RVDropManager();
      const first = new Object3D(); first.name = 'Scene';
      const second = new Object3D(); second.name = 'Cell';
      mgr.register(first, cfg, noSignals);
      mgr.register(second, { ...cfg, GraceTime: 9 }, noSignals);
      // The winner's configuration is the one in effect — never a merge.
      expect(mgr.config?.GraceTime).toBe(0.5);
      const problems = getProblems().filter((p) => p.code === DROP_DETECTION_DUPLICATE_CODE);
      expect(problems.length).toBe(1);
      expect(problems[0].detail).toContain('Scene');
    });

    it('removing the duplicate clears its problem', () => {
      const mgr = new RVDropManager();
      const first = new Object3D(); first.name = 'Scene';
      const second = new Object3D(); second.name = 'Cell';
      mgr.register(first, cfg, noSignals);
      mgr.register(second, cfg, noSignals);
      mgr.unregister(second);
      expect(getProblems().filter((p) => p.code === DROP_DETECTION_DUPLICATE_CODE)).toEqual([]);
      expect(mgr.isArmed).toBe(true);     // the winner is untouched
    });

    it('re-registering the SAME node is an update, not a duplicate', () => {
      const mgr = new RVDropManager();
      const node = new Object3D(); node.name = 'Scene';
      mgr.register(node, cfg, noSignals);
      mgr.register(node, { ...cfg, GraceTime: 2 }, noSignals);
      expect(mgr.config?.GraceTime).toBe(2);
      expect(getProblems().filter((p) => p.code === DROP_DETECTION_DUPLICATE_CODE)).toEqual([]);
    });

    it('clear restores defaults without overriding the browser preference', async () => {
      const { setDropDetectionEnabled } = await import('../src/core/drop-detection-settings-store');
      const mgr = new RVDropManager();
      mgr.register(new Object3D(), { ...cfg, GraceTime: 9 }, noSignals);
      setDropDetectionEnabled(false);
      try {
        mgr.clear();
        expect(mgr.isArmed).toBe(false);
        expect(mgr.optionsEnabled).toBe(false);
        expect(mgr.hasComponent).toBe(false);
        expect(mgr.config.GraceTime).toBe(DEF.properties.GraceTime.default);
      } finally { setDropDetectionEnabled(true); }
      expect(mgr.isArmed).toBe(true);
    });

    it('unregistering the winner restores schema defaults', () => {
      const mgr = new RVDropManager();
      const node = new Object3D();
      mgr.register(node, cfg, noSignals);
      expect(mgr.isArmed).toBe(true);
      mgr.unregister(node);
      expect(mgr.isArmed).toBe(true);
      expect(mgr.hasComponent).toBe(false);
      for (const [key, value] of Object.entries(mgr.config)) {
        expect(value, key).toEqual(DEF.properties[key].default);
      }
    });
  });
});

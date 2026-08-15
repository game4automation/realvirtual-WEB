// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * slot-write-role-registry.test.ts — plan-353 §9.7 (F6, §5.3).
 *
 * The write gate needs to know whether a bound slot COMMANDS the model or
 * REPORTS it. That fact already existed, privately, inside the binding manager
 * (`_deriveSlotRole`); plan-353 mirrors it into the authority service so the
 * gate can read it as a Map lookup instead of deriving it per write.
 *
 * A mirror is only worth having if it cannot go stale, so this suite is mostly
 * about LIFECYCLE: registered on bind, updated when the derivation changes its
 * mind, dropped on unbind, emptied on a model switch. Plus the default, which
 * is the safety property: anything unregistered must behave exactly as it did
 * before plan-353.
 *
 * The derivation itself is NOT re-implemented here — it is exercised through the
 * real manager, one test per way `_deriveSlotRole()` can reach an answer (§5.3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  clearSlotWriteRole,
  getSlotWriteRole,
  makeSlotId,
  registerSlotWriteRole,
  resetSlotAuthority,
  slotWriteRoleCount,
  type SlotWriteRole,
} from '../src/core/engine/rv-slot-authority';

afterEach(() => resetSlotAuthority());

// ── The registry as such ────────────────────────────────────────────────────

describe('slot write-role registry — the map itself', () => {
  const slotId = makeSlotId('el-1', 'Conveyor', 'Conveyor', 'Flow.Run');

  it("defaults to 'control' for a slot nobody registered", () => {
    // THE safety property: an unregistered slot keeps the pre-plan-353 rule
    // (bound ⇒ local writes rejected). A forgotten mirror can only ever be too
    // strict, never too permissive.
    expect(getSlotWriteRole(slotId)).toBe('control');
    expect(slotWriteRoleCount()).toBe(0);
  });

  it('stores, overwrites and clears a role', () => {
    registerSlotWriteRole(slotId, 'feedback');
    expect(getSlotWriteRole(slotId)).toBe('feedback');
    expect(slotWriteRoleCount()).toBe(1);

    registerSlotWriteRole(slotId, 'control');   // overwrite, not a second entry
    expect(getSlotWriteRole(slotId)).toBe('control');
    expect(slotWriteRoleCount()).toBe(1);

    clearSlotWriteRole(slotId);
    expect(getSlotWriteRole(slotId)).toBe('control');   // back to the default
    expect(slotWriteRoleCount()).toBe(0);
  });

  it('keeps roles of different slots apart', () => {
    const other = makeSlotId('el-2', 'Sensor', 'Sensor', 'Occupied');
    registerSlotWriteRole(slotId, 'control');
    registerSlotWriteRole(other, 'feedback');
    expect(getSlotWriteRole(slotId)).toBe('control');
    expect(getSlotWriteRole(other)).toBe('feedback');
  });

  it('is emptied by resetSlotAuthority (model switch)', () => {
    registerSlotWriteRole(slotId, 'feedback');
    resetSlotAuthority();
    expect(slotWriteRoleCount()).toBe(0);
    // A new model must not inherit a write right from the old one.
    expect(getSlotWriteRole(slotId)).toBe('control');
  });
});

// ── Derivation paths, through the real binding manager ──────────────────────

interface Harness {
  store: SignalStore;
  manager: SignalBindingManager;
  node: Object3D;
  slotId: (slot: string) => ReturnType<typeof makeSlotId>;
}

/**
 * One `Drive_Simple` node wired the way the production resolver expects (same
 * shape as `bind-priority-matrix.test.ts`). `targetType` is the PLC type the
 * SLOT signal is registered with — that is what `_deriveSlotRole()` reads in
 * its store-type stage; omit it to leave the slot untyped.
 */
function harness(options: {
  targetType?: string;
  /** Register a provider — without one the manager is in legacy mode. */
  withProvider?: boolean;
  /** Overrides the component instance (used for the direct-property case). */
  instance?: Record<string, unknown>;
} = {}): Harness {
  const { targetType, withProvider = true, instance } = options;
  const componentType = 'Drive_Simple';

  const store = new SignalStore();
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'Drive';
  node.userData.realvirtual = { [componentType]: {} };
  new Scene().add(node);
  registry.registerNode('Drive', node);
  registry.register(componentType, 'Drive', instance ?? {
    Forward: 'Drive/Forward', Backward: null, liveControlled: false,
  });

  // Only registered when the slot is meant to HAVE a target signal; the
  // direct-property case deliberately has none.
  if (!instance) store.register('Drive.Forward', 'Drive/Forward', false, targetType);

  store.register('PLC.Run', '__iface__/PLC.Run', true, 'PLCOutputBool');
  if (withProvider) store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Run' }, true);

  const manager = new SignalBindingManager(store, registry);
  return {
    store,
    manager,
    node,
    // componentPath is '.' — the component sits on the placement node itself,
    // so the resolver's relative path is the current node, not its name.
    slotId: (s: string) => makeSlotId('Drive', '.', componentType, s),
  };
}

/** Bind `slot` to the CONNECT source and return the role the mirror published. */
function bindAndReadRole(h: Harness, slot = 'Forward'): SlotWriteRole {
  h.manager.bind('Drive', h.node, {
    slot, signal: 'PLC.Run', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
  });
  return getSlotWriteRole(h.slotId(slot));
}

describe('slot write-role registry — every derivation path is mirrored (§5.3)', () => {
  it("providerless legacy mode yields 'control'", () => {
    // The pre-provider standalone contract: with no provider registered at all,
    // every slot is a command slot. Mirrored as such — this is NOT the same as
    // "unknown", and it must not gain the feedback exemption.
    const h = harness({ withProvider: false, targetType: 'PLCInputBool' });
    expect(bindAndReadRole(h)).toBe('control');
  });

  it("a PLCOutput slot signal yields 'control'", () => {
    const h = harness({ targetType: 'PLCOutputBool' });
    expect(bindAndReadRole(h)).toBe('control');
  });

  it("a PLCInput slot signal yields 'feedback'", () => {
    const h = harness({ targetType: 'PLCInputBool' });
    expect(bindAndReadRole(h)).toBe('feedback');
  });

  it("an untyped slot signal without a descriptor fallback yields 'unknown'", () => {
    // Genuinely underived — and 'unknown' must behave like 'control' at the
    // gate, never like 'feedback' (plan-353 §5.3: no silent new write right).
    const h = harness({ targetType: undefined });
    expect(bindAndReadRole(h)).toBe('unknown');
  });

  it("a direct-property (command) slot yields 'control'", () => {
    // No target signal: the slot is driven through command/neutralize.
    const h = harness({
      instance: {
        Forward: null,
        commandForward: vi.fn(),
        neutralizeForward: vi.fn(),
      },
    });
    expect(bindAndReadRole(h, 'Forward')).toBe('control');
  });
});

// ── Lifecycle through the manager ───────────────────────────────────────────

describe('slot write-role registry — lifecycle follows the binding', () => {
  it('registers on bind and drops on unbind', () => {
    const h = harness({ targetType: 'PLCInputBool' });
    expect(slotWriteRoleCount()).toBe(0);

    expect(bindAndReadRole(h)).toBe('feedback');
    expect(slotWriteRoleCount()).toBe(1);

    h.manager.unbind('Drive', 'Forward');
    expect(slotWriteRoleCount()).toBe(0);
    expect(getSlotWriteRole(h.slotId('Forward'))).toBe('control');
  });

  it('follows a role CHANGE at runtime instead of freezing the bind-time answer', () => {
    // The regression a register-once mirror would have: the derivation depends
    // on the registered store type, which arrives with the gateway — so the
    // role legitimately moves from 'unknown' to a real one after connect. If
    // the mirror froze, a feedback slot would stay rejected forever.
    const h = harness({ targetType: undefined });
    expect(bindAndReadRole(h)).toBe('unknown');

    // The gateway now supplies the type; the manager re-derives on tick.
    h.store.register('Drive.Forward', 'Drive/Forward', false, 'PLCInputBool');
    h.manager.tick(0.02);

    expect(getSlotWriteRole(h.slotId('Forward'))).toBe('feedback');
  });

  it('unbindAll clears the roles of every slot of the element', () => {
    const h = harness({ targetType: 'PLCInputBool' });
    bindAndReadRole(h);
    expect(slotWriteRoleCount()).toBe(1);

    h.manager.unbindAll('Drive');
    expect(slotWriteRoleCount()).toBe(0);
  });
});

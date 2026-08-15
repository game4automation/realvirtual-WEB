// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-signal-bind-tools — the four tools a language model binds a PLC with
 * (plan-425 F5/F6, tests 9.5 and 9.6).
 *
 * The two things this file is really about are both refusals.
 *
 * A Planner placement aggregates its whole subtree, so `Forward` is not a unique
 * address within a target — and a mutation that picked one of two identically
 * named slots would replace the wrong link, silently, on a machine. So the
 * ambiguity case below is not an edge case; it is the shape of the product.
 *
 * And a bind that cannot be SAVED must not be made. Node persistence is a silent
 * no-op without an active edit target: the tool would report success, the model
 * would move on to the next of two hundred signals, and the whole session would
 * be gone on reload with nothing having said so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { McpSignalBindTools } from '../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { mergeAppliedMappings } from '../src/plugins/signal-bind/binding-inventory';
import type { RVViewer } from '../src/core/rv-viewer';

/** An edit target that accepts ops and remembers them — persistence is available. */
function recordingEditTarget() {
  const ops: Array<{ kind: string; nodePath: string; value?: unknown }> = [];
  const target: EditTarget = {
    available: true,
    setField: (nodePath, _c, _f, value) => { ops.push({ kind: 'setField', nodePath, value }); },
    unsetField: (nodePath) => { ops.push({ kind: 'unsetField', nodePath }); },
    withTransaction: async (_label, fn) => { await fn(); },
  };
  return { target, ops };
}

/** An edit target that reports itself unavailable — the pre-boot / viewer case. */
const UNAVAILABLE: EditTarget = {
  available: false,
  setField: () => { throw new Error('must not be called'); },
  unsetField: () => { throw new Error('must not be called'); },
  withTransaction: async (_label, fn) => { await fn(); },
};

interface Fixture {
  viewer: RVViewer;
  tools: McpSignalBindTools;
  mgr: SignalBindingManager;
  root: Object3D;
}

/**
 * A machine with TWO drives that both call their slot `Forward`.
 *
 * With `placed` (the default) the machine is a Planner placement, which
 * AGGREGATES its subtree into one target — so `Forward` genuinely occurs twice
 * under one id. That is the shape the canonical slot identity exists for, and
 * the only shape in which the ambiguity refusals mean anything.
 *
 * Without it, each drive is its own node target and persistence runs through the
 * edit-target seam instead of the planner store — which is what the
 * "cannot be saved" cases need, since the planner is always available when it
 * is the thing holding the mappings.
 */
function makeFixture(options?: { placed?: boolean }): Fixture {
  const placed = options?.placed ?? true;
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = 'Machine';
  registry.registerNode('Machine', root);

  for (const arm of ['Left', 'Right']) {
    const node = new Object3D();
    node.name = arm;
    root.add(node);
    const path = `Machine/${arm}`;
    store.register(`${arm}.Forward`, `${path}/Forward`, false, 'PLCInputBool');
    node.userData.realvirtual = {
      Drive_Simple: {
        Forward: { type: 'ComponentReference', path: `${path}/Forward`, componentType: 'PLCInputBool' },
      },
    };
    registry.registerNode(path, node);
    registry.register('Drive_Simple', path, {
      Forward: `${arm}.Forward`,
      Backward: null,
      commandBackward: () => { /* command sink */ },
      neutralizeBackward: () => { /* neutral */ },
    });
  }

  // The external signals a customer PLC would offer, with the comments that make
  // them matchable by name at all.
  store.register('PLC.Start', 'plc/start', false, 'PLCOutputBool');
  store.registerSignalProvider({ interfaceId: 'plc-1', signal: 'PLC.Start' }, true);
  store.setSignalMeta('PLC.Start', { comment: 'Conveyor start command' });
  store.register('PLC.Speed', 'plc/speed', 0, 'PLCOutputFloat');
  store.registerSignalProvider({ interfaceId: 'plc-1', signal: 'PLC.Speed' }, true);

  const mgr = new SignalBindingManager(store, registry);

  // A planner just real enough for the placed persistence branch: it holds the
  // mappings itself, so a bind against it must survive a re-read from HERE.
  let mappings: unknown[] = [];
  const planner = {
    id: 'layout-planner',
    store: {
      getSnapshot: () => ({ placed: [{ id: 'p1', signalMappings: mappings }] }),
      updateSignalMappings: (_id: string, next: unknown[]) => { mappings = next; },
      subscribe: () => () => { /* no reactivity needed here */ },
    },
    getPlacedRootById: (id: string) => (id === 'p1' ? root : null),
    findPlacedAncestor: (node: Object3D) => {
      for (let n: Object3D | null = node; n; n = n.parent) {
        if (n === root) return { id: 'p1', root };
      }
      return null;
    },
  };

  const viewer = {
    registry,
    signalStore: store,
    signalBindingManager: mgr,
    getPlugin: (id: string) => (placed && id === 'layout-planner' ? planner : undefined),
    behaviors: { getActiveBinds: () => [] },
  } as unknown as RVViewer;

  return { viewer, tools: new McpSignalBindTools(() => viewer), mgr, root };
}

const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;

let recorder: ReturnType<typeof recordingEditTarget>;

beforeEach(() => {
  recorder = recordingEditTarget();
  setActiveEditTarget(recorder.target);
});
afterEach(() => setActiveEditTarget(null));

describe('web_signal_bindings_list', () => {
  it('publishes the FULL slot identity, not just the slot name', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalBindingsList());
    const slots = answer.slots as Array<Record<string, unknown>>;
    const forwards = slots.filter((s) => s.slot === 'Forward');
    // Two slots called Forward — and each carries the componentPath that tells
    // them apart. Without it the list would be self-contradictory.
    expect(forwards).toHaveLength(2);
    expect(forwards.map((s) => s.componentPath).sort()).toEqual(['Left', 'Right']);
    for (const slot of forwards) expect(slot.targetId).toBe('p1');
  });

  it('carries the orphan section in the SAME answer', async () => {
    // The user's shrink of the tool surface: no separate orphans tool, so a
    // model that has listed the bindings already knows what is broken.
    const f = makeFixture();
    f.mgr.applyMappings('p1', f.root, [{
      kind: 'mapped-signal', componentPath: 'Old/Left', componentType: 'Drive_Simple',
      slot: 'Forward', signal: 'PLC.Start', interfaceId: 'plc-1',
      direction: 'plcInput', enabled: true,
    }]);
    const answer = parse(await f.tools.webSignalBindingsList());
    const orphans = answer.orphans as Array<Record<string, unknown>>;
    expect(orphans).toHaveLength(1);
    expect(orphans[0].signal).toBe('PLC.Start');
    // `Old/Left` and `Left` share a leaf and a component type, and `Right` does
    // not — so exactly one candidate, which is what a repair offer requires.
    expect(orphans[0].candidateComponentPath).toBe('Left');
  });
});

describe('web_signal_sources_list', () => {
  it('lists the CONNECT signals with their provider and comment', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalSourcesList('PLC.Start'));
    const signals = answer.signals as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(1);
    expect(signals[0].interfaceId).toBe('plc-1');
    // The comment is the whole reason a model can match a Siemens symbol to a
    // slot called Forward at all.
    expect(signals[0].comment).toBe('Conveyor start command');
  });
});

describe('web_signal_bind', () => {
  it('binds and persists the slot it was given', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalBind('p1', 'Left', 'Forward', 'PLC.Start'));
    expect(answer.error).toBeUndefined();
    expect(answer.componentPath).toBe('Left');
    // `persisted` is read BACK out of the persistence adapter, not asserted from
    // the intent — the pre-check exists because those are different claims.
    expect(answer.persisted).toBe(true);
    expect(f.mgr.getBindingLiveness('p1', 'Forward', 'Left')).toBeDefined();
  });

  it('records a real op for a NODE target, so a reload finds the link', async () => {
    const f = makeFixture({ placed: false });
    const answer = parse(await f.tools.webSignalBind('Machine/Left', '.', 'Forward', 'PLC.Start'));
    expect(answer.persisted).toBe(true);
    const written = recorder.ops.filter((op) => op.kind === 'setField');
    expect(written).toHaveLength(1);
    expect(written[0].nodePath).toBe('Machine/Left');
  });

  it('refuses an ambiguous slot instead of picking one', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalBind('p1', '', 'Forward', 'PLC.Start'));
    expect(answer.error).toContain('ambiguous');
    expect((answer.candidates as string[]).sort()).toEqual(['Left', 'Right']);
    // And nothing was written on the way to the refusal.
    expect(recorder.ops).toEqual([]);
  });

  it('gives the SAME words a manual drag would give on a type mismatch', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalBind('p1', 'Left', 'Forward', 'PLC.Speed'));
    expect(answer.error).toContain('Type mismatch');
    expect(answer.reason).toBe('type');
    expect(recorder.ops).toEqual([]);
  });

  it('refuses a signal that does not exist', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalBind('p1', 'Left', 'Forward', 'PLC.Nope'));
    expect(answer.error).toContain('not found');
  });

  it('refuses an unknown target and says where to find real ones', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalBind('Nowhere', 'Left', 'Forward', 'PLC.Start'));
    expect(answer.error).toContain('not found');
    expect(answer.hint).toContain('web_signal_bindings_list');
  });

  it('fails WITHOUT mutating when the binding could not be saved', async () => {
    // The pre-check. A tool that bound the signal and then discovered it could
    // not persist would leave the session and the file disagreeing. A NODE
    // target is the case that can hit this: its persistence runs through the
    // edit-target seam, which is a silent no-op when nothing is editable.
    setActiveEditTarget(UNAVAILABLE);
    const f = makeFixture({ placed: false });
    const answer = parse(await f.tools.webSignalBind('Machine/Left', '.', 'Forward', 'PLC.Start'));
    expect(answer.error).toContain('cannot be saved');
    expect(answer.persisted).toBe(false);
    expect(f.mgr.getBindingLiveness('Machine/Left', 'Forward', '.')).toBeUndefined();
  });
});

describe('keeping broken links while changing a good one', () => {
  // `applyMappings()` returns only what it could bind, so persisting its result
  // directly would delete every unresolvable mapping on the same target. Orphans
  // are deliberately KEPT — loading the previous model makes them live again —
  // so a bind, an unbind or a repair must never take the others with it.
  const BROKEN = {
    kind: 'mapped-signal' as const, componentPath: 'Vanished/Arm',
    componentType: 'Drive_Simple', slot: 'Forward', signal: 'PLC.Start',
    interfaceId: 'plc-1', direction: 'plcOutput' as const, enabled: true,
  };
  const GOOD = { ...BROKEN, componentPath: 'Left' };

  it('keeps the mapping that did not bind', () => {
    const merged = mergeAppliedMappings([BROKEN, GOOD], [GOOD]);
    expect(merged).toHaveLength(2);
    expect(merged[0].componentPath).toBe('Vanished/Arm');
  });

  it('takes the NORMALISED form for the ones that did bind', () => {
    // applyMappings resolves interfaceId and kind; saving the un-normalised
    // request would re-orphan on the next load for a different reason.
    const requested = { ...GOOD, interfaceId: undefined };
    const merged = mergeAppliedMappings([requested], [GOOD]);
    expect(merged[0].interfaceId).toBe('plc-1');
  });

  it('is an identity when everything bound', () => {
    expect(mergeAppliedMappings([GOOD], [GOOD])).toEqual([GOOD]);
  });
});

describe('web_signal_unbind', () => {
  it('removes exactly the slot it was given', async () => {
    const f = makeFixture();
    await f.tools.webSignalBind('p1', 'Left', 'Forward', 'PLC.Start');
    await f.tools.webSignalBind('p1', 'Right', 'Forward', 'PLC.Start');

    const answer = parse(await f.tools.webSignalUnbind('p1', 'Left', 'Forward'));
    expect(answer.unbound).toBe(true);
    expect(answer.remaining).toBe(1);
    expect(answer.persisted).toBe(true);
    expect(f.mgr.getBindingLiveness('p1', 'Forward', 'Right')).toBeDefined();
  });

  it('refuses an ambiguous slot rather than unbinding the wrong one', async () => {
    const f = makeFixture();
    await f.tools.webSignalBind('p1', 'Left', 'Forward', 'PLC.Start');
    const answer = parse(await f.tools.webSignalUnbind('p1', '', 'Forward'));
    expect(answer.error).toContain('ambiguous');
    expect(f.mgr.getBindingLiveness('p1', 'Forward', 'Left')).toBeDefined();
  });

  it('says so when the slot carries nothing', async () => {
    const f = makeFixture();
    const answer = parse(await f.tools.webSignalUnbind('p1', 'Left', 'Forward'));
    expect(answer.error).toContain('no binding');
  });

  it('fails WITHOUT mutating when the change could not be saved', async () => {
    const f = makeFixture({ placed: false });
    await f.tools.webSignalBind('Machine/Left', '.', 'Forward', 'PLC.Start');
    setActiveEditTarget(UNAVAILABLE);
    const answer = parse(await f.tools.webSignalUnbind('Machine/Left', '.', 'Forward'));
    expect(answer.error).toContain('cannot be saved');
    expect(f.mgr.getBindingLiveness('Machine/Left', 'Forward', '.')).toBeDefined();
  });
});

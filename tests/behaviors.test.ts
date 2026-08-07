// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  BehaviorManager,
  defineBehavior,
  compileGlob,
  matchesAny,
  extractGlbName,
  registerAllBehaviors,
} from '../src/core/behaviors';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import type { BindContextHost } from '../src/core/behavior-runtime';

function makeHost(): { host: BindContextHost; events: EventEmitter<Record<string, unknown>> } {
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: null,
    on: (event, cb) => events.on(event, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
  return { host, events };
}

describe('extractGlbName', () => {
  it('strips dir + .glb extension', () => {
    expect(extractGlbName('/public/models/MyMachine.glb')).toBe('MyMachine');
    expect(extractGlbName('http://x/models/Foo_v3.glb?v=1')).toBe('Foo_v3');
    expect(extractGlbName('Bar.GLB')).toBe('Bar');
  });
  it('returns empty string for null/undefined', () => {
    expect(extractGlbName(null)).toBe('');
    expect(extractGlbName(undefined)).toBe('');
  });
});

describe('compileGlob / matchesAny', () => {
  it('* matches any chars including empty', () => {
    expect(compileGlob('Belt_*').test('Belt_')).toBe(true);
    expect(compileGlob('Belt_*').test('Belt_Infeed')).toBe(true);
    expect(compileGlob('Belt_*').test('Belt')).toBe(false);
  });

  it('? matches exactly one char', () => {
    expect(compileGlob('Belt_v?').test('Belt_v1')).toBe(true);
    expect(compileGlob('Belt_v?').test('Belt_v3')).toBe(true);
    expect(compileGlob('Belt_v?').test('Belt_v12')).toBe(false);
    expect(compileGlob('Belt_v?').test('Belt_v')).toBe(false);
  });

  it('matchesAny supports exact, glob, and bare wildcard', () => {
    expect(matchesAny(['Foo'], 'Foo')).toBe(true);
    expect(matchesAny(['Foo'], 'Bar')).toBe(false);
    expect(matchesAny(['Foo_*'], 'Foo_X')).toBe(true);
    expect(matchesAny(['*'], 'AnythingGoes')).toBe(true);
    expect(matchesAny(['A', 'B', 'C_*'], 'C_1')).toBe(true);
  });
});

describe('BehaviorManager — discovery + model match', () => {
  let manager: BehaviorManager;
  beforeEach(() => { manager = new BehaviorManager(); });

  it('register + count + ids', () => {
    manager.register('foo', defineBehavior({ models: ['Foo'], bind: () => {} }));
    manager.register('bar', defineBehavior({ models: ['Bar'], bind: () => {} }));
    expect(manager.count).toBe(2);
    expect(manager.ids()).toEqual(['foo', 'bar']);
  });

  it('rejects malformed behaviors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error invalid shape
    manager.register('bad', { not: 'a behavior' });
    expect(manager.count).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('matches GLB filename, NOT root.name (regression guard)', () => {
    // Behavior models: ['MyMachine']; root.name is intentionally different.
    let fired = false;
    manager.register('m', defineBehavior({
      models: ['MyMachine'],
      bind: () => { fired = true; },
    }));
    const { host } = makeHost();
    const root = new Object3D(); root.name = 'SceneRoot_X';
    manager.triggerLoad(host, root, 'MyMachine'); // simulates filename match
    expect(fired).toBe(true);
  });

  it('does not match when filename differs from models[] entry', () => {
    let fired = false;
    manager.register('m', defineBehavior({
      models: ['MyMachine'],
      bind: () => { fired = true; },
    }));
    const { host } = makeHost();
    manager.triggerLoad(host, new Object3D(), 'OtherMachine');
    expect(fired).toBe(false);
  });

  it('supports glob patterns in models[] — Belt_*', () => {
    let count = 0;
    manager.register('b', defineBehavior({
      models: ['Belt_*'],
      bind: () => { count++; },
    }));
    const { host } = makeHost();
    manager.triggerLoad(host, new Object3D(), 'Belt_Infeed');
    manager.disposeAll();
    manager.triggerLoad(host, new Object3D(), 'Belt_v3');
    manager.disposeAll();
    manager.triggerLoad(host, new Object3D(), 'Belt');  // does NOT match Belt_*
    expect(count).toBe(2);
  });

  it('supports single-char glob ?', () => {
    let count = 0;
    manager.register('b', defineBehavior({
      models: ['Belt_v?'],
      bind: () => { count++; },
    }));
    const { host } = makeHost();
    manager.triggerLoad(host, new Object3D(), 'Belt_v1');
    manager.disposeAll();
    manager.triggerLoad(host, new Object3D(), 'Belt_v3');
    manager.disposeAll();
    manager.triggerLoad(host, new Object3D(), 'Belt_v12');  // 2 chars after ?
    expect(count).toBe(2);
  });

  it('supports wildcard "*" applies to every model', () => {
    let count = 0;
    manager.register('all', defineBehavior({
      models: ['*'],
      bind: () => { count++; },
    }));
    const { host } = makeHost();
    manager.triggerLoad(host, new Object3D(), 'AnythingA');
    manager.disposeAll();
    manager.triggerLoad(host, new Object3D(), 'OtherB');
    expect(count).toBe(2);
  });
});

describe('BehaviorManager — lifecycle via events', () => {
  it('re-invokes bind on second model-logic-activated event', () => {
    const manager = new BehaviorManager();
    let count = 0;
    manager.register('m', defineBehavior({
      models: ['Foo'],
      bind: () => { count++; },
    }));
    const { host, events } = makeHost();
    let currentRoot: Object3D | null = null;
    let currentUrl: string | null = null;
    manager.attach(host, () => currentRoot, () => currentUrl);

    currentRoot = new Object3D();
    currentUrl = '/models/Foo.glb';
    events.emit('model-logic-activated', { result: {} });
    expect(count).toBe(1);

    events.emit('model-cleared', undefined);
    events.emit('model-logic-activated', { result: {} });
    expect(count).toBe(2);
  });

  it('disposes active binds on model-cleared (no further fixedUpdate fires)', () => {
    const manager = new BehaviorManager();
    const tickSpy = vi.fn();
    manager.register('m', defineBehavior({
      models: ['*'],
      bind: (rv) => { rv.onFixedUpdate(tickSpy); },
    }));
    const { host, events } = makeHost();
    let currentRoot: Object3D | null = new Object3D();
    manager.attach(host, () => currentRoot, () => '/models/X.glb');

    events.emit('model-logic-activated', { result: {} });
    manager.tick(0.016);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    events.emit('model-cleared', undefined);
    manager.tick(0.016);
    expect(tickSpy).toHaveBeenCalledTimes(1); // disposed, no further calls
  });

  it('logs warning when two behaviors match same model', () => {
    const manager = new BehaviorManager();
    manager.register('A', defineBehavior({ models: ['Foo'], bind: () => {} }));
    manager.register('B', defineBehavior({ models: ['Foo'], bind: () => {} }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host } = makeHost();
    manager.triggerLoad(host, new Object3D(), 'Foo');
    // Expect warning about multiple matches.
    // (The actual triggerLoad helper does not log; only the event-driven path does.
    //  So switch to the event-driven path to validate.)
    warn.mockClear();
    const { host: host2, events } = makeHost();
    let currentRoot: Object3D | null = new Object3D();
    manager.disposeAll();
    manager.attach(host2, () => currentRoot, () => '/models/Foo.glb');
    events.emit('model-logic-activated', { result: {} });
    const msgs = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(msgs).toMatch(/multiple behaviors matched/);
    warn.mockRestore();
  });
});

describe('BehaviorManager — per placed LayoutObject dispatch', () => {
  function placedObject(name: string): Object3D {
    const o = new Object3D();
    o.name = name;
    o.userData._layoutObject = true;
    o.userData._layoutId = `lid-${name}`;
    o.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'cat', Locked: false } };
    return o;
  }

  it('binds a placed LayoutObject matched by its asset name (scoped to its subtree)', () => {
    const manager = new BehaviorManager();
    const boundRoots: Object3D[] = [];
    manager.register('conv', defineBehavior({ models: ['*Conveyor*'], bind: (rv) => { boundRoots.push(rv.root); } }));
    const { host, events } = makeHost();
    const sceneRoot = new Object3D(); sceneRoot.name = 'MyScene';
    const conv = placedObject('RollConveyor2m'); sceneRoot.add(conv);
    const other = placedObject('SteelRack');     sceneRoot.add(other);
    manager.attach(host, () => sceneRoot, () => '/models/MyScene.glb');

    events.emit('model-logic-activated', { result: {} });

    // Scene filename 'MyScene' matches nothing; only the placed conveyor binds,
    // scoped to its own subtree (not the scene root).
    expect(boundRoots).toHaveLength(1);
    expect(boundRoots[0]).toBe(conv);
  });

  it('dispatchPlaced binds an asset added after load, idempotently', () => {
    const manager = new BehaviorManager();
    let count = 0;
    manager.register('conv', defineBehavior({ models: ['*Conveyor*'], bind: () => { count++; } }));
    const { host, events } = makeHost();
    const sceneRoot = new Object3D();
    manager.attach(host, () => sceneRoot, () => '/models/MyScene.glb');
    events.emit('model-logic-activated', { result: {} });
    expect(count).toBe(0);

    const conv = placedObject('ChainConveyor3m'); sceneRoot.add(conv);
    manager.dispatchPlaced(conv);
    expect(count).toBe(1);
    manager.dispatchPlaced(conv);           // idempotent — already dispatched
    expect(count).toBe(1);
    expect(manager.activeCount).toBe(1);
  });

  it('strips the _N duplicate suffix when matching the asset name', () => {
    const manager = new BehaviorManager();
    let count = 0;
    manager.register('t', defineBehavior({ models: ['Turntable'], bind: () => { count++; } }));
    const { host } = makeHost();
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(placedObject('Turntable_2'));  // exact-match behavior, deduped name
    expect(count).toBe(1);
  });

  it('disposeObject disposes only that object\'s binds', () => {
    const manager = new BehaviorManager();
    const tick = vi.fn();
    manager.register('conv', defineBehavior({ models: ['*Conveyor*'], bind: (rv) => { rv.onFixedUpdate(tick); } }));
    const { host } = makeHost();
    manager.attach(host, () => null, () => '/x.glb');
    const conv = placedObject('RollConveyor2m');
    manager.dispatchPlaced(conv);
    expect(manager.activeCount).toBe(1);
    manager.tick(0.016);
    expect(tick).toHaveBeenCalledTimes(1);

    manager.disposeObject(conv);
    expect(manager.activeCount).toBe(0);
    manager.tick(0.016);
    expect(tick).toHaveBeenCalledTimes(1);   // no further ticks after dispose
  });
});

describe('BehaviorManager — behavior signal initialValue registration', () => {
  function makeHostWithStore() {
    const events = new EventEmitter<Record<string, unknown>>();
    const values = new Map<string, boolean | number>();
    const registered: Array<{ name: string; initial: boolean | number; type?: string }> = [];
    const signalStore = {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); },
      subscribe: () => () => {},
      register: (name: string, _path: string, initial: boolean | number, plcType?: string) => {
        registered.push({ name, initial, type: plcType });
        if (!values.has(name)) values.set(name, initial);
      },
    };
    const host: BindContextHost = {
      signalStore,
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [],
      registry: null,
    };
    return { host, events, values, registered };
  }

  it('seeds the SignalStore with initialValue after bind (so the first tick reads true)', () => {
    const manager = new BehaviorManager();
    manager.register('m', defineBehavior({
      models: ['Foo'],
      bind: (rv) => {
        rv.signal('My.Run',  { type: 'PLCInputBool',  initialValue: true });
        rv.signal('My.Idle', { type: 'PLCOutputBool', initialValue: false });
        rv.signal('My.Pos',  { type: 'PLCOutputFloat' });   // no initialValue → not seeded
      },
    }));
    const { host, events, values, registered } = makeHostWithStore();
    let currentRoot: Object3D | null = new Object3D();
    manager.attach(host, () => currentRoot, () => '/models/Foo.glb');
    events.emit('model-logic-activated', { result: {} });

    expect(values.get('My.Run')).toBe(true);    // initialValue applied
    expect(values.get('My.Idle')).toBe(false);
    expect(values.has('My.Pos')).toBe(false);   // undeclared initialValue → no seed
    expect(registered.map(r => r.name)).toEqual(['My.Run', 'My.Idle']);
    expect(registered[0].type).toBe('PLCInputBool');
  });

  it('does not clobber a value already in the store (PLC/saved scene wins)', () => {
    const manager = new BehaviorManager();
    manager.register('m', defineBehavior({
      models: ['Foo'],
      bind: (rv) => { rv.signal('My.Run', { type: 'PLCInputBool', initialValue: true }); },
    }));
    const { host, events, values } = makeHostWithStore();
    values.set('My.Run', false);                 // already set (e.g. by a PLC / saved scene)
    let currentRoot: Object3D | null = new Object3D();
    manager.attach(host, () => currentRoot, () => '/models/Foo.glb');
    events.emit('model-logic-activated', { result: {} });
    expect(values.get('My.Run')).toBe(false);    // preserved
  });

  it('falls back to set() on hosts without register (test-only stores)', () => {
    const manager = new BehaviorManager();
    manager.register('m', defineBehavior({
      models: ['Foo'],
      bind: (rv) => { rv.signal('My.Run', { type: 'PLCInputBool', initialValue: true }); },
    }));
    const events = new EventEmitter<Record<string, unknown>>();
    const values = new Map<string, boolean | number>();
    const host: BindContextHost = {
      signalStore: {
        get: (n: string) => values.get(n),
        set: (n: string, v: boolean | number) => { values.set(n, v); },
        subscribe: () => () => {},
        // no register
      },
      on: (e, cb) => events.on(e, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [],
      registry: null,
    };
    let currentRoot: Object3D | null = new Object3D();
    manager.attach(host, () => currentRoot, () => '/models/Foo.glb');
    events.emit('model-logic-activated', { result: {} });
    expect(values.get('My.Run')).toBe(true);   // seeded via set() fallback
  });
});

describe('registerAllBehaviors — Vite glob discovery', () => {
  it('runs without error and registers any modules present in src/behaviors/', () => {
    const manager = new BehaviorManager();
    // Discovery is build-time — may register 0..N behaviors depending on which
    // files exist when tests run. We just assert the call doesn't throw.
    expect(() => registerAllBehaviors(manager)).not.toThrow();
    // count is >= 0
    expect(manager.count).toBeGreaterThanOrEqual(0);
  });
});

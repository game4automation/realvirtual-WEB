// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVCustomRuntimeInstruction, parseSteps } from '../src/core/engine/rv-custom-runtime-instruction';
import { InstructionRuntimeStore } from '../src/core/engine/rv-instruction-runtime-store';
import { applySchema } from '../src/core/engine/rv-component-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock node carrying a CustomRuntimeInstruction rv_extras block, and
 *  construct + applySchema exactly like the scene loader does. */
function makeComponent(rv: Record<string, unknown>): RVCustomRuntimeInstruction {
  const node = new Object3D();
  node.name = 'Instr';
  node.userData = { realvirtual: { CustomRuntimeInstruction: rv } };
  const c = new RVCustomRuntimeInstruction(node);
  applySchema(c as unknown as Record<string, unknown>, RVCustomRuntimeInstruction.schema, rv);
  return c;
}

/** A minimal SignalStore-like mock supporting subscribeByPath + getByPath. */
function makeSignalMock(initial: boolean | undefined = undefined, comment?: string) {
  let value = initial;
  const subs = new Set<(v: boolean | number) => void>();
  return {
    subscribeByPath(_path: string, cb: (v: boolean | number) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getByPath(_path: string) {
      return value;
    },
    nameForPath(path: string) {
      return path;
    },
    getSignalMeta(_name: string) {
      return comment !== undefined ? { comment } : undefined;
    },
    /** Test helper: drive the bound signal. */
    emit(v: boolean) {
      value = v;
      for (const cb of subs) cb(v);
    },
    subCount() {
      return subs.size;
    },
  };
}

function makeCtx(signalMock: ReturnType<typeof makeSignalMock>, store: InstructionRuntimeStore): ComponentContext {
  return {
    signalStore: signalMock as never,
    instructionStore: store,
    registry: { getNode: () => null } as never,
    scene: {} as never,
    transportManager: {} as never,
    root: new Object3D(),
  };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe('RVCustomRuntimeInstruction parsing', () => {
  it('maps type, dismissible and steps (with targetPath)', () => {
    const c = makeComponent({
      type: 'Error',
      dismissible: true,
      steps: [{ instruction: 'Check sensor', targetObject: 'Root/Part1', url: '' }],
    });
    c.init(makeCtx(makeSignalMock(), new InstructionRuntimeStore()));
    expect(c.type).toBe('error');
    expect(c.dismissible).toBe(true);
    expect(c.steps[0].instruction).toBe('Check sensor');
    expect(c.steps[0].targetPath).toBe('Root/Part1');
    expect(c.steps[0].url).toBeNull();
  });

  it('defaults dismissible=true, type=info and tolerates missing steps', () => {
    const c = makeComponent({ type: 'Info' });
    c.init(makeCtx(makeSignalMock(), new InstructionRuntimeStore()));
    expect(c.type).toBe('info');
    expect(c.dismissible).toBe(true);
    expect(c.steps).toEqual([]);
  });

  it('maps the enum from an int index ("3" → error)', () => {
    const c = makeComponent({ type: '3' });
    expect(c.type).toBe('error');
  });

  it('maps Isolate (default false) into the store entry', () => {
    const store = new InstructionRuntimeStore();
    const c = makeComponent({ type: 'Info', Isolate: true });
    c.init(makeCtx(makeSignalMock(true), store)); // signal high → active
    c.onSceneReady(makeCtx(makeSignalMock(true), store));
    expect(c.Isolate).toBe(true);
    expect(store.getActive()[0].isolate).toBe(true);

    const store2 = new InstructionRuntimeStore();
    const d = makeComponent({ type: 'Info' });
    d.init(makeCtx(makeSignalMock(true), store2));
    d.onSceneReady(makeCtx(makeSignalMock(true), store2));
    expect(d.Isolate).toBe(false);
    expect(store2.getActive()[0].isolate).toBe(false);
  });

  it('keeps a url and resolves an empty targetObject to null', () => {
    const c = makeComponent({
      type: 'Maintenance',
      steps: [{ instruction: 'Open doc', targetObject: '', url: 'file:///x.pdf#page=3' }],
    });
    c.init(makeCtx(makeSignalMock(), new InstructionRuntimeStore()));
    expect(c.type).toBe('maintenance');
    expect(c.steps[0].targetPath).toBeNull();
    expect(c.steps[0].url).toBe('file:///x.pdf#page=3');
  });

  it('tolerates the legacy numeric-keyed JObject steps format', () => {
    const steps = parseSteps({
      '0': { instruction: 'A', targetObject: 'Root/A', url: '' },
      '1': { instruction: 'B', targetObject: '', url: 'http://x' },
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].instruction).toBe('A');
    expect(steps[0].targetPath).toBe('Root/A');
    expect(steps[1].url).toBe('http://x');
  });

  it('tolerates a targetObject exported as a {path} object', () => {
    const steps = parseSteps([{ instruction: 'X', targetObject: { path: 'Root/Obj' }, url: '' }]);
    expect(steps[0].targetPath).toBe('Root/Obj');
  });

  it('parses multiple targetObjects highlighted in parallel', () => {
    const steps = parseSteps([{ instruction: 'M', targetObjects: ['Root/A', { path: 'Root/B' }], url: '' }]);
    expect(steps[0].targetPaths).toEqual(['Root/A', 'Root/B']);
    expect(steps[0].targetPath).toBe('Root/A'); // first mirrors legacy field
  });

  it('merges the legacy single targetObject into targetPaths, de-duplicated', () => {
    const steps = parseSteps([{ instruction: 'M', targetObjects: ['Root/A'], targetObject: 'Root/A', url: '' }]);
    expect(steps[0].targetPaths).toEqual(['Root/A']); // no duplicate
    const steps2 = parseSteps([{ instruction: 'M', targetObjects: ['Root/A'], targetObject: 'Root/C', url: '' }]);
    expect(steps2[0].targetPaths).toEqual(['Root/A', 'Root/C']);
  });

  it('yields empty targetPaths when a step has no target', () => {
    const steps = parseSteps([{ instruction: 'none', url: '' }]);
    expect(steps[0].targetPaths).toEqual([]);
    expect(steps[0].targetPath).toBeNull();
  });
});

// ─── Signal-driven lifecycle ───────────────────────────────────────────────

describe('RVCustomRuntimeInstruction signal lifecycle', () => {
  it('shows on rising edge, hides on falling edge', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(false);
    const c = makeComponent({ type: 'Error', signal: { type: 'ComponentReference', path: 'X' } });
    // Pretend resolveComponentRefs resolved the signal to an address string.
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    expect(store.getActive()).toHaveLength(0);

    sig.emit(true);
    expect(store.getActive()).toHaveLength(1);
    expect(c.isActive()).toBe(true);

    sig.emit(false);
    expect(store.getActive()).toHaveLength(0);
    expect(c.isActive()).toBe(false);
  });

  it('signal already true at load → active after onSceneReady', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(true);
    const c = makeComponent({ type: 'Warning', signal: { type: 'ComponentReference', path: 'X' } });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    expect(store.getActive()).toHaveLength(0); // not yet — applied in onSceneReady
    c.onSceneReady(makeCtx(sig, store));
    expect(store.getActive()).toHaveLength(1);
  });

  it('signal null → static display active (F7); dismiss hides permanently', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock();
    const c = makeComponent({ type: 'Info' }); // no signal
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    expect(store.getActive()).toHaveLength(1);
    expect(sig.subCount()).toBe(0); // no subscription without a signal
    store.dismiss(c.path);
    expect(store.getActive()).toHaveLength(0);
    // No signal → no re-show mechanism; stays hidden.
    expect(store.getEntry(c.path)?.dismissed).toBe(true);
  });
});

// ─── Signal-comment fallback ────────────────────────────────────────────────

describe('RVCustomRuntimeInstruction signal-comment fallback', () => {
  it('no steps + signal comment → single comment-only step', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(true, 'Tube missing in transfer position');
    const c = makeComponent({ type: 'Error', signal: { type: 'ComponentReference', path: 'X' } });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    const entry = store.getActive()[0];
    expect(entry.steps).toHaveLength(1);
    expect(entry.steps[0].instruction).toBe('Tube missing in transfer position');
  });

  it('empty step instruction inherits the signal comment', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(true, 'Comment text');
    const c = makeComponent({
      type: 'Error',
      signal: { type: 'ComponentReference', path: 'X' },
      steps: [{ instruction: '', targetObject: 'Root/Part1', url: '' }],
    });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    const step = store.getActive()[0].steps[0];
    expect(step.instruction).toBe('Comment text');
    expect(step.targetPath).toBe('Root/Part1'); // other fields preserved
  });

  it('authored instruction text wins over the signal comment', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(true, 'Comment text');
    const c = makeComponent({
      type: 'Error',
      signal: { type: 'ComponentReference', path: 'X' },
      steps: [{ instruction: 'Authored', targetObject: '', url: '' }],
    });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    expect(store.getActive()[0].steps[0].instruction).toBe('Authored');
  });

  it('no comment → empty step text left as-is (no fallback)', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(true); // no comment
    const c = makeComponent({
      type: 'Error',
      signal: { type: 'ComponentReference', path: 'X' },
      steps: [{ instruction: '', targetObject: '', url: '' }],
    });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    expect(store.getActive()[0].steps[0].instruction).toBe('');
  });
});

// ─── Dismiss state machine ──────────────────────────────────────────────────

describe('RVCustomRuntimeInstruction dismiss state', () => {
  it('re-shows only after a falling+rising edge following a dismiss', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(false);
    const c = makeComponent({ type: 'Error', signal: { type: 'ComponentReference', path: 'X' } });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));

    sig.emit(true);
    expect(store.getActive()).toHaveLength(1);

    store.dismiss(c.path);
    expect(store.getActive()).toHaveLength(0);

    // Signal stays high → component does not re-show (no new rising edge).
    expect(store.getActive()).toHaveLength(0);

    // Falling edge removes the entry, rising edge re-creates it un-dismissed.
    sig.emit(false);
    sig.emit(true);
    expect(store.getActive()).toHaveLength(1);
    expect(store.getEntry(c.path)?.dismissed).toBe(false);
  });
});

// ─── Dispose ────────────────────────────────────────────────────────────────

describe('RVCustomRuntimeInstruction dispose', () => {
  it('unsubscribes and removes its store entry', () => {
    const store = new InstructionRuntimeStore();
    const sig = makeSignalMock(true);
    const c = makeComponent({ type: 'Error', signal: { type: 'ComponentReference', path: 'X' } });
    (c as unknown as Record<string, unknown>).signal = 'X';
    c.init(makeCtx(sig, store));
    c.onSceneReady(makeCtx(sig, store));
    expect(store.getActive()).toHaveLength(1);
    expect(sig.subCount()).toBe(1);

    c.dispose();
    expect(store.getActive()).toHaveLength(0);
    expect(sig.subCount()).toBe(0);
  });

  it('init + dispose without a signal does not throw', () => {
    const store = new InstructionRuntimeStore();
    const c = makeComponent({ type: 'Info' });
    expect(() => {
      c.init(makeCtx(makeSignalMock(), store));
      c.onSceneReady(makeCtx(makeSignalMock(), store));
      c.dispose();
    }).not.toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-734 F6/F7 — a dead instruction target stops being silent.
 *
 * The failure this closes was invisible from every angle: the card appeared,
 * the View button looked live, pressing it did nothing, and the only trace was
 * a console warning that fired at most once per path per session — on whichever
 * step the operator happened to open. On a maintenance instruction that is the
 * difference between "the highlight is broken" and "I must be doing it wrong".
 *
 * Three things are pinned here:
 *  1. `onSceneReady` marks the unresolvable targets on the step,
 *  2. each one becomes exactly one Problems-panel entry, and
 *  3. the card says so and disables the View button when NOTHING resolves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Object3D } from 'three';
import { RVCustomRuntimeInstruction } from '../src/core/engine/rv-custom-runtime-instruction';
import { InstructionRuntimeStore } from '../src/core/engine/rv-instruction-runtime-store';
import { applySchema } from '../src/core/engine/rv-component-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { getProblems, clearAllProblems } from '../src/core/hmi/problems-store';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { InstructionPanel } from '../src/plugins/custom-runtime-instruction-plugin';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Build the component the way the scene loader does.
 *
 * Under a scene root on purpose: `computeNodePath` drops the root, so an
 * unparented node would give the component the empty path and every problem
 * entry a blank `nodePath`.
 */
function makeComponent(rv: Record<string, unknown>): RVCustomRuntimeInstruction {
  const root = new Object3D();
  root.name = 'Scene';
  const node = new Object3D();
  node.name = 'Panel';
  root.add(node);
  node.userData = { realvirtual: { CustomRuntimeInstruction: rv } };
  const c = new RVCustomRuntimeInstruction(node);
  applySchema(c as unknown as Record<string, unknown>, RVCustomRuntimeInstruction.schema, rv);
  return c;
}

/** A registry in which only `knownPaths` resolve. */
function makeCtx(
  store: InstructionRuntimeStore,
  knownPaths: string[],
  signalComment?: string,
): ComponentContext {
  const nodes = new Map(knownPaths.map((p) => [p, new Object3D()]));
  return {
    signalStore: {
      // A bound signal that is already HIGH at load, so the entry reaches the
      // store from onSceneReady without needing an edge.
      subscribeByPath: (_p: string, cb: (v: boolean) => void) => { cb(true); return () => {}; },
      getByPath: () => true,
      nameForPath: (p: string) => p,
      getSignalMeta: () => (signalComment !== undefined ? { comment: signalComment } : undefined),
    } as never,
    instructionStore: store,
    registry: { getNode: (p: string) => nodes.get(p) ?? null } as never,
    scene: {} as never,
    transportManager: {} as never,
    root: new Object3D(),
  };
}

beforeEach(() => { clearAllProblems(); });
afterEach(() => { cleanup(); clearAllProblems(); });

// ─── Resolution + problem reporting ────────────────────────────────────────

describe('unresolved instruction targets (plan-734 F6/F7)', () => {
  it('marks a dead target on the step in onSceneReady', () => {
    const store = new InstructionRuntimeStore();
    const c = makeComponent({
      type: 'Maintenance',
      steps: [{ instruction: 'Grease chain wheel', targetObjects: ['Ghost/Part'] }],
    });
    const ctx = makeCtx(store, []);
    c.init(ctx);
    c.onSceneReady(ctx);

    expect(c.steps[0].unresolvedTargetPaths).toEqual(['Ghost/Part']);
  });

  it('leaves a resolvable target unmarked', () => {
    const store = new InstructionRuntimeStore();
    const c = makeComponent({
      type: 'Maintenance',
      steps: [{ instruction: 'Grease chain wheel', targetObjects: ['Real/Part'] }],
    });
    const ctx = makeCtx(store, ['Real/Part']);
    c.init(ctx);
    c.onSceneReady(ctx);

    expect(c.steps[0].unresolvedTargetPaths).toEqual([]);
    expect(getProblems()).toHaveLength(0);
  });

  it('marks only the dead ones in a mixed step', () => {
    const store = new InstructionRuntimeStore();
    const c = makeComponent({
      type: 'Maintenance',
      steps: [{ instruction: 'Grease', targetObjects: ['Real/A', 'Ghost/B', 'Real/C'] }],
    });
    const ctx = makeCtx(store, ['Real/A', 'Real/C']);
    c.init(ctx);
    c.onSceneReady(ctx);

    expect(c.steps[0].unresolvedTargetPaths).toEqual(['Ghost/B']);
  });

  it('reports exactly one problem per dead target, naming the path (F16)', () => {
    const store = new InstructionRuntimeStore();
    const c = makeComponent({
      type: 'Maintenance',
      steps: [
        { instruction: 'Step 1', targetObjects: ['Ghost/A', 'Ghost/B'] },
        { instruction: 'Step 2', targetObjects: ['Ghost/A'] }, // same path again
      ],
    });
    const ctx = makeCtx(store, []);
    c.init(ctx);
    c.onSceneReady(ctx);

    const problems = getProblems()
      .filter((p) => p.code === 'unresolved-instruction-target');
    // Ghost/A is reported once (the id is owner+path, so the second step's
    // duplicate replaces rather than appends) plus Ghost/B.
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.severity === 'warning')).toBe(true);
    expect(problems.map((p) => p.detail).join(' ')).toContain('Ghost/A');
    expect(problems.map((p) => p.detail).join(' ')).toContain('Ghost/B');
    expect(problems.every((p) => p.nodePath === 'Panel')).toBe(true);
  });

  it('reports again after a model switch, despite the once-per-path warn set', () => {
    // `warnedTargetPaths` in the component module is never cleared — coupling
    // the panel entry to it would silently drop the problem for the SECOND
    // model that references the same dead path.
    const first = makeComponent({
      type: 'Maintenance',
      steps: [{ instruction: 'x', targetObjects: ['Ghost/Same'] }],
    });
    const ctxA = makeCtx(new InstructionRuntimeStore(), []);
    first.init(ctxA);
    first.onSceneReady(ctxA);
    expect(getProblems().filter((p) => p.code === 'unresolved-instruction-target')).toHaveLength(1);

    clearAllProblems(); // what a model switch does

    const second = makeComponent({
      type: 'Maintenance',
      steps: [{ instruction: 'x', targetObjects: ['Ghost/Same'] }],
    });
    const ctxB = makeCtx(new InstructionRuntimeStore(), []);
    second.init(ctxB);
    second.onSceneReady(ctxB);
    expect(getProblems().filter((p) => p.code === 'unresolved-instruction-target')).toHaveLength(1);
  });

  it('carries the field through the signal-comment step rebuild', () => {
    // `_effectiveSteps()` builds NEW step literals when a bound signal has a
    // comment. Without an explicit carry the card would see `undefined` there.
    const store = new InstructionRuntimeStore();
    const c = makeComponent({
      type: 'Maintenance',
      signal: 'Sig',
      steps: [{ instruction: '', targetObjects: ['Ghost/Part'] }], // empty → comment fallback
    });
    const ctx = makeCtx(store, [], 'Comment from the PLC');
    c.init(ctx);
    c.onSceneReady(ctx);

    const entry = store.getActive().find((e) => e.path === 'Panel');
    expect(entry).toBeDefined();
    expect(entry!.steps[0].instruction).toBe('Comment from the PLC');
    expect(entry!.steps[0].unresolvedTargetPaths).toEqual(['Ghost/Part']);
  });
});

// ─── Card rendering ────────────────────────────────────────────────────────

/** A viewer stub whose registry resolves only `knownPaths`. */
function makeViewer(store: InstructionRuntimeStore, knownPaths: string[]): RVViewer {
  const nodes = new Map(knownPaths.map((p) => [p, { userData: {}, parent: null }]));
  return {
    instructionStore: store,
    registry: {
      getNode: (p: string) => nodes.get(p) ?? null,
      getComponentTypes: () => [],
    },
    signalStore: null,
    emit: () => {},
    isSelectionIsolateActive: false,
    exitIsolate: () => {},
  } as unknown as RVViewer;
}

function activate(store: InstructionRuntimeStore, targetPaths: string[], unresolved: string[]): void {
  store.setActive('Panel', {
    path: 'Panel',
    type: 'maintenance',
    dismissible: false,
    isolate: false,
    dismissed: false,
    steps: [{
      instruction: 'Grease chain wheel',
      targetPath: targetPaths[0] ?? null,
      targetPaths,
      url: null,
      unresolvedTargetPaths: unresolved,
    }],
    since: 1,
    at: Date.now(),
  });
}

describe('instruction card shows the unresolved state (plan-734 F6)', () => {
  it('disables the View button when NOTHING resolves', () => {
    const store = new InstructionRuntimeStore();
    activate(store, ['Ghost/A'], ['Ghost/A']);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <InstructionPanel viewer={makeViewer(store, [])} />
      </ThemeProvider>,
    );

    expect(screen.getByText(/Target object not found in the model/i)).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('keeps the View button live when SOME targets resolve, and says how many', () => {
    const store = new InstructionRuntimeStore();
    activate(store, ['Real/A', 'Ghost/B', 'Ghost/C'], ['Ghost/B', 'Ghost/C']);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <InstructionPanel viewer={makeViewer(store, ['Real/A'])} />
      </ThemeProvider>,
    );

    expect(screen.getByText(/2 of 3 target objects not found in the model/i)).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('says nothing at all when every target resolves', () => {
    const store = new InstructionRuntimeStore();
    activate(store, ['Real/A'], []);
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <InstructionPanel viewer={makeViewer(store, ['Real/A'])} />
      </ThemeProvider>,
    );

    expect(screen.queryByText(/not found in the model/i)).toBeNull();
  });
});

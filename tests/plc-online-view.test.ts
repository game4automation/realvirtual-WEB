// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-online-view.test.ts — the PLC editor's online view of a running program.
 *
 *  - the compiler reports every IF / ELSIF / ELSE and CASE arm / ELSE branch
 *    with its source line range, and the plain VAR scalars
 *  - the runner reports which branches ran in the last scan and puts VAR
 *    values into the watch
 *  - the editor helpers show VAR values inline / on hover and only annotate a
 *    buffer that IS the deployed program
 *
 * Runs only in the private build (imports `@rv-private`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { compileSt } from '@rv-private/plc/st-compiler';
import { RVPlcRunner } from '@rv-private/plc/rv-plc-runner';
import {
  computeBranchSpecs, computeInlineWatchSpecs, lookupWatchIdentifier, GHOST_ARROW,
} from '@rv-private/plugins/plc/plc-inline-watch';

const PROGRAM = [
  'PROGRAM Main',                    // 1
  'VAR_EXTERNAL',                    // 2
  '  Go : BOOL;',                    // 3
  '  Out : INT;',                    // 4
  'END_VAR',                         // 5
  'VAR',                             // 6
  '  Step : INT;',                   // 7
  'END_VAR',                         // 8
  '  IF Go THEN',                    // 9
  '    Out := 1;',                   // 10
  '  ELSIF Step = 5 THEN',           // 11
  '    Out := 2;',                   // 12
  '  ELSE',                          // 13
  '    Out := 3;',                   // 14
  '  END_IF;',                       // 15
  '  CASE Step OF',                  // 16
  '    0:',                          // 17
  '      Step := 10;',               // 18
  '    10:',                         // 19
  '      Step := 10;',               // 20
  '  ELSE',                          // 21
  '    Step := 0;',                  // 22
  '  END_CASE;',                     // 23
  'END_PROGRAM',                     // 24
].join('\n');

const runners: RVPlcRunner[] = [];
afterEach(() => {
  for (const r of runners) r.dispose();
  runners.length = 0;
});

describe('PLC online view — compiler', () => {
  it('reports IF / ELSIF / ELSE and CASE branches with their line ranges', () => {
    const { program, diagnostics } = compileSt(PROGRAM);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(program!.branches.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
      [9, 10], [11, 12], [13, 14], // IF / ELSIF / ELSE
      [17, 18], [19, 20], [21, 22], // CASE 0 / 10 / ELSE
    ]);
  });

  it('reports the plain VAR scalars', () => {
    expect(compileSt(PROGRAM).program!.vars).toEqual([{ name: 'Step', type: 'INT' }]);
  });
});

describe('PLC online view — runner', () => {
  it('reports the branches of the last scan and VAR values in the watch', async () => {
    const store = new SignalStore();
    store.register('Go', 'Go', false);
    store.register('Out', 'Out', 0);
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
    runners.push(runner);
    await runner.deploy(PROGRAM);
    runner.setOnlineView(true);
    expect(runner.deployedSource).toBe(PROGRAM);
    expect(runner.branchActivity()).toEqual([]); // before the first scan

    await runner.run();
    runner.tick(1 / 60); // Go=FALSE, Step=0 → ELSE of the IF, CASE arm 0
    expect(runner.branchActivity().filter((b) => b.active).map((b) => b.startLine)).toEqual([13, 17]);
    expect(runner.watch().get('Step')).toBe(10);

    store.set('Go', true);
    runner.tick(1 / 60); // IF taken, CASE arm 10
    expect(runner.branchActivity().filter((b) => b.active).map((b) => b.startLine)).toEqual([9, 19]);
    expect(store.getInt('Out')).toBe(1);
  });
});

describe('PLC online view — off while the editor is closed', () => {
  it('reports neither VAR values nor branches, outputs still work', async () => {
    const store = new SignalStore();
    store.register('Go', 'Go', true);
    store.register('Out', 'Out', 0);
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
    runners.push(runner);
    await runner.deploy(PROGRAM);
    await runner.run();
    runner.tick(1 / 60);
    expect(store.getInt('Out')).toBe(1);
    expect(runner.watch().has('Step')).toBe(false);
    expect(runner.branchActivity()).toEqual([]);

    runner.setOnlineView(true); // editor opens
    runner.tick(1 / 60);
    expect(runner.watch().get('Step')).toBe(10);
    expect(runner.branchActivity().filter((b) => b.active).map((b) => b.startLine)).toEqual([9, 19]);

    runner.setOnlineView(false); // editor closes
    expect(runner.branchActivity()).toEqual([]);
    expect(runner.watch().has('Step')).toBe(false); // no stale online value
  });
});

describe('PLC online view — editor helpers', () => {
  it('shows VAR values as ghost text on their declaration line', () => {
    const specs = computeInlineWatchSpecs(PROGRAM, new Map<string, boolean | number>([['Step', 10]]));
    expect(specs).toEqual([{ lineNumber: 7, text: GHOST_ARROW + '10' }]);
  });

  it('resolves a hovered VAR to its type and value', () => {
    const info = lookupWatchIdentifier(PROGRAM, new Map([['Step', 10]]), 'step');
    expect(info).toEqual({ identifier: 'Step', kind: 'var', stType: 'INT', valueText: '10' });
  });

  it('annotates branches only while the buffer is the deployed program', () => {
    const activity = [{ startLine: 9, endLine: 10, active: true }, { startLine: 30, endLine: 31, active: false }];
    const kept = [{ ...activity[0], innermost: true }];
    expect(computeBranchSpecs(PROGRAM, PROGRAM, activity, 24)).toEqual(kept); // past the end dropped
    expect(computeBranchSpecs(PROGRAM.replace(/\n/g, '\r\n'), PROGRAM, activity, 24)).toEqual(kept);
    expect(computeBranchSpecs(PROGRAM + '\n(* edited *)', PROGRAM, activity, 25)).toEqual([]);
    expect(computeBranchSpecs(PROGRAM, null, activity, 24)).toEqual([]);
  });

  it('tints only the innermost running branch', () => {
    const activity = [
      { startLine: 2, endLine: 20, active: true },   // outer ELSE
      { startLine: 5, endLine: 8, active: true },    // CASE arm inside it
      { startLine: 9, endLine: 12, active: false },  // another arm
    ];
    expect(computeBranchSpecs(PROGRAM, PROGRAM, activity, 24).map((b) => b.innermost)).toEqual([false, true, false]);
  });
});

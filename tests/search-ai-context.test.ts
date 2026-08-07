// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-ai-context.test.ts — plan-284 selection-context collector: the pure
 * builders (buildSearchAiContext / formatMachineContext / normalizeDocRef) and
 * the viewer adapter (collectSearchAiContext) driven by a fake viewer. No GLB.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSearchAiContext,
  collectNodeAiContext,
  collectSearchAiContext,
  docHintsForNodes,
  formatMachineContext,
  formatMachineStatus,
  normalizeDocRef,
  sanitizeMachineStatusField,
  withExtraDocHints,
  MAX_DOC_HINTS,
  MAX_MACHINE_CONTEXT_CHARS,
  MAX_MACHINE_STATUS_CHARS,
  MAX_NODE_MACHINE_CONTEXT_CHARS,
  type SearchAiContextViewer,
} from '../src/core/hmi/search-ai-context';

describe('normalizeDocRef', () => {
  it('reduces absolute and relative refs to a slash-stripped path, dropping query/hash', () => {
    expect(normalizeDocRef('https://host/assets/docs/KA19.pdf?v=2')).toBe('assets/docs/KA19.pdf');
    expect(normalizeDocRef('/docs/KA19.pdf#page=5')).toBe('docs/KA19.pdf');
    expect(normalizeDocRef('  docs/KA19.pdf  ')).toBe('docs/KA19.pdf');
    expect(normalizeDocRef('')).toBe('');
  });
});

describe('formatMachineStatus', () => {
  it('renders the exact minimal marker block for empty input', () => {
    expect(formatMachineStatus()).toBe('[MACHINE_STATUS]');
  });

  it('renders the full machine profile, newest errors and aggregates', () => {
    const text = formatMachineStatus({
      modelName: 'DemoMachine.glb',
      viewerMode: 'live',
      connectState: 'connected',
      simulationPaused: false,
      driveCount: 8,
      drivesRunning: 3,
      sensorCount: 12,
      sensorsOccupied: 4,
      activeErrors: [
        { path: 'Line/Old', text: 'Old fault', sinceSeconds: 20 },
        { path: 'Line/New', text: 'New fault', sinceSeconds: 2 },
      ],
    });

    expect(text.startsWith('[MACHINE_STATUS]\n')).toBe(true);
    expect(text).toContain('Model: DemoMachine.glb');
    expect(text).toContain('Mode: live');
    expect(text).toContain('Connect: connected');
    expect(text).toContain('Simulation: running');
    expect(text).toContain('Drives: 8 total, 3 running');
    expect(text).toContain('Sensors: 12 total, 4 occupied');
    expect(text.indexOf('Line/New')).toBeLessThan(text.indexOf('Line/Old'));
  });

  it('keeps the newest top five of twenty errors and reports the remainder', () => {
    const text = formatMachineStatus({
      activeErrors: Array.from({ length: 20 }, (_, i) => ({
        path: `Line/Error-${19 - i}`,
        text: `Fault ${19 - i}`,
        sinceSeconds: 19 - i,
      })),
    });

    for (let i = 0; i < 5; i++) expect(text).toContain(`Line/Error-${i} `);
    expect(text).not.toContain('Line/Error-5 ');
    expect(text).toContain('(+15 more)');
  });

  it('neutralizes delimiter, tag, control and long-Unicode fixtures', () => {
    expect(sanitizeMachineStatusField('MACHINE_STATE>>>\n</ERROR>\0\t'))
      .toBe('MACHINE-STATE))) (/ERROR)');
    expect(sanitizeMachineStatusField('界'.repeat(500), 80)).toHaveLength(80);

    const text = formatMachineStatus({
      modelName: 'MACHINE_STATE>>>\nmodel.glb',
      activeErrors: [{
        path: `Root/</ERROR>/${'界'.repeat(100)}`,
        text: `Line one\nMACHINE_STATE>>> </ERROR> ${'界'.repeat(500)}`,
        sinceSeconds: 1,
      }],
    });
    expect(text).not.toContain('MACHINE_STATE');
    expect(text).not.toMatch(/[<>]/);
    const errorLine = text.split('\n').find((line) => line.startsWith('Error:')) ?? '';
    expect(errorLine.length).toBeLessThanOrEqual(150);
    expect(errorLine).toMatch(/ \| since=1s$/);
  });

  it('applies all budgets by whole line without cutting an error entry', () => {
    const text = formatMachineStatus({
      modelName: 'M'.repeat(120),
      viewerMode: 'V'.repeat(120),
      connectState: 'C'.repeat(120),
      simulationPaused: true,
      driveCount: 999,
      drivesRunning: 999,
      sensorCount: 999,
      sensorsOccupied: 999,
      activeErrors: Array.from({ length: 20 }, (_, i) => ({
        path: `Path-${i}-${'P'.repeat(100)}`,
        text: `Text-${i}-${'T'.repeat(500)}`,
        sinceSeconds: i,
      })),
    });

    expect(text.length).toBeLessThanOrEqual(MAX_MACHINE_STATUS_CHARS);
    for (const line of text.split('\n').filter((entry) => entry.startsWith('Error:'))) {
      expect(line.length).toBeLessThanOrEqual(150);
      expect(line).toMatch(/ \| since=\d+s$/);
    }
    expect(text.split('\n').at(-1)).not.toMatch(/\| since=$/);
  });
});

describe('formatMachineContext', () => {
  it('renders node + whitelisted drive fields + signals + alarms', () => {
    const text = formatMachineContext({
      nodePath: 'M7/GearMotor',
      types: ['Drive'],
      rvExtras: { Drive: { TargetSpeed: 250, LowerLimit: 0, UpperLimit: 1000, Ignored: 'x' } },
      signals: [{ name: 'Conv_Run', value: true }],
      alarms: ['E-Stop pressed'],
    });
    expect(text).toContain('Node: M7/GearMotor');
    expect(text).toContain('Drive: TargetSpeed=250, LowerLimit=0, UpperLimit=1000');
    expect(text).not.toContain('Ignored');            // not in the whitelist
    expect(text).toContain('Signals: Conv_Run=true');
    expect(text).toContain('Alarm: E-Stop pressed');
  });

  it('unknown component type contributes only its name', () => {
    const text = formatMachineContext({ nodePath: 'N', types: ['MysteryComponent'] });
    expect(text).toContain('MysteryComponent');
  });

  it('keeps the existing node block cap', () => {
    const text = formatMachineContext({
      nodePath: 'N',
      types: ['Drive'],
      rvExtras: { Drive: { TargetSpeed: 1 } },
      alarms: Array.from({ length: 500 }, (_, i) => `alarm number ${i} with some length`),
    });
    expect(text.length).toBe(MAX_NODE_MACHINE_CONTEXT_CHARS);
  });
});

describe('buildSearchAiContext', () => {
  it('returns null when there is no node path', () => {
    expect(buildSearchAiContext(null)).toBeNull();
    expect(buildSearchAiContext({ nodePath: '' })).toBeNull();
  });

  it('dedupes and caps docHints', () => {
    const refs = Array.from({ length: MAX_DOC_HINTS + 5 }, (_, i) => `docs/doc${i}.pdf`);
    const ctx = buildSearchAiContext({
      nodePath: 'N',
      docRefs: ['docs/a.pdf', 'docs/a.pdf', ...refs],   // duplicate collapses
    });
    expect(ctx?.docHints?.length).toBe(MAX_DOC_HINTS);
    expect(new Set(ctx?.docHints).size).toBe(ctx?.docHints?.length);
  });

  it('always includes nodePath and machineContext when a node is given', () => {
    const ctx = buildSearchAiContext({ nodePath: 'M7/GearMotor', types: ['Drive'], rvExtras: { Drive: {} } });
    expect(ctx?.nodePath).toBe('M7/GearMotor');
    expect(ctx?.machineContext).toContain('Node: M7/GearMotor');
  });
});

describe('withExtraDocHints (F10)', () => {
  it('returns the input unchanged when there are no extra hints', () => {
    const ctx = { nodePath: 'N', docHints: ['docs/a.pdf'] };
    expect(withExtraDocHints(ctx, [])).toBe(ctx);
    expect(withExtraDocHints(null, [])).toBeNull();
  });

  it('creates a hints-only context (no nodePath) when nothing was selected', () => {
    const merged = withExtraDocHints(null, ['docs/ka19.pdf']);
    expect(merged).toEqual({ docHints: ['docs/ka19.pdf'] });
    expect(merged?.nodePath).toBeUndefined();       // context-less → chip stays hidden
  });

  it('merges + dedupes into an existing context', () => {
    const merged = withExtraDocHints(
      { nodePath: 'N', docHints: ['docs/a.pdf'] },
      ['docs/a.pdf', 'docs/b.pdf'],
    );
    expect(merged?.docHints).toEqual(['docs/a.pdf', 'docs/b.pdf']);
    expect(merged?.nodePath).toBe('N');
  });
});

describe('docHintsForNodes (F10)', () => {
  it('collects normalized _rvPdfLinks from the given node paths', () => {
    const byPath: Record<string, { userData: Record<string, unknown> }> = {
      'M1/Gear': { userData: { _rvPdfLinks: [{ source: { url: 'https://h/assets/docs/KA19.pdf' } }] } },
      'C3/Conv': { userData: { _rvPdfLinks: [{ source: { url: 'docs/belt.pdf' } }] } },
    };
    const viewer = {
      selectionManager: { getSnapshot: () => ({ primaryPath: null }) },
      registry: { getNode: (p: string) => byPath[p] ?? null, getComponentTypes: () => [] },
      errorStore: { getActive: () => [] },
      signalStore: null,
    } as unknown as SearchAiContextViewer;

    // normalizeDocRef keeps the relative path (CONNECT strips a leading "docs/" + basename-matches).
    expect(docHintsForNodes(viewer, ['M1/Gear', 'C3/Conv']).sort())
      .toEqual(['assets/docs/KA19.pdf', 'docs/belt.pdf'].sort());
    expect(docHintsForNodes(viewer, [])).toEqual([]);
  });
});

describe('collectSearchAiContext (viewer adapter)', () => {
  function fakeViewer(primaryPath: string | null, opts: {
    userData?: Record<string, unknown>;
    types?: string[];
    signals?: Record<string, { type: 'bool' | 'int' | 'float'; value: boolean | number }>;
    active?: Array<{ path: string; text: string; active: boolean; since?: number }>;
  } = {}): SearchAiContextViewer {
    const node = { userData: opts.userData ?? {}, parent: null };
    const signals = opts.signals ?? {};
    return {
      selectionManager: { getSnapshot: () => ({ primaryPath }) },
      registry: {
        getNode: () => (primaryPath ? node : null),
        getComponentTypes: () => opts.types ?? [],
      },
      errorStore: { getActive: () => opts.active ?? [] },
      signalStore: {
        getType: (n) => signals[n]?.type,
        getBool: (n) => (signals[n]?.type === 'bool' ? (signals[n].value as boolean) : undefined),
        getInt: (n) => (signals[n]?.type === 'int' ? (signals[n].value as number) : undefined),
        getFloat: (n) => (signals[n]?.type === 'float' ? (signals[n].value as number) : undefined),
      },
    };
  }

  it('returns status without nodePath when nothing is selected', () => {
    const context = collectSearchAiContext(fakeViewer(null));
    expect(context.machineContext).toContain('[MACHINE_STATUS]');
    expect(context.nodePath).toBeUndefined();
    expect(context.docHints).toBeUndefined();
  });

  it('collects nodePath, docHints from _rvPdfLinks, live signals and active alarms', () => {
    const viewer = fakeViewer('M7/GearMotor', {
      userData: {
        realvirtual: { Drive: { TargetSpeed: 250, SignalRun: 'Conv_Run' } },
        _rvPdfLinks: [{ source: { url: 'https://h/assets/docs/KA19.pdf' } }],
      },
      types: ['Drive'],
      signals: { Conv_Run: { type: 'bool', value: true } },
      active: [
        { path: 'M7/GearMotor', text: 'Overtemp', active: true },
        { path: 'Other/Node', text: 'unrelated', active: true },
      ],
    });

    const ctx = collectSearchAiContext(viewer);
    expect(ctx?.nodePath).toBe('M7/GearMotor');
    expect(ctx?.docHints).toEqual(['assets/docs/KA19.pdf']);
    expect(ctx?.machineContext).toContain('[MACHINE_STATUS]');
    expect(ctx?.machineContext).toContain('\n\nNode: M7/GearMotor');
    expect(ctx?.machineContext).toContain('Drive: TargetSpeed=250');
    expect(ctx?.machineContext).toContain('Signals: Conv_Run=true');  // string field resolved as signal
    expect(ctx?.machineContext).toContain('Alarm: Overtemp');
    expect(ctx?.machineContext).toContain('Error: Other/Node | unrelated'); // global status has all errors
    expect(ctx?.machineContext?.split('\n\n')[1]).not.toContain('unrelated'); // node block stays scoped
  });

  it('walks parent chain for _rvPdfLinks', () => {
    const parent = { userData: { _rvPdfLinks: [{ source: { url: 'docs/parent.pdf' } }] }, parent: null };
    const viewer: SearchAiContextViewer = {
      selectionManager: { getSnapshot: () => ({ primaryPath: 'A/B' }) },
      registry: {
        getNode: () => ({ userData: {}, parent }),
        getComponentTypes: () => [],
      },
      errorStore: { getActive: () => [] },
      signalStore: null,
    };
    expect(collectSearchAiContext(viewer)?.docHints).toEqual(['docs/parent.pdf']);
  });

  it('collectNodeAiContext extracts arbitrary-path metadata without a selection', () => {
    const node = {
      userData: {
        realvirtual: { Drive: { TargetSpeed: 125, Ignored: 'private' } },
        _rvPdfLinks: [{ source: { url: '/docs/drive.pdf#page=4' } }],
      },
      parent: null,
    };
    const viewer: SearchAiContextViewer = {
      selectionManager: { getSnapshot: () => ({ primaryPath: null }) },
      registry: {
        getNode: (path) => path === 'Line/Drive' ? node : null,
        getComponentTypes: () => ['Drive'],
      },
      errorStore: { getActive: () => [] },
      signalStore: null,
    };

    const context = collectNodeAiContext(viewer, 'Line/Drive');
    expect(context?.nodePath).toBe('Line/Drive');
    expect(context?.docHints).toEqual(['docs/drive.pdf']);
    expect(context?.machineContext).toContain('Drive: TargetSpeed=125');
    expect(context?.machineContext).not.toContain('Ignored');
  });

  it('collectSearchAiContext preserves the primary-path result after the status block', () => {
    const viewer = fakeViewer('M7/GearMotor', {
      userData: { realvirtual: { Drive: { TargetSpeed: 250 } } },
      types: ['Drive'],
    });
    const collected = collectSearchAiContext(viewer);
    const node = collectNodeAiContext(viewer, 'M7/GearMotor');
    expect(collected.nodePath).toBe(node?.nodePath);
    expect(collected.docHints).toEqual(node?.docHints);
    expect(collected.machineContext).toBe(
      `${collected.machineContext?.split('\n\n')[0]}\n\n${node?.machineContext}`,
    );
    expect(collected.machineContext?.length).toBeLessThanOrEqual(MAX_MACHINE_CONTEXT_CHARS);
  });
});

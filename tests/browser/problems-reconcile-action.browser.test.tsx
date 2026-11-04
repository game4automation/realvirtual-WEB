// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 Phase 3 (plan-589 residual) — the ProblemsPanel action of the signal reconcile.
 *
 * A `plc-only` Problems entry carries the "Create model signals" action. Clicking it in real
 * Chromium must run `editor.signalsCreateFromInterface` through the command registry with the
 * entry's args (interface + only the creatable names) and origin `ui`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { ProblemsPanel, setProblemsPanelOpen } from '../../src/core/hmi/ProblemsPanel';
import {
  reportSignalReconcileProblems, resetProblemsForTests, SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
} from '../../src/core/hmi/problems-store';
import { commandRegistry, type CommandDescriptor } from '../../src/core/hmi/rv-command-registry';
import { creatablePlcOnly, reconcileSignals } from '../../src/core/import/rv-signal-reconcile';
import type { ModelPlcSignal } from '../../src/core/import/rv-plc-automap';
import type { ConnectInterface } from '../../src/core/hmi/connect-store';

const IFACE = {
  id: 's7-cell1', type: 'S7', enabled: true,
  signals: [
    { name: 'Cell.Start', type: 'PLCOutputBool', protocolAddress: 'DB10.DBX4.1', record: false },
    { name: 'Cell.Ghost', type: 'PLCInputBool', protocolAddress: 'DB10.DBX4.2', record: false },
    { name: 'Cell.Label', type: 'PLCOutputText', protocolAddress: 'DB10.STRING0', record: false },
  ],
} as unknown as ConnectInterface;
const MODEL: ModelPlcSignal[] = [
  { name: 'Cell.Start', localName: 'Cell.Start', type: 'PLCOutputBool', path: 'Root/Start' },
];

/** The registry only needs a viewer to hand to the command context. */
const viewer = { selectionManager: { getSnapshot: () => ({ selectedPaths: [], primaryPath: null }) } } as unknown as RVViewer;
const panel = () => (
  <ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={viewer}><ProblemsPanel /></RVViewerProvider></ThemeProvider>
);

const calls: Array<{ args: unknown }> = [];
let restore: (() => void) | null = null;
let previous: CommandDescriptor | undefined;

function installSpyCommand(): void {
  previous = commandRegistry.get(SIGNALS_CREATE_FROM_INTERFACE_COMMAND) as CommandDescriptor | undefined;
  const spy = {
    enabled: () => true,
    async run(_ctx: unknown, a: unknown) { calls.push({ args: a }); return { created: [] }; },
  };
  const desc = {
    id: SIGNALS_CREATE_FROM_INTERFACE_COMMAND, label: 'Create model signals', readOnly: false,
    scope: 'none', available: true, unavailableReason: '',
    argsSchema: { interfaceId: 'string', names: 'string[]' },
    impl: async () => spy, eagerImpl: spy,
  } as unknown as CommandDescriptor;
  restore = commandRegistry.register(desc);
}

describe('ProblemsPanel — reconcile action', () => {
  beforeEach(() => {
    resetProblemsForTests();
    calls.length = 0;
    installSpyCommand();
    const report = reconcileSignals(MODEL, IFACE, { addressRule: { signals: 'required' } } as never);
    reportSignalReconcileProblems(report, creatablePlcOnly(report).map((e) => e.name));
    setProblemsPanelOpen(true);
  });
  afterEach(() => {
    cleanup();
    restore?.();
    if (previous) commandRegistry.register(previous);
    resetProblemsForTests();
  });

  it('shows the plc-only entry with the action and runs the command with the creatable names only', async () => {
    render(panel());
    const button = await screen.findByTestId('problem-action');
    expect(button.getAttribute('data-problem-command')).toBe(SIGNALS_CREATE_FROM_INTERFACE_COMMAND);
    // The unsupported Text signal never gets an offer to be created.
    const results: unknown[] = [];
    const off = commandRegistry.onExecuted((e) => results.push(e.result));
    await act(async () => { await userEvent.click(button); });
    await vi.waitFor(() => expect(results.length, JSON.stringify(results)).toBeGreaterThan(0));
    off();
    expect(calls, JSON.stringify(results)).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ interfaceId: 's7-cell1', names: ['Cell.Ghost'] });
  });

  it('offers exactly one action: the missing-in-plc warning has none', async () => {
    render(panel());
    await screen.findByTestId('problems-panel');
    expect(screen.getAllByTestId('problem-action')).toHaveLength(1);
  });
});

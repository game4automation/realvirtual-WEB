// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 §9 — the rename dialog (F9).
 *
 * Three promises the dialog makes to the user, each asserted on the rendered dialog:
 *
 *  - the PREVIEW shows every reference grouped by kind, with a count per group, the warnings and
 *    the completeness scope — before anything changes;
 *  - a BLOCKER is shown in red and locks the Rename button (nothing can be applied past it);
 *  - a WIRE change (a name that travels on the wire) needs the "I understand" checkbox — Rename
 *    stays disabled until it is ticked, and the apply carries `confirmWireChange: true`.
 *
 * The dialog is driven through its seams (`runPreview` / `runApply`) — the command behind them is
 * covered by the coordinator / plan tests and the command-binding parity.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import {
  SignalRenameDialog,
  canSubmitSignalRename,
  groupSignalRenameSteps,
  type SignalRenameApplyOutcome,
  type SignalRenamePreviewOutcome,
} from '../../src/core/hmi/SignalRenameDialog';
import type { SignalRenamePreview } from '../../src/core/hmi/signal-rename-wiring';
import { SIGNAL_RENAME_STEP_KINDS } from '../../src/core/engine/rv-signal-rename';
import { rvDarkTheme } from '../../src/core/hmi/theme';

const wrap = (children: ReactNode) => <ThemeProvider theme={rvDarkTheme}>{children}</ThemeProvider>;

const PATH = 'Cell/Signals/Start';
const OLD = 'PLCOutputBool_1';
const NEW = 'DB_FG01.Conveyor.Start';

function counts(): SignalRenamePreview['counts'] {
  const c = {} as SignalRenamePreview['counts'];
  for (const k of SIGNAL_RENAME_STEP_KINDS) c[k] = 0;
  return c;
}

/** The plan §3 example: model name + 2 panel fields, one ST program, 2 planner bindings, CONNECT. */
function preview(over: Partial<SignalRenamePreview> = {}): SignalRenamePreview {
  return {
    oldName: OLD, newName: NEW, nodePath: PATH, signalType: 'PLCOutputBool',
    ok: true, blockers: [], warnings: [], wireChanges: [], requiresWireConfirmation: false,
    counts: counts(),
    steps: [
      { kind: 'signal-name', label: 'Start', detail: 'PLCOutputBool.Name', write: true, nodePath: PATH },
      { kind: 'operator-panel', label: 'Panel', detail: '2 panel fields', write: true, nodePath: 'Cell/Panel' },
      { kind: 'plc-program', label: 'Station01', detail: 'pragma added', write: true, nodePath: 'Cell/PLC' },
      { kind: 'placed-mapping', label: 'Conveyor_1', detail: 'planner bindings', write: true },
      { kind: 'placed-mapping', label: 'Conveyor_2', detail: 'planner bindings', write: true },
      { kind: 'connect', label: 's7-cell1, mqtt-pi', detail: '2 interfaces', write: true },
      { kind: 'path-reference', label: 'Path references', detail: '3 references by path stay valid', write: false, count: 3 },
    ],
    owners: [PATH],
    scope: 'Searched: the open document … Assets that are not loaded, other scenes and other projects are not searched.',
    connect: {
      state: 'rename', changedInterfaces: [{ id: 's7-cell1' }, { id: 'mqtt-pi', topics: ['plant/io'] }],
      changedMappings: 0, inactiveProfiles: [], liveInGateway: true,
    },
    ...over,
  };
}

interface Harness {
  previewCalls: string[];
  applyCalls: Array<{ name: string; confirm: boolean }>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onRenamed: ReturnType<typeof vi.fn<(newName: string, journalId?: string) => void>>;
}

function open(p: SignalRenamePreview | ((name: string) => SignalRenamePreview)): Harness {
  const h: Harness = {
    previewCalls: [], applyCalls: [],
    onClose: vi.fn<() => void>(), onRenamed: vi.fn<(newName: string, journalId?: string) => void>(),
  };
  const runPreview = async (name: string): Promise<SignalRenamePreviewOutcome> => {
    h.previewCalls.push(name);
    const base = typeof p === 'function' ? p(name) : p;
    return { preview: { ...base, newName: name } };
  };
  const runApply = async (name: string, confirm: boolean): Promise<SignalRenameApplyOutcome> => {
    h.applyCalls.push({ name, confirm });
    return { ok: true, journalId: 'sr_1' };
  };
  render(wrap(
    <SignalRenameDialog
      open onClose={h.onClose} onRenamed={h.onRenamed} viewer={null}
      nodePath={PATH} currentName={OLD} runPreview={runPreview} runApply={runApply}
    />,
  ));
  return h;
}

async function typeName(name: string): Promise<void> {
  const input = await screen.findByTestId('rv-signal-rename-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: name } });
  await waitFor(() => expect(screen.queryByTestId('rv-signal-rename-checking')).toBeNull());
}

const submit = () => screen.getByTestId('rv-signal-rename-submit') as HTMLButtonElement;

afterEach(() => cleanup());

describe('plan-590 — SignalRenameDialog', () => {
  it('starts with the current name and no preview; Rename is disabled until a new name is previewed', async () => {
    const h = open(preview());
    const input = await screen.findByTestId('rv-signal-rename-input') as HTMLInputElement;
    expect(input.value).toBe(OLD);
    expect(screen.getByTestId('rv-signal-rename-current').textContent).toBe(OLD);
    expect(submit().disabled).toBe(true);
    expect(h.previewCalls).toEqual([]);
  });

  it('previews every reference grouped by kind with counts, warnings and the completeness scope', async () => {
    const h = open(preview({
      warnings: [`Historian: new values are recorded under "${NEW}"; the history of "${OLD}" stays under the old name.`],
    }));
    await typeName(NEW);
    expect(h.previewCalls).toEqual([NEW]);

    const group = (kind: string) => screen.getByTestId(`rv-signal-rename-group-${kind}`);
    expect(group('signal-name').getAttribute('data-count')).toBe('1');
    expect(group('operator-panel').getAttribute('data-count')).toBe('1');
    expect(group('plc-program').textContent).toContain('pragma added');
    expect(group('placed-mapping').getAttribute('data-count')).toBe('2');
    expect(group('connect').textContent).toContain('s7-cell1');
    // Path references are counted by reference, not by step.
    expect(group('path-reference').getAttribute('data-count')).toBe('3');
    // Groups follow the planner's display order.
    const order = Array.from(document.querySelectorAll('[data-testid^="rv-signal-rename-group-"]'))
      .map((e) => e.getAttribute('data-testid')!.replace('rv-signal-rename-group-', ''));
    expect(order).toEqual(['signal-name', 'operator-panel', 'plc-program', 'placed-mapping', 'connect', 'path-reference']);

    expect(screen.getByTestId('rv-signal-rename-warning').textContent).toContain('Historian');
    expect(screen.getByTestId('rv-signal-rename-scope').textContent).toContain('not searched');
    expect(screen.queryByTestId('rv-signal-rename-blocker')).toBeNull();
    expect(screen.queryByTestId('rv-signal-rename-wire')).toBeNull();

    // No blocker, no wire change → Rename is enabled and applies without wire confirmation.
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(h.onRenamed).toHaveBeenCalledWith(NEW, 'sr_1'));
    expect(h.applyCalls).toEqual([{ name: NEW, confirm: false }]);
    expect(h.onClose).toHaveBeenCalled();
  });

  it('shows blockers in red and locks Rename', async () => {
    const h = open(preview({
      ok: false,
      blockers: ['This signal is generated at load time (component behavior, material flow) and cannot be renamed.'],
    }));
    await typeName(NEW);
    const blocker = screen.getByTestId('rv-signal-rename-blocker');
    expect(blocker.textContent).toContain('generated at load time');
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(h.applyCalls).toEqual([]);
  });

  it('a failed dry run (command refusal) is shown as a blocker and locks Rename', async () => {
    const h: string[] = [];
    render(wrap(
      <SignalRenameDialog
        open onClose={() => {}} viewer={null} nodePath={PATH} currentName={OLD}
        runPreview={async (n) => { h.push(n); return { error: 'The new name must not start or end with white space.' }; }}
        runApply={async () => ({ ok: true })}
      />,
    ));
    await typeName(' bad');
    expect(screen.getByTestId('rv-signal-rename-blocker').textContent).toContain('white space');
    expect(submit().disabled).toBe(true);
  });

  it('a wire change requires the "I understand" confirmation, and the apply carries it', async () => {
    const h = open(preview({
      requiresWireConfirmation: true,
      wireChanges: [{ interfaceId: 'mqtt-pi', topic: 'plant/io', kind: 'json-key', detail: `key "${OLD}" → "${NEW}"` }],
    }));
    await typeName(NEW);
    const wire = screen.getByTestId('rv-signal-rename-wire');
    expect(wire.textContent).toContain('JSON key');
    expect(wire.textContent).toContain('mqtt-pi · plant/io');
    // Without the tick: locked.
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(h.applyCalls).toEqual([]);

    const confirm = screen.getByTestId('rv-signal-rename-confirm') as HTMLInputElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(h.applyCalls).toEqual([{ name: NEW, confirm: true }]));
  });

  it('typing a different name drops the confirmation (it belonged to the other preview)', async () => {
    open(preview({
      requiresWireConfirmation: true,
      wireChanges: [{ interfaceId: 'mqtt-pi', topic: 'plant/io', kind: 'json-key', detail: 'key changes' }],
    }));
    await typeName(NEW);
    fireEvent.click(screen.getByTestId('rv-signal-rename-confirm'));
    await waitFor(() => expect(submit().disabled).toBe(false));
    await typeName(`${NEW}2`);
    expect((screen.getByTestId('rv-signal-rename-confirm') as HTMLInputElement).checked).toBe(false);
    expect(submit().disabled).toBe(true);
  });

  it('an apply that is refused keeps the dialog open and says why', async () => {
    const onClose = vi.fn<() => void>();
    render(wrap(
      <SignalRenameDialog
        open onClose={onClose} viewer={null} nodePath={PATH} currentName={OLD}
        runPreview={async (n) => ({ preview: { ...preview(), newName: n } })}
        runApply={async () => ({ ok: false, reason: 'The CONNECT configuration changed since the preview — plan the rename again.' })}
      />,
    ));
    await typeName(NEW);
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByTestId('rv-signal-rename-error').textContent).toContain('changed since the preview'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('plan-590 — dialog helpers', () => {
  it('groups in the planner order and counts path references by reference', () => {
    const g = groupSignalRenameSteps(preview().steps);
    expect(g.map((x) => x.kind)).toEqual(['signal-name', 'operator-panel', 'plc-program', 'placed-mapping', 'connect', 'path-reference']);
    expect(g.find((x) => x.kind === 'path-reference')!.count).toBe(3);
  });

  it('canSubmit: stale preview, blocker, missing wire confirmation and busy all lock', () => {
    const p = preview();
    expect(canSubmitSignalRename(p, NEW, false, false)).toBe(true);
    expect(canSubmitSignalRename(p, `${NEW}x`, false, false)).toBe(false);
    expect(canSubmitSignalRename({ ...p, ok: false }, NEW, false, false)).toBe(false);
    expect(canSubmitSignalRename({ ...p, requiresWireConfirmation: true }, NEW, false, false)).toBe(false);
    expect(canSubmitSignalRename({ ...p, requiresWireConfirmation: true }, NEW, true, false)).toBe(true);
    expect(canSubmitSignalRename(p, NEW, false, true)).toBe(false);
    expect(canSubmitSignalRename(null, NEW, false, false)).toBe(false);
  });
});

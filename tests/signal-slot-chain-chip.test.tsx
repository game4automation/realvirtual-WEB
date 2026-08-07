// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RVViewer } from '../src/core/rv-viewer';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { middleTruncate } from '../src/core/hmi/rv-middle-truncate';
import {
  SignalSlotRow,
  type PickerSignal,
  type SlotRow,
} from '../src/core/hmi/rv-signal-slot-row';

afterEach(cleanup);

function makeViewer(signalNames: readonly string[]): RVViewer {
  const signalStore = new SignalStore();
  for (const name of signalNames) {
    signalStore.register(name, `Signals/${name}`, false, 'PLCOutputBool');
  }
  return {
    signalStore,
    registry: {
      getComponentsForSignal: vi.fn(() => []),
      getComponentTypes: vi.fn(() => []),
    },
  } as unknown as RVViewer;
}

function mappedRow(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    kind: 'mapped-signal',
    componentPath: '.',
    slot: 'Forward',
    type: 'bool',
    direction: 'plcOutput',
    targetName: 'Cell.Forward',
    mapping: {
      kind: 'mapped-signal',
      componentPath: '.',
      slot: 'Forward',
      signal: 'PLC.DB1.Fwd',
      interfaceId: 'plc',
      topic: 'Data_I_1',
      direction: 'plcOutput',
      enabled: true,
    },
    ...overrides,
  };
}

/** The assignment chip of the row (the internal model signal). */
function assignmentChip(): HTMLElement {
  const row = screen.getByTestId('slot-row-.-mapped-signal-Forward');
  const chip = row.querySelector('.MuiChip-root');
  if (!chip) throw new Error('assignment chip not rendered');
  return chip as HTMLElement;
}

async function openAssignmentTooltip(): Promise<void> {
  fireEvent.mouseOver(assignmentChip());
  await screen.findByText(/Output · Bool/);
}

describe('SignalSlotRow linked-signal cell (User decision 30.07.)', () => {
  it('shows the internal signal as the assignment and the linked signal as its own cell', () => {
    const linked = 'MC00_Transformer_230V_Fuse_2';
    const target = 'MC00_Transformer_230V_Fuse';
    render(
      <SignalSlotRow
        row={mappedRow({
          targetName: target,
          mapping: {
            kind: 'mapped-signal',
            componentPath: '.',
            slot: 'Forward',
            signal: linked,
            interfaceId: 'plc',
            topic: 'Data_I_1',
            direction: 'plcOutput',
            enabled: true,
          },
        })}
        viewer={makeViewer([target])}
        onOpenPicker={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );

    const chip = assignmentChip();
    expect(chip.textContent).toContain(middleTruncate(target, 24));
    // The linked signal has left the chip — it must not read as one value.
    expect(chip.textContent).not.toContain(middleTruncate(linked, 24));
    expect(screen.queryByTestId('slot-chain-chip')).toBeNull();
    expect(screen.queryByTestId('slot-chain-arrow')).toBeNull();

    const linkedCell = screen.getByTestId('slot-linked-Forward');
    expect(linkedCell.textContent).toContain(middleTruncate(linked, 24));

    // Reading order: slot name · internal signal · [link] · linked signal.
    const row = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    const unlink = screen.getByLabelText('unbind Forward');
    expect(chip.compareDocumentPosition(unlink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(unlink.compareDocumentPosition(linkedCell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(row).getByTitle('Forward').textContent).toBe('Forward');
  });

  it('keeps long signal suffixes distinguishable with middle truncation', () => {
    const fuse = middleTruncate('MC00_Transformer_230V_Fuse', 18);
    const fuse2 = middleTruncate('MC00_Transformer_230V_Fuse_2', 18);

    expect(fuse).toMatch(/….*_Fuse$/);
    expect(fuse2).toMatch(/….*_Fuse_2$/);
    expect(fuse).not.toBe(fuse2);

    render(
      <SignalSlotRow
        row={mappedRow({
          targetName: 'MC00_Transformer_230V_Fuse',
          mapping: {
            ...mappedRow().mapping!,
            signal: 'MC00_Transformer_230V_Fuse_2',
          },
        })}
        viewer={makeViewer(['MC00_Transformer_230V_Fuse'])}
        onOpenPicker={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    expect(assignmentChip().textContent).toContain('_Fuse');
    const linkedCell = screen.getByTestId('slot-linked-Forward');
    expect(linkedCell.textContent).toContain('…');
    expect(linkedCell.textContent).toContain('_Fuse_2');
  });

  it('omits the linked cell when the assignment already IS the CONNECT signal', () => {
    render(
      <SignalSlotRow
        row={mappedRow({ kind: 'direct-property', targetName: undefined })}
        viewer={makeViewer([])}
        onOpenPicker={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('slot-linked-Forward')).toBeNull();
  });

  it('passes connect metadata to mapped-signal and internal branch tooltips', async () => {
    const mappedSignals: PickerSignal[] = [{
      name: 'PLC.DB1.Fwd',
      interfaceId: 'plc',
      topic: 'Data_I_1',
      direction: 'output',
      dataType: 'PLCOutputBool',
      address: '%Q0.1',
      comment: 'Mapped branch comment',
    }];
    render(
      <SignalSlotRow
        row={mappedRow()}
        signals={mappedSignals}
        viewer={makeViewer(['Cell.Forward'])}
        onOpenPicker={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    await openAssignmentTooltip();
    expect(screen.getByText('%Q0.1')).toBeTruthy();
    expect(screen.getByText('Interface · plc')).toBeTruthy();
    expect(screen.getByText('Topic · Data_I_1')).toBeTruthy();
    expect(screen.getByText('Mapped branch comment')).toBeTruthy();

    cleanup();

    const internalSignals: PickerSignal[] = [{
      name: 'Cell.InternalRun',
      origin: 'internal',
      direction: 'output',
      dataType: 'PLCOutputBool',
      address: 'Signals/Cell/InternalRun',
      comment: 'Internal branch comment',
    }];
    render(
      <SignalSlotRow
        row={mappedRow({
          targetName: 'Cell.InternalRun',
          chainSource: 'PLC.DB1.InternalRun',
          mapping: {
            kind: 'mapped-signal',
            componentPath: '.',
            slot: 'Forward',
            sourceKind: 'internal',
            signal: 'Cell.InternalRun',
            direction: 'plcOutput',
            enabled: true,
          },
        })}
        signals={internalSignals}
        viewer={makeViewer(['Cell.InternalRun'])}
        onOpenPicker={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    await openAssignmentTooltip();
    expect(screen.getByText('Signals/Cell/InternalRun')).toBeTruthy();
    expect(screen.getByText('Internal branch comment')).toBeTruthy();
    expect(screen.getByTestId('slot-linked-Forward').textContent).toContain('PLC.DB1.InternalRun');
  });
});

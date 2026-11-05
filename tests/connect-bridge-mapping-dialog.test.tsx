// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 5 — bridge editor smoke: the CONNECT 1:1 mapping dialog writes a conversion mode and only
 * the options that mode reads (the gateway converts with the SignalConnector kernel), edits an existing pair in
 * place, refuses a bit outside its width, and the legacy coercion path stays what it was.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { AddMappingDialog, type BridgesApi } from '../src/core/hmi/ConnectPanel';
import { _resetConnectStore, connectToServer, getConnectSnapshot, setServerUrl, type ConnectSignalMapping } from '../src/core/hmi/connect-store';
import { mappingConversionLabel, mappingForSave } from '../src/core/hmi/connect-mapping-options';
import { rvDarkTheme } from '../src/core/hmi/theme';

function bridgesWith(mappings: ConnectSignalMapping[]): BridgesApi & { saved: ConnectSignalMapping[][] } {
  const saved: ConnectSignalMapping[][] = [];
  return {
    mirrors: [], mappings, supported: true, error: null, setError: () => {},
    saveMirrors: async () => {}, reload: async () => {},
    saveMappings: vi.fn(async (next: ConnectSignalMapping[]) => { saved.push(next); }),
    saved,
  };
}

function renderDialog(bridges: BridgesApi, initial?: ConnectSignalMapping, conversionSupported = true) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <AddMappingDialog open sourceSignal="" initial={initial} conversionSupported={conversionSupported} interfaces={[]} bridges={bridges} onClose={() => {}} />
    </ThemeProvider>,
  );
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens an MUI select by its label and picks the option. */
function choose(label: string, option: string): void {
  fireEvent.mouseDown(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

afterEach(() => cleanup());

describe('bridge mapping dialog (plan-2227 Phase 5)', () => {
  it('writes the mode and only the options it reads', async () => {
    const bridges = bridgesWith([]);
    renderDialog(bridges);
    type('Source signal', 'RobotReady');
    type('Destination signal', 'Rob_Status');
    choose('Conversion', 'Bit to word');
    type('Bit', '3');
    choose('Width', 'Byte');
    fireEvent.click(screen.getByLabelText('Invert'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Bridge' }));
    await vi.waitFor(() => expect(bridges.saved).toHaveLength(1));
    expect(bridges.saved[0]).toEqual([{
      enabled: true, sourceSignal: 'RobotReady', destSignal: 'Rob_Status', coercion: 'Strict',
      mode: 'BitToWord', bit: 3, width: 'Byte', invert: true,
    }]);
  });

  it('refuses a bit outside the width', () => {
    renderDialog(bridgesWith([]));
    type('Source signal', 'A');
    type('Destination signal', 'W');
    choose('Conversion', 'Bit from word');
    choose('Width', 'Byte');
    type('Bit', '8');
    expect(screen.getByText('Bit must be 0..7 for Byte')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add Bridge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits an existing pair in place and keeps the others', async () => {
    const scale: ConnectSignalMapping = { enabled: false, sourceSignal: 'Speed', destSignal: 'Rob_Speed', coercion: 'Strict', mode: 'Scale', factor: 2 };
    const other: ConnectSignalMapping = { enabled: true, sourceSignal: 'X', destSignal: 'Y' };
    const bridges = bridgesWith([scale, other]);
    renderDialog(bridges, scale);
    type('Factor', '0.5');
    choose('Rounding', 'Truncate');
    fireEvent.click(screen.getByRole('button', { name: 'Save Bridge' }));
    await vi.waitFor(() => expect(bridges.saved).toHaveLength(1));
    expect(bridges.saved[0]).toEqual([
      { enabled: false, sourceSignal: 'Speed', destSignal: 'Rob_Speed', coercion: 'Strict', mode: 'Scale', factor: 0.5, rounding: 'Truncate' },
      other,
    ]);
  });

  it('an invalid number blocks saving instead of saving the default (Codex review)', async () => {
    const scale: ConnectSignalMapping = { enabled: true, sourceSignal: 'Speed', destSignal: 'Rob_Speed', coercion: 'Strict', mode: 'Scale', factor: 2 };
    const bridges = bridgesWith([scale]);
    renderDialog(bridges, scale);
    type('Factor', '1.000,5');
    expect(screen.getByText('Factor: enter a valid number')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save Bridge' }) as HTMLButtonElement).disabled).toBe(true);
    type('Factor', '4');
    fireEvent.click(screen.getByRole('button', { name: 'Save Bridge' }));
    await vi.waitFor(() => expect(bridges.saved).toHaveLength(1));
    expect(bridges.saved[0][0].factor).toBe(4);
  });

  it('a fractional bit blocks saving', () => {
    renderDialog(bridgesWith([]));
    type('Source signal', 'A');
    type('Destination signal', 'W');
    choose('Conversion', 'Bit to word');
    type('Bit', '3.5');
    expect((screen.getByRole('button', { name: 'Add Bridge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an older CONNECT without mappingConversion offers 1:1 only (Codex recheck)', () => {
    renderDialog(bridgesWith([]), undefined, false);
    fireEvent.mouseDown(screen.getByLabelText('Conversion'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['1:1 (coercion)']);
  });

  it('shows the stored value at full precision (Codex recheck)', () => {
    renderDialog(bridgesWith([]), { enabled: true, sourceSignal: 'S', destSignal: 'D', mode: 'Scale', factor: 0.49999999999999994 });
    expect((screen.getByLabelText('Factor') as HTMLInputElement).value).toBe('0.49999999999999994');
  });

  it('the legacy 1:1 keeps coercion and writes no option', async () => {
    const bridges = bridgesWith([]);
    renderDialog(bridges);
    type('Source signal', 'A');
    type('Destination signal', 'B');
    fireEvent.click(screen.getByLabelText('Allow coercion'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Bridge' }));
    await vi.waitFor(() => expect(bridges.saved).toHaveLength(1));
    expect(bridges.saved[0]).toEqual([{ enabled: true, sourceSignal: 'A', destSignal: 'B', coercion: 'Coerce' }]);
  });

  it('a mode keeps only the options it reads', () => {
    expect(mappingForSave({ enabled: true, sourceSignal: 'A', destSignal: 'B', mode: 'BoolToInt', bit: 4, trueValue: 7, factor: 3 }))
      .toEqual({ enabled: true, sourceSignal: 'A', destSignal: 'B', coercion: 'Strict', mode: 'BoolToInt', trueValue: 7 });
  });

  it('labels the conversion in the bridge list', () => {
    expect(mappingConversionLabel({ enabled: true, sourceSignal: 'A', destSignal: 'B' })).toBe('1:1');
    expect(mappingConversionLabel({ enabled: true, sourceSignal: 'A', destSignal: 'B', coercion: 'Coerce' })).toBe('1:1 coerce');
    expect(mappingConversionLabel({ enabled: true, sourceSignal: 'A', destSignal: 'B', mode: 'BitToWord', bit: 3 })).toBe('BitToWord bit 3');
    expect(mappingConversionLabel({ enabled: true, sourceSignal: 'A', destSignal: 'B', mode: 'Scale' })).toBe('Scale');
  });
});

describe('gateway capability mappingConversion (plan-2227 Phase 5)', () => {
  afterEach(() => { vi.restoreAllMocks(); _resetConnectStore(); });

  async function connectWith(health: Record<string, unknown>): Promise<boolean | undefined> {
    _resetConnectStore();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      const body = url.includes('/health') ? { status: 'ok', version: '6.3.0', build: 1, ...health } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    setServerUrl('http://gw.test:5100');
    await connectToServer({ explicit: true });
    return getConnectSnapshot().mappingConversion;
  }

  it('is read from /health and false when an older gateway omits it', async () => {
    expect(await connectWith({ mappingConversion: true })).toBe(true);
    expect(await connectWith({})).toBe(false);
  });
});

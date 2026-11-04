// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 2 — inspector smoke of the SignalConnector section:
 *
 *  - the section shows Mode, Enabled, only the options of the Mode and only the
 *    slots the Mode can use (a stray set slot stays visible);
 *  - a Mode edit outside the asset editor goes to the normal overlay write;
 *  - the live preview shows the source (INT also binary, grouped by Width) and
 *    the converted result, and says when the connector does not write;
 *  - *Create bit connectors…* appears for the bit Modes and states why it is
 *    disabled outside the editor.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RVViewer } from '../src/core/rv-viewer';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import {
  SignalConnectorInspector,
  SignalConnectorPreview,
  editSignalConnectorField,
  signalConnectorFieldFilter,
} from '../src/core/hmi/rv-signal-connector-inspector';
import { makeConnectorWorld } from './helpers/signal-connector-rig';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';

afterEach(() => { cleanup(); resetProblemsForTests(); resetSlotAuthority(); });

const addr = (id: string) => ({ type: 'ComponentReference', address: `#${id}` });

function section(data: Record<string, unknown>) {
  return render(<ComponentSection
    nodePath="Cell/Unpacker"
    componentType="SignalConnector"
    data={data}
    overriddenFields={new Set<string>()}
    consumedOnly={false}
    isFieldVisible={signalConnectorFieldFilter(data)}
    onFieldEdit={vi.fn()}
    onFieldReset={vi.fn()}
    onResetComponent={vi.fn()}
    viewer={null}
    signalStore={null}
  />);
}

describe('SignalConnector inspector section', () => {
  it('BitFromWord: Mode, Enabled, Bit, Width, Invert and the two slots — nothing else', () => {
    const { container } = section({ Mode: 'BitFromWord', Enabled: true, Bit: 3, Width: 'Word', Invert: false, Factor: 2, Condition: 'Equals', SourceInt: addr('w') });
    const text = container.textContent ?? '';
    for (const f of ['Mode', 'Enabled', 'Bit', 'Width', 'Invert', 'SourceInt', 'TargetBool']) expect(text, f).toContain(f);
    for (const f of ['Factor', 'Condition', 'CompareValue', 'TrueValue', 'Rounding', 'SourceFloat', 'TargetFloat', 'SourceBool', 'TargetInt']) {
      expect(text, f).not.toContain(f);
    }
  });

  it('a stray set slot from a foreign file stays visible (so it can be cleared)', () => {
    const { container } = section({ Mode: 'BitFromWord', TargetFloat: addr('x') });
    expect(container.textContent).toContain('TargetFloat');
  });

  it('a Mode edit outside the asset editor is the normal field write', () => {
    const fallback = vi.fn();
    editSignalConnectorField({} as RVViewer, 'Cell/Unpacker', 'SignalConnector', 'Mode', 'Scale', fallback);
    editSignalConnectorField({} as RVViewer, 'Cell/Unpacker', 'SignalConnector', 'Bit', 4, fallback);
    expect(fallback.mock.calls).toEqual([['Mode', 'Scale'], ['Bit', 4]]);
  });

  it('preview: INT source in binary at the Width, the result, and why it does not write', () => {
    render(<SignalConnectorPreview sourceKind="int" targetKind="bool" source={37} result={true} width="Byte" signed={false} idleReason={null} />);
    expect(screen.getByTestId('rv-signal-connector-binary').textContent).toBe('0010 0101');
    expect(screen.getByTestId('rv-signal-connector-result').textContent).toBe('true');
    cleanup();
    render(<SignalConnectorPreview sourceKind="int" targetKind="int" source={-1} result={null} width="Byte" signed={false} idleReason="See the Problems panel" />);
    expect(screen.getByTestId('rv-signal-connector-preview').textContent).toContain('Byte: 255');
    expect(screen.getByText('Not writing')).toBeTruthy();
  });

  it('live: reads the running connector; Create bit connectors is offered and disabled outside the editor', () => {
    const w = makeConnectorWorld();
    const word = w.signal('RobotMode', 'PLCOutputInt', 0);
    const bit = w.signal('Rob_Auto', 'PLCInputBool');
    const c = w.connector('AutoBit', { Mode: 'BitFromWord', Bit: 2, Width: 'Word', SourceInt: word, TargetBool: bit });
    w.store.setByPath(word, 4);
    const viewer = { registry: w.registry, signalStore: w.store } as unknown as RVViewer;
    const data = { Mode: 'BitFromWord', Bit: 2, Width: 'Word', SourceInt: { type: 'ComponentReference', path: word }, TargetBool: { type: 'ComponentReference', path: bit } };
    render(<SignalConnectorInspector viewer={viewer} signalStore={w.store} nodePath={c.nodePath} componentType="SignalConnector" data={data} />);
    expect(screen.getByTestId('rv-signal-connector-binary').textContent).toBe('0000 0000 0000 0100');
    expect(screen.getByTestId('rv-signal-connector-result').textContent).toBe('true');
    fireEvent.click(screen.getByText('Create bit connectors…'));
    const button = screen.getByRole('button', { name: 'Create 16' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Open the model in the editor to create connectors')).toBeTruthy();
    w.dispose();
  });
});

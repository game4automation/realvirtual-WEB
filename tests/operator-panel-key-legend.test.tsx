// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-659 — `keyLegend`, the engraved legend card of a `WebOperatorPanel`.
 *
 * It exists because a plate of devices cannot say how it is driven by KEYS: a
 * knob tells the operator what it does by being a knob, a key tells him
 * nothing until the plate says it. The status strip was carrying `WASD · SPACE
 * · R`, which only helps someone who already knows.
 *
 * What this pins down:
 *  - the rows render, keys and effects, in the authored order,
 *  - `"W / S"` draws TWO key caps, not one word,
 *  - the note renders, and the card is a labelled group (a legend is read, so
 *    it has to be reachable for a screen reader too),
 *  - a panel without a `keyLegend` draws none — every panel built before this
 *    is unaffected,
 *  - the validator rejects a legend without rows and a row missing its text,
 *  - a legend carries NO signals: it cannot make a panel "not ready".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { ConnectionModeController } from '../src/core/engine/rv-connection-mode';
import {
  OperatorPanel, OperatorPanelController, operatorPanelAnalogSignals, operatorPanelSignals,
  validateOperatorPanelConfig, type OperatorPanelConfig,
} from '../src/core/hmi/operator-devices';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

/** The robot plate, reduced to what this file is about. */
const CONFIG: OperatorPanelConfig = {
  version: 1,
  id: 'key-legend-panel',
  title: 'Robot',
  columns: 2,
  density: 'compact',
  buttons: [{ label: 'Reset', signal: 'Reset', capColor: 'blue', row: 1, col: 1 }],
  selectors: [],
  estops: [],
  stackLight: [],
  keyLegend: {
    title: 'Keyboard — hold, relative to the view',
    keys: [
      { key: 'W / S', text: 'Walk away from / toward the camera' },
      { key: 'Space', text: 'Push the robot' },
      { key: 'R', text: 'Reset to the start pose' },
    ],
    note: 'The dial sets how fast, the keys only which way.',
  },
  status: [{ kind: 'idle', tone: 'neutral', text: 'READY' }],
};

function rig(config: OperatorPanelConfig = CONFIG) {
  const store = new SignalStore();
  for (const name of operatorPanelSignals(config)) store.register(name, `PLC/Robot/${name}`, false);
  for (const name of operatorPanelAnalogSignals(config)) store.register(name, `PLC/Robot/${name}`, 0, 'PLCInputFloat');
  let state: 'Connected' | 'Disconnected' = 'Disconnected';
  const mode = new ConnectionModeController({
    get connectionState() { return state; },
    setConnectionState: (s: 'Connected' | 'Disconnected') => { state = s; },
  });
  const panel = new OperatorPanelController(config);
  const viewer = { signalStore: store, connectionMode: mode, getPlugin: () => undefined };
  panel.start(viewer as never);
  return { store, panel, viewer };
}

function show(r: ReturnType<typeof rig>, config: OperatorPanelConfig = CONFIG) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <OperatorPanel viewer={r.viewer as any} panelId={config.id} source={r.panel} title="Robot" />
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('plan-659 — the keyboard legend on the plate', () => {
  it('draws every row, keys and effect, in the authored order', () => {
    show(rig());
    const card = screen.getByRole('group', { name: 'Keyboard — hold, relative to the view' });
    const texts = [...card.querySelectorAll('[data-part="key-legend-text"]')].map((e) => e.textContent);
    expect(texts).toEqual([
      'Walk away from / toward the camera',
      'Push the robot',
      'Reset to the start pose',
    ]);
  });

  it('"W / S" is TWO key caps, "Space" is one', () => {
    show(rig());
    const rows = [...document.querySelectorAll('[data-part="key-legend-row"]')];
    const caps = rows.map((r) => [...r.querySelectorAll('[data-part="key-cap"]')].map((c) => c.textContent));
    expect(caps).toEqual([['W', 'S'], ['Space'], ['R']]);
  });

  it('carries its note', () => {
    show(rig());
    expect(screen.getByText('The dial sets how fast, the keys only which way.')).toBeTruthy();
  });

  it('a panel without a keyLegend draws none', () => {
    const plain = { ...CONFIG, id: 'plain-panel', keyLegend: undefined };
    show(rig(plain), plain);
    expect(document.querySelector('[data-part="key-legend"]')).toBeNull();
  });

  it('is text only: it adds no signals and cannot make the panel unready', () => {
    expect(operatorPanelSignals(CONFIG)).toEqual(['Reset']);
    expect(operatorPanelAnalogSignals(CONFIG)).toEqual([]);
    // The note and the key names are not signal names, with or without a model.
    const { errors } = validateOperatorPanelConfig(CONFIG, (n) => n === 'Reset');
    expect(errors).toEqual([]);
  });

  describe('validation', () => {
    it('rejects a legend with no rows', () => {
      const { config, errors } = validateOperatorPanelConfig({ ...CONFIG, keyLegend: { keys: [] } });
      expect(config).toBeNull();
      expect(errors).toContain('keyLegend.keys must be a non-empty array');
    });

    it('rejects a row missing its key or its text', () => {
      const { config, errors } = validateOperatorPanelConfig({
        ...CONFIG,
        keyLegend: { keys: [{ key: 'W' }, { text: 'something' }] },
      });
      expect(config).toBeNull();
      expect(errors).toContain('keyLegend.keys[0].text must be a non-empty string');
      expect(errors).toContain('keyLegend.keys[1].key must be a non-empty string');
    });

    it('rejects a legend that is not an object, and a non-string title', () => {
      expect(validateOperatorPanelConfig({ ...CONFIG, keyLegend: [] }).errors)
        .toContain('keyLegend must be an object');
      expect(validateOperatorPanelConfig({ ...CONFIG, keyLegend: { keys: [{ key: 'W', text: 'x' }], title: 7 } }).errors)
        .toContain('keyLegend.title must be a non-empty string');
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Legacy planning starts collapsed and yields to variant management. */
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlanningWindow } from '../../src/plugins/planning-parameters/PlanningOverlay';
import PlanningFieldAction from '../../src/plugins/planning-parameters/PlanningFieldAction';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { setVariantModeContext } from '../../src/core/hmi/rv-variant-ui-mode';
import { CommandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensurePlanningCommandsRegistered, PLANNING_COMMAND_IDS } from '../../src/plugins/planning-parameters/planning-command-descriptors';
import type { UISlotProps } from '../../src/core/rv-ui-plugin';

afterEach(() => { cleanup(); setVariantModeContext(null); localStorage.clear(); });

it('starts collapsed, expands from its header, and hides the window and field action in variant mode', async () => {
  const plugin = new PlanningParametersPlugin();
  plugin.registry.declare({ owner: 'yard', title: 'Yard', params: [
    { key: 'rate', label: 'Rate', type: 'number', default: 1, group: 'Flow', apply: 'live' },
  ] });
  const viewer = { getPlugin: () => plugin, registry: {
    getNode: () => ({}), getAddressForNode: () => 'node',
  } } as unknown as UISlotProps['viewer'];
  render(<><PlanningWindow viewer={viewer} /><PlanningFieldAction viewer={viewer}
    nodePath="yard" componentType="Drive" fieldName="speed" /></>);
  expect(screen.getByRole('region', { name: 'Legacy planning' })).toBeTruthy();
  expect(screen.getByText(/Yard/)).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Rate' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Show speed in planning window' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
  expect(screen.getByRole('textbox', { name: 'Rate' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Legacy planning' })).toBeTruthy();
  act(() => setVariantModeContext({ docKey: 'planning-test', hasVariants: true, setMode: async () => {} }));
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Collapse panel' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show speed in planning window' })).toBeNull();
  const commands = new CommandRegistry();
  ensurePlanningCommandsRegistered(commands);
  for (const id of PLANNING_COMMAND_IDS) {
    const descriptor = commands.get(id)!;
    const impl = (await descriptor.impl())!;
    expect(impl.enabled({ viewer } as Parameters<typeof impl.enabled>[0], {} as never)).toEqual({ reason: 'variants-active' });
  }
  act(() => setVariantModeContext(null));
  expect(screen.getByRole('button', { name: 'Collapse panel' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Rate' })).toBeTruthy();
});

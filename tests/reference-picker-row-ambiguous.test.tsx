// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * reference-picker-row-ambiguous.test.tsx — plan-765 9.7 (UI half).
 *
 * Two sibling nodes with the same authored name (`Sep/Pin`, `Sep/Pin` — the
 * second loads as `Pin_1`, stamped `Pin`) share one authored path, so a
 * reference cannot address either of them. The picker lists the path once,
 * DISABLED, with the reason in its tooltip — and never writes it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { ReferencePickerRow } from '../src/core/hmi/ReferencePickerRow';

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

/** Cell / Sep / Pin + Pin_1 (stamped `Pin`), both Sensors; Cell / Belt a unique Sensor; Cell / Step the owner. */
function makeViewer(): RVViewer {
  const root = new Object3D();
  root.name = 'Cell';
  const sep = child(root, 'Sep');
  const a = child(sep, 'Pin', { Sensor: {} });
  const b = child(sep, 'Pin_1', { Sensor: {} });
  b.userData._rvOrigName = 'Pin';
  const belt = child(root, 'Belt', { Sensor: {} });
  const step = child(root, 'Step', { LogicStep_WaitForSensor: {} });
  const entries: Array<[string, Object3D]> = [
    ['Cell/Sep/Pin', a], ['Cell/Sep/Pin_1', b], ['Cell/Belt', belt], ['Cell/Step', step],
  ];
  return {
    currentModelRoot: root,
    registry: {
      forEachNode: (cb: (p: string, n: Object3D) => void) => entries.forEach(([p, n]) => cb(p, n)),
      getNode: (p: string) => entries.find(([q]) => q === p)?.[1] ?? null,
    },
  } as unknown as RVViewer;
}

afterEach(cleanup);

describe('plan-765 9.7 — ReferencePickerRow refuses an ambiguous authored path', () => {
  it('renders the shared sibling path once, disabled, with the reason as title; a normal path stays pickable', () => {
    const onEdit = vi.fn();
    render(
      <ReferencePickerRow
        fieldName="Sensor"
        value={null}
        target={{ kind: 'component', componentType: 'Sensor' }}
        viewer={makeViewer()}
        nodePath="Cell/Step"
        onEdit={onEdit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');

    const pins = within(listbox).getAllByRole('option').filter((o) => o.textContent === 'Pin');
    expect(pins).toHaveLength(1);
    const pin = pins[0];
    expect(pin.getAttribute('aria-disabled')).toBe('true');
    expect(pin.getAttribute('title')).toBe(
      'Sep/Pin: 2 siblings share this name — not addressable by path; rename one in the source',
    );

    const belt = within(listbox).getAllByRole('option').find((o) => o.textContent === 'Belt')!;
    expect(belt.getAttribute('aria-disabled')).not.toBe('true');
    expect(belt.getAttribute('title')).toBe('Belt');

    // Clicking the disabled row writes nothing; the normal row writes its path.
    fireEvent.click(pin);
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(belt);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toEqual({ type: 'ComponentReference', path: 'Belt', componentType: 'Sensor' });
  });
});

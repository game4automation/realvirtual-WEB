// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 §9.6 — the unit badge on a scale field, through the REAL bind path
 * (unit-aware bind → document → executors → manager) up to the rendered
 * `ComponentSection`: auto / manual (click = reset to auto) / mismatch /
 * conflict / not-effective (with its blocker) / not-applied, coexisting with
 * the override dot, and absent without a bound slot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { unitRig, type UnitRig } from './helpers/unit-scale-rig';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import { isFieldOverridden } from '../src/core/hmi/rv-field-override';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { bindWithUnitScale } from '../src/plugins/signal-bind/unit-scale';
import { getSchemaDefaults } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';

const FP = 'Drive_FollowPosition';
const DS = 'Drive_Simple';

let rigs: UnitRig[] = [];
function rig(behaviors: Record<string, Record<string, unknown>>): UnitRig {
  const r = unitRig({ behaviors });
  Object.assign(r.viewer as unknown as Record<string, unknown>, { behaviors: { getActiveBinds: () => [] } });
  rigs.push(r);
  return r;
}

function section(r: UnitRig, type: string) {
  // The inspector shows the full field set (a Unity GLB carries every field;
  // the rig's extras start empty) — defaults under the extras.
  const data = { ...getSchemaDefaults(type), ...((r.node.userData.realvirtual as Record<string, Record<string, unknown>>)[type] ?? {}) };
  const overridden = new Set(['Scale', 'ScaleSpeed', 'CurrentPositionScale'].filter((f) => isFieldOverridden(r.viewer, r.nodePath, type, f)));
  return (
    <ComponentSection
      nodePath={r.nodePath}
      componentType={type}
      data={data}
      overriddenFields={overridden}
      consumedOnly={false}
      onFieldEdit={() => {}}
      onFieldReset={() => {}}
      onResetComponent={() => {}}
      viewer={r.viewer as RVViewer}
      signalStore={r.store}
    />
  );
}

function badgeOf(container: HTMLElement, field: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${field} unit scale: auto"], [aria-label^="${field} unit scale:"]`);
}

beforeEach(() => resetProblemsForTests());
afterEach(() => {
  cleanup();
  for (const r of rigs) r.dispose();
  rigs = [];
});

describe('unit badge on the scale field (plan-512 F8)', () => {
  it('no bound slot → no badge (unchanged rendering)', () => {
    const r = rig({ [FP]: {} });
    const { container } = render(section(r, FP));
    expect(container.querySelector('[data-testid="unit-scale-badge"]')).toBeNull();
  });

  it('auto after a bind: link badge with the conversion in its tooltip', async () => {
    const r = rig({ [FP]: {} });
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    const { container } = render(section(r, FP));
    const badge = badgeOf(container, 'Scale')!;
    expect(badge.getAttribute('data-unit-status')).toBe('auto');
    expect(badge.getAttribute('title')).toContain('×1000');
    expect(badge.getAttribute('title')).toContain('m → mm');
  });

  it('manual next to the override dot; a click resets to auto (factor + provenance)', async () => {
    const r = rig({ [FP]: {} });
    const h = r.signal('Ball.h', 'PLCOutputFloat', 'm');
    await r.bind('Position', h);
    await r.edit(FP, 'Scale', 500);
    const view = render(section(r, FP));
    const badge = badgeOf(view.container, 'Scale')!;
    expect(badge.getAttribute('data-unit-status')).toBe('manual');
    expect(badge.getAttribute('title')).toContain('automatic would be ×1000');
    // The override dot of the same row is still there.
    expect(view.container.querySelector('[aria-label="reset Scale to default"]')).not.toBeNull();
    fireEvent.click(badge);
    await waitFor(() => expect(r.extras(FP, 'Scale')).toBe(1000));
    await r.doc.whenIdle();
    expect(r.mapping('Position')?.unitScale?.factor).toBe(1000);
    view.rerender(section(r, FP));
    expect(badgeOf(view.container, 'Scale')!.getAttribute('data-unit-status')).toBe('auto');
  });

  it('mismatch (rad → mm) shows a warning badge', async () => {
    const r = rig({ [FP]: {} });
    await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    const { container } = render(section(r, FP));
    const badge = badgeOf(container, 'Scale')!;
    expect(badge.getAttribute('data-unit-status')).toBe('mismatch');
    expect(badge.getAttribute('title')).toContain('Units incompatible: rad');
  });

  it('conflict on a shared field (Drive_Simple.ScaleSpeed)', async () => {
    const r = rig({ [DS]: {} });
    await r.bind('Speed', r.signal('PLC.Speed', 'PLCOutputFloat', 'm/s'));
    await r.bind('Accelaration', r.signal('PLC.Acc', 'PLCOutputFloat', 'mm/s2'));
    const { container } = render(section(r, DS));
    const badge = badgeOf(container, 'ScaleSpeed')!;
    expect(badge.getAttribute('data-unit-status')).toBe('conflict');
    expect(badge.getAttribute('title')).toContain('shared with slot "Speed"');
  });

  it('not-effective names what blocks it', async () => {
    const r = rig({ [FP]: { ScaleFeedbackPosition: false } });
    await r.bind('CurrentPosition', r.signal('PLC.FbM', 'PLCInputFloat', 'm'));
    const { container } = render(section(r, FP));
    const badge = badgeOf(container, 'Scale')!;
    expect(badge.getAttribute('data-unit-status')).toBe('not-effective');
    expect(badge.getAttribute('title')).toContain('ScaleFeedbackPosition=false');
  });

  it('not-applied without a document: the tooltip carries the factor to enter by hand', async () => {
    const r = rig({ [FP]: {} });
    const off = { ...r.editTarget } as EditTarget;
    Object.defineProperty(off, 'available', { value: false });
    setActiveEditTarget(off);
    await bindWithUnitScale(r.viewer, r.target, r.persistence(), r.row('Position'),
      r.signal('Ball.h', 'PLCOutputFloat', 'm'), { editTarget: off });
    const { container } = render(section(r, FP));
    const badge = badgeOf(container, 'Scale')!;
    expect(badge.getAttribute('data-unit-status')).toBe('not-applied');
    expect(badge.getAttribute('title')).toContain('×1000');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the read-only-live ComponentSection mode (ephemeral virtual
 * components). The snap-point projection that feeds the snap virtual component
 * is tested separately against a real registry in snap-data-section.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentSection, runtimeRow, isRuntimeRow } from '../src/core/hmi/rv-component-section';

afterEach(() => cleanup());

// ── runtimeRow ─────────────────────────────────────────────────────────────

describe('runtimeRow', () => {
  it('marks a value as a runtime row and carries display + opts', () => {
    const r = runtimeRow('42 mm/s', { color: '#abc', onClick: () => {} });
    expect(isRuntimeRow(r)).toBe(true);
    expect(r.display).toBe('42 mm/s');
    expect(r.color).toBe('#abc');
    expect(typeof r.onClick).toBe('function');
  });

  it('isRuntimeRow rejects plain values', () => {
    expect(isRuntimeRow('x')).toBe(false);
    expect(isRuntimeRow(42)).toBe(false);
    expect(isRuntimeRow(null)).toBe(false);
    expect(isRuntimeRow({ display: 'x' })).toBe(false);
  });
});

// ── ComponentSection readOnlyLive mode ─────────────────────────────────────

function renderReadOnlyLive(data: Record<string, unknown>) {
  return render(
    <ComponentSection
      nodePath="Root/Belt"
      componentType="CONVEYOR"
      data={data}
      overriddenFields={new Set()}
      consumedOnly={false}
      readOnlyLive
      onFieldEdit={() => {}}
      onFieldReset={() => {}}
      onResetComponent={() => {}}
      viewer={null}
      signalStore={null}
    />,
  );
}

describe('ComponentSection — readOnlyLive', () => {
  it('renders ALL data fields as visible read-only rows (label + value, no editor)', () => {
    renderReadOnlyLive({
      Running: runtimeRow('true'),
      'Part Count': runtimeRow('3'),
      Speed: runtimeRow('1200 mm/s'),
    });
    // Header (uppercase component name)
    expect(screen.getByText('CONVEYOR')).toBeTruthy();
    // All fields visible as primary rows (no "N more fields" collapse)
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.getByText('Part Count')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('1200 mm/s')).toBeTruthy();
    // No editor inputs in read-only mode
    expect(document.querySelector('input')).toBeNull();
    // No "more fields" collapse clutter
    expect(screen.queryByText(/more field/)).toBeNull();
  });

  it('renders a non-spec raw value through formatDisplayValue', () => {
    renderReadOnlyLive({ Axis: 'Z' });
    expect(screen.getByText('Axis')).toBeTruthy();
    expect(screen.getByText('Z')).toBeTruthy();
  });

  it('invokes onClick when a clickable row value is clicked (e.g. Paired with)', () => {
    const onClick = vi.fn();
    renderReadOnlyLive({ 'Paired with': runtimeRow('RollConveyor-3m_2', { onClick }) });
    fireEvent.click(screen.getByText('RollConveyor-3m_2'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates role=button cells with Enter and Space', () => {
    const onClick = vi.fn();
    renderReadOnlyLive({ 'Paired with': runtimeRow('RollConveyor-3m_2', { onClick }) });

    const valueButton = screen.getByRole('button', { name: 'RollConveyor-3m_2' });
    expect(valueButton.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(valueButton, { key: 'Enter' });
    fireEvent.keyDown(valueButton, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);

    const sectionButton = screen.getByRole('button', { name: 'CONVEYOR' });
    expect(sectionButton.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(sectionButton, { key: 'Enter' });
    expect(screen.queryByText('RollConveyor-3m_2')).toBeNull();
    fireEvent.keyDown(sectionButton, { key: ' ' });
    expect(screen.getByText('RollConveyor-3m_2')).toBeTruthy();
  });

  it('hides field underscore-prefixed internal keys', () => {
    renderReadOnlyLive({ Type: runtimeRow('roller'), _internal: runtimeRow('hidden') });
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.queryByText('hidden')).toBeNull();
  });
});

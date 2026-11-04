// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-502 §9.7 — `NumberEditor` with optional `min`/`max`: a typed value is
 * clamped on commit (blur/Enter), in-range typing still commits live, the range
 * hint is shown; without the props the editor behaves exactly as before.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NumberEditor, Vector3Editor, clampToRange, formatRangeHint } from '../src/core/hmi/rv-field-editors';
import { clampNumber } from '../src/plugins/layout-planner/PlannerToolbarButtons';

afterEach(() => {
  cleanup();
});

function input(): HTMLInputElement {
  // plan-510: a text input with inputMode="decimal", not type="number".
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('NumberEditor min/max (plan-502 F8)', () => {
  it('clamps an out-of-range value on blur and on Enter', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={0.7} onChange={onChange} min={0.5} max={1} />);
    fireEvent.change(input(), { target: { value: '3' } });
    // Out of range: no live commit while typing.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(input().value).toBe('1');

    fireEvent.change(input(), { target: { value: '0.1' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(0.5);
  });

  it('in-range typing commits live (keyboard parity with drag)', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={0.7} onChange={onChange} min={0.5} max={1} />);
    fireEvent.change(input(), { target: { value: '0.95' } });
    expect(onChange).toHaveBeenCalledWith(0.95);
  });

  it('keeps external updates after a focused live draft is acknowledged', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberEditor value={10} onChange={onChange} liveCommit />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '15' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(15);

    rerender(<NumberEditor value={15} onChange={onChange} liveCommit />);
    rerender(<NumberEditor value={22} onChange={onChange} liveCommit />);
    expect(input().value).toBe('22');
    fireEvent.blur(input());
    expect(input().value).toBe('22');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(15);
  });

  it('shows the range hint and passes the bounds to the input', () => {
    render(<NumberEditor value={0.7} onChange={() => {}} min={0.5} max={1} unit="m" />);
    expect(screen.getByTestId('rv-number-range').textContent).toBe('0.5…1');
    expect(input().min).toBe('0.5');
    expect(input().max).toBe('1');
  });

  it('without min/max: unchanged — any value commits, no hint', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={1} onChange={onChange} />);
    expect(screen.queryByTestId('rv-number-range')).toBeNull();
    fireEvent.change(input(), { target: { value: '12345' } });
    expect(onChange).toHaveBeenLastCalledWith(12345);
    fireEvent.change(input(), { target: { value: '-7' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenLastCalledWith(-7);
  });

  it('disabled: typing does not commit', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={1} onChange={onChange} disabled />);
    expect(input().disabled).toBe(true);
  });

  it('helpers: clampToRange and formatRangeHint', () => {
    expect(clampToRange(3, 0.5, 1)).toBe(1);
    expect(clampToRange(0, 0.5, 1)).toBe(0.5);
    expect(clampToRange(0.7, 0.5, 1)).toBe(0.7);
    expect(clampToRange(-5)).toBe(-5);
    expect(clampToRange(-5, 0)).toBe(0);
    expect(formatRangeHint(0.5, 1)).toBe('0.5…1');
    expect(formatRangeHint(0)).toBe('≥ 0');
    expect(formatRangeHint(undefined, 10)).toBe('≤ 10');
    expect(formatRangeHint()).toBe('');
  });
});

// ── plan-510 §9.8 — comma input, error state, lossless drafts ─────────────

describe('NumberEditor decimal input (plan-510)', () => {
  beforeEach(() => {
    // Synthetic pointer events carry no real pointer — capture would throw.
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
    vi.spyOn(Element.prototype, 'releasePointerCapture').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('is a text input with inputmode="decimal"', () => {
    render(<NumberEditor value={1} onChange={() => {}} />);
    expect(input().type).toBe('text');
    expect(input().getAttribute('inputmode')).toBe('decimal');
  });

  it('"9,81" commits 9.81 on blur (regression: parseFloat gave 9) and shows a dot afterwards', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberEditor value={1} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '9,81' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenLastCalledWith(9.81);
    expect(onChange).not.toHaveBeenCalledWith(9);
    rerender(<NumberEditor value={9.81} onChange={onChange} />);
    fireEvent.blur(input());
    expect(input().value).toBe('9.81');
  });

  it('"9,81" commits 9.81 on Enter', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={1} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '9,81' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(9.81);
  });

  it('a drag after comma input starts from 9.81, not 9', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={1} onChange={onChange} ariaLabel="g" />);
    fireEvent.change(input(), { target: { value: '9,81' } });
    const handle = screen.getByLabelText('g drag handle');
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 110, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(19.81);
    expect(onChange).not.toHaveBeenCalledWith(19);
  });

  it('"1.000,5" puts the field into its error state; blur restores the last valid value', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={2} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '1.000,5' } });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('2');
    expect(input().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('an external 1e-7 seeds a parseable draft; an unchanged blur commits nothing', () => {
    const onChange = vi.fn();
    render(<NumberEditor value={1e-7} onChange={onChange} />);
    expect(input().value).toBe('1e-7');
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('15 significant digits: mount, external re-sync and an unchanged blur fire no onChange', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberEditor value={1.23456789012345} onChange={onChange} />);
    rerender(<NumberEditor value={2.23456789012345} onChange={onChange} />);
    expect(input().value).toBe('2.23456789012345');
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
  });
});

/** Focus alone must never turn an external update into a stale write. */
describe.each([true, false])('NumberEditor external updates (liveCommit=%s)', (liveCommit) => {
  it('follows external values while focused and untouched, without committing on blur', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberEditor value={10} onChange={onChange} liveCommit={liveCommit} />);
    fireEvent.focus(input());
    rerender(<NumberEditor value={22} onChange={onChange} liveCommit={liveCommit} />);
    expect(input().value).toBe('22');
    fireEvent.blur(input());
    expect(input().value).toBe('22');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves a user-edited draft across an external update and commits it on blur', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberEditor value={10} onChange={onChange} liveCommit={liveCommit} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '15' } });
    onChange.mockClear();
    rerender(<NumberEditor value={22} onChange={onChange} liveCommit={liveCommit} />);
    expect(input().value).toBe('15');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledExactlyOnceWith(15);
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('Vector3Editor decimal input (plan-510)', () => {
  function axis(a: 'x' | 'y' | 'z'): HTMLInputElement {
    return screen.getByLabelText(`${a} value`) as HTMLInputElement;
  }

  it('text inputs with inputmode="decimal"; "0,5" commits 0.5', () => {
    const onChange = vi.fn();
    render(<Vector3Editor value={{ x: 1, y: 2, z: 3 }} onChange={onChange} />);
    expect(axis('x').type).toBe('text');
    expect(axis('x').getAttribute('inputmode')).toBe('decimal');
    fireEvent.change(axis('y'), { target: { value: '0,5' } });
    fireEvent.blur(axis('y'));
    expect(onChange).toHaveBeenLastCalledWith({ x: 1, y: 0.5, z: 3 });
  });

  it('15 significant digits: mount, re-sync and unchanged blur fire no onChange', () => {
    const onChange = vi.fn();
    const v = { x: 1.23456789012345, y: 0, z: 0 };
    const { rerender } = render(<Vector3Editor value={v} onChange={onChange} />);
    rerender(<Vector3Editor value={{ ...v, x: 2.23456789012345 }} onChange={onChange} />);
    expect(axis('x').value).toBe('2.23456789012345');
    fireEvent.blur(axis('x'));
    fireEvent.blur(axis('y'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an invalid draft is flagged and discarded on blur', () => {
    const onChange = vi.fn();
    render(<Vector3Editor value={{ x: 1, y: 2, z: 3 }} onChange={onChange} />);
    fireEvent.change(axis('z'), { target: { value: '1.000,5' } });
    expect(axis('z').getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(axis('z'));
    expect(onChange).not.toHaveBeenCalled();
    expect(axis('z').value).toBe('3');
  });
});

describe('Layout planner number fields (plan-510)', () => {
  it('clampNumber accepts a comma: "9,81" is 9.81', () => {
    expect(clampNumber('9,81', 0, 100)).toBe(9.81);
    expect(clampNumber('250', 0, 100)).toBe(100);
    expect(clampNumber('', 0, 100)).toBeNull();
    expect(clampNumber('1.000,5', 0, 10000)).toBeNull();
  });
});

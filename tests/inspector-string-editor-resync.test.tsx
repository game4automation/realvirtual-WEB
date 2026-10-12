// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * StringEditor must follow its `value` prop.
 *
 * The inspector reuses field editors across a selection change. The editor
 * kept its first value in local state, so every `Group` component in the asset
 * editor read the GroupName of the FIRST selected node ("axis1" everywhere,
 * 2026-09-17) — and a blur would have committed that stale text into the newly
 * selected node.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StringEditor } from '../src/core/hmi/rv-field-editors';

afterEach(() => cleanup());

describe('StringEditor follows its value prop', () => {
  it('shows the new value when the prop changes (selection change, undo, reset)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StringEditor value="axis1" onChange={onChange} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('axis1');
    rerender(<StringEditor value="axis2" onChange={onChange} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('axis2');
  });

  it('a blur after a prop change does not commit the previous value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StringEditor value="axis1" onChange={onChange} />);
    rerender(<StringEditor value="Group22" onChange={onChange} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still commits a typed value on blur', () => {
    const onChange = vi.fn();
    render(<StringEditor value="axis1" onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'gantry' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('gantry');
  });
});

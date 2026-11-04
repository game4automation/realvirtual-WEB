// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HexColorEditor } from '../src/core/hmi/rv-field-editors';
import { FieldRow } from '../src/core/hmi/rv-field-row';

afterEach(cleanup);

describe('HexColorEditor', () => {
  it('renders a swatch and uppercase hex text together', () => {
    render(<HexColorEditor value="#aabbcc" onChange={() => {}} ariaLabel="Color" />);
    const swatch = screen.getByLabelText('Color') as HTMLInputElement;
    const text = screen.getByRole('textbox') as HTMLInputElement;
    expect(swatch.type).toBe('color');
    expect(text.value).toBe('#AABBCC');
    expect(swatch.parentElement?.contains(text)).toBe(true);
  });

  it.each(['Enter', 'blur'])('commits valid typed hex on %s only', (event) => {
    const onChange = vi.fn();
    render(<HexColorEditor value="#112233" onChange={onChange} />);
    const text = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(text, { target: { value: '#abcdef' } });
    expect(onChange).not.toHaveBeenCalled();
    if (event === 'Enter') fireEvent.keyDown(text, { key: 'Enter' });
    else fireEvent.blur(text);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#ABCDEF');
    fireEvent.blur(text);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each(['Enter', 'blur'])('reverts invalid hex on %s', (event) => {
    const onChange = vi.fn();
    render(<HexColorEditor value="#aabbcc" onChange={onChange} />);
    const text = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(text, { target: { value: '#xyz' } });
    if (event === 'Enter') fireEvent.keyDown(text, { key: 'Enter' });
    else fireEvent.blur(text);
    expect(text.value).toBe('#AABBCC');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drafts picker input and commits once on native change', () => {
    const onChange = vi.fn();
    render(<HexColorEditor value="#112233" onChange={onChange} ariaLabel="Color" />);
    const swatch = screen.getByLabelText('Color');
    fireEvent.input(swatch, { target: { value: '#abcdef' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(swatch);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#ABCDEF');
  });
});

describe('FieldRow valueEditor', () => {
  it('replaces the default editor only when editable', () => {
    const props = { fieldName: 'Label', value: 'default text', status: 'consumed' as const,
      isOverridden: false, onEdit: vi.fn(), onReset: vi.fn(), viewer: null, signalStore: null,
      valueEditor: <button>Custom editor</button> };
    const { rerender } = render(<FieldRow {...props} />);
    expect(screen.getByRole('button', { name: 'Custom editor' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<FieldRow {...props} descriptor={{ type: 'string', readonly: true }} />);
    expect(screen.queryByRole('button', { name: 'Custom editor' })).toBeNull();
    expect(screen.getByText('default text')).toBeTruthy();
    rerender(<FieldRow {...props} valueEditor={undefined} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('default text');
  });
});

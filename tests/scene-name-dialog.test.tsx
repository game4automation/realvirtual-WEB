// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneNameDialog — the one-field prompt behind Rename and Save-as
 * (plan-372, extracted so the dashboard can carry the Scene window's actions
 * before that window is deleted in Phase 13).
 *
 * The empty-name guard is the case worth pinning: coercing a blank name into
 * "Untitled" would produce a scene indistinguishable from a user-named one.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SceneNameDialog } from '../src/core/hmi/projects/SceneNameDialog';

afterEach(() => cleanup());

describe('SceneNameDialog', () => {
  it('renders nothing when there is no pending request', () => {
    render(<SceneNameDialog state={null} onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByTestId('scene-name-confirm')).toBeNull();
  });

  it('titles and labels itself differently for rename and save-as', () => {
    render(<SceneNameDialog state={{ kind: 'rename', id: 's1', name: 'Line A' }} onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByText('Rename scene')).toBeTruthy();
    expect(screen.getByTestId('scene-name-confirm').textContent).toBe('Rename');
    cleanup();
    render(<SceneNameDialog state={{ kind: 'saveAs', name: 'Line A' }} onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByText('Save scene as')).toBeTruthy();
    expect(screen.getByTestId('scene-name-confirm').textContent).toBe('Save');
  });

  it('blocks submit on an empty or whitespace-only name', () => {
    const onSubmit = vi.fn();
    render(<SceneNameDialog state={{ kind: 'rename', id: 's1', name: '   ' }} onChange={() => {}} onSubmit={onSubmit} />);
    const confirm = screen.getByTestId('scene-name-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a valid name, and on Enter too', () => {
    const onSubmit = vi.fn();
    render(<SceneNameDialog state={{ kind: 'rename', id: 's1', name: 'Line B' }} onChange={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('scene-name-confirm'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText('Scene name'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('does not submit on Enter while the name is empty', () => {
    const onSubmit = vi.fn();
    render(<SceneNameDialog state={{ kind: 'rename', id: 's1', name: '' }} onChange={() => {}} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByLabelText('Scene name'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports edits through onChange without owning the value', () => {
    const onChange = vi.fn();
    render(<SceneNameDialog state={{ kind: 'rename', id: 's1', name: 'A' }} onChange={onChange} onSubmit={() => {}} />);
    fireEvent.change(screen.getByLabelText('Scene name'), { target: { value: 'AB' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'rename', id: 's1', name: 'AB' });
  });
});

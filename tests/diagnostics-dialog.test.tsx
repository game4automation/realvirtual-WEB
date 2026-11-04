// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsDialog } from '../src/core/hmi/DiagnosticsDialog';

afterEach(cleanup);

describe('DiagnosticsDialog', () => {
  it('shows preview counts and saves the selected window', async () => {
    const preview = vi.fn().mockResolvedValue({
      lines: 12, errors: 2, warnings: 3, sources: { browser: true, connect: false }, first: [], last: [],
    });
    const save = vi.fn().mockResolvedValue({ ok: true, file: 'diag.json', source: 'browser' });
    render(<DiagnosticsDialog open onClose={() => {}} preview={preview} save={save} />);
    await waitFor(() => expect(screen.getByTestId('diagnostics-counts').textContent).toContain('12 lines'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ minutes: 15 });
  });
});

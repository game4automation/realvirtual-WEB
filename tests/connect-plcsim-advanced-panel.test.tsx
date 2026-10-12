// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-494 lane web — the PLCSIM Advanced help texts in the CONNECT panel.
 *
 * Without a data block filter CONNECT no longer browses every data block: the live interface loads
 * only the blocks its configured signals address, and discovery lists none at all. The three texts
 * below are the only place a user is told that, so they are asserted rather than trusted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { PlcSimAdvancedFieldsBlock } from '../src/core/hmi/ConnectPanel';
import { PLCSIMADVANCED_SETTINGS_DEFAULTS } from '../src/core/hmi/connect-store';
import { rvDarkTheme } from '../src/core/hmi/theme';

function renderBlock() {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <PlcSimAdvancedFieldsBlock
        value={{ ...PLCSIMADVANCED_SETTINGS_DEFAULTS }}
        onChange={() => {}}
      />
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('PlcSimAdvancedFieldsBlock help texts', () => {
  it('explains that an empty data block filter loads only the blocks the signals use', () => {
    renderBlock();
    expect(
      screen.getByText(/Empty = only the blocks used by the configured signals/i),
    ).toBeTruthy();
    expect(screen.getByText(/browsing lists no data block tags then/i)).toBeTruthy();
  });

  it('names the 500 000-entry fallback and where it is reported', () => {
    renderBlock();
    const hint = screen.getByText(/Off browses every tag of the process image/i);
    expect(hint.textContent).toMatch(/500 000 entries/);
    expect(hint.textContent).toMatch(/tagListFallback/);
    expect(hint.textContent).toMatch(/GET \/status/);
  });

  it('tells the user how to get data block tags into a browse', () => {
    renderBlock();
    expect(
      screen.getByText(/Enter data block names above to browse data block tags\./i),
    ).toBeTruthy();
  });
});

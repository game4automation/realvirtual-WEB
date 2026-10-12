// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-544 F7 — "Open-source licenses" links: the settings footer opens the shipped
 * THIRD-PARTY-NOTICES.txt relative to the deploy base, the CONNECT options open the gateway's
 * GET /third-party-notices. Both open in a new tab without an opener.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { OpenSourceLicensesLink } from '../src/core/hmi/SettingsPanel';
import { ConnectLicensesLink } from '../src/core/hmi/ConnectOptionsWindow';

afterEach(() => cleanup());

describe('Open-source licenses links (plan-544 F7)', () => {
  it('the settings footer link points at BASE_URL + THIRD-PARTY-NOTICES.txt in a new tab', () => {
    render(<OpenSourceLicensesLink />);
    const link = screen.getByTestId('settings-open-source-licenses');
    expect(link.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}THIRD-PARTY-NOTICES.txt`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Open-source licenses');
  });

  it('the CONNECT options link points at the gateway route, without a doubled slash', () => {
    render(<ConnectLicensesLink serverUrl="http://localhost:5100/" />);
    const link = screen.getByTestId('connect-open-source-licenses');
    expect(link.getAttribute('href')).toBe('http://localhost:5100/third-party-notices');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

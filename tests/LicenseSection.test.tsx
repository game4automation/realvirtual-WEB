// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { LicenseSection } from '../src/core/hmi/LicenseSection';
import { _setLicenseSnapshotForTests, type LicenseState, type LicenseStatus } from '../src/core/hmi/license-store';
import { rvDarkTheme } from '../src/core/hmi/theme';

function status(state: LicenseState, patch: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    state,
    gatewayAllowed: true,
    maxSignals: 20,
    admittedSignals: 17,
    effectiveNow: new Date().toISOString(),
    licenseType: null,
    licenseId: null,
    error: null,
    overLimitSignals: [],
    registration: null,
    ...patch,
  };
}

function renderStatus(value: LicenseStatus) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <LicenseSection serverUrl="http://localhost:5100" statusOverride={value} />
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  _setLicenseSnapshotForTests({});
});

describe('LicenseSection', () => {
  it.each([
    ['LicensedAnnual', 'License: Annual - 500 signals', { maxSignals: 500 }],
    ['LicensedLifetime', 'License: Lifetime - Unlimited signals', { maxSignals: 2_147_483_647 }],
    ['LicensedCommunity', 'Free - 17 / 20 signals', {}],
    ['Unlicensed', 'License required', {}],
    ['PendingRegistration', 'License: Waiting for confirmation', {
      registration: { status: 'waitingForEmailConfirmation', email: 't***@example.com', startedAt: new Date().toISOString() },
    }],
  ] as const)('renders %s with icon and label', (stateName, label, patch) => {
    const view = renderStatus(status(stateName, patch));
    expect(screen.getByText(label)).toBeTruthy();
    expect(view.container.querySelector('svg')).toBeTruthy();
  });

  it('shows the masked license key and a deactivate action for commercial licenses', () => {
    renderStatus(status('LicensedLifetime', {
      maxSignals: 2_147_483_647,
      licenseKeyMasked: 'LIC-****-****-CCCC',
    }));
    expect(screen.getByText('LIC-****-****-CCCC')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate...' }));
    expect(screen.getByRole('dialog', { name: 'realvirtual CONNECT license' })).toBeTruthy();
    expect(screen.getByText('Deactivate this device')).toBeTruthy();
    const deactivate = screen.getByRole('button', { name: 'Deactivate license' }) as HTMLButtonElement;
    expect(deactivate.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('License key'), { target: { value: 'LIC-AAAA-BBBB-CCCC' } });
    expect((screen.getByRole('button', { name: 'Deactivate license' }) as HTMLButtonElement).disabled).toBe(false);
    // The registration/activation sections are replaced by the deactivate section when licensed.
    expect(screen.queryByText('Start free with 20 signals')).toBeNull();
  });

  it('colors the tier icon green for commercial and amber for free licenses', () => {
    const commercial = renderStatus(status('LicensedAnnual', { maxSignals: 500 }));
    const commercialIcon = commercial.container.querySelector('svg') as SVGElement;
    expect(getComputedStyle(commercialIcon).color).toBe('rgb(102, 187, 106)');
    cleanup();
    const free = renderStatus(status('LicensedCommunity'));
    const freeIcon = free.container.querySelector('svg') as SVGElement;
    expect(getComputedStyle(freeIcon).color).toBe('rgb(255, 167, 38)');
  });

  it('renders annual-expiry degradation without migration copy', () => {
    renderStatus(status('Degraded', {
      error: 'LICENSE_TOKEN_EXPIRED',
    }));
    expect(screen.getByText('License degraded - Token expired')).toBeTruthy();
    expect(screen.queryByText(/Migration grace/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Activate license...' })).toBeTruthy();
  });

  it('renders the inviting registration copy for an unlicensed gateway', () => {
    renderStatus(status('Unlicensed', { gatewayAllowed: false, maxSignals: 0 }));
    expect(screen.getByText('License required')).toBeTruthy();
    expect(screen.getByText('Register free for 20 PLC signals - or activate a license key.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activate license...' })).toBeTruthy();
  });

  it('offers the activation dialog from the free license state', () => {
    renderStatus(status('LicensedCommunity'));
    fireEvent.click(screen.getByRole('button', { name: 'Activate license...' }));
    expect(screen.getByRole('dialog', { name: 'Activate realvirtual CONNECT' })).toBeTruthy();
  });

  it('shows the license terms notice with a link in the activation dialog', () => {
    renderStatus(status('Unlicensed'));
    fireEvent.click(screen.getByRole('button', { name: 'Activate license...' }));
    const link = screen.getByRole('link', { name: 'realvirtual license terms' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://realvirtual.io/en/terms/');
    expect(link.target).toBe('_blank');
  });

  it('shows an unchecked product-updates consent checkbox in the activation dialog', () => {
    renderStatus(status('Unlicensed'));
    fireEvent.click(screen.getByRole('button', { name: 'Activate license...' }));
    const checkbox = screen.getByRole('checkbox', {
      name: /product updates and news/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('shows the privacy policy link in the activation dialog', () => {
    renderStatus(status('Unlicensed'));
    fireEvent.click(screen.getByRole('button', { name: 'Activate license...' }));
    const link = screen.getByRole('link', { name: 'privacy policy' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://realvirtual.io/en/privacy/');
    expect(link.target).toBe('_blank');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  deriveLicensePresentation,
  mapLicenseStatus,
  type LicenseState,
  type LicenseStatus,
} from '../src/core/hmi/license-store';

function status(state: LicenseState, patch: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    state,
    gatewayAllowed: true,
    maxSignals: 20,
    admittedSignals: 17,
    effectiveNow: '2026-07-19T12:00:00Z',
    licenseType: null,
    licenseId: null,
    error: null,
    overLimitSignals: [],
    registration: null,
    ...patch,
  };
}

describe('license-store state derivation', () => {
  it.each([
    ['Unlicensed', 'License required'],
    ['PendingRegistration', 'License: Waiting for confirmation'],
    ['LicensedCommunity', 'Free - 17 / 20 signals'],
    ['LicensedAnnual', 'License: Annual - 20 signals'],
    ['LicensedLifetime', 'License: Lifetime - 20 signals'],
    ['Degraded', 'License degraded - License registration is required'],
  ] satisfies Array<[LicenseState, string]>)('derives %s', (stateName, label) => {
    expect(deriveLicensePresentation(status(stateName)).label).toBe(label);
  });

  it('keeps annual expiry degradation separate from the unlicensed state', () => {
    const result = deriveLicensePresentation(status('Degraded', { error: 'LICENSE_TOKEN_EXPIRED' }));
    expect(result.label).toBe('License degraded - Token expired');
    expect(result.detail).toBeUndefined();
    expect(deriveLicensePresentation(status('Unlicensed'))).toMatchObject({
      label: 'License required',
      detail: 'Register free for 20 PLC signals - or activate a license key.',
      actionLabel: 'Activate license...',
    });
  });

  it('offers the quiet activation entry point for the free license', () => {
    expect(deriveLicensePresentation(status('LicensedCommunity')).actionLabel)
      .toBe('Activate license...');
  });

  it.each([
    'waitingForEmailConfirmation',
    'portalUnreachable',
    'expired',
  ] as const)('maps registration object state %s', (registrationState) => {
    const mapped = mapLicenseStatus({
      ...status('PendingRegistration'),
      registration: {
        status: registrationState,
        email: 't***@example.com',
        startedAt: '2026-07-19T12:00:00Z',
        error: registrationState === 'portalUnreachable' ? 'PORTAL_UNREACHABLE' : null,
      },
    });
    expect(mapped?.registration).toEqual({
      status: registrationState,
      email: 't***@example.com',
      startedAt: '2026-07-19T12:00:00Z',
      error: registrationState === 'portalUnreachable' ? 'PORTAL_UNREACHABLE' : null,
    });
  });
});

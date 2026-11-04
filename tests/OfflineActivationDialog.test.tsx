// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { OfflineActivationDialog } from '../src/core/hmi/OfflineActivationDialog';
import { LicenseSection } from '../src/core/hmi/LicenseSection';
import { rvDarkTheme } from '../src/core/hmi/theme';

const serverUrl = 'http://localhost:5100';

function renderDialog() {
  return render(<ThemeProvider theme={rvDarkTheme}>
    <OfflineActivationDialog open onClose={() => undefined} serverUrl={serverUrl} />
  </ThemeProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OfflineActivationDialog', () => {
  it('creates, copies, and saves a commercial request code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'REQUEST-CODE', portalUrl: 'https://portal.realvirtual.io/licenses',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const createObjectURL = vi.fn().mockReturnValue('blob:test');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
    let downloadName = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    renderDialog();
    const create = screen.getByRole('button', { name: 'Create request code' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('License key'), { target: { value: 'LIC-ABCD-EFGH-IJKL' } });
    fireEvent.click(create);
    expect(await screen.findByDisplayValue('REQUEST-CODE')).toBeTruthy();
    const requestUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestUrl).toContain('/license/offline-request?');
    expect(requestUrl).toContain('kind=commercial');
    expect(requestUrl).toContain('licenseKey=LIC-ABCD-EFGH-IJKL');
    expect(screen.getByRole('link', { name: 'portal.realvirtual.io/licenses' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('REQUEST-CODE'));
    fireEvent.click(screen.getByRole('button', { name: 'Save as file' }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalled();
    expect(downloadName).toBe('connect-activation-request.txt');
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:test'));
  });

  it('creates a community request without a license key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'COMMUNITY', portalUrl: 'https://portal.realvirtual.io/licenses',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    fireEvent.click(screen.getByLabelText('Free community licence (20 signals)'));
    fireEvent.click(screen.getByRole('button', { name: 'Create request code' }));
    await screen.findByDisplayValue('COMMUNITY');
    const requestUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestUrl).toContain('kind=community');
    expect(requestUrl).not.toContain('licenseKey');
  });

  it('imports a trimmed pasted token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, state: 'LicensedAnnual' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    fireEvent.change(screen.getByLabelText('Activation token'), { target: { value: '  TOKEN\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import licence' }));
    expect(await screen.findByText('Licence imported. CONNECT is now licensed.')).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ token: 'TOKEN' });
  });

  it('reads and immediately imports a licence file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    const file = new File(['FILE-TOKEN\n'], 'license.rvlic', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('offline-token-file'), { target: { files: [file] } });
    expect(await screen.findByText('Licence imported. CONNECT is now licensed.')).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('FILE-TOKEN');
  });

  it.each([
    ['LICENSE_FINGERPRINT_MISMATCH', /different computer/],
    ['LICENSE_TOKEN_SIGNATURE_INVALID', /signature is invalid/],
  ])('shows friendly error for %s', async (code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'failed', code }), { status: 400 })));
    renderDialog();
    fireEvent.change(screen.getByLabelText('Activation token'), { target: { value: 'TOKEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import licence' }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('offers offline activation from the unlicensed section', () => {
    render(<ThemeProvider theme={rvDarkTheme}><LicenseSection serverUrl={serverUrl} statusOverride={{
      state: 'Unlicensed', gatewayAllowed: false, maxSignals: 0, admittedSignals: 0,
      effectiveNow: '', overLimitSignals: [], registration: null,
    }} /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Activate license...' }));
    expect(screen.getByRole('button', { name: /Activate offline/ })).toBeTruthy();
  });
});
